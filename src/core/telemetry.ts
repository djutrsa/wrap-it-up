// Opt-in anonymous telemetry. When the developer has turned on "share anonymous usage data"
// (widget menu), the `feedback` command forwards ONLY the already-metadata feedback row plus an
// anonymous per-install client_id to a Supabase table. It NEVER sends wrap text, the next-prompt,
// code, file contents, paths, the ctx sidecar, or the conversation.
//
// The privacy guarantee is the `anonymize()` allowlist below: it constructs the outbound row field
// by field from a closed set. Anything not named there CANNOT leave — adding a field is the only
// way to widen the payload, so the choke point is one reviewable function. The transport is a plain
// PostgREST insert with the project's publishable anon key; RLS allows anon INSERT only (no reads),
// and `Prefer: return=minimal` means the insert never reads a row back.

import { FeedbackEvent } from "./feedback";

export interface TelemetryConfig {
  url: string; // https://<ref>.supabase.co  (project URL)
  anonKey: string; // publishable anon key — RLS restricts it to INSERT-only, so it is safe to ship
  clientId: string; // random per-install UUID — NOT identifying, just groups one install's rows
}

// The exact, closed set of fields allowed off the machine. All metadata; no free text from the wrap.
export interface TelemetryRow {
  client_id: string;
  event_id: string;
  wrap_id: string; // an ISO-timestamp id (no path, no content) — lets Clock-1 and Clock-2 rows join
  event_ts: string;
  perceived_useful: string;
  perceived_delay_sec: number | null;
  respond_vs_dismiss: string;
  reason_chip: string | null;
  reentry_outcome: string | null;
  reentry_delay_sec: number | null;
  recorder_version: string | null;
  model_version: string | null;
  fried_flag: boolean | null;
  time_away_min: number | null;
  session_type: string | null;
  session_len_min: number | null;
}

// The ONLY keys that may appear in an outbound row. Exported so a test can assert the payload never
// grows beyond it.
export const TELEMETRY_FIELDS: (keyof TelemetryRow)[] = [
  "client_id", "event_id", "wrap_id", "event_ts", "perceived_useful", "perceived_delay_sec",
  "respond_vs_dismiss", "reason_chip", "reentry_outcome", "reentry_delay_sec", "recorder_version",
  "model_version", "fried_flag", "time_away_min", "session_type", "session_len_min",
];

// Build the outbound row from the allowlist ONLY. Any extra property on `ev` (now or added later)
// is structurally dropped — it is never copied across.
export function anonymize(ev: FeedbackEvent, clientId: string): TelemetryRow {
  const sc = ev.session_context || ({} as FeedbackEvent["session_context"]);
  return {
    client_id: clientId,
    event_id: ev.event_id,
    wrap_id: ev.wrap_id,
    event_ts: ev.event_ts,
    perceived_useful: ev.perceived_useful,
    perceived_delay_sec: ev.perceived_delay_sec,
    respond_vs_dismiss: ev.respond_vs_dismiss,
    reason_chip: ev.reason_chip,
    reentry_outcome: ev.reentry_outcome,
    reentry_delay_sec: ev.reentry_delay_sec,
    recorder_version: ev.recorder_version,
    model_version: ev.model_version,
    fried_flag: sc.fried_flag,
    time_away_min: sc.time_away_min,
    session_type: sc.session_type,
    session_len_min: sc.session_len_min,
  };
}

export function validConfig(c: any): c is TelemetryConfig {
  return !!(
    c &&
    typeof c.url === "string" &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(c.url) &&
    typeof c.anonKey === "string" &&
    c.anonKey.length > 20 &&
    typeof c.clientId === "string" &&
    c.clientId.length > 0
  );
}

// Fire-and-forget insert. NEVER throws — telemetry must never break the feedback write or the
// widget. Returns a small result for tests. Awaited by the caller so the short-lived `feedback`
// process doesn't exit before the POST flushes. A missing/invalid config is a silent no-op.
export async function sendTelemetry(
  row: TelemetryRow,
  config: any
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!validConfig(config)) return { ok: false, error: "no/invalid telemetry config" };
  const endpoint = config.url.replace(/\/$/, "") + "/rest/v1/feedback_telemetry";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: "Bearer " + config.anonKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal", // no SELECT-after-insert → anon needs (and gets) no read access
      },
      body: JSON.stringify(row),
    });
    return { ok: res.ok, status: res.status };
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
