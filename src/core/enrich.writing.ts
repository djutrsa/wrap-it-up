// Writing-mode enrichment (the DOC-WRITING counterpart of enrich.ts / enrich.northstar.ts).
// The recorder turns a captured doc-writing session — the markdown diff, the changed
// document contents, a deterministic DOC-STRUCTURE SCAN (empty headings, open-thread
// markers, coverage), and (when present) the AI chat — into a calm re-entry briefing.
//
// Same portable contract as the other enrichers (no vscode, no network): the 3-symbol
// surface buildEnrichInput / WRAP_TOOL / applyEnrichmentObj is byte-identical in shape, so
// the broker (cli.ts) and the eval harness consume it unchanged — only the SYSTEM prompt and
// the GROUNDED FACTS assembly differ. Unlike the coding prompt, this one grounds DRAFT-FIRST,
// CHAT-SECOND, so it works well even when there is no transcript at all (the common case).

import { SessionContext, WrapUp, Status } from "./types";
import { clip, redact } from "./redact";
import { selectConversationDigest, renderConvoDigest } from "./conversation";

const STATUSES: Status[] = ["Working", "Partially working", "Broken", "Unknown"];
const base = (u: string) => u.split(/[\\/]/).pop() || u;

const SYSTEM = `You are the distillation engine for "Wrap It Up" (writing mode). You turn a writer's CAPTURED DOC-WRITING SESSION — the markdown/text diff, the changed document contents (the actual draft on disk), a deterministic DOC-STRUCTURE SCAN (empty headings, open-thread markers, missing sections, per-section coverage), and — WHEN PRESENT — their AI CHAT — into a short, trustworthy re-entry briefing they read when returning to an abandoned draft.

GROUND IN THE DRAFT FIRST. The changed document contents and the doc-structure scan are your PRIMARY ground truth: they are what the draft ACTUALLY SAYS right now. If an AI chat digest is present, it is provided already DISTILLED (the original goal, the latest writer messages, the assistant's last narration); use it ONLY as a SECONDARY signal for intent (what they were trying to write), and never let it override what the text on the page shows. There is often NO chat at all — when there is none, ground entirely in the draft and the scan, and say nothing about intent you cannot read in the text. There is no compile step and no test suite in writing mode. Hard rules:

1. GROUND every claim in captured evidence — the actual prose in the diff and changed files, and the doc-structure scan (a heading with an empty body, a TODO/TK marker on a line, a section present or absent). If there is no evidence for something, do NOT assert it — say "Unknown"/"unclear". When the chat and the draft CONFLICT, trust the DRAFT: a section the writer discussed but did not actually write is NOT done — say so plainly. Never invent an argument, a thesis, or a section's content you cannot read in the text.

2. NO PARAPHRASE OF MEANING. Never state what a section ARGUES, CONCLUDES, RECOMMENDS, or CLAIMS. Report only its completeness STATE (drafted / thin / stub / has open markers) and its existence. A summary describes structure and progress ("the Discussion section is drafted, ~400 words, no open markers"), NOT content ("the Discussion concludes X"). If the actual claim matters, QUOTE a short verbatim excerpt — never a generated restatement. A quoted sentence cannot be confidently wrong; a paraphrase can.

3. CLIP-BLINDNESS IS REAL BLINDNESS. If a "[clipped N chars]" marker appears in the changed-file content, you have NOT read the whole document. Do NOT assert any section is complete, correct, or solid. Defer to the doc-structure scan's coverage counts (computed over the full file), not to your reading of the clipped prose. Treat the clip marker as a "you are partially blind here" signal.

4. SESSION-SCOPE vs DOCUMENT-SCOPE. Markers and empty headings that are NOT in this session's diff are PRE-EXISTING, not this session's work. List them at most as "pre-existing open threads (N)"; never anchor the next move on one unless the chat shows the writer returned to it. Anchor the next move on a stub the diff CREATED or TOUCHED. Whole-document coverage is ambient context ("document has 40 sections; you edited 1"), not this-session status.

5. DRAFT STATE, NOT VERSION CONTROL. The diff shows the working draft as it stands now — uncommitted, mid-revision. NEVER claim a draft is "published", "submitted", or "final". A section that gained text this session is EXPANDED; a heading that appeared with no body under it is a NEW STUB. Trust the doc-structure scan and the reconciled Sections-added / Files-changed lists over your own reading of the raw diff. Describe what the words say, not what a commit log would say.

6. Calm, plain language. No hype, no shame, no productivity-speak. Describe the draft; do not praise or scold the writer.

7. NO QUALITY WORDS. Never say "solid", "complete", "holds together", "final", "publishable", or "ready". The scan detects structure and explicit markers, not argument quality. The strongest honest positive is "drafted; no open markers found — not reviewed for correctness." Absence of a detected problem is NOT evidence of quality.

8. DEFERRED-WORK GUARDRAIL. An explicit PLACEHOLDER or POSTPONEMENT marker — TODO, TK, TKTK, TBD, XXX, FIXME, "[ ]", "[citation needed]", "<!-- ... -->", "placeholder", "fill in", "to be written" — sitting ON or INSIDE a section means that gap was left ON PURPOSE. Treat it as a KNOWN, INTENTIONALLY-PARKED hole and frame the next move as RESUMING it, not discovering a fresh defect. The marker re-frames ONLY the heading it physically sits under — do not extend "parked" status to neighboring claims. A sentence that merely reads awkwardly, or a section that is simply thin, is NOT a parked placeholder — call thin prose "thin / needs expansion", and do not soft-pedal a real gap by calling it parked.

9. ABSENCE OF A SECTION'S TEXT IS EVIDENCE; ABSENCE OF A SCAN SIGNAL IS NOT. If the scan reports a heading with an empty body or a missing expected section, that IS grounded evidence the part is unwritten — surface it. But do NOT assert a section is "wrong", "weak", or "unsupported" merely because no marker fired on it; the scan flags structure and explicit markers, not argument quality. When the draft simply has prose you cannot verify, say "drafted; not yet reviewed", never "broken".

10. NEXT-STEP IS INTENT, POINT AT THE DOC BY NAME. "suggestedNextAIPrompt" and "suggestedNextAction" must point at the writer's actual IN-PROGRESS work — the section they were drafting or the open thread they were resolving — not at whatever was edited last incidentally. It must be SELF-CONTAINED for a fresh writing assistant with no memory of this session: give ONE concrete next move; name the exact file and heading (quote it, e.g. the "## Methods" section); inline the actual open question or stub text you can see (e.g. the literal "<!-- TK: which baseline? -->"); add a guardrail that protects finished prose ("do not rewrite the ## Introduction"). Do NOT reference "the section above" or "as we discussed" — the reader has no chat history. No tool/IDE names, no secrets. The prompt may name ONLY a section, heading, file, or marker that appears in the GROUNDED FACTS (scanner) block — never one that exists only in the chat digest. If the chat's freshest intent and the freshest grounded stub disagree, anchor on the stub. If the draft reached a genuinely clean stopping point (no stubs, no open threads), OR neither scan nor chat yields a grounded in-progress thread, set it to null.

Output ONLY a JSON object (no prose, no code fences) with exactly these keys:
{"title": string, "status": "Working"|"Partially working"|"Broken"|"Unknown", "summary": string, "whatChanged": string[], "whatWorks": string[], "whatBroke": string[], "suggestedNextAction": string, "suggestedNextAIPrompt": string|null, "suggestedCommitMessage": string}`;

