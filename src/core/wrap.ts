// Build the LOCAL, context-only wrap-up (no LLM yet).
// Deterministic and grounded ONLY in `derived`. The LLM enrich step replaces
// these fields in place later.
// No vscode import.

import { SessionContext, WrapUp, Status, Derived } from "./types";
import { clip, redact } from "./redact";
import { MARKER_DENSE_BASENAME } from "./scanDocs";

const base = (uri: string) => uri.split(/[\\/]/).pop() || uri;
const lastLine = (s: string) => (s || "").split("\n").filter((l) => l.trim()).pop() || "";

// AI/agent & editor CLIs whose failures are almost always incidental environment noise
// (a crashed assistant invocation, a permissions hiccup) — NOT the developer's task. A
// crash of one of these must not become the next step; that would be "activity, not
// intent", the exact thing this tool exists to avoid. They still count as captured
// evidence elsewhere (status / "what broke"); we only refuse to ANCHOR the next step on them.
const AGENT_CLI = /^(claude|gemini|kiro|cursor|copilot|aider|codex|cody|continue|ollama|llm)\b/i;
const isAgentCmd = (cmd: string) => AGENT_CLI.test((cmd || "").trim());

export function buildLocalWrap(ctx: SessionContext): WrapUp {
  const d = ctx.derived;
  const top = d.hotFiles.map((h) => base(h.uri));
  const status = pickStatus(d);

  const whatChanged: string[] = [];
  if (top.length) whatChanged.push(`Edited: ${top.slice(0, 6).join(", ")}${top.length > 6 ? ` (+${top.length - 6} more)` : ""}`);
  if (d.created.length) whatChanged.push(`Created: ${d.created.map(base).join(", ")}`);
  if (d.touched.length) whatChanged.push(`Changed on disk: ${d.touched.map(base).join(", ")}`);
  if (d.deleted.length) whatChanged.push(`Deleted: ${d.deleted.map(base).join(", ")}`);
  if (d.deadEnds.length) whatChanged.push(`Dead ends (created then deleted): ${d.deadEnds.map((x) => base(x.uri)).join(", ")}`);
  if (ctx.git?.changedFiles?.length) whatChanged.push(`Git changed: ${ctx.git.changedFiles.slice(0, 8).join(", ")}`);

  const whatWorks: string[] = [];
  for (const f of d.fixedSignals) whatWorks.push(`${base(f.uri)} — ${f.clearedErrors} error(s) cleared this session`);
  const recoveredSet = new Set(d.recoveredRuns.map((r) => r.cmd));
  for (const r of d.recoveredRuns) whatWorks.push(`\`${r.cmd}\` was failing earlier and now passes (fixed this session)`);
  for (const r of d.passedRuns.slice(0, 5)) if (!recoveredSet.has(r.cmd)) whatWorks.push(`\`${r.cmd}\` passed`);

  const whatBroke: string[] = [];
  for (const b of d.brokenSignals) whatBroke.push(`${base(b.uri)} — ${b.openErrors} open error(s)${b.topMessages?.[0] ? `: ${redact(b.topMessages[0]).slice(0, 160)}` : ""}`);
  for (const r of d.failedRuns.slice(0, 5)) whatBroke.push(`\`${r.cmd}\` failed (exit ${r.exitCode})${r.outTail ? `: ${redact(lastLine(r.outTail)).slice(0, 160)}` : ""}`);

  const { nextAction, nextPrompt } = nextSteps(ctx, d, top);

  const wrap: WrapUp = {
    schemaVersion: 1,
    source: "wrap-it-up-recorder",
    title: makeTitle(ctx, d, top),
    status,
    summary: makeSummary(ctx, d, top),
    whatChanged: whatChanged.length ? whatChanged : ["(nothing meaningful captured this session)"],
    whatWorks,
    whatBroke,
    suggestedNextAction: nextAction,
    suggestedNextPrompt: nextPrompt,
    suggestedCommitMessage: `wip: ${top.slice(0, 3).join(", ") || "session changes"}`,
    capturedContext: {
      branch: ctx.git?.branch,
      changedFiles: ctx.git?.changedFiles?.length ? ctx.git.changedFiles : [...new Set([...top, ...d.created.map(base), ...d.touched.map(base)])],
      runOutput: [
        ...d.passedRuns.map((r) => `PASS  ${r.cmd}`),
        ...d.failedRuns.map((r) => `FAIL  ${r.cmd} (exit ${r.exitCode})`),
      ],
    },
    enrichment: "pending",
  };

  // WRITING MODE (additive). Only when the broker opted in (ctx.docStructure set) AND the coding
  // signal cluster is empty: override the prose-relevant fields from the deterministic doc-structure
  // scan. The codingEmpty guard is the single invariant that keeps every coding wrap byte-identical.
  if (ctx.docStructure && codingEmpty(d)) return applyWritingLocal(ctx, wrap);
  return wrap;
}

