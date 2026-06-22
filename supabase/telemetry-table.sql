-- Wrap It Up — opt-in anonymous feedback telemetry.
-- Applied to the user's own Supabase project (via the Supabase MCP `execute_sql`). Idempotent.
--
-- Access model: the widget inserts with the project's PUBLISHABLE anon key. RLS allows anon INSERT
-- ONLY — there is no SELECT/UPDATE/DELETE policy and no SELECT grant, so the anon key cannot read,
-- change, or delete anything. The insert uses PostgREST `Prefer: return=minimal`, so it never reads
-- a row back. Only metadata rows are ever written (no wrap text, next-prompt, code, paths, or chat).
--
-- Abuse bound: because the anon key is public, the INSERT policy validates shape (enumerated values
-- + length caps) so a leaked key can't write arbitrary/huge rows. There is no per-IP rate limit at
-- the DB layer — acceptable for a tiny private beta; revisit (edge function / pg_net) if it scales.

create table if not exists public.feedback_telemetry (
  id                  bigint generated always as identity primary key,
  received_at         timestamptz  not null default now(),  -- server-side receive time
  client_id           text         not null,                -- random per-install id (NOT identifying)
  event_id            text         not null,                -- joins a Clock-1 row to its Clock-2 update
  wrap_id             text,                                  -- ISO-timestamp id only (no path/content)
  event_ts            timestamptz,
  perceived_useful    text,                                  -- didnt_help | oriented | right_back_in | none
  perceived_delay_sec numeric,
  respond_vs_dismiss  text,
  reason_chip         text,                                  -- stale | wrong_files | couldnt_tell | note_fine_i_bounced
  reentry_outcome     text,                                  -- didnt_help | eventually | yes | none
  reentry_delay_sec   numeric,
  recorder_version    text,
  model_version       text,
  fried_flag          boolean,
  time_away_min       numeric,
  session_type        text,
  session_len_min     numeric
);

alter table public.feedback_telemetry enable row level security;

-- anon may INSERT only, and only well-formed rows. No other policy ⇒ no read/update/delete.
drop policy if exists "anon insert only" on public.feedback_telemetry;
create policy "anon insert only" on public.feedback_telemetry
  for insert to anon
  with check (
    length(client_id) between 1 and 80
    and length(event_id) between 1 and 120
    and (wrap_id is null or length(wrap_id) <= 120)
    and (perceived_useful is null or perceived_useful in ('didnt_help','oriented','right_back_in','none'))
    and (respond_vs_dismiss is null or length(respond_vs_dismiss) <= 40)
    and (reason_chip is null or reason_chip in ('stale','wrong_files','couldnt_tell','note_fine_i_bounced'))
    and (reentry_outcome is null or reentry_outcome in ('didnt_help','eventually','yes','none'))
    and (recorder_version is null or length(recorder_version) <= 40)
    and (model_version is null or length(model_version) <= 60)
    and (session_type is null or length(session_type) <= 40)
  );

-- Table-level grants: INSERT only. Deliberately NO SELECT grant, so even with a policy the anon
-- role cannot read rows. (Owner/service_role still reads for analytics, bypassing RLS.)
grant insert on public.feedback_telemetry to anon;

-- Helpful for "distinct testers" and time-bucketed rollups when you read with the service key.
create index if not exists feedback_telemetry_client_idx on public.feedback_telemetry (client_id);
create index if not exists feedback_telemetry_received_idx on public.feedback_telemetry (received_at);
