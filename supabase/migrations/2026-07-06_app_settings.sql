-- app_settings: single-row key/value store for operator-controlled toggles
-- shared by the dashboard and the Mac-hosted launchd emailer.
--
-- Current keys (as of 2026-07-06):
--   weekly_email_fire_request  ISO timestamp written by the dashboard's
--                              Fire-now button. The fire-watcher launchd
--                              agent polls this every 2 minutes and, on
--                              any value change, runs the weekly emailer
--                              as a DRAFT job (never sends).
--
-- Explicitly NO auto-send toggle. Per user policy every batch stays as
-- drafts until Pagan sends manually from Gmail. Do not add a
-- weekly_email_auto_send key here.

create table if not exists public.app_settings (
  key         text primary key,
  value       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- Touch updated_at on write so the fire-watcher can distinguish a real
-- write from a heartbeat re-select.
create or replace function public.touch_app_settings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.touch_app_settings_updated_at();

-- RLS: read + write gated on super_admin. The fire-watcher on Pagan's
-- Mac uses the service-role key so it bypasses RLS.
alter table public.app_settings enable row level security;

drop policy if exists app_settings_select_super on public.app_settings;
create policy app_settings_select_super on public.app_settings
  for select to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid()
              and (is_super = true or designation = 'super_admin'))
  );

drop policy if exists app_settings_write_super on public.app_settings;
create policy app_settings_write_super on public.app_settings
  for all to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid()
              and (is_super = true or designation = 'super_admin'))
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid()
              and (is_super = true or designation = 'super_admin'))
  );

-- Seed the fire-request key with an empty string so the fire-watcher's
-- first read has something to compare against.
insert into public.app_settings (key, value)
values ('weekly_email_fire_request', '')
on conflict (key) do nothing;
