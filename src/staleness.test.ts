// Regression test for the "process.exit(8) haunts a later, unrelated wrap" bug.
// Two fixes, two layers:
//   (A) reduce.ts marks a failed run STALE when a later successful run superseded it; wrap.ts then
//       refuses to let a stale failure drive status / the "what broke" list / the next step.
//   (B) enrich.ts honors the model's EMPTY resume prompt (a deliberate "nothing in progress")
//       instead of falling back to the local crash-anchored draft.
// Self-contained, no network. Run via `npm test`.

import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { reduceEvents } from "./core/reduce";
import { buildLocalWrap } from "./core/wrap";
import { applyEnrichmentObj } from "./core/enrich";
import { WrapEvent, SessionContext } from "./core/types";

const FOLDER = path.join(os.tmpdir(), "wiu-stale-proj");
const f = (rel: string) => path.join(FOLDER, rel);

function ctxFrom(events: WrapEvent[]): SessionContext {
  const ts = events.map((e) => e.t);
  return {
    events,
    derived: reduceEvents(events),
    git: undefined,
    workspaceName: "wiu-stale-proj",
    dirtyBuffers: [],
    changedFileContents: [],
    span: { start: Math.min(...ts), end: Math.max(...ts) },
    conversation: [],
  } as SessionContext;
}

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log("  ok   " + name); }
  catch (e: any) { failures++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
};

console.log("Staleness + reconcile test:");

// ---- Layer A: a throwaway failure early, superseded by later unrelated success ----
const stale: WrapEvent[] = [
  { t: 1000, kind: "fs.change", uri: f("scratch.js"), op: "create" },
  { t: 2000, kind: "shell.exec", cmd: 'node -e "process.exit(8)"', exitCode: 1, outTail: "" },   // FAIL (early)
  { t: 3000, kind: "fs.change", uri: f("widget.html"), op: "change" },                            // later, UNRELATED work
  { t: 4000, kind: "shell.exec", cmd: "node --check main.js", exitCode: 0, outTail: "ok" },        // PASS (later) → supersedes
  { t: 5000, kind: "doc.change", uri: f("main.js"), lang: "js", churn: 3, dirty: false },
];
const staleCtx = ctxFrom(stale);
const staleWrap = buildLocalWrap(staleCtx);

check("the superseded failure is flagged stale", () => {
  const fr = staleCtx.derived.failedRuns.find((r) => /process\.exit/.test(r.cmd));
  assert.ok(fr, "failed run missing"); assert.strictEqual(fr!.stale, true);
});
check("a still-current pass is NOT stale-flagged away (sanity)", () => {
  assert.ok(staleCtx.derived.passedRuns.some((r) => r.cmd === "node --check main.js"));
});
check("status is NOT dragged to Broken/Partially by the stale failure", () => {
  assert.strictEqual(staleWrap.status, "Working");
});
check("the stale failure never reaches 'what is broken'", () => {
  assert.ok(!staleWrap.whatBroke.some((s) => /process\.exit/.test(s)), "stale failure leaked into whatBroke");
});
check("the next move / prompt does NOT anchor on the stale failure", () => {
  assert.ok(!/process\.exit/.test(staleWrap.suggestedNextAction), "next move anchored on stale failure");
  assert.ok(!/process\.exit/.test(staleWrap.suggestedNextPrompt || ""), "next prompt anchored on stale failure");
});
check("the failure is still in the honest run record (not hidden)", () => {
  assert.ok(staleWrap.capturedContext.runOutput.some((s) => /process\.exit/.test(s)), "run record dropped the failure");
});

// ---- Control: a CURRENT failure (nothing passed after it) must STILL anchor ----
const current: WrapEvent[] = [
  { t: 1000, kind: "shell.exec", cmd: "npm test", exitCode: 1, outTail: "1 failing" },
  { t: 1100, kind: "doc.change", uri: f("app.js"), lang: "js", churn: 2, dirty: false },          // editing to fix; no re-run
];
const curCtx = ctxFrom(current);
const curWrap = buildLocalWrap(curCtx);
check("a current (un-superseded) failure is NOT marked stale", () => {
  const fr = curCtx.derived.failedRuns.find((r) => r.cmd === "npm test");
  assert.ok(fr && !fr.stale, "current failure wrongly marked stale");
});
check("a current failure DOES drive status + the resume prompt", () => {
  assert.notStrictEqual(curWrap.status, "Working");
  assert.ok(/npm test/.test(curWrap.suggestedNextPrompt || ""), "current failure failed to anchor the prompt");
});

// ---- Layer B: enrich honors an EMPTY model prompt; only a MISSING field falls back ----
check("empty model prompt → honored as 'no prompt' (null), NOT the local crash draft", () => {
  const out = applyEnrichmentObj(curWrap, { status: "Working", whatBroke: [], suggestedNextAIPrompt: "" });
  assert.strictEqual(out.suggestedNextPrompt, null);
});
check("a real model prompt is used verbatim", () => {
  const out = applyEnrichmentObj(curWrap, { suggestedNextAIPrompt: "Open app.js and finish the parser." });
  assert.strictEqual(out.suggestedNextPrompt, "Open app.js and finish the parser.");
});
check("a MISSING prompt field still falls back to the local draft", () => {
  const out = applyEnrichmentObj(curWrap, { status: "Broken" }); // no suggestedNextAIPrompt key
  assert.strictEqual(out.suggestedNextPrompt, curWrap.suggestedNextPrompt);
});

if (failures) { console.log("\n" + failures + " check(s) FAILED"); process.exit(1); }
console.log("\nAll staleness + reconcile checks passed.");
