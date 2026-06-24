// Claude Code adapter for the broker CLI.
// Locates the session transcript Claude Code already writes to disk, and
// translates its tool calls into the SAME WrapEvent[] the editor recorder
// produces — so the existing engine (reduce → wrap → enrich) yields a rich
// wrap with REAL status, not the git-only "Unknown" fallback.
//
// Reads ONLY a first-party local file the user owns (the transcript). No
// network, no scraping a running app.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WrapEvent, Turn } from "./core/types";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

const norm = (p: string): string => {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
};

function readCwd(jsonl: string): string | null {
  try {
    const fh = fs.openSync(jsonl, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fh, buf, 0, buf.length, 0);
      const head = buf.toString("utf8", 0, n);
      for (const line of head.split("\n").slice(0, 25)) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.cwd) return o.cwd;
        } catch {
          /* partial last line — ignore */
        }
      }
    } finally {
      fs.closeSync(fh);
    }
  } catch {
    /* unreadable — skip */
  }
  return null;
}

// Is `parent` an ancestor of (or equal to) `child`? Both already norm'd.
function isAncestorOrEqual(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Does this transcript edit any file INSIDE `wantDir`? Scans Edit/Write/MultiEdit/Notebook
// tool calls for a target path under the folder. Lets us recognize a session that ran in a
// PARENT cwd but actually worked in the wrap-target subfolder. Bounded: stops at first hit.
function transcriptEditedInside(jsonl: string, wantDir: string): boolean {
  let data: string;
  try { data = fs.readFileSync(jsonl, "utf8"); } catch { return false; }
  const prefix = wantDir.endsWith(path.sep) ? wantDir : wantDir + path.sep;
  for (const line of data.split("\n")) {
    if (line.indexOf("file_path") < 0 && line.indexOf("notebook_path") < 0) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) continue;
    for (const b of content) {
      if (b && b.type === "tool_use" && b.input) {
        const p = b.input.file_path || b.input.notebook_path;
        if (typeof p === "string" && norm(p).startsWith(prefix)) return true;
      }
    }
  }
  return false;
}

// Locate the Claude Code transcript for the session you were ACTUALLY working in when wrapping
// `folder`. We return the MOST-RECENT *relevant* session across ALL project dirs, where a session
// is relevant if either:
//   (a) its recorded cwd IS the target folder (Claude Code was launched in it), or
//   (b) its cwd is an ANCESTOR of the target AND it edited files inside the target — i.e. you
//       launched Claude Code in a parent dir (e.g. your home dir) but worked in this subfolder.
// This replaces the old "newest .jsonl in the cwd-slug dir", which silently grabbed an unrelated
// EARLIER same-slug session whenever the session cwd != the wrap target — it could otherwise
// pick the wrong session and produce a stale, wrong wrap.
// Returns null when nothing relevant is found (caller falls back to the git-only wrap).
export function findTranscript(folder: string): string | null {
  const want = norm(folder);

  // Every transcript across all project dirs, newest first.
  const all: { file: string; mtime: number }[] = [];
  try {
    for (const d of fs.readdirSync(PROJECTS)) {
      const dd = path.join(PROJECTS, d);
      let files: string[];
      try { files = fs.readdirSync(dd).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const full = path.join(dd, f);
        try { all.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* skip */ }
      }
    }
  } catch {
    return null; // no projects dir
  }
  all.sort((a, b) => b.mtime - a.mtime);

  // Walk newest → oldest; return the first relevant session. The expensive content scan (b) only
  // runs for ancestor-cwd sessions, and we stop at the first match — usually the very newest.
  for (const c of all) {
    const cwd = readCwd(c.file);
    if (!cwd) continue;
    const ncwd = norm(cwd);
    if (ncwd === want) return c.file;
    if (isAncestorOrEqual(ncwd, want) && transcriptEditedInside(c.file, want)) return c.file;
  }
  return null;
}

const langOf = (p: string): string => (p.split(".").pop() || "").toLowerCase();

// A Claude Code Bash tool call can be a whole multi-line script. Store a single
// bounded line so status/dedup stay meaningful and the wrap + LLM prompt stay
// clean — without losing the command's leading token (the AGENT_CLI guard keys
// off the start of the command, so it must survive clipping).
const clipCmd = (c: string): string => {
  const one = c.replace(/\s+/g, " ").trim();
  return one.length > 200 ? one.slice(0, 200) + " …" : one;
};

const resultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((x: any) => (x && typeof x.text === "string" ? x.text : "")).join(" ");
  return "";
};

