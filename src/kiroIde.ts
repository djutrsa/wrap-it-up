// Kiro IDE adapter for the broker CLI. Sibling of src/kiro.ts (CLI) and src/claudeCode.ts.
//
// Kiro IDE is a VS Code (Code OSS) fork; its agent ("kiro.kiroagent") persists each chat session
// under the editor's globalStorage:
//   <globalStorage>/kiro.kiroagent/
//     workspace-sessions/<base64url(workspacePath)>/sessions.json   -> [{ sessionId, title,
//                                                                          dateCreated, workspaceDirectory }]
//     workspace-sessions/<base64url(workspacePath)>/<sessionId>.json -> { history:[{message,…}], … }  (the CHAT)
//     <opaque-hash>/<opaque-hash>/<opaque-hash>                      -> per-execution detail blobs (the WORK):
//          { chatSessionId, executionId, actions:[ … ], … }
//
// The chat (history) and the agent's tool work (actions) live in SEPARATE files: the session json
// holds the conversation; the per-execution blobs hold the tool calls + results. The blob paths are
// opaque hashes (not derivable), so we DISCOVER a session's blobs by scanning for a matching
// `chatSessionId`. Each action carries the parity signal we need:
//   actionType "runCommand" -> input.command + output.exitCode  (REAL pass/fail)
//   actionType "replace"/"fsWrite"/… -> input.file / rawInput.path  (file change)
//   actionType "readFiles"/"model"/"say"/"intentClassification" -> read/LLM/chat noise, skipped
//
// Reads ONLY first-party local files the user owns. No network, no scraping a running app.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WrapEvent, Turn } from "./core/types";

// The IDE's globalStorage/kiro.kiroagent dir. Honors WRAPITUP_KIRO_IDE_DIR (testing / non-standard
// installs), else the per-platform VS Code-fork location.
function agentDir(): string {
  if (process.env.WRAPITUP_KIRO_IDE_DIR) return process.env.WRAPITUP_KIRO_IDE_DIR;
  const home = os.homedir();
  let base: string;
  if (process.platform === "win32") base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  else if (process.platform === "darwin") base = path.join(home, "Library", "Application Support");
  else base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Kiro", "User", "globalStorage", "kiro.kiroagent");
}

const norm = (p: string): string => {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
};
function isAncestorOrEqual(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}
const langOf = (p: string): string => (p.split(".").pop() || "").toLowerCase();
const clipCmd = (c: string): string => {
  const one = c.replace(/\s+/g, " ").trim();
  return one.length > 200 ? one.slice(0, 200) + " …" : one;
};

// Locate the Kiro IDE session for `folder`: the MOST-RECENT session (by dateCreated) whose recorded
// workspaceDirectory is the target (or an ancestor of it). Returns the path to its <sessionId>.json
// (the chat file); transcriptToEvents discovers the matching execution blobs from there. null ⇒ none.
export function findTranscript(folder: string): string | null {
  const want = norm(folder);
  const wsRoot = path.join(agentDir(), "workspace-sessions");
  let dirs: string[];
  try { dirs = fs.readdirSync(wsRoot); } catch { return null; }

  let best: { file: string; dc: number } | null = null;
  for (const d of dirs) {
    const sj = path.join(wsRoot, d, "sessions.json");
    let arr: any;
    try { arr = JSON.parse(fs.readFileSync(sj, "utf8")); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (!s || typeof s.sessionId !== "string" || typeof s.workspaceDirectory !== "string") continue;
      const ws = norm(s.workspaceDirectory);
      if (ws !== want && !isAncestorOrEqual(ws, want)) continue;
      const file = path.join(wsRoot, d, s.sessionId + ".json");
      if (!fs.existsSync(file)) continue;
      const dc = Number(s.dateCreated) || 0;
      if (!best || dc > best.dc) best = { file, dc };
    }
  }
  return best ? best.file : null;
}

// Scan the agent store for this session's per-execution blobs and return their actions, time-ordered.
// Bounded: skips the chat/diff/telemetry subtrees, caps depth, file size, and files parsed. A cheap
// substring pre-check on the raw text avoids JSON.parse for blobs that don't mention this session.
// Memoized per session: transcriptToEvents and transcriptToConversation both need the actions, so the
// (bounded) disk scan runs once per wrap, not twice.
let _actionCache: { sessionId: string; actions: any[] } | null = null;
function collectActions(sessionId: string): any[] {
  if (_actionCache && _actionCache.sessionId === sessionId) return _actionCache.actions;
  const root = agentDir();
  const SKIP_TOP = new Set(["workspace-sessions", ".diffs", "dev_data", "default"]);
  const actions: any[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let parsed = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && SKIP_TOP.has(e.name)) continue;
        if (depth < 4) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile() && parsed < 800) {
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size < 80 || st.size > 8 * 1024 * 1024) continue;
        let data: string;
        try { data = fs.readFileSync(full, "utf8"); } catch { continue; }
        if (data.indexOf(sessionId) < 0) continue; // not this session — skip the parse
        parsed++;
        let o: any;
        try { o = JSON.parse(data); } catch { continue; }
        if (o && o.chatSessionId === sessionId && Array.isArray(o.actions)) actions.push(...o.actions);
      }
    }
  }
  actions.sort((a, b) => (Number(a?.emittedAt) || 0) - (Number(b?.emittedAt) || 0));
  _actionCache = { sessionId, actions };
  return actions;
}

