#!/usr/bin/env node
// Headless end-to-end harness — drives the ENGINE exactly as the widget's main.js does, so the
// chip→regenerate loop can be verified WITHOUT clicking through Electron. runEngine/runFeedback are
// copied verbatim from main.js so the invocation (args, ELECTRON_RUN_AS_NODE, last-line JSON) matches.
//   node widget-lookfeel/desktop-widget/e2e-headless.js
// Plumbing checks are provider-agnostic (pass with or without an LLM); set WRAPITUP_NO_LLM=1 for a
// fast deterministic run. The Electron UI layer (card.html ↔ main.js IPC) is covered separately by the
// syntax + IPC-contract checks; this harness covers the engine sequence the widget drives.
"use strict";
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO = path.join(__dirname, "..", "..");
// Default to the source build; WRAPITUP_ENGINE points the SAME checks at the PACKAGED engine
// (…/resources/app.asar.unpacked/out/cli.js) to prove the shipped engine passes too.
const ENGINE = process.env.WRAPITUP_ENGINE ? path.resolve(process.env.WRAPITUP_ENGINE) : path.join(REPO, "out", "cli.js");

// ---- the widget's exact spawn helpers (copied from main.js) ----
function runEngine(cmd, folder, source, extraArgs) {
  return new Promise((resolve) => {
    let out = "";
    const args = [ENGINE, cmd, "--cwd", folder];
    if (source) args.push("--source", source);
    if (extraArgs) args.push(...extraArgs);
    const p = spawn(process.execPath, args, { cwd: folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").filter(Boolean).pop())); } catch { resolve({ ok: false }); } });
    p.on("error", () => resolve({ ok: false, reason: "spawn failed" }));
  });
}
function runFeedback(folder, event) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENGINE, "feedback", "--cwd", folder], { cwd: folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    p.on("error", () => resolve());
    p.on("close", () => resolve());
    p.stdin.on("error", () => {});
    p.stdin.write(JSON.stringify(event));
    p.stdin.end();
  });
}
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "ignore" });

(async () => {
  let fail = 0;
  const ck = (l, c) => { console.log((c ? "  PASS  " : "  FAIL  ") + l); if (!c) fail++; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wiu-e2e-"));
  sh("git init -q", tmp); sh("git config user.email t@t.t", tmp); sh("git config user.name t", tmp);
  fs.writeFileSync(path.join(tmp, "a.txt"), "v1\n"); sh("git add -A", tmp); sh("git commit -qm init", tmp);
  fs.writeFileSync(path.join(tmp, "a.txt"), "v2 changed\n"); // an in-progress change to wrap

  // 1) widget "Wrap it up" → engine wrap
  const wrap = await runEngine("wrap", tmp, "git");
  ck("wrap → wrote a note", !!(wrap && wrap.ok && wrap.file));

  // 2) widget "Where was I?" → engine resume (the widget copies res.nextPrompt to the clipboard)
  const resume = await runEngine("resume", tmp, undefined, undefined);
  ck("resume → wrapId + a paste-ready nextPrompt (clipboard)", !!(resume && resume.ok && resume.wrapId && resume.nextPrompt));
  const wrapId = resume.wrapId;
  const wrapFile = path.join(tmp, ".wrap-it-up", "wrapups", wrapId + ".md");
  const before = fs.readFileSync(wrapFile, "utf8");

  // 3) the card: tapping "didn't help → wrong files" logs the rating AND fires a regenerate
  await runFeedback(tmp, { kind: "perceived", event_id: "e1", wrap_id: wrapId, perceived_useful: "didnt_help", reason_chip: "wrong_files", respond_vs_dismiss: "responded" });
  const regen = await runEngine("regenerate", tmp, null, ["--wrap-id", wrapId, "--reason", "wrong_files"]);
  ck("regenerate → improved nextPrompt (widget re-copies it)", !!(regen && regen.ok && regen.nextPrompt));

  // 4) the silent swap: same file overwritten in place — NOT a new note
  const mdCount = fs.readdirSync(path.join(tmp, ".wrap-it-up", "wrapups")).filter((f) => f.endsWith(".md")).length;
  ck("note swapped IN PLACE (one .md, same wrapId)", mdCount === 1 && regen.wrapId === wrapId && fs.existsSync(wrapFile));

  // 5) both signals logged, independently
  const feedbackDir = path.join(tmp, ".wrap-it-up", "feedback");
  const lines = (f) => (fs.existsSync(path.join(feedbackDir, f)) ? fs.readFileSync(path.join(feedbackDir, f), "utf8").trim().split("\n").filter(Boolean) : []);
  ck("rating logged (1 row) + regenerate logged (1 row)", lines("feedback.jsonl").length === 1 && lines("regenerations.jsonl").length === 1);

  // 6) "note was fine, I bounced" must NOT regenerate
  const noop = await runEngine("regenerate", tmp, null, ["--wrap-id", wrapId, "--reason", "note_fine_i_bounced"]);
  ck("note_fine_i_bounced → no-op (no regenerate)", !!(noop && noop.ok === false));

  const after = fs.readFileSync(wrapFile, "utf8");
  console.log("  note text: " + (after !== before ? "CHANGED by regenerate (live enrich provider)" : "unchanged (no LLM provider — plumbing-only run)"));

  // 7) BYO-key injection contract: a key in the engine's ENV (exactly what the widget's spawnEnv injects
  // when a stored key exists and the CLI is absent) must drive the API path. With a dummy key + the CLI
  // disabled, the local wrap is still written and enrichment is attempted then fails gracefully — proving
  // the key path is reached, WITHOUT spending real tokens or touching the user's `claude` CLI.
  const keyEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", ANTHROPIC_API_KEY: "sk-ant-dummy-INVALID", WRAPITUP_NO_CLI: "1" };
  delete keyEnv.WRAPITUP_NO_LLM;
  const keyRes = await new Promise((resolve) => {
    let out = "";
    const p = spawn(process.execPath, [ENGINE, "wrap", "--cwd", tmp, "--source", "git"], { cwd: tmp, env: keyEnv });
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").filter(Boolean).pop())); } catch { resolve({ ok: false }); } });
    p.on("error", () => resolve({ ok: false }));
  });
  ck("BYO key: wrap still written with a key in env", !!(keyRes && keyRes.ok && keyRes.file));
  ck("BYO key: API enrichment attempted then failed gracefully (dummy key)",
    !!(keyRes && keyRes.file && /AI enrichment failed/.test(fs.readFileSync(keyRes.file, "utf8"))));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? `\nE2E HARNESS: ${fail} check(s) FAILED` : "\nE2E HARNESS: all checks passed");
  process.exit(fail ? 1 : 0);
})();
