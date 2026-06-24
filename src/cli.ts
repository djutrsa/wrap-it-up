#!/usr/bin/env node
// Headless "broker" CLI — the spawn-per-trigger entry point.
// Runs the portable core against a git folder with NO VS Code and NO chat: a
// standalone "wrap up where I am" built from `git diff` + changed-file contents.
// Local-first (the wrap is written before any network call); AI enrichment runs
// ONLY if ANTHROPIC_API_KEY is set, and a failure keeps the local wrap.
//
//   node out/cli.js wrap   --cwd <folder> [--source claude-code|git]
//        -> writes a wrap; prints {ok,file,title,status,nextMove,source}
//        default source is claude-code (reads the session transcript for REAL
//        status); auto-falls-back to git-only when no session is found.
//   node out/cli.js resume --cwd <folder> [--prev <wrapId>]
//        -> prints the latest wrap {ok,file,wrapId,title,nextMove,nextPrompt,prev}
//        --prev surfaces the PRIOR wrap's one-liner for the Clock-2 retrospective.
//   node out/cli.js feedback --cwd <folder>   (one JSON event on stdin)
//        -> appends a feedback row (kind:"perceived") or patches a prior row
//        (kind:"reentry"); triages a "didn't help". Calibration + triage only.

import * as fs from "fs";
import * as path from "path";
import { execSync, spawn } from "child_process";
import { buildLocalWrap, renderWrapMarkdown } from "./core/wrap";
import { selectEnrich } from "./core/modes";
import { scanDocs } from "./core/scanDocs";
import { reduceEvents, reconcileGitStatus } from "./core/reduce";
import { SessionContext, WrapUp, Derived } from "./core/types";
import { redact } from "./core/redact";
import { appendFeedbackEvent, patchReentryOutcome, appendTriage, appendRegeneration, summarizeFeedback, wrapIdFromFile, readEventById } from "./core/feedback";
import { anonymize, sendTelemetry } from "./core/telemetry";
import { callClaudeTool } from "./llm";
import { findTranscript, transcriptToEvents, transcriptToConversation } from "./claudeCode";

function readGit(folder: string): SessionContext["git"] {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: folder }).toString().trim();
    const diff = execSync("git diff HEAD", { cwd: folder, maxBuffer: 10 * 1024 * 1024 }).toString();
    const changedFiles = execSync("git diff --name-only HEAD", { cwd: folder }).toString().split("\n").filter(Boolean);
    const committedFiles = execSync("git ls-files", { cwd: folder, maxBuffer: 10 * 1024 * 1024 }).toString().split("\n").filter(Boolean);
    return { branch, diffVsHead: redact(diff), changedFiles, committedFiles };
  } catch {
    return undefined;
  }
}

function readChangedContents(folder: string, relPaths: string[]): { uri: string; text: string }[] {
  const out: { uri: string; text: string }[] = [];
  for (const rel of relPaths.slice(0, 6)) {
    try {
      const full = path.join(folder, rel);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 200_000) continue;
      out.push({ uri: rel, text: redact(fs.readFileSync(full, "utf8")).slice(0, 6000) });
    } catch {
      /* deleted or unreadable — skip */
    }
  }
  return out;
}

// Standalone (no editor events): classify the working tree straight from `git status`.
// `git diff HEAD` misses untracked new files; porcelain status sees them and gives a
// clean created / modified / deleted split (git's own classification).
function gitStatusDerived(folder: string): { created: string[]; touched: string[]; deleted: string[] } {
  const created: string[] = [], touched: string[] = [], deleted: string[] = [];
  try {
    const out = execSync("git status --porcelain=v1 -uall", { cwd: folder, maxBuffer: 10 * 1024 * 1024 }).toString();
    for (const line of out.split("\n")) {
      if (line.length < 4) continue;
      const x = line[0], y = line[1];
      let file = line.slice(3).trim().replace(/^"|"$/g, "");
      if (file.includes(" -> ")) file = file.split(" -> ").pop()!.replace(/^"|"$/g, ""); // rename → new name
      if (x === "D" || y === "D") deleted.push(file);
      else if (x === "A" || x === "?") created.push(file);
      else touched.push(file);
    }
  } catch {
    /* no git — leave empty */
  }
  return { created, touched, deleted };
}

