#!/usr/bin/env node
"use strict";
// Headless gate for the `npx wrap-it-up` distribution — proves every npx base WITHOUT publishing to
// npm or pushing to public main. Run before any publish:
//   node widget-lookfeel/desktop-widget/npx-smoke.js     (or: npm run npx:smoke)
// Covers: staged-publish builds a CLEAN package · the privacy allowlist holds (no src/, private dirs,
// .map/.ts/.test) · the tarball installs with electron-as-dependency · the engine resolves in the
// node_modules layout · the bin shim + launcher boot the widget · `--project` seeds the cwd (and the
// guard: nothing is written without it) · the app identity is unified to 'wrap-it-up' · the SHIPPED
// engine produces a real wrap. The dummy-key enrichment path is NOT covered here (it needs live
// network + is engine-level, not npx) — e2e-headless.js covers the engine separately.
const { spawnSync, spawn, execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const REPO = path.join(__dirname, "..", "..");
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "wiu-npx-" + tag + "-"));
function lastJson(s) { const L = String(s).trim().split("\n").filter(Boolean); for (let i = L.length - 1; i >= 0; i--) { try { return JSON.parse(L[i]); } catch {} } return null; }
function collect(child, ms) { return new Promise((res) => { let out = "", err = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d)); const t = setTimeout(() => { try { child.kill(); } catch {} res({ timedOut: true, out, err, code: null }); }, ms); child.on("close", (c) => { clearTimeout(t); res({ timedOut: false, out, err, code: c }); }); }); }

