#!/usr/bin/env node
"use strict";
// `npx wrap-it-up` entry point — launch the real Electron widget from the terminal, auto-watching the
// current folder. This is the zero-install TRIAL door; the packaged installer is still the always-on
// product (this can't auto-start at login). First run downloads the Electron runtime (~150MB, cached
// after that). Works the same from the dev repo (bin/ -> ../widget-lookfeel/...) and the published
// package (node_modules/wrap-it-up/bin/ -> ../widget-lookfeel/...) — identical relative geometry.
const { spawn } = require("child_process");
const path = require("path");

let electronPath;
try {
  electronPath = require("electron"); // under plain node this resolves to the Electron binary PATH (a string)
} catch (e) {
  console.error(
    "Wrap It Up: the Electron runtime failed to install.\n" +
      "Retry `npx wrap-it-up@latest`, or set ELECTRON_MIRROR if you're behind a proxy.\n" +
      String((e && e.message) || e)
  );
  process.exit(1);
}
if (typeof electronPath !== "string") {
  console.error("Wrap It Up: could not resolve the Electron binary (require('electron') returned a non-string).");
  process.exit(1);
}

const main = path.join(__dirname, "..", "widget-lookfeel", "desktop-widget", "main.js");
// Inject `--project <cwd>` FIRST (the terminal's folder = the project to watch), then forward any
// user/test args (--smoke=…, --user-data-dir=…, --hidden). The widget's seedProjectFromArgv reads it.
const args = [main, "--project", process.cwd(), ...process.argv.slice(2)];

const child = spawn(electronPath, args, { stdio: "inherit", windowsHide: false });
child.on("close", (code) => process.exit(code == null ? 0 : code)); // surface smoke/single-instance exit codes
child.on("error", (err) => {
  console.error("Wrap It Up: failed to launch Electron:", err && err.message);
  process.exit(1);
});