const EDIT_ACTION = /^(replace|strreplace|fswrite|writefile|createfile|fsappend|appendtofile|insert|insertline|applydiff|edit)$/i;
const CREATE_ACTION = /^(fswrite|writefile|createfile)$/i;

// Translate a session's agent actions into WrapEvents. runCommand -> shell.exec (with REAL exitCode);
// file-edit actions -> file changes (reconciled vs git later). Reads/LLM/chat actions carry no
// change/run signal and are skipped (mirror the CLI + Claude Code adapters).
export function transcriptToEvents(file: string, folder?: string): WrapEvent[] {
  const events: WrapEvent[] = [];
  let sessionId = "";
  try { sessionId = String(JSON.parse(fs.readFileSync(file, "utf8")).sessionId || ""); } catch { /* fall through */ }
  if (!sessionId) sessionId = path.basename(file).replace(/\.json$/i, "");
  if (!sessionId) return events;

  const want = folder ? norm(folder) : null;
  const inScope = (p: string): boolean => !want || !path.isAbsolute(p) || isAncestorOrEqual(want, norm(p));

  let seq = 0;
  for (const a of collectActions(sessionId)) {
    if (!a || typeof a !== "object") continue;
    const type = String(a.actionType || "");
    const t = Number(a.emittedAt) || ++seq;
    const state = String(a.actionState || "");

    if (type === "runCommand") {
      if (/reject|den|cancel/i.test(state)) continue; // proposed but not executed — no verdict
      const cmd = clipCmd(String((a.input && a.input.command) || (a.rawInput && a.rawInput.command) || ""));
      if (!cmd) continue;
      const out = a.output || {};
      const exitCode = typeof out.exitCode === "number" ? out.exitCode : (/error|fail/i.test(state) ? 1 : 0);
      events.push({ t, kind: "shell.exec", cmd, exitCode, outTail: String(out.output || "").slice(-1200) });
    } else if (EDIT_ACTION.test(type)) {
      const uri = (a.input && (a.input.file || a.input.path)) || (a.rawInput && a.rawInput.path);
      if (typeof uri === "string" && uri && inScope(uri)) {
        events.push({ t, kind: "doc.change", uri, lang: langOf(uri), churn: 1, dirty: false });
        // create-type tools ⇒ create; replace/append/insert ⇒ change. reconcileGitStatus() later
        // demotes an over-eager "create" when git shows the file already existed at HEAD.
        const op: "create" | "change" = CREATE_ACTION.test(type) ? "create" : "change";
        events.push({ t, kind: "fs.change", uri, op });
      }
    }
    // readFiles / model / say / intentClassification / listDirectory / … : no event.
  }
  return events;
}

const turnText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }
  return "";
};

// A `say` action's narration text (the assistant's real reasoning), tolerant of string / {text} / {message}.
const sayText = (out: unknown): string => {
  if (typeof out === "string") return out.trim();
  if (out && typeof out === "object") {
    const o = out as any;
    if (typeof o.text === "string") return o.text.trim();
    if (typeof o.message === "string") return o.message.trim();
  }
  return "";
};

// Extract the developer↔assistant CONVERSATION — the chat-AWARE signal "where was I" leans on.
// The human's typed prompts come from `history` (their stated intent — the highest-signal thing a
// chat-blind wrap can't see). The assistant's SUBSTANTIVE narration, however, is stored as `say`
// actions in the execution blobs, not in history (which often carries only a terse "On it."); we pull
// those in, grouped by executionId, so the enricher reasons over the real explanation, not a stub.
// Tool calls/results stay out (they already become WrapEvents). Per-turn clip keeps memory sane.
export function transcriptToConversation(file: string): Turn[] {
  let o: any;
  try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  const hist = Array.isArray(o.history) ? o.history : [];
  const sessionId = String(o.sessionId || path.basename(file).replace(/\.json$/i, ""));

  const sayByExec = new Map<string, string[]>();
  for (const a of collectActions(sessionId)) {
    if (!a || a.actionType !== "say") continue;
    const txt = sayText(a.output);
    if (!txt) continue;
    const k = String(a.executionId || "");
    const list = sayByExec.get(k) || [];
    list.push(txt);
    sayByExec.set(k, list);
  }

  const turns: Turn[] = [];
  let seq = 0;
  for (const h of hist) {
    const m = h && h.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    let text: string;
    if (m.role === "assistant") {
      const says = sayByExec.get(String(h.executionId || ""));
      text = (says && says.length ? says.join("\n") : turnText(m.content)).trim();
    } else {
      text = turnText(m.content);
    }
    if (!text) continue;
    turns.push({ t: ++seq, role: m.role, text: text.length > 4000 ? text.slice(0, 4000) : text });
  }
  return turns;
}