function codingEmpty(d: Derived): boolean {
  return !d.brokenSignals.length && !d.failedRuns.length && !d.passedRuns.length
    && !d.fixedSignals.length && !d.recoveredRuns.length;
}

// Produce the prose-grounded wrap from the doc-structure scan. Pure; enrich.writing re-words
// these later. Status is scan-cleanliness (drafted vs unwritten), NEVER a quality judgment.
function applyWritingLocal(ctx: SessionContext, w: WrapUp): WrapUp {
  const ds = ctx.docStructure!;
  const d = ctx.derived;
  const changed = [...new Set([...d.created.map(base), ...d.touched.map(base), ...d.hotFiles.map((h) => base(h.uri))])];
  const primary = ds.coverage[0] ? base(ds.coverage[0].uri) : (changed[0] || ctx.workspaceName);

  // Marker-dense files (TODO.md / ROADMAP.md / …) are parked-by-design: still LISTED, but they
  // must not drive the status downgrade.
  const dense = (uri: string) => MARKER_DENSE_BASENAME.test(base(uri));
  const downEmpty = ds.emptyHeadings.filter((e) => !dense(e.uri));
  const downThreads = ds.openThreads.filter((t) => !dense(t.uri));

  const totalSections = ds.coverage.reduce((a, c) => a + c.total, 0);
  const draftedSections = ds.coverage.reduce((a, c) => a + c.drafted, 0);
  const addedHeadings = new Set(ds.prose.flatMap((p) => p.addedHeadings.map((s) => s.toLowerCase())));

  // A LONE marker informs the list but does NOT flip the badge — need an empty *heading*
  // (structural, low false-positive) or >= 2 markers to downgrade from Working.
  let status: Status;
  if (!totalSections && !ds.openThreads.length) status = "Unknown";
  else if (draftedSections > 0 && !downEmpty.length && downThreads.length < 2) status = "Working";
  else if (totalSections > 0 && draftedSections === 0) status = "Broken";
  else status = "Partially working";

  const whatChanged: string[] = [];
  for (const p of ds.prose) {
    const parts: string[] = [];
    if (p.addedHeadings.length) parts.push(`added ${p.addedHeadings.length} section(s): ${p.addedHeadings.slice(0, 4).join(", ")}`);
    if (p.addedWords) parts.push(`+${p.addedWords} words`);
    if (p.removedWords) parts.push(`-${p.removedWords} words`);
    if (parts.length) whatChanged.push(`${base(p.uri)}: ${parts.join(", ")}`);
  }
  if (!whatChanged.length && changed.length) whatChanged.push(`Edited: ${changed.slice(0, 6).join(", ")}`);
  if (d.created.length) whatChanged.push(`Created: ${d.created.map(base).join(", ")}`);

  const threadSections = new Set(ds.openThreads.map((t) => (t.section || "").toLowerCase()));
  const whatWorks: string[] = [];
  for (const c of ds.coverage) {
    const solid = c.sections.filter((s) => s.words >= 12 && !threadSections.has(s.section.toLowerCase()));
    if (solid.length) whatWorks.push(`${base(c.uri)}: ${solid.length} section(s) drafted, no open markers — not reviewed for correctness`);
  }

  const whatBroke: string[] = [];
  for (const e of ds.emptyHeadings.slice(0, 8)) whatBroke.push(`${base(e.uri)} — "${e.section}" is ${e.kind === "empty" ? "an empty heading (no body)" : `thin (${e.words} words)`}`);
  for (const t of ds.openThreads.slice(0, 8)) whatBroke.push(`${base(t.uri)}:${t.line} — open marker "${t.marker}"${t.section ? ` in "${t.section}"` : ""}: ${t.excerpt}`);
  if (!whatBroke.length) whatBroke.push("No empty sections or open-work markers detected (not reviewed for correctness).");

  // Prefer a stub the diff TOUCHED this session (session-scope), else first empty heading, else marker.
  const freshEmpty = ds.emptyHeadings.find((e) => addedHeadings.has(e.section.toLowerCase())) || downEmpty[0] || ds.emptyHeadings[0];
  const freshThread = downThreads[0] || ds.openThreads[0];
  let nextAction: string;
  let nextPrompt: string | null;
  if (freshEmpty) {
    nextAction = `Fill in the ${freshEmpty.kind === "empty" ? "empty" : "thin"} "${freshEmpty.section}" section in ${base(freshEmpty.uri)}.`;
    nextPrompt = `In ${base(freshEmpty.uri)}, the "${freshEmpty.section}" section is ${freshEmpty.kind === "empty" ? "an empty heading with no body" : `only ${freshEmpty.words} words`}. Draft it. Do not rewrite sections that are already drafted.`;
  } else if (freshThread) {
    nextAction = `Resolve the open marker in ${base(freshThread.uri)}${freshThread.section ? ` ("${freshThread.section}")` : ""}: ${freshThread.excerpt}`;
    nextPrompt = `In ${base(freshThread.uri)}${freshThread.section ? `, section "${freshThread.section}"` : ""} there is an open marker at line ${freshThread.line}: ${freshThread.excerpt}. Resolve it. Leave finished sections unchanged.`;
  } else {
    nextAction = `Review ${primary} and continue the draft.`;
    nextPrompt = null;
  }

  const addedWords = ds.prose.reduce((a, p) => a + p.addedWords, 0);
  const removedWords = ds.prose.reduce((a, p) => a + p.removedWords, 0);
  const summary: string[] = [];
  summary.push(`${draftedSections}/${totalSections} section(s) drafted across ${ds.coverage.length} document(s).`);
  if (ds.emptyHeadings.length || ds.openThreads.length) summary.push(`${ds.emptyHeadings.length} empty/thin heading(s), ${ds.openThreads.length} open marker(s).`);
  if (addedWords || removedWords) summary.push(`+${addedWords}/-${removedWords} words this session.`);
  summary.push(`(Writing-mode wrap — doc-structure scan; not reviewed for correctness.)`);

  const title = freshEmpty || ds.coverage.some((c) => c.drafted < c.total) ? `Drafting ${primary}` : `Revising ${primary}`;

  return {
    ...w,
    title,
    status,
    summary: summary.join(" "),
    whatChanged: whatChanged.length ? whatChanged : w.whatChanged,
    whatWorks,
    whatBroke,
    suggestedNextAction: nextAction,
    suggestedNextPrompt: nextPrompt,
    suggestedCommitMessage: `draft: ${changed.slice(0, 3).join(", ") || primary}`,
  };
}

