// VS Code extension entry point. Starts the recorder, registers the status-bar
// "Wrap this up" button + commands. Wrap flow is local-first: write the LOCAL
// context-only wrap FIRST (never lost), show success, THEN enrich with the LLM
// in place. On LLM failure the local wrap stays.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Recorder, readSessionSlice } from "./recorder";
import { reduceEvents, reconcileGitStatus } from "./core/reduce";
import { buildLocalWrap, renderWrapMarkdown } from "./core/wrap";
import { buildEnrichInput, applyEnrichmentObj, WRAP_TOOL } from "./core/enrich";
import { SessionContext, WrapUp, WrapEvent } from "./core/types";
import { redact } from "./core/redact";
import { callClaudeTool } from "./llm";

let recorder: Recorder | undefined;
let resumeStatus: vscode.StatusBarItem | undefined; // the "WHERE WAS I?" button (shown only while a wrap is unresumed)
let wrapping = false;                 // re-entrancy guard: ignore clicks while a wrap is in flight
let lastWrapSig: string | undefined;  // fingerprint of the last wrapped slice (no-change dedupe)

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return;

  const dir = path.join(folder, ".wrap-it-up");
  try { fs.mkdirSync(path.join(dir, "wrapups"), { recursive: true }); } catch { /* ignore */ }
  ensureGitignore(dir);
  const logPath = path.join(dir, "session.log.jsonl");

  const doRedact = () => vscode.workspace.getConfiguration("wrapItUp").get<boolean>("redactSecrets", true);
  recorder = new Recorder(folder, logPath, doRedact);
  recorder.start();
  context.subscriptions.push({ dispose: () => recorder?.dispose() });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(save) WRAP IT UP";
  status.tooltip = "Wrap It Up — save where you are so you can pick it back up";
  status.command = "wrapItUp.wrap";
  status.show();
  context.subscriptions.push(status);

  // "WHERE WAS I?" — the re-entry button. Sits left of WRAP IT UP and shows ONLY while
  // there's a wrap you haven't picked up yet (a pending re-entry marker on disk).
  resumeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  resumeStatus.text = "$(lightbulb) WHERE WAS I?";
  resumeStatus.command = "wrapItUp.resume";
  resumeStatus.backgroundColor = new vscode.ThemeColor("statusBarItem.prominentBackground");
  context.subscriptions.push(resumeStatus);
  refreshResume(folder);

  context.subscriptions.push(
    vscode.commands.registerCommand("wrapItUp.wrap", async () => {
      if (wrapping) return; // GUARD: a wrap (+ enrich) is already in flight — ignore the click
      const events = readSessionSlice(logPath);
      const sig = sliceSig(events);
      if (lastWrapSig !== undefined && sig === lastWrapSig) {
        // DEDUPE: nothing new since the last wrap — don't spawn a duplicate or re-spend on enrich.
        vscode.window.showInformationMessage("Wrap It Up: nothing new since your last wrap — it's still saved.");
        return;
      }
      wrapping = true;
      status.text = "$(sync~spin) Wrapping…";
      let savedFile: string | undefined;
      try {
        const { file, ctx, local } = writeLocalWrap(folder, events);
        lastWrapSig = sig;
        setPending(folder, file, collectPendingFiles(folder, ctx)); // arm "WHERE WAS I?"
        refreshResume(folder);
        status.text = "$(check) Wrapped up";
        await enrichInPlace(context, file, ctx, local, status);
        savedFile = file;
      } catch (err: any) {
        status.text = "$(warning) Wrap failed — retry";
        vscode.window.showErrorMessage("Wrap It Up: " + (err?.message || String(err)));
      } finally {
        wrapping = false;
        setTimeout(() => { if (!wrapping) status.text = "$(save) WRAP IT UP"; }, 6000);
      }
      // Confirm OUTSIDE the lock; don't auto-open (opening the .md bolts editor status items
      // onto the bar and crowds the WHERE WAS I? button — and you're heading OUT anyway).
      if (savedFile) {
        const choice = await vscode.window.showInformationMessage(
          "Wrapped up — your place is saved. 💡 WHERE WAS I? will be waiting when you come back.",
          "Open wrap",
        );
        if (choice === "Open wrap") {
          const doc = await vscode.workspace.openTextDocument(savedFile);
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      }
    }),
    vscode.commands.registerCommand("wrapItUp.setKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Wrap It Up — Claude API key",
        prompt: "Paste your Anthropic API key. Stored in VS Code secret storage, never written to a file.",
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store("wrapItUp.anthropicKey", key.trim());
        vscode.window.showInformationMessage("Wrap It Up: Claude API key saved.");
      }
    }),
    vscode.commands.registerCommand("wrapItUp.showLast", async () => {
      const latest = readLatestWrap(folder);
      if (!latest) { vscode.window.showInformationMessage("Wrap It Up: no wraps yet — click WRAP IT UP to make one."); return; }
      const doc = await vscode.workspace.openTextDocument(latest.file);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("wrapItUp.copyNextPrompt", () => copyNextPrompt(folder)),
    vscode.commands.registerCommand("wrapItUp.listWraps", async () => {
      const items = listWraps(folder);
      if (!items.length) { vscode.window.showInformationMessage("Wrap It Up: no wraps yet."); return; }
      const pick = await vscode.window.showQuickPick(items, { title: "Wrap It Up — recent wraps", placeHolder: "Open a past wrap-up" });
      if (pick) { const doc = await vscode.workspace.openTextDocument(pick.file); await vscode.window.showTextDocument(doc, { preview: true }); }
    }),
    vscode.commands.registerCommand("wrapItUp.resume", () => resumeFlow(folder)),
  );
}

