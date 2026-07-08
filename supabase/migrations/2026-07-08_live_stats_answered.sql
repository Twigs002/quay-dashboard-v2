-- Live Floor "Answered" metric = Calls minus No-Answer.
-- The daemon (live_dialfire_daemon.py) now writes an `answered` count per
-- agent = completed calls whose hs_lead_status != NO_ANSWER (i.e. every
-- reached/dispositioned call, including "Declined" outcomes NOT_ENGAGING /
-- DO_NOT_CONTACT). Nullable so pre-existing rows and the daemon's empty-poll
-- path don't break; the front-end falls back to calls when it's null.
alter table if exists public.live_stats
  add column if not exists answered integer not null default 0;
