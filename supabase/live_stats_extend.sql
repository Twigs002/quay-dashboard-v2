-- Extend live_stats with the per-lead-type breakdown so the Live Floor can
-- show seller / rental / email leads next to total calls. Idempotent.

alter table public.live_stats
  add column if not exists seller_leads integer default 0,
  add column if not exists rental_leads integer default 0,
  add column if not exists email_leads  integer default 0;
