-- ============================================================
-- Quay 1 — Live Floor stats table (Dialfire today's-calls stream)
-- ============================================================
-- Populated by the local Mac daemon `scripts/live_dialfire_daemon.py`
-- (launched by ~/Library/LaunchAgents/com.quay1.dialfire-live.plist).
-- The daemon upserts every ~90s; the dashboard subscribes to this table
-- via Supabase realtime so call/lead counts on the Live Floor tab
-- update instantly without a page reload.
--
-- One row per agent. staff_id is a lowercase-hyphenated slug of the
-- agent's display name so it lines up with the existing `staff` table.
-- ============================================================

create table if not exists public.live_stats (
  staff_id     text primary key,
  name         text not null,
  calls        integer not null default 0,
  leads        integer not null default 0,
  work_hours   numeric(10, 3) default 0,
  success_rate numeric(5, 2) default 0,
  updated_at   timestamptz not null default now()
);

create index if not exists live_stats_updated_idx on public.live_stats(updated_at desc);

alter table public.live_stats enable row level security;

-- Everyone authenticated can READ — the dashboard depends on this.
drop policy if exists live_stats_select_authn on public.live_stats;
create policy live_stats_select_authn
  on public.live_stats for select
  to authenticated
  using (true);

-- Writes are admin-only (and the daemon uses the service-role key which
-- bypasses RLS anyway). Keeps random authenticated clients from
-- poisoning the live numbers.
drop policy if exists live_stats_admin_write on public.live_stats;
create policy live_stats_admin_write
  on public.live_stats for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Realtime publication: include this table so Supabase pushes inserts
-- and updates to subscribed dashboard clients.
alter publication supabase_realtime add table public.live_stats;

comment on table public.live_stats is
  'Quay 1 Live Floor stream — upserted every ~90s by the local Mac '
  'daemon (scripts/live_dialfire_daemon.py). Subscribed by the dashboard '
  'Live Floor tab via Supabase realtime.';
