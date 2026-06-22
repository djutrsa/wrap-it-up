// Chat-aware enrichment (the chat-AWARE counterpart of enrich.ts): the recorder reads
// the AI session transcript, so the prompt uses the conversation for INTENT and the
// tool runs + git diff for TRUTH.

// LLM enrichment. Pure core — no vscode, no
// network. buildEnrichInput() assembles the grounded prompt; applyEnrichment()
// merges the model's JSON back onto the local wrap. The transport (Anthropic
// call) is injected by the adapter so the core stays portable/testable.

import { SessionContext, WrapUp, Status } from "./types";
import { clip, redact } from "./redact";
import { selectConversationDigest, renderConvoDigest } from "./conversation";

const STATUSES: Status[] = ["Working", "Partially working", "Broken", "Unknown"];
const base = (u: string) => u.split(/[\\/]/).pop() || u;

const SYSTEM = `You are the distillation engine for "Wrap It Up". You turn a developer's CAPTURED CODING SESSION — their AI CHAT (the conversation with their coding assistant), plus the tool runs, git diff, and changed files — into a short, trustworthy re-entry briefing they read when returning to abandoned work.

You CAN see the developer's AI chat. It is provided already DISTILLED to its highest-signal parts: the original goal, the latest developer messages, and the assistant's last narration. Use the chat for INTENT (what they were trying to do); use the tool runs + diff + files for what ACTUALLY HAPPENED. Hard rules:
1. GROUND every claim. INTENT comes from the chat (what the developer asked for, the plan they agreed to). TRUTH comes from artifacts (a passed/failed run, an error that appeared or cleared, a diff hunk, on-disk file contents). When the chat and the artifacts CONFLICT, trust the artifacts: something discussed but absent from the diff/results was NOT actually done — say so plainly. Never invent a goal or root cause beyond what the chat + artifacts support; an honest "unclear" beats a confident guess.
2. "suggestedNextAIPrompt" must be SELF-CONTAINED so a fresh AI agent with no memory of this session could act on it: give ONE concrete next move, inline the real error text and file paths, name the file to start in, add a guardrail ("don't break X which is passing"). No "see above", no tool/IDE names, no secrets. Anchor it on the developer's IN-PROGRESS thread — their most recent stated goal or the assistant's last unfinished step — NOT on whatever was discussed first or longest. If the session reached a genuinely clean stopping point, set it to null.
3. GIT STATE: the diff is taken vs HEAD, so it shows UNCOMMITTED working-tree changes. NEVER claim a file is "committed" (you cannot see commit history). A diff entry with a previous (a/) version is a MODIFICATION of an already-existing file; "new file mode" is genuinely new. Only call a file "created" when it is new this session — a modified existing file is a change, not a creation. The "Files created" / "Files changed" lists below are already reconciled against git; trust them over your own reading of the diff.
4. Calm, plain language. No hype, no shame, no productivity-speak.
5. DEFERRED-WORK GUARDRAIL: if the chat, the captured diff, or file contents contain an explicit POSTPONEMENT marker — TODO, FIXME, HACK, or the phrases "fix later", "temporarily", "for now", "next sprint" — that sits on or directly references the SAME error or failing test that is still open, treat that failure as a KNOWN, INTENTIONALLY-PARKED state, not an accidental bug. Frame the next move as RESUMING the work the developer chose to defer, not as discovering and fixing a fresh mistake. This requires a genuine postponement token: a bare "// BUG" or a comment that merely describes a present defect does NOT qualify — that is a real bug to fix now, so do not soft-pedal it.
6. CONFIG ALTITUDE: when build/config scaffolding (tsconfig flags, library or runtime versions, package.json setup) is merely incidental setup and NOT what the session was about, keep it in the background — do not spend the summary or the next action narrating it. BUT when that config IS the session's actual subject, or is part of a failure→fix arc (a config change that cleared or caused a build/test error), it is first-class evidence — surface it plainly. Decide which case you are in from what the chat, the open errors, command runs, and most-edited files point at.
7. ABSENCE OF A CAPTURED RUN IS NOT EVIDENCE OF ABSENCE. The captured command output is INCOMPLETE — commands often run outside the captured terminal (an external shell, a CI job). So a missing run does NOT mean the action never happened. Never assert that something "was not run", "did not complete", or "was not verified" merely because you see no captured run for it. Treat ON-DISK CHANGES as first-class evidence that work occurred: new or modified files, and generated build/test/result artifacts, mean the action that produces them most likely ran. Ground status in those, or hedge ("appears to have run; the results file shows …") — never "it did not run" when the artifacts say otherwise.
8. DISTILL THE RIGHT THREAD. A session often wanders across several sub-tasks; identify the one that was actually IN PROGRESS at the END (the most recent unfinished goal in the chat), not whatever was discussed first or longest, and point the next move at THAT. A failing invocation of the AI/agent tooling itself (claude, gemini, cursor, aider, kiro) is almost always incidental environment noise, NOT the task — never make "fix that command" the next step unless the chat shows that tool IS the subject of the session.
9. REVISION REQUEST: if the SESSION EVIDENCE begins with a "REVISION REQUEST" line, the developer found a PRIOR version of this note unhelpful for the reason it gives. Produce a BETTER note that directly addresses that reason — but every rule above STILL applies: stay grounded in the chat + artifacts, never invent, and an honest "Unknown" still beats a confident guess.

Output ONLY a JSON object (no prose, no code fences) with exactly these keys:
{"title": string, "status": "Working"|"Partially working"|"Broken"|"Unknown", "summary": string, "whatChanged": string[], "whatWorks": string[], "whatBroke": string[], "suggestedNextAction": string, "suggestedNextAIPrompt": string|null, "suggestedCommitMessage": string}`;