function buildCtx(folder: string): SessionContext {
  const git = readGit(folder);
  const { created, touched, deleted } = gitStatusDerived(folder);
  const hot = [...touched, ...created];
  const derived: Derived = {
    hotFiles: hot.slice(0, 12).map((uri, i) => ({ uri, churn: 10, lastTouched: i })),
    fixedSignals: [], brokenSignals: [], failedRuns: [], passedRuns: [], recoveredRuns: [],
    deadEnds: [], debuggedActive: false, saves: 0,
    created, touched, deleted,
  };
  const changed = [...new Set([...created, ...touched])];
  const now = Date.now();
  return {
    events: [],
    derived,
    git,
    workspaceName: path.basename(folder),
    dirtyBuffers: [],
    changedFileContents: readChangedContents(folder, changed),
    span: { start: now, end: now },
  };
}

// Build the session context from a Claude Code transcript: parse its tool calls
// into events, reduce to grounded facts, then reconcile created/touched against
// git's authoritative "vs HEAD" truth (same pipeline the editor recorder feeds).
function buildCtxFromTranscript(folder: string, file: string): SessionContext {
  const events = transcriptToEvents(file, folder);
  const conversation = transcriptToConversation(file); // chat-AWARE signal (reduced to a digest at enrich time)
  const git = readGit(folder);
  const derived = reconcileGitStatus(reduceEvents(events), git);
  const changed = [...new Set([...derived.created, ...derived.touched])];
  const times = events.map((e) => e.t).filter((n) => n > 0);
  const now = Date.now();
  return {
    events,
    derived,
    git,
    workspaceName: path.basename(folder),
    dirtyBuffers: [],
    changedFileContents: readChangedContents(folder, changed),
    conversation,
    span: { start: times.length ? Math.min(...times) : now, end: times.length ? Math.max(...times) : now },
  };
}

