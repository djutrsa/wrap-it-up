// Headless proof the portable CORE works with no VS Code — run: npm run selftest
// Feeds a synthetic event log through reduce -> buildLocalWrap -> render and prints
// the wrap-up. Exercises the grounding: errors appeared then cleared (fix), a
// passing run, and a failing run that should drive the next action.

import { WrapEvent, SessionContext } from "./core/types";
import { reduceEvents } from "./core/reduce";
import { buildLocalWrap, renderWrapMarkdown } from "./core/wrap";

const t0 = 1_750_000_000_000;
const events: WrapEvent[] = [
  { t: t0, kind: "session.mark", reason: "workspace-open" },
  { t: t0 + 1_000, kind: "focus.editor", uri: "src/core/reduce.ts", lang: "typescript" },
  { t: t0 + 2_000, kind: "doc.change", uri: "src/core/reduce.ts", lang: "typescript", churn: 420, dirty: true },
  { t: t0 + 3_000, kind: "diag.delta", uri: "src/core/reduce.ts", errors: 2, warnings: 0, deltaErrors: 2, deltaWarnings: 0, topMessages: ["Property 'churn' does not exist on type 'Derived'"] },
  { t: t0 + 9_000, kind: "file.save", uri: "src/core/reduce.ts", lang: "typescript" },
  { t: t0 + 9_500, kind: "diag.delta", uri: "src/core/reduce.ts", errors: 0, warnings: 0, deltaErrors: -2, deltaWarnings: 0 },
  { t: t0 + 12_000, kind: "shell.exec", cmd: "npm run compile", exitCode: 0, outHead: "tsc ok", outTail: "" },
  { t: t0 + 20_000, kind: "doc.change", uri: "src/extension.ts", lang: "typescript", churn: 180, dirty: true },
  { t: t0 + 22_000, kind: "shell.exec", cmd: "npm test", exitCode: 1, outHead: "FAIL recorder.test.ts", outTail: "Expected 3 events, received 2\n    at Object.<anonymous> (recorder.test.ts:14)" },
  { t: t0 + 25_000, kind: "fs.change", uri: "src/boxscore.ts", op: "create" }, // external write (e.g. Claude Code)
];

const ctx: SessionContext = {
  events,
  derived: reduceEvents(events),
  workspaceName: "WrapItUp",
  dirtyBuffers: [],
  changedFileContents: [{ uri: "src/boxscore.ts", text: "export function leader(s: Record<string, Stat>): string { return 42; }" }],
  span: { start: events[0].t, end: events[events.length - 1].t },
};

console.log(renderWrapMarkdown(buildLocalWrap(ctx), ctx));