function pickStatus(d: Derived): Status {
  // Don't let an incidental agent/tool-CLI crash (claude/gemini/…) color the verdict —
  // same "activity, not intent" guard as nextSteps(). The crash is still recorded under
  // "what broke" as honest evidence; it just doesn't flip the status badge to Broken.
  const realFailedRuns = d.failedRuns.filter((r) => !isAgentCmd(r.cmd));
  const broke = d.brokenSignals.length > 0 || realFailedRuns.length > 0;
  const good = d.passedRuns.length > 0 || d.fixedSignals.length > 0;
  if (broke && good) return "Partially working";
  if (broke) return "Broken";
  if (good) return "Working";
  return "Unknown";
}

function makeTitle(ctx: SessionContext, d: Derived, top: string[]): string {
  if (d.brokenSignals.length) return `Debugging ${base(d.brokenSignals[0].uri)}`;
  if (top.length) return `Working on ${top[0]}`;
  const changed = [...d.created, ...d.touched];
  if (changed.length) return `Working on ${base(changed[0])}`;
  return `Session in ${ctx.workspaceName}`;
}

function makeSummary(ctx: SessionContext, d: Derived, top: string[]): string {
  const fixed = d.fixedSignals.reduce((a, f) => a + f.clearedErrors, 0);
  const open = d.brokenSignals.reduce((a, b) => a + b.openErrors, 0);
  const parts: string[] = [];
  const diskChanged = d.created.length + d.touched.length;
  if (top.length) parts.push(`${top.length} file(s) edited (top: ${top.slice(0, 3).join(", ")}), ${d.saves} save(s).`);
  else if (diskChanged) parts.push(`${diskChanged} file(s) changed on disk${d.created.length ? ` (${d.created.length} new)` : ""}.`);
  else parts.push(`No file edits or disk changes were captured.`);
  if (fixed || open) parts.push(`${fixed} error(s) cleared, ${open} still open.`);
  if (d.passedRuns.length || d.failedRuns.length) parts.push(`${d.passedRuns.length} run(s) passed, ${d.failedRuns.length} failed.`);
  if (d.recoveredRuns.length) parts.push(`Fixed ${d.recoveredRuns.length} previously-failing command(s).`);
  if (d.debuggedActive) parts.push(`A debug session ran.`);
  if (d.deadEnds.length) parts.push(`${d.deadEnds.length} dead-end file(s).`);
  parts.push(`(Recorder wrap — editor events only; it did not read your AI chat.)`);
  return parts.join(" ");
}

