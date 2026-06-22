// Chat-AWARE conversation handling. The product's whole premise is GROUNDING,
// so we deliberately do NOT summarize the conversation with a second LLM call — that would
// re-invent /compact, add latency + a hallucination surface, and expose us to an unbounded
// distribution of summaries. Instead we DETERMINISTICALLY EXTRACT a small, fixed-shape set of
// the highest-signal turns — the same "reduce, don't summarize" philosophy as core/reduce.ts.
//
// This guarantees three properties that keep the product trustworthy:
//   • Bounded prompt  — a hard char ceiling regardless of session length → predictable latency
//     and cost (a 1000-turn session costs the same as a 10-turn one).
//   • Fixed shape     — the enricher sees the SAME structure every time, so its task is identical
//     for any session → the OUTPUT distribution stays tight (the thing that would otherwise
//     erode trust as users hit a wide spread of sessions).
//   • No second model call — no /compact dependency, no compounding error.
//
// The conversation only needs to add INTENT (what they were trying to do) and the LATEST STATE
// (where they ended up). What actually CHANGED is already covered by the tool-call + git facts.

import { Turn } from "./types";
import { clip } from "./redact";

// Budgets (chars). Deliberately small + explicit — this is the contract that bounds everything.
const GOAL_HEAD = 600, GOAL_TAIL = 200;            // developer's first message (original goal)
const ASK_HEAD = 380, ASK_TAIL = 140;              // each recent developer message
const RECENT_ASKS = 3;                             // how many trailing developer messages to keep
const NARRATION_HEAD = 150, NARRATION_TAIL = 600;  // assistant turns: favor the conclusion (tail)
const NARRATION_TURNS = 2;                          // last N assistant narration turns
const TOTAL_BUDGET = 3000;                          // hard ceiling on the whole digest, no matter the input

export interface ConvoDigest {
  goal: string | null;     // the developer's first substantive message (original intent)
  recentAsks: string[];    // their last few messages, oldest→newest (current intent), goal excluded
  lastNarration: string[]; // the assistant's last narration turns, oldest→newest (latest state)
}

// Claude Code injects synthetic "user" turns (slash-command wrappers, interrupts, continuation
// notices, system reminders, image stubs). Those are not the developer speaking — drop them so
// INTENT stays clean. (tool_result-bearing user turns already carry no text and are dropped upstream.)
const NOISE_USER = /^(<command-name>|<command-message>|<command-args>|<local-command|<user-prompt|<bash-|Caveat:|\[Request interrupted|This session is being continued|<system-reminder>|API Error|\[Image)/;
const isDeveloperTurn = (t: Turn) => t.role === "user" && t.text.trim().length > 0 && !NOISE_USER.test(t.text.trim());
const isAssistantNarration = (t: Turn) => t.role === "assistant" && t.text.trim().length > 0;

// Reduce a full conversation to its bounded, fixed-shape digest. Pure + deterministic:
// same turns in → same digest out, every time.
export function selectConversationDigest(turns: Turn[] | undefined): ConvoDigest | null {
  if (!turns || !turns.length) return null;
  const devs = turns.filter(isDeveloperTurn);
  const narration = turns.filter(isAssistantNarration);
  if (!devs.length && !narration.length) return null;

  const goal = devs.length ? clip(devs[0].text, GOAL_HEAD, GOAL_TAIL) : null;
  // last RECENT_ASKS developer turns, excluding the first one (already used as the goal)
  const tailDevs = (devs.length > 1 ? devs.slice(1) : []).slice(-RECENT_ASKS);
  const recentAsks = tailDevs.map((t) => clip(t.text, ASK_HEAD, ASK_TAIL));
  const lastNarration = narration.slice(-NARRATION_TURNS).map((t) => clip(t.text, NARRATION_HEAD, NARRATION_TAIL));

  return trimToBudget({ goal, recentAsks, lastNarration });
}

// Hard ceiling enforcement: even after the per-field clips, pathological turns could sum past
// the budget. Trim the least-critical material first (oldest narration, then oldest asks), always
// keeping the goal + the single most-recent ask, so the digest size is bounded for ANY input.
function trimToBudget(d: ConvoDigest): ConvoDigest {
  const size = () =>
    (d.goal?.length || 0) +
    d.recentAsks.reduce((a, s) => a + s.length, 0) +
    d.lastNarration.reduce((a, s) => a + s.length, 0);
  while (size() > TOTAL_BUDGET && d.lastNarration.length) d.lastNarration.shift();
  while (size() > TOTAL_BUDGET && d.recentAsks.length > 1) d.recentAsks.shift();
  if (size() > TOTAL_BUDGET && d.goal) {
    const others = d.recentAsks.reduce((a, s) => a + s.length, 0);
    d.goal = d.goal.slice(0, Math.max(200, TOTAL_BUDGET - others));
  }
  return d;
}

// Render the digest into the fixed block the enricher always sees (identical shape every session).
export function renderConvoDigest(d: ConvoDigest): string {
  const L: string[] = [];
  L.push("AI CHAT — distilled to its highest-signal parts (INTENT + latest state; the tool/diff facts below are the ground truth):");
  if (d.goal) {
    L.push("• ORIGINAL GOAL (developer's first message):");
    L.push(indent(d.goal));
  }
  if (d.recentAsks.length) {
    L.push("• LATEST DEVELOPER MESSAGES (oldest→newest — the current intent):");
    for (const a of d.recentAsks) L.push(indent(a));
  }
  if (d.lastNarration.length) {
    L.push("• ASSISTANT'S LAST NARRATION (what it reported doing / planned next):");
    for (const n of d.lastNarration) L.push(indent(n));
  }
  return L.join("\n");
}

const indent = (s: string) => s.split("\n").map((l) => "    " + l).join("\n");