export function buildEnrichInput(ctx: SessionContext, local: WrapUp): { system: string; user: string } {
  const d = ctx.derived;
  const L: string[] = [];
  L.push(`WORKSPACE: ${ctx.workspaceName}   BRANCH: ${ctx.git?.branch || "(no git)"}`);
  L.push("");
  // CHAT-AWARE: the conversation, deterministically reduced to a bounded, fixed-shape digest
  // (core/conversation.ts) — never the raw transcript, so prompt size + output stay predictable.
  // Provides INTENT; the GROUNDED FACTS below remain the ground truth for what actually happened.
  const digest = selectConversationDigest(ctx.conversation);
  if (digest) {
    L.push(renderConvoDigest(digest));
    L.push("");
  }
  L.push("GROUNDED FACTS (captured tool runs + file events — the ground truth for what ACTUALLY happened):");
  L.push(`- Most-edited files: ${d.hotFiles.map((h) => `${base(h.uri)}(${h.churn})`).join(", ") || "none"}`);
  if (d.fixedSignals.length) L.push(`- Errors CLEARED this session: ${d.fixedSignals.map((f) => `${base(f.uri)}(${f.clearedErrors})`).join(", ")}`);
  if (d.brokenSignals.length) L.push(`- Errors STILL OPEN: ${d.brokenSignals.map((b) => `${base(b.uri)}: ${b.openErrors} — ${(b.topMessages[0] || "").slice(0, 160)}`).join(" | ")}`);
  if (d.passedRuns.length) L.push(`- Commands PASSED: ${d.passedRuns.map((r) => r.cmd).join(", ")}`);
  if (d.recoveredRuns.length) L.push(`- Commands RECOVERED (were failing earlier, now pass — fixed this session): ${d.recoveredRuns.map((r) => r.cmd).join(", ")}`);
  if (d.failedRuns.length) L.push(`- Commands FAILED: ${d.failedRuns.map((r) => `${r.cmd} (exit ${r.exitCode}) tail="${clip(r.outTail, 220, 0)}"`).join(" | ")}`);
  if (d.created.length) L.push(`- Files created: ${d.created.map(base).join(", ")}`);
  if (d.touched.length) L.push(`- Files changed on disk: ${d.touched.map(base).join(", ")}`);
  if (d.deleted.length) L.push(`- Files deleted: ${d.deleted.map(base).join(", ")}`);
  if (d.deadEnds.length) L.push(`- Dead ends (created then deleted): ${d.deadEnds.map((x) => base(x.uri)).join(", ")}`);
  if (d.debuggedActive) L.push(`- A debug session ran.`);
  L.push("");
  if (ctx.git?.diffVsHead) {
    L.push("GIT DIFF vs HEAD (clipped):");
    L.push(clip(ctx.git.diffVsHead, 2500, 500));
    L.push("");
  }
  if (ctx.dirtyBuffers.length) {
    L.push("UNSAVED BUFFERS (clipped):");
    for (const b of ctx.dirtyBuffers.slice(0, 4)) {
      L.push(`# ${b.uri}`);
      L.push(clip(b.text, 600, 100));
    }
    L.push("");
  }
  if (ctx.changedFileContents.length) {
    L.push("CHANGED FILE CONTENTS (on-disk, this session — read these to ground what works/broke):");
    for (const f of ctx.changedFileContents.slice(0, 6)) {
      L.push(`# ${f.uri}`);
      L.push(clip(f.text, 1800, 300));
    }
    L.push("");
  }
  L.push("DETERMINISTIC DRAFT (improve the WORDING; do NOT add any claim not grounded above):");
  L.push(JSON.stringify({
    title: local.title, status: local.status, summary: local.summary,
    whatChanged: local.whatChanged, whatWorks: local.whatWorks, whatBroke: local.whatBroke,
    suggestedNextAction: local.suggestedNextAction, suggestedNextAIPrompt: local.suggestedNextPrompt,
    suggestedCommitMessage: local.suggestedCommitMessage,
  }, null, 1));
  // REVISION nudge (regenerate-with-a-nudge): hoist a short steer to the TOP so it's high-salience;
  // rule 9 tells the model to honor it while keeping every grounding rule. No-op on a normal wrap.
  if (ctx.nudge) L.unshift("REVISION REQUEST — the developer rated the PREVIOUS version of this note unhelpful. Fix it for this reason (grounding rules above still apply): " + ctx.nudge, "");
  // Best-effort secret redaction: scrub keys/tokens/
  // creds from the grounded prompt so the model can never echo them into the wrap.
  return { system: SYSTEM, user: redact(L.join("\n")) };
}