// Fingerprint of a captured session slice — lets a re-wrap skip when nothing changed.
function sliceSig(events: WrapEvent[]): string {
  const n = events.length;
  return `${n}:${n ? events[n - 1].t : 0}`;
}

function writeLocalWrap(folder: string, events: WrapEvent[]): { file: string; ctx: SessionContext; local: WrapUp } {
  const git = readGit(folder);
  const derived = reconcileGitStatus(reduceEvents(events), git);
  const dirtyBuffers = vscode.workspace.textDocuments
    .filter((d) => d.isDirty && d.uri.scheme === "file")
    .slice(0, 12)
    .map((d) => ({ uri: path.relative(folder, d.uri.fsPath), text: redact(d.getText()).slice(0, 4000) }));
  const changedFileContents = readChangedContents(folder, [...new Set([...derived.created, ...derived.touched])]);
  const times = events.map((e) => e.t);
  const ctx: SessionContext = {
    events, derived, git,
    workspaceName: path.basename(folder),
    dirtyBuffers,
    changedFileContents,
    span: { start: times[0] || Date.now(), end: times[times.length - 1] || Date.now() },
  };
  const local = buildLocalWrap(ctx);
  const file = path.join(folder, ".wrap-it-up", "wrapups", new Date().toISOString().replace(/[:.]/g, "-") + ".md");
  fs.writeFileSync(file, renderWrapMarkdown(local, ctx), "utf8"); // never lost
  return { file, ctx, local };
}

async function enrichInPlace(
  context: vscode.ExtensionContext, file: string, ctx: SessionContext, local: WrapUp, status: vscode.StatusBarItem,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("wrapItUp");
  if (!cfg.get<boolean>("enableLLM", true)) return;
  const key = await getApiKey(context);
  if (!key) {
    vscode.window.showInformationMessage("Wrap It Up: saved locally. Run “Wrap It Up: Set Claude API key” to enable AI summaries.");
    return;
  }
  status.text = "$(sync~spin) Wrapping… (AI)";
  try {
    const { system, user } = buildEnrichInput(ctx, local);
    const model = cfg.get<string>("model", "claude-sonnet-4-6");
    const obj = await callClaudeTool(key, model, system, user, WRAP_TOOL);
    const enriched = applyEnrichmentObj(local, obj);
    fs.writeFileSync(file, renderWrapMarkdown(enriched, ctx), "utf8");
    status.text = "$(check) Wrapped up";
  } catch (err: any) {
    const failed: WrapUp = { ...local, enrichment: "failed" };
    fs.writeFileSync(file, renderWrapMarkdown(failed, ctx) + `\n<!-- AI enrichment failed: ${String(err?.message || err).slice(0, 200)} -->\n`, "utf8");
    status.text = "$(warning) Saved locally — AI enrichment failed";
  }
}

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  return (await context.secrets.get("wrapItUp.anthropicKey"))?.trim();
}

