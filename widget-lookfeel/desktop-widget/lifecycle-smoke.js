#!/usr/bin/env node
// Headless lifecycle smoke — proves the "stays up" behaviors WITHOUT any clicking, by launching
// Electron with main.js's --smoke modes in throwaway --user-data-dirs. Each mode prints a single
// last-line JSON object (same discipline as the engine) which we parse.
//   node widget-lookfeel/desktop-widget/lifecycle-smoke.js
// Covers: boot (starts + tray), single-instance (2nd launch exits, 1st survives), detached survival
// (lives independent of the launching parent), crash-recreate (renderer crash → window rebuilt).
"use strict";
const { spawn, execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const electronPath = require("electron"); // the npm 'electron' module exports the binary path
const MAIN = path.join(__dirname, "main.js");

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "wiu-smoke-" + tag + "-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function killTree(pid) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(pid);
  } catch { /* already gone */ }
}
function lastJson(s) {
  const lines = String(s).trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep scanning */ } }
  return null;
}
const launch = (args, ud, detached) =>
  spawn(electronPath, [MAIN, ...args, "--user-data-dir=" + ud], { stdio: ["ignore", "pipe", "pipe"], detached: !!detached });
function collect(child, timeoutMs) {
  return new Promise((resolve) => {
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ timedOut: true, out, err, code: null }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ timedOut: false, out, err, code }); });
  });
}

(async () => {
  let fail = 0;
  const ck = (label, cond, extra) => { console.log((cond ? "  PASS  " : "  FAIL  ") + label + (!cond && extra ? "  " + extra : "")); if (!cond) fail++; };

  // 1) boot — starts, tray created, clean exit
  {
    const r = await collect(launch(["--smoke=boot"], tmp("boot")), 25000);
    const j = lastJson(r.out);
    ck("boot: starts + tray created + clean exit", !!(j && j.ok && j.check === "boot" && j.tray) && r.code === 0,
      JSON.stringify({ code: r.code, j, err: r.err.slice(-200) }));
  }

  // 2) single-instance — a 2nd launch on the SAME userData exits; the 1st survives
  {
    const ud = tmp("single");
    const a = launch(["--smoke=hold"], ud);
    let aout = ""; a.stdout.on("data", (d) => (aout += d)); a.stderr.on("data", () => {});
    for (let i = 0; i < 80 && !/"hold"/.test(aout); i++) await sleep(150); // wait until A holds the lock
    const rb = await collect(launch(["--smoke=hold"], ud), 15000);
    ck("single-instance: 2nd launch exits via the lock", /second-instance-exits/.test(rb.out) && !rb.timedOut,
      JSON.stringify({ code: rb.code, out: rb.out.slice(-160) }));
    ck("single-instance: 1st instance still alive", alive(a.pid));
    killTree(a.pid);
  }

  // 3) detached survival — launched detached+unref'd, lives independent of this parent
  {
    const a = launch(["--smoke=hold"], tmp("detach"), true);
    const pid = a.pid;
    a.unref();
    a.stdout.on("data", () => {}); a.stderr.on("data", () => {}); // don't tether the event loop
    await sleep(4000);
    ck("detached: survives independent of the launching parent", alive(pid));
    killTree(pid);
  }

  // 4) crash-recreate — force-crash the renderer; the widget window is rebuilt
  {
    const r = await collect(launch(["--smoke=crash"], tmp("crash")), 18000);
    const j = lastJson(r.out);
    ck("crash: widget recreated after a forced renderer crash", !!(j && j.ok && j.check === "window-recreated"),
      JSON.stringify({ code: r.code, j, err: r.err.slice(-160) }));
  }

  console.log(fail ? `\nLIFECYCLE SMOKE: ${fail} check(s) FAILED` : "\nLIFECYCLE SMOKE: all checks passed");
  process.exit(fail ? 1 : 0);
})();
