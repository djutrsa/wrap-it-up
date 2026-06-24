// Assertion test for the Kiro CLI adapter (src/kiro.ts).
// Self-contained: writes a synthetic session log that mirrors the REAL Kiro "v1" schema
// (reverse-engineered from a live ~/.kiro/sessions/cli/<uuid>.jsonl — Prompt /
// AssistantMessage / ToolResults, with ExecuteCmd exit_status and a FileWrite create), then
// runs the adapter and asserts the parity-critical outputs. No private data committed; no
// network; cleans up its temp file. Run via `npm test` (after build) → exits non-zero on fail.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { transcriptToEvents, transcriptToConversation } from "./kiro";

// A wrap-target folder (need not exist on disk — the adapter only reads the log + scopes paths).
const FOLDER = path.join(os.tmpdir(), "wiu-kiro-test-proj");
const inside = (rel: string) => path.join(FOLDER, rel);
const outside = path.join(os.tmpdir(), "wiu-kiro-OTHER-repo", "stray.ts"); // must be dropped by scoping

// Build the synthetic session, line by line, exactly as Kiro persists it.
const L = (o: unknown) => JSON.stringify(o);
const lines: string[] = [
  // 1) developer prompt (carries the only real timestamp — unix seconds)
  L({ version: "v1", kind: "Prompt", data: {
    message_id: "m1",
    content: [{ kind: "text", data: "add a color theme switcher (honey amber + kiro purple) to the widget" }],
    meta: { timestamp: 1782314613 },
  }}),
  // 2) assistant narrates + calls write (create the spec) and a stray write OUTSIDE the project
  L({ version: "v1", kind: "AssistantMessage", data: { content: [
    { kind: "text", data: "I'll create the spec file, then run the build and the tests." },
    { kind: "toolUse", data: { toolUseId: "tu_write", name: "write", input: {
      __tool_use_purpose: "create spec", command: "create", path: inside("writing/themes.md"), content: "# Themes" } } },
    { kind: "toolUse", data: { toolUseId: "tu_stray", name: "write", input: {
      command: "create", path: outside, content: "scratch" } } },
  ]}}),
  // 3) results for both writes (Kiro tags the tool by result.tool.kind.BuiltIn.<Name>)
  L({ version: "v1", kind: "ToolResults", data: { results: {
    tu_write: { tool: { kind: { BuiltIn: { FileWrite: {} } }, tool_use_purpose: "create spec" },
      result: { Success: { items: [{ Text: "Successfully created " + inside("writing/themes.md") }] } } },
    tu_stray: { tool: { kind: { BuiltIn: { FileWrite: {} } } },
      result: { Success: { items: [{ Text: "Successfully created " + outside }] } } },
  }}}),
  // 4) assistant runs two shell commands: one passes, one fails
  L({ version: "v1", kind: "AssistantMessage", data: { content: [
    { kind: "toolUse", data: { toolUseId: "tu_pass", name: "executeBash", input: { command: "npm test" } } },
    { kind: "toolUse", data: { toolUseId: "tu_fail", name: "executeBash", input: { command: "npm run build" } } },
  ]}}),
  // 5) results: exit_status is the parity signal ("exit code: N"); failure normalizes to 1
  L({ version: "v1", kind: "ToolResults", data: { results: {
    tu_pass: { tool: { kind: { BuiltIn: { ExecuteCmd: {} } } },
      result: { Success: { items: [{ Json: { exit_status: "exit code: 0", stdout: "12 passing\n", stderr: "" } }] } } },
    tu_fail: { tool: { kind: { BuiltIn: { ExecuteCmd: {} } } },
      result: { Success: { items: [{ Json: { exit_status: "exit code: 1", stdout: "", stderr: "error TS2304: Cannot find name 'foo'\n" } }] } } },
  }}}),
];

const tmp = path.join(os.tmpdir(), "wiu-kiro-fixture-" + process.pid + ".jsonl");
fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log("  ok   " + name); }
  catch (e: any) { failures++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}

try {
  const events = transcriptToEvents(tmp, FOLDER);
  const conv = transcriptToConversation(tmp);

  const shells = events.filter((e) => e.kind === "shell.exec") as Array<any>;
  const fsChanges = events.filter((e) => e.kind === "fs.change") as Array<any>;
  const docs = events.filter((e) => e.kind === "doc.change") as Array<any>;
  const base = (u: string) => u.split(/[\\/]/).pop();

  console.log("Kiro adapter test:");

  check("captures both shell runs", () => assert.strictEqual(shells.length, 2));
  check("passing command -> exitCode 0", () => {
    const r = shells.find((s) => s.cmd === "npm test");
    assert.ok(r, "npm test not found"); assert.strictEqual(r.exitCode, 0);
  });
  check("failing command -> exitCode 1 (the Working/Broken signal)", () => {
    const r = shells.find((s) => s.cmd === "npm run build");
    assert.ok(r, "npm run build not found"); assert.strictEqual(r.exitCode, 1);
  });
  check("failure carries stderr into outTail", () => {
    const r = shells.find((s) => s.cmd === "npm run build");
    assert.ok(/TS2304/.test(r.outTail), "stderr not in outTail: " + r.outTail);
  });
  check("FileWrite create -> fs.change op=create", () => {
    const c = fsChanges.find((f) => base(f.uri) === "themes.md");
    assert.ok(c, "themes.md change missing"); assert.strictEqual(c.op, "create");
  });
  check("FileWrite -> doc.change with lang", () => {
    const d = docs.find((f) => base(f.uri) === "themes.md");
    assert.ok(d, "themes.md doc.change missing"); assert.strictEqual(d.lang, "md");
  });
  check("scoping drops the out-of-project write", () => {
    assert.ok(!events.some((e: any) => typeof e.uri === "string" && base(e.uri) === "stray.ts"),
      "stray.ts leaked across folders");
  });
  check("timestamps are real + monotonic (not 1970)", () => {
    const ts = events.map((e) => e.t);
    assert.ok(ts[0] > 1.7e12, "first event not anchored to the prompt time: " + ts[0]);
    // Paired doc.change/fs.change for one write share a timestamp (same moment), so the
    // invariant is non-decreasing; distinct tool results still strictly advance.
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], "went backwards at " + i);
  });
  check("conversation keeps the developer prompt", () => {
    assert.strictEqual(conv[0].role, "user");
    assert.ok(/color theme switcher/.test(conv[0].text), "prompt text missing");
  });
  check("conversation keeps assistant narration, drops tool noise", () => {
    const a = conv.find((t) => t.role === "assistant");
    assert.ok(a && /create the spec file/.test(a.text), "assistant narration missing");
    assert.ok(!conv.some((t) => /BuiltIn|toolUse|exit_status/.test(t.text)), "tool noise leaked into conversation");
  });
} finally {
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
}

if (failures) { console.log("\n" + failures + " check(s) FAILED"); process.exit(1); }
console.log("\nAll Kiro adapter checks passed.");