// Read on-disk contents of files changed this session (redacted, capped) so the
// LLM can ground "what works/broke" even with no git diff and no diagnostics.
function readChangedContents(folder: string, relPaths: string[]): { uri: string; text: string }[] {
  const out: { uri: string; text: string }[] = [];
  for (const rel of relPaths.slice(0, 6)) {
    try {
      const full = path.join(folder, rel);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 200_000) continue; // skip dirs / huge files
      out.push({ uri: rel, text: redact(fs.readFileSync(full, "utf8")).slice(0, 6000) });
    } catch { /* deleted or unreadable — skip */ }
  }
  return out;
}

function readGit(folder: string): SessionContext["git"] {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: folder }).toString().trim();
    const diff = execSync("git diff HEAD", { cwd: folder, maxBuffer: 10 * 1024 * 1024 }).toString();
    const changedFiles = execSync("git diff --name-only HEAD", { cwd: folder }).toString().split("\n").filter(Boolean);
    // Authoritative "tracked at HEAD" set so reconcileGitStatus can tell a genuinely-new
    // file from one that already existed/was committed (vs HEAD). See reduce.ts.
    const committedFiles = execSync("git ls-files", { cwd: folder, maxBuffer: 10 * 1024 * 1024 }).toString().split("\n").filter(Boolean);
    return { branch, diffVsHead: redact(diff), changedFiles, committedFiles };
  } catch { return undefined; }
}

function ensureGitignore(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n", "utf8");
  } catch { /* ignore */ }
}

// ---- UX v1: resume surfacing ("Last wrap: … Next: …") ----

interface ParsedWrap { title: string; status: string; nextMove: string; nextPrompt: string | null; }

