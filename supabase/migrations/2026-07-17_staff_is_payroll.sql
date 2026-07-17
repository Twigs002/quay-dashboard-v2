-- Add the `is_payroll` role flag to staff.
--
-- Payroll is a restricted login type shared across the Quay 1 apps:
--   • quay-dashboard-v2 — sees ONLY the Clocks, Staff (Directory) and Payroll
--     tabs (may sign in on is_payroll alone; is_admin is not required).
--   • quay-hubspot      — gated down to the Recruitment area only, exactly like
--     a broker login (nav hidden, view pinned to Recruitment).
--
-- Mirrors the existing is_super / is_admin / is_broker boolean flags.
-- Idempotent: safe to run more than once.

alter table public.staff
  add column if not exists is_payroll boolean not null default false;

-- To grant a login the Payroll role (replace the username):
--   update public.staff set is_payroll = true where id = '<staff-username>';
-- The account still needs its Supabase auth user + PIN like any other login.
