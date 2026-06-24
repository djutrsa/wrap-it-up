// Kiro CLI adapter for the broker CLI.
// Kiro (AWS's agentic tool; its CLI is the renamed Amazon Q Developer CLI) auto-persists
// every session to
//     ~/.kiro/sessions/cli/<uuid>.jsonl     (+ a <uuid>.json companion carrying `cwd`)
// AS YOU WORK — no manual /save. We locate the session that ran in the wrap-target folder
// and translate its tool calls into the SAME WrapEvent[] the editor recorder produces, so
// the engine (reduce → wrap → enrich) yields a rich wrap with REAL status instead of the
// git-only "Unknown" fallback. Sibling of src/claudeCode.ts; same three exports.
//
// Reads ONLY first-party local files the user owns (the session log). No network, no
// scraping a running app.
//
// Kiro session schema (reverse-engineered from a real session, "version":"v1"):
//   each line: { version, kind, data }
//   • kind "Prompt"           data.content[]{kind:"text", data:<string>}      (the developer)
//                             data.meta.timestamp = unix SECONDS
//   • kind "AssistantMessage" data.content[]{kind:"text"|"toolUse", data:…}   (assistant + tool calls)
//        toolUse block →  data:{ toolUseId, name, input:{ command, path, content, … } }
//   • kind "ToolResults"      data.results{ <toolUseId>: { tool.kind.BuiltIn.<Name>,
//                                                          result:{Success|Error}{items[]{Json|Text}} } }
//        ExecuteCmd result Json → { exit_status:"exit code: N", stdout, stderr }   ← the parity signal
//
// STATUS caveat (documented, by design): Kiro normalizes every non-zero exit to
// "exit code: 1" — the specific code is lost, which is fine for the binary Working/Broken
// verdict — and when the agent CHAINS commands (`fail; echo`) exit_status reflects only the
// LAST one, so a masked failure can read as success. We take exit_status as the primary
// verdict and carry stdout+stderr into outTail so "what broke" still surfaces the evidence.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WrapEvent, Turn } from "./core/types";

const CLI_SESSIONS = path.join(os.homedir(), ".kiro", "sessions", "cli");

const norm = (p: string): string => {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
};

// Is `parent` an ancestor of (or equal to) `child`? Both already norm'd.
function isAncestorOrEqual(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// The session's cwd lives as a clean top-level field in the <uuid>.json companion that
// sits next to the .jsonl — no need to parse the log head (unlike Claude Code).
function readCwd(jsonl: string): string | null {
  const meta = jsonl.replace(/\.jsonl$/i, ".json");
  try {
    const o = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (o && typeof o.cwd === "string" && o.cwd) return o.cwd;
  } catch {
    /* missing/partial companion — skip */
  }
  return null;
}

// Does this session write any file INSIDE `wantDir`? Scans AssistantMessage toolUse inputs
// for a target path under the folder. Lets us recognize a session launched in a PARENT cwd
// that actually worked in the wrap-target subfolder. Bounded: stops at the first hit.
function transcriptEditedInside(jsonl: string, wantDir: string): boolean {
  let data: string;
  try { data = fs.readFileSync(jsonl, "utf8"); } catch { return false; }
  const prefix = wantDir.endsWith(path.sep) ? wantDir : wantDir + path.sep;
  for (const line of data.split("\n")) {
    if (line.indexOf('"path"') < 0) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.kind !== "AssistantMessage") continue;
    const content = o.data && Array.isArray(o.data.content) ? o.data.content : [];
    for (const b of content) {
      const p = b && b.data && b.data.input && b.data.input.path;
      if (typeof p === "string" && norm(p).startsWith(prefix)) return true;
    }
  }
  return false;
}

