// Feedback ledger — schema owned in ONE place so it can never drift.
// Portable: NO `vscode`, NO `electron`. The widget pipes a JSON event to `cli.js feedback`,
// which calls into here. The two clocks live in SEPARATE columns and are never merged:
//   Clock 1 (perceived_useful) — written once per WHERE-WAS-I? press, at card resolution.
//   Clock 2 (reentry_outcome)  — patched lazily onto a PRIOR row at the next re-entry.
// Calibration + triage ONLY (never model training).

import * as fs from "fs";
import * as path from "path";

export type Perceived = "didnt_help" | "oriented" | "right_back_in" | "none";
export type RespondVsDismiss =
  | "responded"
  | "dismissed_unvoted_byuser"
  | "dismissed_byTimer"
  | "never_opened";
export type ReasonChip = "stale" | "wrong_files" | "couldnt_tell" | "note_fine_i_bounced" | null;
export type ReentryOutcome = "didnt_help" | "eventually" | "yes" | "none" | null;

export interface SessionContextMeta {
  fried_flag: boolean | null;
  time_away_min: number | null;
  session_type: string | null;
  session_len_min: number | null;
}

// One row per WHERE-WAS-I? press.
export interface FeedbackEvent {
  event_id: string;
  wrap_id: string;
  wrs_score: number | null; // null at capture
  event_ts: string; // ISO UTC press time
  perceived_useful: Perceived; // Clock 1 — NEVER stored as "success"
  perceived_delay_sec: number | null;
  respond_vs_dismiss: RespondVsDismiss;
  reason_chip: ReasonChip; // only on `didnt_help`, optional
  reentry_outcome: ReentryOutcome; // Clock 2 — null until a later re-entry patches it
  reentry_outcome_ts: string | null;
  reentry_delay_sec: number | null;
  recorder_version: string | null;
  model_version: string | null;
  session_context: SessionContextMeta;
}

export interface TriageEntry {
  ts: string;
  wrap_id: string;
  wrs_score: number | null;
  reason_chip: ReasonChip;
  files: string[];
  next_move: string | null;
  next_prompt: string | null;
}

