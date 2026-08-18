-- Add a per-staff `salary_type` so payroll can pay a salaried person either
-- their full fixed salary or a pro-rata amount (salary x hours worked / 193.5).
--
--   • 'prorata' (default) — current behaviour: COST TO COMPANY = hours worked
--     x rate, where rate falls back to salary / 193.5.
--   • 'fixed'             — COST TO COMPANY = the full monthly salary, ignoring
--     hours worked.
--
-- Surfaced in the Staff editor (Monthly salary → Salary type) and read by the
-- Agents & Callers Payroll export (Sheet 4). Applies to any staff with a
-- salary set. Idempotent: safe to run more than once.

alter table public.staff
  add column if not exists salary_type text not null default 'prorata';

-- Guard the allowed values. Dropped-and-recreated so re-runs stay clean.
alter table public.staff
  drop constraint if exists staff_salary_type_chk;
alter table public.staff
  add constraint staff_salary_type_chk check (salary_type in ('fixed', 'prorata'));

-- Backfill any pre-existing NULLs (there should be none given the default).
update public.staff set salary_type = 'prorata' where salary_type is null;
