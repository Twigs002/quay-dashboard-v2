-- Team Reports · recipient subscriptions
-- Backs the Monday-morning per-team lead-gen email (Python emailer at
-- market-analysis-reports/src/weekly_team_report_email.py) and the
-- subscribers CRUD panel in the Teams Reporting tab of quay-dashboard-v2.
--
-- Data model:
--   - email:                recipient's inbox
--   - name:                 friendly greeting name (optional)
--   - teams:                canonical team names they get stats for
--                           (matches LN_TEAMS_ALL / normalizeCampaignName
--                           output, e.g. 'Babes', 'Amigos', 'Assassins')
--   - active:               false = paused, cron skips this row
--   - send_last_week:       include last-week block in the email
--   - send_month_to_date:   include month-to-date block in the email
--   - notes:                free-text scratch pad for supers (e.g. "team
--                           leader on leave until Mon")
--
-- RLS: SELECT/INSERT/UPDATE/DELETE all gated on staff.is_super — mirrors
-- the payroll_canonical_divisions pattern in schema_payroll_config.sql.

create table if not exists public.team_report_recipients (
  id                  uuid primary key default gen_random_uuid(),
  email               text        not null,
  name                text        null,
  teams               text[]      not null default '{}'::text[],
  active              boolean     not null default true,
  send_last_week      boolean     not null default true,
  send_month_to_date  boolean     not null default false,
  notes               text        null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid        null references auth.users(id) on delete set null,

  constraint team_report_recipients_email_unique unique (email)
);

comment on table  public.team_report_recipients is
  'Weekly Monday-morning per-team stats email subscriptions. Managed by supers.';
comment on column public.team_report_recipients.teams is
  'Canonical team names (e.g. "Babes", "Amigos") — subset of LN_TEAMS_ALL.';

-- Auto-touch updated_at on any UPDATE
create or replace function public.team_report_recipients_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists team_report_recipients_touch on public.team_report_recipients;
create trigger team_report_recipients_touch
  before update on public.team_report_recipients
  for each row
  execute function public.team_report_recipients_touch_updated_at();

-- RLS: gate everything on is_super
alter table public.team_report_recipients enable row level security;

drop policy if exists team_report_recipients_select_super on public.team_report_recipients;
create policy team_report_recipients_select_super on public.team_report_recipients
  for select to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

drop policy if exists team_report_recipients_insert_super on public.team_report_recipients;
create policy team_report_recipients_insert_super on public.team_report_recipients
  for insert to authenticated with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

drop policy if exists team_report_recipients_update_super on public.team_report_recipients;
create policy team_report_recipients_update_super on public.team_report_recipients
  for update to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

drop policy if exists team_report_recipients_delete_super on public.team_report_recipients;
create policy team_report_recipients_delete_super on public.team_report_recipients
  for delete to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

-- Service-role (used by the Python emailer via SUPABASE_SERVICE_KEY) has
-- BYPASSRLS so no separate policy needed.
