-- Lock each staff member's Quay 1 app access (staff.allowed_sites) to their
-- designation. The dashboard now writes this column from the designation on
-- every staff save (see APP_ACCESS_BY_DESIGNATION in quay/app.js); this
-- migration backfills the mapping for existing rows so managers / payroll /
-- brokers get the right switcher entries without a manual re-save.
--
--   super_admin   -> dashboard, leads, hubspot, boarding, polar, invoicing
--                    (supers also see everything via the switcher's isSuper
--                     path; the full list is stored for cross-app robustness)
--   manager (Admin)-> dashboard, boarding
--   payroll        -> dashboard, invoicing (broker invoicing)
--   broker         -> polar (Polar Push only)
--   senior_broker  -> polar, boarding
--
-- Scope: ONLY the five designations above, and ONLY rows that are NOT a
-- dedicated broker login (is_broker=true). Those live on the super-only
-- Brokers sub-tab and keep their hand-picked app grants (e.g. HubSpot) — they
-- must not be clobbered here. Plain caller/support designations are left
-- untouched. Idempotent: safe to run more than once.
--
-- Type-agnostic: staff.allowed_sites was created outside this repo's migration
-- history, so we detect whether it is a Postgres array (text[]) or jsonb and
-- write the matching literal.

do $$
declare
  col_type text;
begin
  select data_type into col_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'staff' and column_name = 'allowed_sites';

  if col_type is null then
    raise notice 'public.staff.allowed_sites not found — skipping app-access backfill';
    return;
  end if;

  if col_type = 'ARRAY' then
    update public.staff set allowed_sites = ARRAY['dashboard','leads','hubspot','boarding','polar','invoicing']::text[]
      where lower(designation) = 'super_admin'   and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = ARRAY['dashboard','boarding']::text[]
      where lower(designation) = 'manager'       and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = ARRAY['dashboard','invoicing']::text[]
      where lower(designation) = 'payroll'       and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = ARRAY['polar']::text[]
      where lower(designation) = 'broker'        and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = ARRAY['polar','boarding']::text[]
      where lower(designation) = 'senior_broker' and coalesce(is_broker, false) = false;
  else
    -- jsonb (or json, which accepts a jsonb literal by assignment cast)
    update public.staff set allowed_sites = '["dashboard","leads","hubspot","boarding","polar","invoicing"]'::jsonb
      where lower(designation) = 'super_admin'   and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = '["dashboard","boarding"]'::jsonb
      where lower(designation) = 'manager'       and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = '["dashboard","invoicing"]'::jsonb
      where lower(designation) = 'payroll'       and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = '["polar"]'::jsonb
      where lower(designation) = 'broker'        and coalesce(is_broker, false) = false;
    update public.staff set allowed_sites = '["polar","boarding"]'::jsonb
      where lower(designation) = 'senior_broker' and coalesce(is_broker, false) = false;
  end if;
end $$;