(async () => {
  let fail = 0;
  const trash = [];
  const ck = (l, c, x) => { console.log((c ? "  PASS  " : "  FAIL  ") + l + (!c && x ? "  " + x : "")); if (!c) fail++; };

  // 1) stage (builds engine fresh + assembles the clean package) → 2) pack
  const STAGE = String(spawnSync("node", [path.join(REPO, "scripts", "stage-npm.js")], { encoding: "utf8", cwd: REPO }).stdout).trim().split("\n").filter(Boolean).pop();
  trash.push(STAGE);
  const packed = spawnSync("npm", ["pack", "--json"], { encoding: "utf8", cwd: STAGE, shell: true });
  let files = [], tarball = null;
  try { const j = JSON.parse(packed.stdout); files = (j[0].files || []).map((f) => f.path); tarball = path.join(STAGE, j[0].filename); } catch {}
  ck("stage + pack: clean tarball built", !!(STAGE && tarball && fs.existsSync(tarball) && files.length), JSON.stringify({ STAGE, n: files.length }));

  // 3) privacy gate — positive allowlist + explicit deny
  const DENY = /(^|\/)(src|writing|backtest|oracle|northstar|supabase|brag-output|\.wrap-it-up)\//i;
  const DENYEXT = /\.(ts|map|vsix)$|\.test\.js$|(^|\/)tsconfig\.json$|(^|\/)electron-builder\.yml$|node_modules\//i;
  const leaked = files.filter((f) => DENY.test(f) || DENYEXT.test(f));
  ck("privacy: no source/private/map files in tarball", leaked.length === 0, "leaked: " + leaked.join(", "));

  // 4) install the tarball into a throwaway project (pulls electron-as-dependency from cache)
  const PROJ = tmp("inst"); trash.push(PROJ);
  fs.writeFileSync(path.join(PROJ, "package.json"), JSON.stringify({ name: "wiu-npx-test", version: "1.0.0", private: true }));
  const inst = spawnSync("npm", ["install", tarball, "--no-audit", "--no-fund"], { encoding: "utf8", cwd: PROJ, shell: true, timeout: 480000 });
  const wiuRoot = path.join(PROJ, "node_modules", "wrap-it-up");
  const engine = path.join(wiuRoot, "out", "cli.js");
  const installedBin = path.join(wiuRoot, "bin", "wrap-it-up.js");
  const installedMain = path.join(wiuRoot, "widget-lookfeel", "desktop-widget", "main.js");
  const binShim = path.join(PROJ, "node_modules", ".bin", "wrap-it-up" + (process.platform === "win32" ? ".cmd" : ""));
  ck("install: package + engine + bin shim present", inst.status === 0 && fs.existsSync(engine) && fs.existsSync(binShim), JSON.stringify({ status: inst.status, err: String(inst.stderr).slice(-280) }));

  const run = (file, args, ms, extra) => collect(spawn("node", [file, ...args, "--user-data-dir=" + tmp("ud")], { cwd: PROJ, stdio: ["ignore", "pipe", "pipe"], ...extra }), ms);

  // 5) launcher boots the widget (tray decodes, clean exit) — proves engine-path geometry + assets
  { const { out, code, err } = await run(installedBin, ["--smoke=boot"], 60000); const j = lastJson(out); ck("launcher: boot ok + tray + exit 0", !!(j && j.ok && j.check === "boot" && j.tray) && code === 0, JSON.stringify({ code, j, err: String(err).slice(-160) })); }

  // 6) menu builds headlessly
  { const { out } = await run(installedBin, ["--smoke=menudump"], 60000); const j = lastJson(out); ck("launcher: menu builds (items present)", !!(j && j.ok && j.check === "menudump" && Array.isArray(j.items) && j.items.length > 3), JSON.stringify({ n: j && j.items && j.items.length })); }

  // 7) --project seeds the cwd as the watched folder + identity unified to 'wrap-it-up'
  { const { out } = await run(installedBin, ["--smoke=udpath"], 60000); const j = lastJson(out); ck("launcher: --project seeds cwd + name 'wrap-it-up'", !!(j && j.ok && j.folder && path.resolve(j.folder) === path.resolve(PROJ) && j.name === "wrap-it-up"), JSON.stringify({ j })); }

  // 8) guard: running main.js WITHOUT --project (the installed-app case) writes no folder
  { const electronBin = require(path.join(PROJ, "node_modules", "electron")); const { out } = await collect(spawn(electronBin, [installedMain, "--smoke=udpath", "--user-data-dir=" + tmp("ud")], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }), 60000); const j = lastJson(out); ck("guard: no --project ⇒ no folder written", !!(j && j.ok && !j.folder), JSON.stringify({ j })); }

  // 9) the npm-generated bin shim (.cmd on Windows) launches
  { const r = await collect(spawn(binShim, ["--smoke=boot", "--user-data-dir=" + tmp("ud")], { cwd: PROJ, stdio: ["ignore", "pipe", "pipe"], shell: true }), 60000); const j = lastJson(r.out); ck("npm bin shim launches", !!(j && j.ok && j.check === "boot"), JSON.stringify({ code: r.code, j, err: String(r.err).slice(-160) })); }

  // 10) the SHIPPED engine produces a real wrap (deterministic, no network)
  { const G = tmp("git"); trash.push(G); try { execSync("git init -q", { cwd: G, stdio: "ignore" }); execSync('git config user.email t@t.t', { cwd: G, stdio: "ignore" }); execSync('git config user.name t', { cwd: G, stdio: "ignore" }); fs.writeFileSync(path.join(G, "a.txt"), "v1\n"); execSync("git add -A", { cwd: G, stdio: "ignore" }); execSync('git commit -qm init', { cwd: G, stdio: "ignore" }); fs.writeFileSync(path.join(G, "a.txt"), "v2 changed\n"); } catch {}
    const w = spawnSync("node", [engine, "wrap", "--cwd", G, "--source", "git"], { encoding: "utf8", env: { ...process.env, WRAPITUP_NO_LLM: "1", ELECTRON_RUN_AS_NODE: "1" }, timeout: 60000 });
    const j = lastJson(w.stdout); ck("shipped engine: wrote a wrap note", !!(j && j.ok && j.file && fs.existsSync(j.file)), JSON.stringify({ status: w.status, j, err: String(w.stderr).slice(-160) })); }

  for (const d of trash) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  console.log(fail ? `\nNPX SMOKE: ${fail} check(s) FAILED` : "\nNPX SMOKE: all checks passed");
  process.exit(fail ? 1 : 0);
})();
