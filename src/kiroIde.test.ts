// Assertion test for the Kiro IDE adapter (src/kiroIde.ts).
// Builds a synthetic agent store mirroring the REAL on-disk layout (workspace-sessions/<ws>/
// sessions.json + <sessionId>.json chat, plus a per-execution blob with an actions[] array), points
// the adapter at it via WRAPITUP_KIRO_IDE_DIR, and asserts discovery + the parity signals
// (runCommand exitCode, file edits, path scoping, conversation). Self-contained; cleans up. `npm test`.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(os.tmpdir(), "wiu-kiroIde-store-" + process.pid);
process.env.WRAPITUP_KIRO_IDE_DIR = ROOT; // must be set BEFORE the adapter reads agentDir()

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { findTranscript, transcriptToEvents, transcriptToConversation } from "./kiroIde";

const FOLDER = path.join(os.tmpdir(), "wiu-kiroIde-proj");
const inside = (rel: string) => path.join(FOLDER, rel);
const outside = path.join(os.tmpdir(), "wiu-kiroIde-OTHER", "stray.ts");
const SESSION = "sess-abc-1";

// --- lay down the fixture ---
const wsDir = path.join(ROOT, "workspace-sessions", "WS1");
const execDir = path.join(ROOT, "execs", "aa", "bb");
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(execDir, { recursive: true });

fs.writeFileSync(path.join(wsDir, "sessions.json"), JSON.stringify([
  { sessionId: SESSION, title: "Add theme", dateCreated: "1782321297711", workspaceDirectory: FOLDER },
]));
fs.writeFileSync(path.join(wsDir, SESSION + ".json"), JSON.stringify({
  sessionId: SESSION,
  workspaceDirectory: FOLDER,
  history: [
    { message: { role: "user", content: [{ type: "text", text: "add a comment header to widget.html, then node --check" }] } },
    { message: { role: "assistant", content: "On it." }, executionId: "ex-1" }, // terse in history; real narration is a `say` action
  ],
}));
// the per-execution detail blob (the agent's tool work)
fs.writeFileSync(path.join(execDir, "blob1"), JSON.stringify({
  chatSessionId: SESSION,
  executionId: "ex-1",
  workflowType: "chat-agent",
  status: "succeed",
  actions: [
    { actionType: "say", actionState: "Success", emittedAt: 1050, executionId: "ex-1", output: "Reading the file first, then I'll add the header and run node --check." },
    { actionType: "readFiles", actionState: "Accepted", emittedAt: 1000, input: { files: [{ path: inside("widget.html") }] } }, // skip
    { actionType: "replace", actionState: "Accepted", emittedAt: 1100, input: { file: inside("widget.html") }, rawInput: { path: inside("widget.html") } },
    { actionType: "replace", actionState: "Accepted", emittedAt: 1150, input: { file: outside } }, // out of project → dropped
    { actionType: "runCommand", actionState: "Success", emittedAt: 1200, input: { command: "node --check main.js", cwd: FOLDER }, output: { output: "ok\n", exitCode: 0 } },
    { actionType: "runCommand", actionState: "Error", emittedAt: 1300, input: { command: "npm run build" }, output: { output: "error TS2304\n", exitCode: 1 } },
  ],
  version: "2.0.0",
}));

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log("  ok   " + name); }
  catch (e: any) { failures++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
};

try {
  console.log("Kiro IDE adapter test:");

  const tr = findTranscript(FOLDER);
  check("findTranscript locates the session chat file", () => {
    assert.ok(tr, "no transcript found");
    assert.strictEqual(path.basename(tr!), SESSION + ".json");
  });

  const events = transcriptToEvents(tr || "", FOLDER);
  const conv = transcriptToConversation(tr || "");
  const shells = events.filter((e) => e.kind === "shell.exec") as any[];
  const fsChanges = events.filter((e) => e.kind === "fs.change") as any[];
  const base = (u: string) => u.split(/[\\/]/).pop();

  check("captures both shell runs from the execution blob", () => assert.strictEqual(shells.length, 2));
  check("runCommand exit 0 → exitCode 0", () => {
    const r = shells.find((s) => s.cmd === "node --check main.js"); assert.ok(r); assert.strictEqual(r.exitCode, 0);
  });
  check("runCommand exit 1 → exitCode 1 (Working/Broken signal) + stderr tail", () => {
    const r = shells.find((s) => s.cmd === "npm run build"); assert.ok(r); assert.strictEqual(r.exitCode, 1);
    assert.ok(/TS2304/.test(r.outTail));
  });
  check("replace edit → fs.change for the in-project file", () => {
    const c = fsChanges.find((f) => base(f.uri) === "widget.html"); assert.ok(c, "widget.html change missing");
  });
  check("scoping drops the out-of-project edit", () => {
    assert.ok(!events.some((e: any) => typeof e.uri === "string" && base(e.uri) === "stray.ts"), "stray.ts leaked");
  });
  check("readFiles (a pure read) produces no event", () => {
    // only widget.html should appear as an edit; no event should reference a read-only action
    assert.ok(fsChanges.every((f) => base(f.uri) === "widget.html"));
  });
  check("conversation keeps the user prompt AND the assistant's say-narration (not just 'On it.')", () => {
    assert.strictEqual(conv[0].role, "user");
    assert.ok(/comment header/.test(conv[0].text));
    const a = conv.find((t) => t.role === "assistant");
    assert.ok(a && /Reading the file first/.test(a.text), "assistant say-narration not pulled in: " + (a && a.text));
  });
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failures) { console.log("\n" + failures + " check(s) FAILED"); process.exit(1); }
console.log("\nAll Kiro IDE adapter checks passed.");