export function buildEnrichInput(ctx: SessionContext, local: WrapUp): { system: string; user: string } {
  const d = ctx.derived;
  const ds = ctx.docStructure;
  const L: string[] = [];
  L.push(`WORKSPACE: ${ctx.workspaceName}   BRANCH: ${ctx.git?.branch || "(no git)"}`);
  L.push("");
  // Chat-aware variant: the conversation digest provides INTENT only (secondary signal);
  // the draft + scan below are the ground truth. Absent on the common no-transcript case.
  const digest = selectConversationDigest(ctx.conversation);
  if (digest) {
    L.push(renderConvoDigest(digest));
    L.push("");
  }
  L.push("GROUNDED FACTS (the draft text + doc-structure scan — the ground truth for what the document actually says):");
  if (d.created.length) L.push(`- Files created: ${d.created.map(base).join(", ")}`);
  if (d.touched.length) L.push(`- Files changed: ${d.touched.map(base).join(", ")}`);
  if (d.deleted.length) L.push(`- Files deleted: ${d.deleted.map(base).join(", ")}`);
  if (ds) {
    for (const c of ds.coverage.slice(0, 6)) L.push(`- ${base(c.uri)}: ${c.drafted}/${c.total} section(s) drafted`);
    if (ds.emptyHeadings.length) L.push(`- Empty/thin headings: ${ds.emptyHeadings.map((e) => `"${e.section}" (${e.kind}${e.words ? `, ${e.words}w` : ""}) in ${base(e.uri)}`).join(" | ")}`);
    if (ds.openThreads.length) L.push(`- Open-work markers: ${ds.openThreads.map((t) => `${base(t.uri)}:${t.line} ${t.marker}${t.section ? ` in "${t.section}"` : ""} — ${t.excerpt}`).join(" | ")}`);
    if (ds.missingSections.length) L.push(`- Missing expected sections: ${ds.missingSections.map((m) => `${m.section} (${base(m.uri)})`).join(", ")}`);
    for (const p of ds.prose) {
      const parts: string[] = [];
      if (p.addedHeadings.length) parts.push(`+sections: ${p.addedHeadings.slice(0, 6).join(", ")}`);
      if (p.removedHeadings.length) parts.push(`-sections: ${p.removedHeadings.slice(0, 6).join(", ")}`);
      if (p.addedWords || p.removedWords) parts.push(`+${p.addedWords}/-${p.removedWords} words`);
      if (parts.length) L.push(`- This session in ${base(p.uri)}: ${parts.join("; ")}`);
    }
  } else {
    L.push("- (no doc-structure scan available)");
  }
  L.push("");
  if (ctx.git?.diffVsHead) {
    L.push("DIFF vs HEAD (clipped — the prose changed this session):");
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
    L.push("CHANGED DOCUMENT CONTENTS (on-disk, this session — the actual draft; read to ground completeness):");
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
  if (ctx.nudge) L.unshift("REVISION REQUEST — the writer rated the PREVIOUS version of this note unhelpful. Fix it for this reason (grounding rules above still apply): " + ctx.nudge, "");
  // Load-bearing security invariant (do NOT add an unredacted return path): the whole prompt —
  // including the chat digest and every scanned excerpt — is scrubbed here before it can leave.
  return { system: SYSTEM, user: redact(L.join("\n")) };
}

// Tool schema that FORCES structured output. Byte-identical in shape to the other enrichers
// so the eval harness and applyEnrichmentObj are unchanged.
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

// Merge the model's structured object onto the local wrap. Identical to the other enrichers.
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
