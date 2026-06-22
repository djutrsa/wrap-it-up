// Portable core types. ZERO `vscode` import — this module has no IDE/runtime
// dependency, so the same engine powers the extension and the CLI.

export type WrapEvent =
  | { t: number; kind: "doc.change"; uri: string; lang: string; churn: number; dirty: boolean }
  | { t: number; kind: "file.save"; uri: string; lang: string }
  | { t: number; kind: "file.create"; uri: string }
  | { t: number; kind: "file.delete"; uri: string }
  | { t: number; kind: "file.rename"; from: string; to: string }
  | { t: number; kind: "fs.change"; uri: string; op: "create" | "change" | "delete" }
  | { t: number; kind: "diag.delta"; uri: string; errors: number; warnings: number; deltaErrors: number; deltaWarnings: number; topMessages?: string[] }
  | { t: number; kind: "shell.exec"; cmd: string; exitCode?: number; outHead?: string; outTail?: string }
  | { t: number; kind: "task.end"; name: string; exitCode?: number }
  | { t: number; kind: "debug.start"; name: string }
  | { t: number; kind: "debug.end"; name: string }
  | { t: number; kind: "focus.editor"; uri: string; lang: string }
  | { t: number; kind: "session.mark"; reason: "idle-gap" | "workspace-open" };

// One turn of the developer↔assistant conversation (chat-AWARE path). Extracted from a
// CLI session transcript; reduced to a bounded, fixed-shape digest (core/conversation.ts)
// before it ever reaches the LLM — we never feed the raw conversation.
export interface Turn { t: number; role: "user" | "assistant"; text: string }

export type Status = "Working" | "Partially working" | "Broken" | "Unknown";

// Domain mode (the registry axis in core/modes.ts). Orthogonal to the chat-aware/chat-blind
// VISIBILITY axis. "code" is today's default and keeps the engine byte-identical.
export type WrapMode = "code" | "writing";

// Writing-mode "oracle" (core/scanDocs.ts) — the prose analog of the run/compile signals
// coding gets for free. Deterministic doc-structure scan: what's drafted vs unwritten, what
// open-work markers remain, and what changed this session. Present only when WRAPITUP_MODE=writing.
export interface DocStructure {
  emptyHeadings: { uri: string; section: string; level: number; line: number; kind: "empty" | "thin"; words: number }[];
  openThreads: { uri: string; section: string | null; marker: string; line: number; excerpt: string }[]; // excerpt already redact+clip'd
  missingSections: { uri: string; section: string }[]; // empty unless doc-skeleton check enabled
  coverage: { uri: string; total: number; drafted: number; sections: { section: string; words: number }[] }[];
  prose: { uri: string; addedWords: number; removedWords: number; addedHeadings: string[]; removedHeadings: string[] }[]; // from the diff; empty when no diff
}

export interface Derived {
  hotFiles: { uri: string; churn: number; lastTouched: number }[];
  fixedSignals: { uri: string; clearedErrors: number }[];
  brokenSignals: { uri: string; openErrors: number; topMessages: string[] }[];
  failedRuns: { cmd: string; exitCode: number; outTail: string }[];
  passedRuns: { cmd: string }[];
  // Commands that FAILED earlier this session but PASS at the end = fixed in-flight.
  recoveredRuns: { cmd: string }[];
  deadEnds: { uri: string }[];
  debuggedActive: boolean;
  saves: number;
  created: string[];
  deleted: string[];
  // Files written by ANY process (incl. external CLI agents) via the FS watcher,
  // even when they never pass through the editor. The Claude-Code-in-terminal fix.
  touched: string[];
}

export interface SessionContext {
  events: WrapEvent[];
  derived: Derived;
  // committedFiles = `git ls-files` (tracked at HEAD). Lets the recorder tell a
  // genuinely-new file from one that already existed/was committed (vs HEAD).
  git?: { branch: string; diffVsHead: string; changedFiles: string[]; committedFiles?: string[] };
  workspaceName: string;
  dirtyBuffers: { uri: string; text: string }[];
  // Actual on-disk contents of files changed this session (read at wrap-time,
  // redacted). Gives the LLM the real code to ground from when there is no git
  // diff and no editor diagnostics (the no-git, external-agent case).
  changedFileContents: { uri: string; text: string }[];
  // Chat-AWARE path only: the developer↔assistant conversation distilled from the CLI
  // session transcript (Claude Code etc.). Ordered turns; absent on the git-only / editor
  // paths. Its PRESENCE is what selects the chat-aware enricher. Reduced to a bounded,
  // fixed-shape digest before it reaches the LLM (see core/conversation.ts) — so prompt
  // size, latency, and the output distribution stay predictable across session sizes.
  conversation?: Turn[];
  // REVISION nudge (regenerate-with-a-nudge): a short steer derived from a feedback reason chip
  // (e.g. "wrong files") when the developer asks for a better note. Absent on a normal wrap.
  nudge?: string;
  // Domain mode (core/modes.ts). Absent/"code" ⇒ today's exact behavior. Set by the broker
  // from an explicit WRAPITUP_MODE opt-in; selects the enricher and the local-wrap producer.
  mode?: WrapMode;
  // Writing-mode doc-structure scan (core/scanDocs.ts). Present only when mode === "writing";
  // its presence makes buildLocalWrap produce prose-grounded fields. Coding path leaves it unset.
  docStructure?: DocStructure;
  span: { start: number; end: number };
}

export interface WrapUp {
  schemaVersion: 1;
  source: "wrap-it-up-recorder";
  title: string;
  status: Status;
  summary: string;
  whatChanged: string[];
  whatWorks: string[];
  whatBroke: string[];
  suggestedNextAction: string;
  suggestedNextPrompt: string | null;
  suggestedCommitMessage: string;
  capturedContext: { branch?: string; changedFiles: string[]; runOutput: string[] };
  // "pending" = local context-only wrap (no LLM yet).
  enrichment: "pending" | "complete" | "failed";
}
