-- Quay payroll - fix the canonical-divisions roster in the live table
-- =================================================================
-- NEEDS APPLYING BY HAND, AFTER A QUICK CHECK. Run in the Supabase SQL Editor
-- for the shared project dqszbqiimbfvmmnpgpsb. Idempotent (upsert + targeted
-- update), so a re-run is safe.
--
-- ROSTER CHANGE - CONFIRM THE TEAM LIST WITH PAGAN FIRST. Before applying,
-- eyeball the live table:
--   select name, display_order, active from public.payroll_canonical_divisions
--   order by display_order;
--
-- WHY (audit P1, 2026-10-16):
--   payroll.js (around line 213) REPLACES its in-code CANONICAL_TEAMS list with
--   the rows in public.payroll_canonical_divisions at runtime. The live seed
--   (schema_payroll_config.sql:228-295) is missing several teams the JS list
--   already carries, so payroll buckets their hours under "Not in master list -
--   review", and it still marks Rebels active even though that team is archived.
--   This also feeds the quay-clock admin timesheet team picker, which is why
--   the Injection teams were invisible there too.
--
-- WHAT THIS DOES:
--   * Adds the 7 teams present in payroll.js CANONICAL_TEAMS but absent from the
--     live seed: ASB Calling, ASB Injection, Clienthub, Engine Room, Rentals,
--     SS Injection, WSB Injection. (ASB/SS/WSB Injection are the three clock
--     CLOCK_CAMPAIGNS_ALL teams that existed only in the clock.)
--   * Re-activates any of those that already exist but were toggled inactive.
--   * Sets Rebels inactive (archived; keeps its history, drops it from pickers).
--
-- display_order values continue after the current max (670) so they sort to the
-- end; adjust if you want them interleaved alphabetically.
--
-- VERIFY AFTER APPLYING:
--   select name, active from public.payroll_canonical_divisions
--     where name in ('ASB Calling','ASB Injection','Clienthub','Engine Room',
--                    'Rentals','SS Injection','WSB Injection','Rebels')
--     order by name;
--   -> the first 7 active=true, Rebels active=false.
--   Then reload the dashboard Payroll tab and the quay-clock admin timesheet
--   picker: the Injection teams appear, Rebels does not, nothing lands under
--   "Not in master list".
-- =================================================================

insert into public.payroll_canonical_divisions (name, display_order, active) values
  ('ASB Calling',   680, true),
  ('Clienthub',     690, true),
  ('Engine Room',   700, true),
  ('Rentals',       710, true),
  ('ASB Injection', 720, true),
  ('SS Injection',  730, true),
  ('WSB Injection', 740, true)
on conflict (name) do update set active = true;

update public.payroll_canonical_divisions
   set active = false
 where name = 'Rebels';