const PERCEIVED = new Set<Perceived>(["didnt_help", "oriented", "right_back_in", "none"]);
const RVD = new Set<RespondVsDismiss>([
  "responded",
  "dismissed_unvoted_byuser",
  "dismissed_byTimer",
  "never_opened",
]);
const CHIPS = new Set(["stale", "wrong_files", "couldnt_tell", "note_fine_i_bounced"]);

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const boolean = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// Canonicalize a raw event (from the widget's stdin JSON) into a schema row.
// Schema rules (non-negotiable): a no-vote is recorded as `none` + its dismiss state and
// is NEVER coerced to `didnt_help`; Clock 2 is NEVER set on the Clock-1 write; the reason chip is
// only kept on the lowest rung (no asymmetric "tell us why" tax on the other options).
export function normalizeEvent(raw: any): FeedbackEvent {
  const perceived: Perceived = PERCEIVED.has(raw?.perceived_useful) ? raw.perceived_useful : "none";
  const rvd: RespondVsDismiss = RVD.has(raw?.respond_vs_dismiss)
    ? raw.respond_vs_dismiss
    : perceived === "none"
    ? "dismissed_byTimer"
    : "responded";
  const chip: ReasonChip =
    perceived === "didnt_help" && CHIPS.has(raw?.reason_chip) ? raw.reason_chip : null;
  const sc = raw?.session_context || {};
  return {
    event_id: str(raw?.event_id) || `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    wrap_id: str(raw?.wrap_id) || "unknown",
    wrs_score: num(raw?.wrs_score), // expected null at capture
    event_ts: str(raw?.event_ts) || new Date().toISOString(),
    perceived_useful: perceived,
    perceived_delay_sec: num(raw?.perceived_delay_sec),
    respond_vs_dismiss: rvd,
    reason_chip: chip,
    reentry_outcome: null, // Clock 2 lives only on a later patch, never here
    reentry_outcome_ts: null,
    reentry_delay_sec: null,
    recorder_version: str(raw?.recorder_version),
    model_version: str(raw?.model_version),
    session_context: {
      fried_flag: boolean(sc.fried_flag),
      time_away_min: num(sc.time_away_min),
      session_type: str(sc.session_type),
      session_len_min: num(sc.session_len_min),
    },
  };
}

export function feedbackDir(folder: string): string {
  return path.join(folder, ".wrap-it-up", "feedback");
}

// The wrap's stable id = its ISO-timestamp basename (already the sort key).
export function wrapIdFromFile(file: string): string {
  return path.basename(file).replace(/\.md$/i, "");
}

// Append one row (append-only JSONL).
export function appendFeedbackEvent(folder: string, raw: any): FeedbackEvent {
  const ev = normalizeEvent(raw);
  const dir = feedbackDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "feedback.jsonl"), JSON.stringify(ev) + "\n", "utf8");
  return ev;
}

// Read back the CURRENT state of a row by event_id (last match wins). Lets telemetry send the same
// row after a Clock-2 patch so the server sees the re-entry outcome, not just the Clock-1 vote.
export function readEventById(folder: string, eventId: string): FeedbackEvent | null {
  if (!eventId) return null;
  const rows = readJsonl(path.join(feedbackDir(folder), "feedback.jsonl")) as FeedbackEvent[];
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i] && rows[i].event_id === eventId) return rows[i];
  return null;
}

// Clock-2 lazy write-back. Find the row with `eventId` and set ONLY its reentry_* fields — never
// a Clock-1 column, and never an already-recorded Clock-2 answer. Read → patch the one line →
// atomic temp-swap (fs.rename replaces the destination on both POSIX and Windows). Returns true
// if a row was patched.
export function patchReentryOutcome(
  folder: string,
  eventId: string,
  outcome: Exclude<ReentryOutcome, null>,
  outcomeTs: string,
  delaySec: number | null
): boolean {
  const file = path.join(feedbackDir(folder), "feedback.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let patched = false;
  const out = raw.split("\n").map((line) => {
    if (!line.trim() || patched) return line;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      return line;
    }
    if (row.event_id !== eventId) return line;
    patched = true;
    if (row.reentry_outcome != null) return line; // already answered — don't overwrite
    row.reentry_outcome = outcome;
    row.reentry_outcome_ts = outcomeTs;
    row.reentry_delay_sec = delaySec;
    return JSON.stringify(row);
  });
  if (!patched) return false;
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, out.join("\n"), "utf8");
  fs.renameSync(tmp, file);
  return true;
}

// The highest-value immediate use of a "didn't help": pull {wrap, score, files, next-prompt} into a
// review queue. That's where note quality actually improves — by reading the failures.
export function appendTriage(folder: string, entry: TriageEntry): void {
  const dir = feedbackDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "triage.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

// Regenerate signal: one append-only row per "regenerate this wrap" (chip-triggered). The nudge +
// that the original was rated unhelpful IS the improvement signal; whether the fix LANDED is inferred
// later from the next re-entry's Clock-2 outcome (we never nag with an extra vote). Triage only.
export interface RegenerationEntry {
  ts: string;
  wrap_id: string;
  reason: string; // the feedback reason chip that steered it (wrong_files | stale | couldnt_tell)
  nudge: string; // the steer actually sent to the recorder
  title: string | null; // the regenerated wrap's title
}
export function appendRegeneration(folder: string, entry: RegenerationEntry): void {
  const dir = feedbackDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "regenerations.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

// ---- one-screen quality readout (the beta go/no-go number, alongside gut feel) ----
// Vote-based, NO model call: aggregates the local ledger so you can see "is it landing?" at a glance.
export interface FeedbackSummary {
  n: number; // total Clock-1 rows (WHERE-WAS-I? presses that opened a card)
  responded: number; // votes that picked a rung (not a no-vote)
  rightBackIn: number;
  oriented: number;
  didntHelp: number;
  noVote: number;
  rightBackInRate: number | null; // right_back_in / responded — the headline "did it land" number
  reentryAnswered: number;
  reentryYes: number;
  reentryEventually: number;
  reentryDidntHelp: number;
  reentrySuccessRate: number | null; // (yes + eventually) / answered — Clock-2 outcome
  regenerations: number;
  regenRate: number | null; // regenerations / n
  topReasons: { reason: string; count: number }[];
}

function readJsonl(file: string): any[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function summarizeFeedback(folder: string): FeedbackSummary {
  const dir = feedbackDir(folder);
  const rows: FeedbackEvent[] = readJsonl(path.join(dir, "feedback.jsonl"));
  const regens = readJsonl(path.join(dir, "regenerations.jsonl"));
  const n = rows.length;
  const count = (p: Perceived) => rows.filter((r) => r.perceived_useful === p).length;
  const rightBackIn = count("right_back_in"),
    oriented = count("oriented"),
    didntHelp = count("didnt_help"),
    noVote = count("none");
  const responded = rightBackIn + oriented + didntHelp;
  const answered = rows.filter((r) => r.reentry_outcome && r.reentry_outcome !== "none");
  const reentryAnswered = answered.length;
  const reentryYes = answered.filter((r) => r.reentry_outcome === "yes").length;
  const reentryEventually = answered.filter((r) => r.reentry_outcome === "eventually").length;
  const reentryDidntHelp = answered.filter((r) => r.reentry_outcome === "didnt_help").length;
  const reasons: Record<string, number> = {};
  for (const r of rows) if (r.reason_chip) reasons[r.reason_chip] = (reasons[r.reason_chip] || 0) + 1;
  const topReasons = Object.entries(reasons)
    .map(([reason, c]) => ({ reason, count: c }))
    .sort((a, b) => b.count - a.count);
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    n, responded, rightBackIn, oriented, didntHelp, noVote,
    rightBackInRate: rate(rightBackIn, responded),
    reentryAnswered, reentryYes, reentryEventually, reentryDidntHelp,
    reentrySuccessRate: rate(reentryYes + reentryEventually, reentryAnswered),
    regenerations: regens.length,
    regenRate: rate(regens.length, n),
    topReasons,
  };
}
