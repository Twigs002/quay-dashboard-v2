-- ln_teams: single source of truth for the canonical LN team roster.
--
-- Replaces the twin hardcoded LN_TEAMS_ALL arrays in
--   • quay-dashboard-v2/quay/app.js        (LN Stats team picker + subscribers form)
--   • market-analysis-reports/src/weekly_team_report_email.py (raw→pretty map)
--
-- Both consumers fall back to a static in-code copy of this list if the
-- fetch fails, so the dashboard/emailer never break when Supabase is down.
-- Order below (display_order 1..70) matches the current hardcoded order.
--
-- Run in the Supabase SQL editor against the quay-clock project.

create table if not exists public.ln_teams (
  id            serial primary key,
  name          text unique not null,
  display_order int not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists ln_teams_display_order_idx
  on public.ln_teams (display_order);

-- Seed the 70-team roster in the exact order they were hardcoded.
insert into public.ln_teams (name, display_order) values
  ('ASB Calling',    1),
  ('Amigos',         2),
  ('Assassins',      3),
  ('Avengers',       4),
  ('Babes',          5),
  ('Ballers',        6),
  ('Bergscape',      7),
  ('Betties',        8),
  ('Blitz',          9),
  ('Boets',         10),
  ('Bulls',         11),
  ('Cavaliers',     12),
  ('Chargers',      13),
  ('City Sunsets',  14),
  ('Clienthub',     15),
  ('Conquerors',    16),
  ('Dealers',       17),
  ('Dealmakers',    18),
  ('Dixies',        19),
  ('Dolphins',      20),
  ('Donkeys',       21),
  ('Dragons',       22),
  ('Dutchmen',      23),
  ('Engine Room',   24),
  ('Falcons',       25),
  ('Farmers',       26),
  ('Furys',         27),
  ('Gladiators',    28),
  ('Goal Diggers',  29),
  ('Gunslingers',   30),
  ('Hawks',         31),
  ('Headbangers',   32),
  ('Hoekers',       33),
  ('Hooligans',     34),
  ('Hout Baes',     35),
  ('Huntsmen',      36),
  ('Hustlers',      37),
  ('Invincibles',   38),
  ('Jaguars',       39),
  ('Knights',       40),
  ('Koeksisters',   41),
  ('Komorants',     42),
  ('Lions',         43),
  ('Llamas',        44),
  ('Musketeers',    45),
  ('Panthers',      46),
  ('Pirates',       47),
  ('Power Rangers', 48),
  ('Prom Queens',   49),
  ('Proteas',       50),
  ('Raccoons',      51),
  ('Rentals',       52),
  ('Rockets',       53),
  ('Samurais',      54),
  ('Slayers',       55),
  ('Soccer Moms',   56),
  ('Spartans',      57),
  ('Surfers',       58),
  ('Swesties',      59),
  ('Targaryens',    60),
  ('Tigers',        61),
  ('TNT',           62),
  ('Tornadoes',     63),
  ('Vikings',       64),
  ('Vipers',        65),
  ('Warriors',      66),
  ('Weasels',       67),
  ('Wizards',       68),
  ('Wolves',        69),
  ('Wombats',       70)
on conflict (name) do nothing;

-- ── RLS ────────────────────────────────────────────────────────────────
-- Read = any authenticated user (the dashboard loads at boot).
-- Write = super/admin only, gated by the existing public.is_admin() helper
-- (defined in the quay-clock schema; same function used by other admin-
-- scoped tables in this project).

alter table public.ln_teams enable row level security;

drop policy if exists ln_teams_select_authn on public.ln_teams;
create policy ln_teams_select_authn on public.ln_teams
  for select to authenticated using (true);

drop policy if exists ln_teams_insert_admin on public.ln_teams;
create policy ln_teams_insert_admin on public.ln_teams
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists ln_teams_update_admin on public.ln_teams;
create policy ln_teams_update_admin on public.ln_teams
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists ln_teams_delete_admin on public.ln_teams;
create policy ln_teams_delete_admin on public.ln_teams
  for delete to authenticated
  using (public.is_admin());