// Tool schema that FORCES structured output (the API returns valid JSON for us).
export const WRAP_TOOL = {
  name: "wrap_up",
  description: "Return the distilled Wrap It Up session wrap-up, grounded ONLY in the captured evidence provided.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "short generated title for the session" },
      status: { type: "string", enum: ["Working", "Partially working", "Broken", "Unknown"] },
      summary: { type: "string" },
      whatChanged: { type: "array", items: { type: "string" } },
      whatWorks: { type: "array", items: { type: "string" } },
      whatBroke: { type: "array", items: { type: "string" } },
      suggestedNextAction: { type: "string" },
      suggestedNextAIPrompt: { type: "string", description: "self-contained next prompt per the rules; empty string if nothing is clearly in progress" },
      suggestedCommitMessage: { type: "string" },
    },
    required: ["title", "status", "summary", "whatChanged", "whatWorks", "whatBroke", "suggestedNextAction", "suggestedCommitMessage"],
  },
};

// Merge the model's structured object onto the local wrap.
export function applyEnrichmentObj(local: WrapUp, p: any): WrapUp {
  const status: Status = p && STATUSES.indexOf(p.status) >= 0 ? p.status : local.status;
  const np = str(p?.suggestedNextAIPrompt);
  return {
    ...local,
    title: str(p?.title) || local.title,
    status,
    summary: str(p?.summary) || local.summary,
    whatChanged: arr(p?.whatChanged, local.whatChanged),
    whatWorks: arr(p?.whatWorks, local.whatWorks),
    whatBroke: arr(p?.whatBroke, local.whatBroke),
    suggestedNextAction: str(p?.suggestedNextAction) || local.suggestedNextAction,
    suggestedNextPrompt: np ? np : local.suggestedNextPrompt,
    suggestedCommitMessage: str(p?.suggestedCommitMessage) || local.suggestedCommitMessage,
    enrichment: "complete",
  };
}

function str(x: unknown): string { return typeof x === "string" ? x.trim() : ""; }
function arr(x: unknown, fb: string[]): string[] {
  return Array.isArray(x) ? x.filter((y) => typeof y === "string" && y.trim()).map((y) => (y as string).trim()) : fb;
}