function parseWrap(text: string): ParsedWrap {
  const m1 = text.match(/^# (.+)$/m);
  const m2 = text.match(/^status:\s*(.+)$/m);
  const grab = (re: RegExp): string => {
    const m = text.match(re);
    const v = m && m[1] ? m[1].trim() : "";
    return v && !v.startsWith("— (no in-progress") ? v : "";
  };
  const nextMove = grab(/\*\*Suggested next move:\*\*\s*\n>\s*(.+)/) || "Continue where you left off.";
  const nextPrompt = grab(/\*\*Suggested next AI prompt \(paste-ready\):\*\*\s*\n>\s*(.+)/);
  return {
    title: m1 ? m1[1].trim() : "Untitled session",
    status: m2 ? m2[1].trim() : "Unknown",
    nextMove,
    nextPrompt: nextPrompt || null,
  };
}

function wrapsDir(folder: string): string { return path.join(folder, ".wrap-it-up", "wrapups"); }

function wrapFiles(folder: string): string[] {
  try { return fs.readdirSync(wrapsDir(folder)).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
}

// ISO-timestamp filenames sort chronologically, so the last one is the newest.
function readLatestWrap(folder: string): { file: string; parsed: ParsedWrap } | undefined {
  const files = wrapFiles(folder);
  if (!files.length) return undefined;
  const file = path.join(wrapsDir(folder), files[files.length - 1]);
  try { return { file, parsed: parseWrap(fs.readFileSync(file, "utf8")) }; } catch { return undefined; }
}

function listWraps(folder: string): { label: string; description: string; file: string }[] {
  return wrapFiles(folder).reverse().slice(0, 30).map((f) => {
    const file = path.join(wrapsDir(folder), f);
    let p: ParsedWrap;
    try { p = parseWrap(fs.readFileSync(file, "utf8")); } catch { p = { title: f, status: "?", nextMove: "", nextPrompt: null }; }
    return { label: p.title, description: `${p.status} · ${f.replace(/\.md$/, "")}`, file };
  });
}

async function copyNextPrompt(folder: string): Promise<void> {
  const latest = readLatestWrap(folder);
  if (!latest) { vscode.window.showInformationMessage("Wrap It Up: no wrap found yet."); return; }
  await vscode.env.clipboard.writeText(latest.parsed.nextPrompt || latest.parsed.nextMove);
  vscode.window.showInformationMessage("Wrap It Up: next prompt copied — paste it to your AI to pick up where you left off.");
}

// ---- "WHERE WAS I?" re-entry state (the pending marker) ----
// The marker = a wrap you have not picked up yet. It is set when you wrap, and clears
// ONLY by a deliberate act: you pick it up (a), you wrap again (c, supersedes), or you
// explicitly hide it (d). It is intentionally NOT cleared by editing files — clearing on
// activity would reintroduce the "what counts as an edit?" guessing we set out to avoid,
// and a wrong guess silently drops your safety net at the worst moment. Clear on intent,
// not on activity.

interface Pending { wrapFile: string; files: string[]; }

function pendingPath(folder: string): string { return path.join(folder, ".wrap-it-up", "pending.json"); }

function readPending(folder: string): Pending | undefined {
  try {
    const p = JSON.parse(fs.readFileSync(pendingPath(folder), "utf8"));
    if (p && typeof p.wrapFile === "string" && fs.existsSync(p.wrapFile)) {
      return { wrapFile: p.wrapFile, files: Array.isArray(p.files) ? p.files : [] };
    }
  } catch { /* none */ }
  return undefined;
}

function setPending(folder: string, wrapFile: string, files: string[]): void {
  try { fs.writeFileSync(pendingPath(folder), JSON.stringify({ wrapFile, files }), "utf8"); } catch { /* ignore */ }
}

function clearPending(folder: string): void {
  try { fs.rmSync(pendingPath(folder), { force: true }); } catch { /* ignore */ }
}

function refreshResume(folder: string): void {
  if (!resumeStatus) return;
  const on = vscode.workspace.getConfiguration("wrapItUp").get<boolean>("showResumeButton", true);
  const pend = on ? readPending(folder) : undefined;
  if (pend) {
    let title = "your last session";
    try { title = parseWrap(fs.readFileSync(pend.wrapFile, "utf8")).title; } catch { /* ignore */ }
    resumeStatus.tooltip = `Pick up where you left off — “${title}”`;
    resumeStatus.show();
  } else {
    resumeStatus.hide();
  }
}

function collectPendingFiles(folder: string, ctx: SessionContext): string[] {
  const rels = new Set<string>();
  for (const f of ctx.changedFileContents) rels.add(f.uri);
  for (const u of ctx.derived.touched) rels.add(u);
  for (const u of ctx.derived.created) rels.add(u);
  return [...rels].map((r) => (path.isAbsolute(r) ? r : path.join(folder, r)));
}

// The "WHERE WAS I?" action: a single deliberate click that puts you back where you
// were — reopen the files this wrap recorded, then surface the wrap itself (the
// orientation note) as the active editor. No menu: a QuickPick is rendered with the
// SAME widget as the Command Palette (a search box + list), so it reads as "search for
// a command" and people stall on it. One click → it just does the re-entry.
async function resumeFlow(folder: string): Promise<void> {
  const pend = readPending(folder);
  const wrapFile = pend?.wrapFile || readLatestWrap(folder)?.file;
  if (!wrapFile) { vscode.window.showInformationMessage("Wrap It Up: nothing to pick up yet."); return; }
  const parsed = parseWrap(fs.readFileSync(wrapFile, "utf8"));

  // Reopen recorded files first (kept in the background), then open the wrap LAST so it
  // lands as the focused editor — that's the doc that tells you what to do next.
  let reopened = 0;
  for (const f of (pend?.files || []).slice(0, 8)) {
    try { const doc = await vscode.workspace.openTextDocument(f); await vscode.window.showTextDocument(doc, { preview: false }); reopened++; } catch { /* gone — skip */ }
  }
  try {
    const doc = await vscode.workspace.openTextDocument(wrapFile);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch { /* wrap unreadable — still report below */ }

  clearPending(folder); // clicking WHERE WAS I? is the deliberate "I've re-entered" act
  refreshResume(folder);

  const opened = reopened ? `reopened ${reopened} file${reopened === 1 ? "" : "s"} — ` : "";
  // The toast is what people actually act on, so show the FULL next step (no clipping to a
  // useless "…") and offer one-click copy of the full move / paste-ready prompt. Truncating
  // here also breaks copy: the text is clipped before VS Code ever sees it, so copying the
  // notification only ever yields the "…" stub.
  const actions = parsed.nextPrompt ? ["Copy next step", "Copy AI prompt"] : ["Copy next step"];
  const choice = await vscode.window.showInformationMessage(`Welcome back — ${opened}Next: ${parsed.nextMove}`, ...actions);
  if (choice === "Copy next step") await vscode.env.clipboard.writeText(parsed.nextMove);
  else if (choice === "Copy AI prompt" && parsed.nextPrompt) await vscode.env.clipboard.writeText(parsed.nextPrompt);
}

export function deactivate(): void { recorder?.dispose(); }
