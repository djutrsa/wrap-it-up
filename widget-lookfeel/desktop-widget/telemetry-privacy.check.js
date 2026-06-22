#!/usr/bin/env node
// Privacy self-test for opt-in telemetry. Proves the outbound payload is metadata-only and that a
// polluted feedback event CANNOT leak wrap text / code / the next-prompt. Pure + offline (no network).
//   node widget-lookfeel/desktop-widget/telemetry-privacy.check.js
"use strict";
const path = require("path");
const { anonymize, validConfig, sendTelemetry, TELEMETRY_FIELDS } = require(path.join(__dirname, "..", "..", "out", "core", "telemetry.js"));

let fail = 0;
const ck = (l, c) => { console.log((c ? "  PASS  " : "  FAIL  ") + l); if (!c) fail++; };

// A feedback row deliberately polluted with fields that must NEVER leave the machine.
const polluted = {
  event_id: "e1", wrap_id: "2026-06-21T10-00-00", wrs_score: null, event_ts: "2026-06-21T10:00:00Z",
  perceived_useful: "didnt_help", perceived_delay_sec: 3, respond_vs_dismiss: "responded",
  reason_chip: "wrong_files", reentry_outcome: "yes", reentry_outcome_ts: "x", reentry_delay_sec: 5,
  recorder_version: "northstar", model_version: "opus", session_context: { fried_flag: true, time_away_min: 30, session_type: "deep", session_len_min: 90 },
  // --- forbidden: these are what an accidental spread would leak ---
  wrap_text: "SECRET WRAP BODY", next_prompt: "paste-ready next prompt with code", code: "const KEY='sk-live-xxx'",
  changedFileContents: [{ uri: "a.ts", text: "secret source" }], conversation: [{ role: "user", text: "private chat" }],
  _telemetry: { url: "https://x.supabase.co", anonKey: "should-not-echo" },
};

const row = anonymize(polluted, "client-123");
const keys = Object.keys(row).sort();
ck("payload keys == the allowlist exactly (no extras)", JSON.stringify(keys) === JSON.stringify([...TELEMETRY_FIELDS].sort()));

const blob = JSON.stringify(row);
const forbidden = ["SECRET WRAP BODY", "paste-ready next prompt", "sk-live-xxx", "secret source", "private chat", "should-not-echo"];
ck("no wrap text / code / next-prompt / chat / key leaked", forbidden.every((s) => !blob.includes(s)));
ck("metadata carried through (rating, chip, reentry, client_id)", row.perceived_useful === "didnt_help" && row.reason_chip === "wrong_files" && row.reentry_outcome === "yes" && row.client_id === "client-123");
ck("session flags carried (not the raw context object)", row.fried_flag === true && row.session_len_min === 90 && !("session_context" in row));

ck("validConfig rejects empty / partial", !validConfig(null) && !validConfig({ url: "https://x.supabase.co" }) && !validConfig({ url: "http://evil.com", anonKey: "x".repeat(40), clientId: "c" }));
ck("validConfig accepts a well-formed config", validConfig({ url: "https://abcd.supabase.co", anonKey: "x".repeat(40), clientId: "c" }));

(async () => {
  const r = await sendTelemetry(row, null); // no config → must be a silent no-op, never a throw
  ck("sendTelemetry with no config is a no-op (no network, no throw)", r && r.ok === false);
  console.log(fail ? `\nTELEMETRY PRIVACY: ${fail} check(s) FAILED` : "\nTELEMETRY PRIVACY: all checks passed");
  process.exit(fail ? 1 : 0);
})();
