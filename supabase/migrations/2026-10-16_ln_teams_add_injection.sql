-- ln_teams - add the ASB / SS / WSB Injection teams
-- =================================================================
-- NEEDS APPLYING BY HAND. Run in the Supabase SQL Editor for the shared
-- project dqszbqiimbfvmmnpgpsb. Idempotent (on conflict do nothing).
--
-- ROSTER CHANGE - CONFIRM WITH PAGAN FIRST. Specifically confirm the Injection
-- teams belong in the LN roster (they drive the LN Stats picker + the weekly
-- team-report emailer), not only in payroll. If they are payroll-only, apply
-- 2026-10-16_payroll_divisions_seed_fixup.sql and SKIP this file.
--
-- WHY (audit P1, 2026-10-16):
--   public.ln_teams is the single source of truth for the LN roster (mirrored
--   by LN_TEAMS_FALLBACK in quay/data.js and ROSTER_FALLBACK in
--   scripts/refresh_clienthub_owners.py / the weekly emailer). It was seeded
--   with 70 teams and never got the three Injection teams that exist in the
--   clock CLOCK_CAMPAIGNS_ALL.
--
-- display_order continues after the seeded max (70) so they sort to the end.
--
-- VERIFY AFTER APPLYING:
--   select name, display_order, active from public.ln_teams
--     where name in ('ASB Injection','SS Injection','WSB Injection')
--     order by display_order;
--   -> three rows, active=true. Reload the LN Stats picker to confirm.
-- =================================================================

insert into public.ln_teams (name, display_order) values
  ('ASB Injection', 71),
  ('SS Injection',  72),
  ('WSB Injection', 73)
on conflict (name) do nothing;
