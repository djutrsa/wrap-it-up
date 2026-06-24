// Use the Kiro CLI as a HEADLESS model provider for wrap enrichment — the local-and-free path for a
// Kiro user who has NEITHER the Claude Code CLI NOR an ANTHROPIC_API_KEY. Runs on the user's existing
// Kiro login (no key of ours):
//     kiro-cli chat "<prompt>" --no-interactive --trust-tools=
// answers directly (no tool wandering), in plain text. Kiro has no structured-output/tool mode, so we
// ask for JSON in the prompt, strip the terminal chrome (ANSI escapes, the "> " prefix, the trailing
// "Credits/Time" footer), and parse the JSON object out. Best-effort — less reliable than Claude's
// forced tool-schema, but far better than no enrichment (a chat-blind, deterministic wrap).
//
// This is the Kiro CLI as a MODEL; it's unrelated to src/kiro.ts (which reads Kiro CLI SESSIONS).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

// Locate the kiro-cli binary: explicit override, then PATH, then the known per-OS install location.
function kiroBin(): string | null {
  if (process.env.WRAPITUP_KIRO_BIN) return process.env.WRAPITUP_KIRO_BIN;
  const exe = process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    try { const p = path.join(d, exe); if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  const cands: string[] = [];
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    cands.push(path.join(la, "Kiro-Cli", "kiro-cli.exe"));
  } else {
    cands.push(path.join(os.homedir(), ".local", "bin", "kiro-cli"));
    cands.push("/usr/local/bin/kiro-cli");
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

export function hasKiroCli(): boolean { return !!kiroBin(); }

// Strip ANSI/OSC terminal escapes, then pull the outermost balanced {...} JSON object out of Kiro's
// answer (it prints a "> " prefix and a "Credits/Time" footer around the model's text). String-aware
// brace matching so a "}" inside a JSON string value doesn't end the object early. Exported for tests.
export function extractJsonFromKiroOutput(raw: string): string {
  const text = String(raw || "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");        // CSI sequences (colors, cursor moves)
  const start = text.indexOf("{");
  if (start < 0) return text.trim();
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start).trim();
}

// One headless kiro-cli enrichment. Resolves { obj, model } or rejects (the caller falls through to
// the next provider / the local wrap). The prompt is passed as a single argv element with shell:false,
// so nothing user-derived is shell-interpreted (no injection, no DEP0190).
export function callKiroCli(system: string, user: string, model?: string): Promise<{ obj: any; model: string }> {
  return new Promise((resolve, reject) => {
    const bin = kiroBin();
    if (!bin) return reject(new Error("kiro-cli not found"));
    const prompt = system + "\n\n--- SESSION EVIDENCE (ground ONLY in this) ---\n\n" + user;
    const args = ["chat", prompt, "--no-interactive", "--trust-tools="];
    if (model && /^[\w.\-:]+$/.test(model)) args.push("--model", model);

    let child;
    try { child = spawn(bin, args, { shell: false, env: process.env }); }
    catch (e) { return reject(e); }

    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } reject(new Error("kiro-cli timed out")); }, 120_000);
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`kiro-cli exit ${code}: ${(err || out).replace(/\s+/g, " ").slice(-300)}`));
      let obj: any;
      try { obj = JSON.parse(extractJsonFromKiroOutput(out)); }
      catch { return reject(new Error("kiro-cli returned unparseable output")); }
      resolve({ obj, model: model || "kiro-cli" });
    });
    try { child.stdin.end(); } catch { /* ignore */ } // --no-interactive reads the arg, not stdin
  });
}
