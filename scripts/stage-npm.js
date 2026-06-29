#!/usr/bin/env node
"use strict";
// Staged-publish: assemble a CLEAN, minimal npm package for `npx wrap-it-up` in an OS temp dir, then
// print its path on stdout (progress goes to stderr). `npm pack` / `npm publish` run from THAT dir —
// never the dev repo root, which stays private:true and carries writing/ backtest/ oracle/ northstar/.
// The POSITIVE allowlist below makes the privacy invariant STRUCTURAL: only these files can ever ship.
//   node scripts/stage-npm.js   ->   prints <stage-dir>
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const WIDGET = path.join("widget-lookfeel", "desktop-widget");

// 1) Build the engine fresh — out/ is gitignored, so never assume it exists or is current.
process.stderr.write("[stage] building engine (npm run build)…\n");
// execSync runs through a shell, so Windows resolves npm.cmd (Node >=20 refuses to spawn .cmd directly).
execSync("npm run build", { cwd: REPO, stdio: "inherit" });

// 2) Fresh staging dir under the OS temp root.
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "wiu-stage-"));

function copyFile(rel) {
  const dst = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(REPO, rel), dst);
}
function copyTree(rel, accept) {
  for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
    const childRel = path.join(rel, e.name);
    if (e.isDirectory()) copyTree(childRel, accept);
    else if (!accept || accept(childRel)) copyFile(childRel);
  }
}

// 3) Positive allowlist copy. (.map excluded = privacy: maps embed ../src/cli.ts path structure.)
copyTree("out", (rel) => rel.endsWith(".js") && !rel.endsWith(".test.js") && !/(^|[\\/])selftest\.js$/.test(rel));
copyFile(path.join("bin", "wrap-it-up.js"));
for (const f of ["main.js", "widget.html", "card.html", "prompt.html"]) copyFile(path.join(WIDGET, f));
copyTree(path.join(WIDGET, "assets"));
for (const f of ["README.md", "LICENSE"]) if (fs.existsSync(path.join(REPO, f))) copyFile(f);

// 4) Generated CLEAN manifest — not the dual-identity dev manifest (no VS Code fields, no devDeps).
const electronVersion = String((rootPkg.devDependencies && rootPkg.devDependencies.electron) || "").replace(/^\D*/, "") || "42.4.1";
const manifest = {
  name: "wrap-it-up",
  version: rootPkg.version,
  description: "One-click session wrap-up for AI-assisted coding — save your place when your brain quits.",
  license: "MIT",
  repository: rootPkg.repository,
  bin: { "wrap-it-up": "bin/wrap-it-up.js" },
  main: "bin/wrap-it-up.js",
  engines: { node: ">=18" },
  dependencies: { electron: electronVersion }, // EXACT pin (no caret) — avoids npm deduping to a host's incompatible electron major
  files: [
    "bin/",
    "out/**/*.js",
    "widget-lookfeel/desktop-widget/main.js",
    "widget-lookfeel/desktop-widget/*.html",
    "widget-lookfeel/desktop-widget/assets/",
    "README.md",
    "LICENSE",
  ],
};
fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

process.stderr.write("[stage] clean package staged at:\n");
process.stdout.write(STAGE + "\n");