// Is the `claude` CLI on PATH? Lets us prefer Claude Code's own auth for the
// summary (no separate ANTHROPIC_API_KEY needed when you work through Claude).
function hasClaudeCli(): boolean {
  if (process.env.WRAPITUP_CLAUDE_BIN) return true;
  const exts = process.platform === "win32" ? ["", ".cmd", ".ps1", ".exe"] : [""];
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) {
      try {
        if (fs.existsSync(path.join(d, "claude" + e))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

function parseJsonLoose(s: string): any {
  let t = (s || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// Enrich via headless Claude Code (`claude -p`), reusing the user's existing
// Claude Code login — no API key required. The prompt/JSON contract is the same
// one buildEnrichInput() defines (the SYSTEM block already demands a bare JSON
// object), so applyEnrichmentObj() merges the result unchanged.
function callClaudeCli(model: string, system: string, user: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const prompt = system + "\n\n--- SESSION EVIDENCE (ground ONLY in this) ---\n\n" + user;
    // `claude` is an npm shim (.cmd/.ps1 on Windows) → must run via a shell. Pass a
    // single command string (no args array) to avoid DEP0190; the model is the only
    // interpolated value, so sanitize it, and send the prompt over stdin (never the
    // command line) so nothing user-derived can reach the shell.
    //
    // Only pass `--model` when one was EXPLICITLY configured (WRAPITUP_MODEL). An
    // explicit `--model` overrides the CLI's own model resolution — so hardcoding a
    // public-API alias like "claude-sonnet-4-6" breaks Bedrock/Vertex backends, where
    // the CLI expects an inference-profile id (e.g. global.anthropic.claude-sonnet-4-6[1m])
    // and returns a 400 "invalid model identifier". When unset, omit the flag entirely so
    // the CLI uses the user's own resolved default (ANTHROPIC_DEFAULT_SONNET_MODEL, etc.).
    const safeModel = model && /^[\w.\-:[\]]+$/.test(model) ? model : "";
    const modelFlag = safeModel ? ` --model ${safeModel}` : "";
    // Keep this call LEAN — it is a one-shot text→JSON summarization, not an agent run.
    // `--safe-mode` skips MCP servers / hooks / CLAUDE.md / skills (the cold-start cost),
    // and `--tools ""` disables built-in tools so the model answers directly instead of
    // wandering (reading files, running commands) — which is what made it take ~90s.
    let child;
    try {
      child = spawn(`claude -p --output-format json --safe-mode --tools ""${modelFlag}`, { shell: true });
    } catch (e) {
      return reject(e);
    }
    let out = "", err = "";
    const killer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("claude -p timed out"));
    }, 120_000);
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        // The `claude` CLI prints API/model errors (e.g. a Bedrock 400 "invalid model
        // identifier") to STDOUT as a JSON result, not to stderr — so prefer stderr but
        // fall back to stdout, otherwise the message is an unhelpful blank. Try to pull the
        // human-readable `.result` out of the JSON; fall back to the raw tail.
        let detail = err.trim();
        if (!detail && out.trim()) {
          try { detail = String(JSON.parse(out).result || out); } catch { detail = out; }
        }
        return reject(new Error(`claude -p exit ${code}: ${detail.slice(0, 300)}`));
      }
      try {
        resolve(parseJsonLoose(String(JSON.parse(out).result || "")));
      } catch {
        reject(new Error("claude -p returned unparseable output"));
      }
    });
    child.stdin.on("error", () => { /* ignore EPIPE if claude exits early */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Enrichment provider chain (local-first is already satisfied by the caller,
// which writes the local wrap before calling this): 1) headless Claude Code,
// 2) ANTHROPIC_API_KEY direct API, 3) local-only. A provider that fails falls
// through to the next; "failed" is reported only when a provider was tried and
// none succeeded. With no provider at all the local wrap stands (enrichment "pending").
async function enrich(ctx: SessionContext, local: WrapUp): Promise<{ wrap: WrapUp; err?: string }> {
  if (process.env.WRAPITUP_NO_LLM === "1") return { wrap: local };
  // WRAPITUP_MODEL is OPTIONAL. The CLI path passes it through verbatim — empty means
  // "let the `claude` CLI resolve its own default", which is what makes Bedrock/Vertex
  // backends work (they reject the public-API alias). The direct-API path has no such
  // resolver, so it still needs a concrete default model id.
  const cliModel = (process.env.WRAPITUP_MODEL || "").trim();
  const apiModel = cliModel || "claude-sonnet-4-6";
  // The mode registry picks the enricher: a domain override (e.g. writing) if ctx.mode set it,
  // else the presence-based chat-aware/chat-blind fallback. Same WrapUp schema for all of them.
  const E = selectEnrich(ctx);
  const { system, user } = E.buildEnrichInput(ctx, local);
  let attempted = false, lastErr = "";

  if (process.env.WRAPITUP_NO_CLI !== "1" && hasClaudeCli()) {
    attempted = true;
    try {
      return { wrap: E.applyEnrichmentObj(local, await callClaudeCli(cliModel, system, user)) };
    } catch (e: any) {
      lastErr = String(e?.message || e);
    }
  }

  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (key) {
    attempted = true;
    try {
      return { wrap: E.applyEnrichmentObj(local, await callClaudeTool(key, apiModel, system, user, E.WRAP_TOOL)) };
    } catch (e: any) {
      lastErr = String(e?.message || e);
    }
  }

  if (attempted) return { wrap: { ...local, enrichment: "failed" }, err: lastErr };
  return { wrap: local };
}

async function doWrap(folder: string, source: string): Promise<{ file: string; wrap: WrapUp; usedSource: string }> {
  let ctx: SessionContext | null = null;
  let usedSource = "git";
  if (source !== "git") {
    const tr = findTranscript(folder);
    if (tr) {
      ctx = buildCtxFromTranscript(folder, tr);
      usedSource = "claude-code";
    }
  }
  if (!ctx) ctx = buildCtx(folder); // git-only fallback (no session found)

  // DOMAIN MODE (explicit opt-in; auto-detect deferred). WRAPITUP_MODE=writing runs the
  // doc-structure scan so buildLocalWrap + the writing enricher have prose facts to ground on.
  // Unset ⇒ "code" ⇒ today's exact behavior (no scan, presence-based enricher).
  ctx.mode = process.env.WRAPITUP_MODE === "writing" ? "writing" : "code";
  if (ctx.mode === "writing") ctx.docStructure = scanDocs(ctx.changedFileContents, ctx.dirtyBuffers, ctx.git);

  const local = buildLocalWrap(ctx);
  const dir = path.join(folder, ".wrap-it-up", "wrapups");
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(folder, ".wrap-it-up", ".gitignore");
  try {
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n", "utf8");
  } catch {
    /* ignore */
  }
  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, "-") + ".md");
  fs.writeFileSync(file, renderWrapMarkdown(local, ctx), "utf8"); // local-first: never lost

  const { wrap, err } = await enrich(ctx, local);
  const tail = err ? `\n<!-- AI enrichment failed: ${err.slice(0, 200)} -->\n` : "";
  fs.writeFileSync(file, renderWrapMarkdown(wrap, ctx) + tail, "utf8");
  writeCtxSidecar(file, ctx); // persist the capture so a later regenerate can re-enrich it (local-only)
  return { file, wrap, usedSource };
}

// The capture sidecar: <wrapId>.ctx.json next to the wrap .md (in .wrap-it-up/wrapups/, which is
// git-ignored). Lets a regenerate re-enrich the SAME capture (fast + drift-free) instead of re-scanning.
// Local-only; NEVER uploaded by telemetry.
function ctxSidecarPath(wrapFile: string): string {
  return wrapFile.replace(/\.md$/i, ".ctx.json");
}
function writeCtxSidecar(wrapFile: string, ctx: SessionContext): void {
  try { fs.writeFileSync(ctxSidecarPath(wrapFile), JSON.stringify(ctx), "utf8"); } catch { /* non-fatal */ }
}
function readCtxSidecar(wrapFile: string): SessionContext | null {
  try { return JSON.parse(fs.readFileSync(ctxSidecarPath(wrapFile), "utf8")) as SessionContext; } catch { return null; }
}

// A short steer derived from the feedback reason chip, injected as ctx.nudge on regenerate.
// note_fine_i_bounced / skip / unknown -> null (the note was fine; do NOT regenerate).
function nudgeForReason(reason: string): string | null {
  switch (reason) {
    case "wrong_files":
      return "The previous note focused on the wrong files or tasks. Re-read the changed files and reset the next step to the work actually in progress (grounded in the diff/artifacts), not what was merely discussed.";
    case "stale":
      return "The previous note is out of date with the current state. Re-ground the status and the next step strictly in the CURRENT on-disk / git state; drop anything no longer true.";
    case "couldnt_tell":
      return "The previous note was unclear or too vague. Be concrete: inline the exact error text, the file paths, and the next command. If status is genuinely ambiguous from the evidence, say so plainly rather than guessing.";
    default:
      return null;
  }
}

// Re-enrich a SPECIFIC wrap with a nudge, in place. Reuses the original capture (the sidecar) for
// wrong_files / couldn't_tell — fast + deterministic; re-captures fresh for "stale" (the note is out
// of date) or when no sidecar exists. Overwrites the same <wrapId>.md and rewrites the sidecar.
async function doRegenerate(
  folder: string,
  wrapId: string,
  reason: string
): Promise<{ ok: boolean; reason?: string; file?: string; wrapId?: string; wrap?: WrapUp }> {
  const nudge = nudgeForReason(reason);
  if (!nudge) return { ok: false, reason: "no-op (note was fine)" };
  const file = (wrapId && wrapFileById(folder, wrapId)) || latestWrap(folder);
  if (!file) return { ok: false, reason: "no wrap to regenerate" };

  // "stale" wants the freshest state -> re-capture; otherwise re-enrich the original capture.
  let ctx: SessionContext | null = reason === "stale" ? null : readCtxSidecar(file);
  if (!ctx) {
    const tr = findTranscript(folder);
    ctx = tr ? buildCtxFromTranscript(folder, tr) : buildCtx(folder);
  }
  ctx.nudge = nudge;

  const local = buildLocalWrap(ctx);
  const { wrap, err } = await enrich(ctx, local);
  const tail = err ? `\n<!-- AI enrichment failed: ${err.slice(0, 200)} -->\n` : "";
  fs.writeFileSync(file, renderWrapMarkdown(wrap, ctx) + tail, "utf8"); // overwrite in place
  writeCtxSidecar(file, ctx);
  appendRegeneration(folder, { ts: new Date().toISOString(), wrap_id: wrapIdFromFile(file), reason, nudge, title: wrap.title });
  return { ok: true, file, wrapId: wrapIdFromFile(file), wrap };
}

function latestWrap(folder: string): string | undefined {
  try {
    const dir = path.join(folder, ".wrap-it-up", "wrapups");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return files.length ? path.join(dir, files[files.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

// A wrap file looked up by its id (the ISO-timestamp basename). Used to fetch the PRIOR wrap's
// one-liner for the Clock-2 retrospective, and to pull triage context for a "didn't help".
function wrapFileById(folder: string, id: string): string | undefined {
  if (!id) return undefined;
  const f = path.join(folder, ".wrap-it-up", "wrapups", id + ".md");
  return fs.existsSync(f) ? f : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const grab = (md: string, re: RegExp): string | null => {
  const m = md.match(re);
  return m ? m[1].trim() : null;
};

// Pull the paste-ready next prompt out of a wrap's markdown (multi-line block up to the next ---,
// stripping the "> " quote; the "— (…)" placeholder means "no prompt"). Shared by resume + triage.
function extractNextPrompt(md: string): string | null {
  const block = md.match(/\*\*Suggested next AI prompt \(paste-ready\):\*\*\s*\n([\s\S]*?)\n\n---/);
  let p = block ? block[1].replace(/^>\s?/gm, "").trim() : "";
  if (/^—\s*\(/.test(p)) p = "";
  return p || null;
}

// Opt-in telemetry: the widget includes a `_telemetry` block ONLY when the developer has consented.
// Send the anonymized CURRENT state of one feedback row to the collector — read back by id so a
// Clock-2 patch is reflected (the server sees the re-entry outcome, not just the Clock-1 vote).
// Never throws; a missing block / no row / bad config is a silent no-op.
async function telemeter(folder: string, eventId: string, tconf: any): Promise<void> {
  if (!tconf || !eventId) return;
  const ev = readEventById(folder, eventId);
  if (!ev) return;
  try { await sendTelemetry(anonymize(ev, String(tconf.clientId || "")), tconf); } catch { /* never break feedback */ }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const ci = args.indexOf("--cwd");
  const folder = ci >= 0 && args[ci + 1] ? path.resolve(args[ci + 1]) : process.cwd();

  if (cmd === "wrap") {
    const si = args.indexOf("--source");
    const source = si >= 0 && args[si + 1] ? args[si + 1] : "claude-code";
    const { file, wrap, usedSource } = await doWrap(folder, source);
    const md = fs.readFileSync(file, "utf8");
    const nextMove = grab(md, /\*\*Suggested next move:\*\*\s*\n>\s*(.+)/) || wrap.suggestedNextAction;
    process.stdout.write(
      JSON.stringify({ ok: true, file, title: wrap.title, status: wrap.status, nextMove, source: usedSource }) + "\n"
    );
  } else if (cmd === "resume") {
    const file = latestWrap(folder);
    if (!file) {
      process.stdout.write(JSON.stringify({ ok: false, reason: "no wraps yet" }) + "\n");
      return;
    }
    const md = fs.readFileSync(file, "utf8");
    let nextPrompt = extractNextPrompt(md) || "";
    const title = grab(md, /^#\s+(.+)/m) || "your last session";
    const nextMove = grab(md, /\*\*Suggested next move:\*\*\s*\n>\s*(.+)/) || "";
    // "Where was I?" puts a paste-ready resume text on the clipboard. When the wrap has no
    // in-progress AI prompt (a clean stopping point), fall back to the next move so the button
    // NEVER leaves the clipboard untouched — which silently pastes stale, unrelated content.
    if (!nextPrompt && nextMove) nextPrompt = `Continue my last session — "${title}". Next step: ${nextMove}`;
    const wrapId = wrapIdFromFile(file);
    // Clock-2: on this re-entry, surface a faint retrospective for the PREVIOUS
    // note (passed by the widget as --prev). Only when it's a genuinely earlier wrap, so the card
    // never asks "did this land?" about the note it's opening right now.
    const pi = args.indexOf("--prev");
    const prevId = pi >= 0 && args[pi + 1] ? args[pi + 1] : "";
    let prev: { wrapId: string; title: string | null; nextMove: string | null } | null = null;
    if (prevId && prevId !== wrapId) {
      const pf = wrapFileById(folder, prevId);
      if (pf) {
        const pmd = fs.readFileSync(pf, "utf8");
        prev = {
          wrapId: prevId,
          title: grab(pmd, /^#\s+(.+)/m),
          nextMove: grab(pmd, /\*\*Suggested next move:\*\*\s*\n>\s*(.+)/),
        };
      }
    }
    process.stdout.write(
      JSON.stringify({ ok: true, file, wrapId, title, nextMove, nextPrompt, prev }) + "\n"
    );
  } else if (cmd === "feedback") {
    // `--report`: a one-screen, vote-based quality readout (no model call) for the beta go/no-go.
    if (args.includes("--report")) {
      const s = summarizeFeedback(folder);
      const pct = (x: number | null) => (x == null ? "—" : (x * 100).toFixed(0) + "%");
      process.stdout.write(
        [
          `Wrap It Up — feedback readout  (${folder})`,
          `  notes rated: ${s.n}   (responded ${s.responded}, no-vote ${s.noVote})`,
          `  "did it land?"   right-back-in ${pct(s.rightBackInRate)} (${s.rightBackIn}/${s.responded})  |  oriented ${s.oriented}  |  didn't-help ${s.didntHelp}`,
          `  re-entry (Clock-2): success ${pct(s.reentrySuccessRate)}  (yes ${s.reentryYes}, eventually ${s.reentryEventually}, no ${s.reentryDidntHelp}; of ${s.reentryAnswered} answered)`,
          `  regenerations: ${s.regenerations}  (${pct(s.regenRate)} of rated notes)`,
          `  top reasons: ${s.topReasons.map((t) => `${t.reason}×${t.count}`).join(", ") || "—"}`,
        ].join("\n") + "\n"
      );
      return;
    }
    // One JSON event on stdin (clean — no arg-quoting). `kind` discriminates the two clocks:
    //   "perceived" → append one feedback row (+ triage a "didn't help"); "reentry" → patch a prior row.
    let ev: any;
    try {
      ev = JSON.parse((await readStdin()).trim());
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, reason: "bad json" }) + "\n");
      return;
    }
    if (ev.kind === "reentry") {
      const ok = patchReentryOutcome(
        folder,
        String(ev.target_event_id || ""),
        ev.reentry_outcome,
        typeof ev.reentry_outcome_ts === "string" ? ev.reentry_outcome_ts : new Date().toISOString(),
        typeof ev.reentry_delay_sec === "number" ? ev.reentry_delay_sec : null
      );
      if (ok) await telemeter(folder, String(ev.target_event_id || ""), ev._telemetry); // Clock-2 update
      process.stdout.write(JSON.stringify({ ok }) + "\n");
      return;
    }
    const row = appendFeedbackEvent(folder, ev);
    // Triage every "didn't help": pull {wrap, score(null), files, next-move, next-prompt} into the
    // review queue — reading the failures is where note quality actually improves.
    if (row.perceived_useful === "didnt_help") {
      const wf = wrapFileById(folder, row.wrap_id);
      let files: string[] = [], nextMove: string | null = null, nextPrompt: string | null = null;
      if (wf) {
        const wmd = fs.readFileSync(wf, "utf8");
        const filesLine = grab(wmd, /\*\*Files:\*\*\s*(.+)/);
        files = filesLine ? filesLine.split(",").map((s) => s.trim()).filter(Boolean) : [];
        nextMove = grab(wmd, /\*\*Suggested next move:\*\*\s*\n>\s*(.+)/);
        nextPrompt = extractNextPrompt(wmd);
      }
      appendTriage(folder, {
        ts: new Date().toISOString(),
        wrap_id: row.wrap_id,
        wrs_score: null,
        reason_chip: row.reason_chip,
        files,
        next_move: nextMove,
        next_prompt: nextPrompt,
      });
    }
    await telemeter(folder, row.event_id, ev._telemetry); // Clock-1 vote (+ chip), if consented
    process.stdout.write(JSON.stringify({ ok: true, event_id: row.event_id }) + "\n");
  } else if (cmd === "regenerate") {
    // Chip-triggered "regenerate with a nudge": re-do a specific wrap, steered by the reason chip.
    const wi = args.indexOf("--wrap-id");
    const wrapId = wi >= 0 && args[wi + 1] ? args[wi + 1] : "";
    const ri = args.indexOf("--reason");
    const reason = ri >= 0 && args[ri + 1] ? args[ri + 1] : "";
    const res = await doRegenerate(folder, wrapId, reason);
    if (!res.ok || !res.file) {
      process.stdout.write(JSON.stringify({ ok: false, reason: res.reason || "regenerate failed" }) + "\n");
      return;
    }
    // Return the resume schema so the widget can silently swap the note + re-copy the new prompt.
    const md = fs.readFileSync(res.file, "utf8");
    let nextPrompt = extractNextPrompt(md) || "";
    const title = grab(md, /^#\s+(.+)/m) || (res.wrap && res.wrap.title) || "your last session";
    const nextMove = grab(md, /\*\*Suggested next move:\*\*\s*\n>\s*(.+)/) || "";
    if (!nextPrompt && nextMove) nextPrompt = `Continue my last session — "${title}". Next step: ${nextMove}`;
    process.stdout.write(
      JSON.stringify({ ok: true, file: res.file, wrapId: res.wrapId, title, status: res.wrap?.status, nextMove, nextPrompt }) + "\n"
    );
  } else {
    process.stderr.write("usage: cli.js wrap|resume|feedback|regenerate --cwd <folder>\n");
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(1);
});