// Locate the Kiro session for the work you were ACTUALLY doing when wrapping `folder`.
// Return the MOST-RECENT *relevant* session, where relevant means either:
//   (a) its recorded cwd IS the target folder (Kiro was launched in it), or
//   (b) its cwd is an ANCESTOR of the target AND it wrote files inside the target.
// Returns null when nothing relevant is found (caller falls back to the git-only wrap).
export function findTranscript(folder: string): string | null {
  const want = norm(folder);

  const all: { file: string; mtime: number }[] = [];
  try {
    for (const f of fs.readdirSync(CLI_SESSIONS)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(CLI_SESSIONS, f);
      try { all.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* skip */ }
    }
  } catch {
    return null; // no kiro sessions dir
  }
  all.sort((a, b) => b.mtime - a.mtime);

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

// A shell command can be a whole multi-line script. Store a single bounded line so status/
// dedup stay meaningful and the wrap + LLM prompt stay clean — without losing the command's
// leading token (the AGENT_CLI guard keys off the start of the command, so it must survive).
const clipCmd = (c: string): string => {
  const one = c.replace(/\s+/g, " ").trim();
  return one.length > 200 ? one.slice(0, 200) + " …" : one;
};

// Kiro reports exit as the literal string "exit code: N". Pull N; absent/garbage ⇒ 0.
function parseExit(s: unknown): number {
  if (typeof s !== "string") return 0;
  const m = s.match(/exit code:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Translate a session log into WrapEvents. The parity-critical signal is STATUS: an
// ExecuteCmd result carries exit_status -> shell.exec pass/fail -> the engine's verdict.
// FileWrite -> file changes (created/touched, reconciled vs git later). Reads & web lookups
// (FileRead/WebFetch/WebSearch) carry no change/run signal, so we skip them (mirror Claude Code).
export function transcriptToEvents(file: string, folder?: string): WrapEvent[] {
  const events: WrapEvent[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return events;
  }

  // Scope file writes to the wrap TARGET — an agent's session writes all over the machine
  // (scratch/temp dirs, OTHER repos) and listing those as the project's "active files" is
  // cross-folder contamination. Keep relative paths (resolve under cwd) and absolute paths
  // inside the target; drop absolute paths outside it. shell.exec carries no path, so command
  // evidence is unaffected. No folder ⇒ no scoping (back-compat).
  const want = folder ? norm(folder) : null;
  const inScope = (p: string): boolean => !want || !path.isAbsolute(p) || isAncestorOrEqual(want, norm(p));

  // toolUseId -> input, gathered from AssistantMessage blocks (which always precede the
  // matching ToolResults in file order — same forward-reference shape as Claude Code).
  const inputById = new Map<string, any>();
  // Only Prompts carry a real timestamp (unix secs); other records don't. Carry the latest
  // prompt time forward and add a monotonic tick per event, so `t` is real AND strictly
  // increasing (a flat seq would put the session span in 1970).
  let seq = 0;
  let clock = 0;
  const stamp = (): number => clock + ++seq;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.kind === "Prompt") {
      const ts = o.data && o.data.meta && o.data.meta.timestamp;
      if (typeof ts === "number" && isFinite(ts)) clock = ts * 1000;
      continue;
    }

    if (o.kind === "AssistantMessage") {
      const content = o.data && Array.isArray(o.data.content) ? o.data.content : [];
      for (const b of content) {
        if (b && b.kind === "toolUse" && b.data && b.data.toolUseId) {
          inputById.set(b.data.toolUseId, b.data.input || {});
        }
      }
      continue;
    }

    if (o.kind === "ToolResults") {
      const results = o.data && o.data.results && typeof o.data.results === "object" ? o.data.results : {};
      for (const id of Object.keys(results)) {
        const r = results[id] || {};
        const builtin = r.tool && r.tool.kind && r.tool.kind.BuiltIn;
        const toolName = builtin && typeof builtin === "object" ? Object.keys(builtin)[0] : "";
        const input = inputById.get(id) || {};
        const ok = !!(r.result && Object.prototype.hasOwnProperty.call(r.result, "Success"));
        const variant = ok ? r.result.Success : r.result && r.result.Error;
        const items = (variant && Array.isArray(variant.items) && variant.items) || [];
        const t = stamp();

        if (toolName === "ExecuteCmd") {
          const cmd = clipCmd(String(input.command || ""));
          if (!cmd) continue;
          const j = (items[0] && items[0].Json) || {};
          let exitCode = parseExit(j.exit_status);
          if (!ok && exitCode === 0) exitCode = 1; // Error variant without a numeric code ⇒ failure
          const tail = [j.stdout, j.stderr].filter((x: unknown) => typeof x === "string" && x).join("\n");
          events.push({ t, kind: "shell.exec", cmd, exitCode, outTail: tail.slice(-1200) });
        } else if (toolName === "FileWrite") {
          const uri = input.path;
          if (typeof uri === "string" && uri && inScope(uri)) {
            events.push({ t, kind: "doc.change", uri, lang: langOf(uri), churn: 1, dirty: false });
            // input.command "create" ⇒ create; "str_replace"/"insert"/"append"/… ⇒ change.
            // reconcileGitStatus() later demotes a create to a modification when git shows the
            // file already existed at HEAD, so an over-eager "create" is self-correcting.
            const op: "create" | "change" = String(input.command || "").toLowerCase() === "create" ? "create" : "change";
            events.push({ t, kind: "fs.change", uri, op });
          }
        } else if (/delete/i.test(toolName)) {
          const uri = input.path;
          if (typeof uri === "string" && uri && inScope(uri)) {
            events.push({ t, kind: "fs.change", uri, op: "delete" });
          }
        }
        // FileRead / WebFetch / WebSearch and any other read-only tool: no event.
      }
      continue;
    }
  }
  return events;
}

// Extract the developer↔assistant CONVERSATION — the chat-AWARE signal the tool-call exhaust
// throws away. Keep the human's typed prompts (their stated intent) and the assistant's
// narration text; DROP toolUse inputs and tool_result payloads (those already become
// WrapEvents). Returns ordered turns; the bounded digest that reaches the LLM is computed
// later (core/conversation.ts), so we only clip per-turn here to keep memory sane.
export function transcriptToConversation(file: string): Turn[] {
  const turns: Turn[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return turns;
  }

  let seq = 0;
  let clock = 0;
  const stamp = (): number => clock + ++seq;

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }

    const role: "user" | "assistant" | null =
      o.kind === "Prompt" ? "user" : o.kind === "AssistantMessage" ? "assistant" : null;
    if (!role) continue;

    if (role === "user") {
      const ts = o.data && o.data.meta && o.data.meta.timestamp;
      if (typeof ts === "number" && isFinite(ts)) clock = ts * 1000;
    }

    const content = o.data && Array.isArray(o.data.content) ? o.data.content : [];
    const text = content
      .filter((b: any) => b && b.kind === "text" && typeof b.data === "string")
      .map((b: any) => b.data)
      .join("\n")
      .trim();
    if (!text) continue; // tool-only turn — no narration to keep

    turns.push({ t: stamp(), role, text: text.length > 4000 ? text.slice(0, 4000) : text });
  }
  return turns;
}