// Translate a session transcript into WrapEvents. The parity-critical signal is
// STATUS: a Bash/PowerShell tool_result carries `is_error` (and "Exit code N" in
// its text on failure) -> shell.exec pass/fail -> the engine's status verdict.
// Edit/Write/MultiEdit -> file changes (created/touched, reconciled vs git later).
export function transcriptToEvents(file: string, folder?: string): WrapEvent[] {
  const events: WrapEvent[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return events;
  }

  const cmdById = new Map<string, string>(); // tool_use_id -> shell command
  let seq = 0; // monotonic fallback clock when timestamps are missing

  // Scope file edits to the wrap TARGET. An external agent's transcript records edits ALL OVER the
  // machine — scratch/temp dirs, OTHER repos — and listing those as the project's "active files" is
  // cross-folder contamination (a scratch file surfaced as a project edit). Keep relative paths (they
  // resolve under the project cwd) and absolute paths inside the target; drop absolute paths outside it.
  // shell.exec carries no path, so command evidence is unaffected. No folder ⇒ no scoping (back-compat).
  const want = folder ? norm(folder) : null;
  const inScope = (p: string): boolean => !want || !path.isAbsolute(p) || isAncestorOrEqual(want, norm(p));

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(o.timestamp || "") || ++seq;
    const msg = o.message && typeof o.message === "object" ? o.message : {};
    const content = Array.isArray(msg.content) ? msg.content : [];

    for (const b of content) {
      if (!b || typeof b !== "object") continue;

      if (b.type === "tool_use") {
        const name = b.name;
        const inp = b.input || {};
        if (name === "Bash" || name === "PowerShell") {
          if (b.id) cmdById.set(b.id, clipCmd(String(inp.command || "")));
        } else if (name === "Edit" || name === "MultiEdit") {
          const uri = inp.file_path;
          if (uri && inScope(uri)) {
            events.push({ t, kind: "doc.change", uri, lang: langOf(uri), churn: 1, dirty: false });
            events.push({ t, kind: "fs.change", uri, op: "change" });
          }
        } else if (name === "NotebookEdit") {
          const uri = inp.notebook_path || inp.file_path;
          if (uri && inScope(uri)) {
            events.push({ t, kind: "doc.change", uri, lang: langOf(uri), churn: 1, dirty: false });
            events.push({ t, kind: "fs.change", uri, op: "change" });
          }
        } else if (name === "Write") {
          const uri = inp.file_path;
          if (uri && inScope(uri)) {
            events.push({ t, kind: "doc.change", uri, lang: langOf(uri), churn: 1, dirty: false });
            // Treat Write as a create; reconcileGitStatus() demotes it to a
            // modification when git shows the file already existed at HEAD.
            events.push({ t, kind: "fs.change", uri, op: "create" });
          }
        }
      } else if (b.type === "tool_result") {
        const id = b.tool_use_id;
        if (id && cmdById.has(id)) {
          const cmd = cmdById.get(id)!;
          const text = resultText(b.content);
          const isErr = b.is_error === true;
          let exitCode = 0;
          if (isErr) {
            const m = text.match(/Exit code (\d+)/i);
            exitCode = m ? parseInt(m[1], 10) : 1;
          }
          events.push({ t, kind: "shell.exec", cmd, exitCode, outTail: text.slice(-1200) });
        }
      }
    }
  }
  return events;
}

// Extract the developer↔assistant CONVERSATION from a transcript — the chat-AWARE signal that
// transcriptToEvents() (tool-call exhaust) throws away. We keep the human's typed messages (their
// stated intent — the highest-signal thing a chat-blind wrap can't see) and the assistant's
// narration text, but DROP raw tool_use inputs and tool_result payloads: those already become
// WrapEvents, and here we want the reasoning, not the noise. Returns ordered turns; the bounded,
// fixed-shape DIGEST that actually reaches the LLM is computed later (core/conversation.ts), so we
// only clip per-turn here to keep memory sane on huge transcripts.
export function transcriptToConversation(file: string): Turn[] {
  const turns: Turn[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return turns;
  }

  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isMeta === true) continue; // injected meta (hooks, reminders) — not the developer
    const type = o.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = o.message && typeof o.message === "object" ? o.message : {};

    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // text blocks only — skip tool_use (raw inputs) and tool_result (payloads) and thinking
      text = msg.content
        .filter((blk: any) => blk && blk.type === "text" && typeof blk.text === "string")
        .map((blk: any) => blk.text)
        .join("\n");
    }
    text = text.trim();
    if (!text) continue; // tool-only turn — no narration to keep

    const t = Date.parse(o.timestamp || "") || ++seq;
    // Bound per-turn memory; the digest re-clips to its own char budget.
    turns.push({ t, role: type, text: text.length > 4000 ? text.slice(0, 4000) : text });
  }
  return turns;
}
