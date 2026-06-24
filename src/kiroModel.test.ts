// Test for the Kiro-CLI-as-model output parsing (src/kiroModel.ts). The risky part is pulling clean
// JSON out of Kiro's headless chat output, which wraps the answer in terminal chrome: ANSI color /
// cursor escapes, a "> " prompt prefix, and a trailing "Credits / Time" footer. Pure + offline (no
// kiro-cli spawn). Run via `npm test`.

import * as assert from "assert";
import { extractJsonFromKiroOutput } from "./kiroModel";

const E = "\x1b"; // ESC

// A realistic raw capture: warning line + cursor-hide + "> " prefix + the JSON + credits footer, all
// dusted with ANSI. The JSON deliberately contains a NESTED object and a "}" INSIDE a string value, so
// a naive "first } ends it" parser would truncate.
const raw =
  `${E}[38;5;11mWARNING: ${E}[0m--trust-tools arg needs a prefix\n\n` +
  `${E}[?25l${E}[38;5;141m> ${E}[0m{"status":"Working","title":"theme switcher","meta":{"n":7},"whatBroke":["a closing } brace in text"]}${E}[0m${E}[0m\n` +
  `${E}[38;5;8m\n ▸ Credits: 0.04 • Time: 2s\n\n${E}[0m${E}[1G${E}[?25h`;

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log("  ok   " + name); }
  catch (e: any) { failures++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
};

console.log("Kiro model (CLI enrichment) parsing test:");

check("extracts clean, parseable JSON from chromed output", () => {
  const json = extractJsonFromKiroOutput(raw);
  const o = JSON.parse(json); // must not throw
  assert.strictEqual(o.status, "Working");
  assert.strictEqual(o.title, "theme switcher");
});
check("string-aware brace matching keeps a '}' inside a value", () => {
  const o = JSON.parse(extractJsonFromKiroOutput(raw));
  assert.deepStrictEqual(o.whatBroke, ["a closing } brace in text"]);
  assert.strictEqual(o.meta.n, 7); // nested object survived
});
check("no ANSI escapes survive in the extracted JSON", () => {
  assert.ok(extractJsonFromKiroOutput(raw).indexOf(E) < 0, "ESC leaked into output");
});
check("handles a ```json fenced answer too", () => {
  const fenced = `${E}[0mHere you go:\n\`\`\`json\n{"status":"Broken","ok":false}\n\`\`\`\n`;
  const o = JSON.parse(extractJsonFromKiroOutput(fenced));
  assert.strictEqual(o.status, "Broken");
});
check("no-JSON output degrades gracefully (no throw)", () => {
  const r = extractJsonFromKiroOutput(`${E}[31msome error, no json here${E}[0m`);
  assert.strictEqual(typeof r, "string"); // returns text; the caller's JSON.parse will reject → fall through
});

if (failures) { console.log("\n" + failures + " check(s) FAILED"); process.exit(1); }
console.log("\nAll Kiro model parsing checks passed.");