function nextSteps(ctx: SessionContext, d: Derived, top: string[]): { nextAction: string; nextPrompt: string | null } {
  const realFailures = d.failedRuns.filter((r) => !isAgentCmd(r.cmd));
  if (realFailures.length) {
    const r = realFailures[0];
    const line = redact(lastLine(r.outTail));
    return {
      nextAction: `Re-run \`${r.cmd}\` and fix the failure${line ? `: ${line.slice(0, 160)}` : ""}.`,
      nextPrompt: `\`${r.cmd}\` is failing with exit ${r.exitCode}${line ? `: "${clip(line, 200, 0)}"` : ""}. ${top.length ? `The active files this session were ${top.slice(0, 3).join(", ")}. ` : ""}Find the cause and fix it, then re-run \`${r.cmd}\` to confirm it passes. Don't change unrelated passing code.`,
    };
  }
  if (d.brokenSignals.length) {
    const b = d.brokenSignals[0];
    const f = base(b.uri);
    const msg = redact(b.topMessages?.[0] || "");
    return {
      nextAction: `Open ${f} and clear the ${b.openErrors} remaining error(s)${msg ? `: ${msg.slice(0, 140)}` : ""}.`,
      nextPrompt: `${f} has ${b.openErrors} unresolved error(s)${msg ? `: "${msg.slice(0, 200)}"` : ""}. Open it, fix the error(s), and confirm the language server reports zero problems. Leave the rest of the file as-is.`,
    };
  }
  if (top.length) {
    return { nextAction: `Continue in ${top[0]} (the most-edited file this session).`, nextPrompt: null };
  }
  const changed = [...d.created, ...d.touched].map(base);
  if (changed.length) {
    return {
      nextAction: `Review the changed file(s): ${changed.slice(0, 4).join(", ")}, and continue.`,
      nextPrompt: `These files changed this session: ${changed.slice(0, 8).join(", ")}. Open them, confirm they work as intended, and continue the in-progress work.`,
    };
  }
  return { nextAction: "Nothing in progress to resume from this session.", nextPrompt: null };
}

export function renderWrapMarkdown(w: WrapUp, ctx: SessionContext): string {
  const fmt = (ms: number) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "?");
  const li = (arr: string[]) => (arr.length ? arr.map((x) => `- ${x}`).join("\n") : "- —");
  const chatAware = !!(ctx.conversation && ctx.conversation.length);
  return `---
schemaVersion: 1
source: wrap-it-up-recorder
status: ${w.status}
enrichment: ${w.enrichment}
branch: ${w.capturedContext.branch || "(no git)"}
span: ${fmt(ctx.span.start)} -> ${fmt(ctx.span.end)}
---

# ${w.title}

## ▶ Here is where to restart

**Suggested next move:**
> ${w.suggestedNextAction}

**Suggested next AI prompt (paste-ready):**
> ${w.suggestedNextPrompt || (w.enrichment === "complete" ? "— (no specific resume prompt — a clean stopping point; 'Where was I?' copies the next move instead)" : "— (no in-progress prompt yet; AI enrichment will fill this in)")}

---

## Summary
${w.summary}

## What changed
${li(w.whatChanged)}

## Current status
**${w.status}**

## What works
${li(w.whatWorks)}

## What is broken or uncertain
${li(w.whatBroke)}

## Captured context
- **Branch:** ${w.capturedContext.branch || "(no git)"}  •  **Files:** ${w.capturedContext.changedFiles.join(", ") || "—"}
- **Run/test output:** ${w.capturedContext.runOutput.length ? "\n" + w.capturedContext.runOutput.map((r) => "  - " + r).join("\n") : "none (none captured this session)"}

## Suggested commit message *(draft only — not committed)*
> ${w.suggestedCommitMessage}

---
${chatAware
  ? `*Chat-aware wrap — distilled from your AI session: the conversation (intent) + tool runs + git diff. enrichment: ${w.enrichment}.*`
  : `*Recorder wrap — editor events only (no AI chat). enrichment: ${w.enrichment}.*`}
`;
}
