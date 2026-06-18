-- Quay 1 — payroll reference-data tables (Config sub-tab)
-- ============================================================
-- Promotes the 5 hard-coded reference lists from quay/payroll.js into
-- editable Supabase tables. The dashboard hydrates a mutable CONFIG
-- object from these tables on each Payroll-tab open; if a read fails
-- (RLS, network, tables-not-yet-deployed) the static JS constants ship
-- as a fallback so the algorithm still works.
--
-- Run this once in the Supabase SQL Editor against the same project
-- that hosts the `staff` + `events` tables. Idempotent.
--
-- Write access is gated on staff.is_super (see schema-superuser.sql in
-- the quay-clock repo for how that flag is provisioned). SELECT is
-- open to any authenticated dashboard user so the algorithm runs.
-- ============================================================

create extension if not exists pgcrypto;

-- 1. Tables ----------------------------------------------------

-- §3.1 — 67 canonical division names, in display order. display_order
-- is the master sort used by the By Division pivot.
create table if not exists public.payroll_canonical_divisions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  display_order int  not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists payroll_canonical_divisions_order_idx
  on public.payroll_canonical_divisions(display_order);

-- §3.2 — exact-match typo / variant merges. Applied after title-case +
-- suffix-strip + apostrophe-strip but BEFORE the alias-regex stage.
create table if not exists public.payroll_typo_map (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  canonical     text not null,
  created_at    timestamptz not null default now()
);

-- §3.3 — broader regex aliases. `pattern` is the regex SOURCE (no
-- enclosing slashes, no flags); always compiled case-insensitive on
-- the client side. `priority` orders evaluation; first match wins.
create table if not exists public.payroll_alias_patterns (
  id            uuid primary key default gen_random_uuid(),
  pattern       text not null,
  target        text not null,
  priority      int  not null,
  created_at    timestamptz not null default now()
);
create index if not exists payroll_alias_patterns_priority_idx
  on public.payroll_alias_patterns(priority);

-- §3.4 — per-employee default team. Looked up by exact name match when
-- the Employee-notes field is blank.
create table if not exists public.payroll_default_team (
  id            uuid primary key default gen_random_uuid(),
  agent_name    text not null unique,
  default_team  text not null,
  created_at    timestamptz not null default now()
);

-- §3.5 — standalone short-codes that should be dropped entirely.
-- Stored lower-case; lookup is case-insensitive.
create table if not exists public.payroll_drop_standalone (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  created_at    timestamptz not null default now()
);

-- 2. Row-level security ---------------------------------------

alter table public.payroll_canonical_divisions enable row level security;
alter table public.payroll_typo_map            enable row level security;
alter table public.payroll_alias_patterns      enable row level security;
alter table public.payroll_default_team        enable row level security;
alter table public.payroll_drop_standalone     enable row level security;

-- Wipe any pre-existing policies so re-runs land cleanly.
do $$ begin
  perform 1 from pg_policies where schemaname = 'public'
    and tablename in ('payroll_canonical_divisions', 'payroll_typo_map',
                      'payroll_alias_patterns', 'payroll_default_team',
                      'payroll_drop_standalone');
  if found then
    execute (
      select string_agg(format('drop policy if exists %I on public.%I;', policyname, tablename), ' ')
      from pg_policies where schemaname = 'public'
        and tablename in ('payroll_canonical_divisions', 'payroll_typo_map',
                          'payroll_alias_patterns', 'payroll_default_team',
                          'payroll_drop_standalone')
    );
  end if;
end $$;

-- SELECT: any authenticated dashboard user can read the lists.
create policy payroll_canonical_divisions_select_authn on public.payroll_canonical_divisions
  for select to authenticated using (true);
create policy payroll_typo_map_select_authn on public.payroll_typo_map
  for select to authenticated using (true);
create policy payroll_alias_patterns_select_authn on public.payroll_alias_patterns
  for select to authenticated using (true);
create policy payroll_default_team_select_authn on public.payroll_default_team
  for select to authenticated using (true);
create policy payroll_drop_standalone_select_authn on public.payroll_drop_standalone
  for select to authenticated using (true);

-- INSERT / UPDATE / DELETE: only supers (staff.is_super = true on the
-- row mapped to the caller via auth_user_id) can mutate. Modelled on
-- the existing super-check pattern in quay-clock.

-- payroll_canonical_divisions
create policy payroll_canonical_divisions_insert_super on public.payroll_canonical_divisions
  for insert to authenticated with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_canonical_divisions_update_super on public.payroll_canonical_divisions
  for update to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_canonical_divisions_delete_super on public.payroll_canonical_divisions
  for delete to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

-- payroll_typo_map
create policy payroll_typo_map_insert_super on public.payroll_typo_map
  for insert to authenticated with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_typo_map_update_super on public.payroll_typo_map
  for update to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_typo_map_delete_super on public.payroll_typo_map
  for delete to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

-- payroll_alias_patterns
create policy payroll_alias_patterns_insert_super on public.payroll_alias_patterns
  for insert to authenticated with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_alias_patterns_update_super on public.payroll_alias_patterns
  for update to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_alias_patterns_delete_super on public.payroll_alias_patterns
  for delete to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

-- payroll_default_team
create policy payroll_default_team_insert_super on public.payroll_default_team
  for insert to authenticated with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_default_team_update_super on public.payroll_default_team
  for update to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_default_team_delete_super on public.payroll_default_team
  for delete to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

-- payroll_drop_standalone
create policy payroll_drop_standalone_insert_super on public.payroll_drop_standalone
  for insert to authenticated with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_drop_standalone_update_super on public.payroll_drop_standalone
  for update to authenticated
  using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  )
  with check (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );
create policy payroll_drop_standalone_delete_super on public.payroll_drop_standalone
  for delete to authenticated using (
    exists (select 1 from public.staff
            where auth_user_id = auth.uid() and is_super)
  );

-- 3. Seed data -------------------------------------------------
-- Mirrors the v1 static constants in quay/payroll.js. ON CONFLICT
-- DO NOTHING so re-runs and post-deploy edits are safe.

-- 3.1 — canonical divisions (display order matches spec §3.1)
insert into public.payroll_canonical_divisions (name, display_order, active) values
  ('Amigos',        10,  true),
  ('Assassins',     20,  true),
  ('Avengers',      30,  true),
  ('Babes',         40,  true),
  ('Ballers',       50,  true),
  ('Boets',         60,  true),
  ('Bulls',         70,  true),
  ('Cavaliers',     80,  true),
  ('Chargers',      90,  true),
  ('City Sunsets',  100, true),
  ('Conquerors',    110, true),
  ('Dealers',       120, true),
  ('Dealmakers',    130, true),
  ('Dixies',        140, true),
  ('Dolphins',      150, true),
  ('Donkeys',       160, true),
  ('Dragons',       170, true),
  ('Dutchmen',      180, true),
  ('Falcons',       190, true),
  ('Farmers',       200, true),
  ('Furys',         210, true),
  ('Gladiators',    220, true),
  ('Goal Diggers',  230, true),
  ('Gunslingers',   240, true),
  ('Hawks',         250, true),
  ('Headbangers',   260, true),
  ('Hoekers',       270, true),
  ('Hooligans',     280, true),
  ('Hustlers',      290, true),
  ('Invincibles',   300, true),
  ('Knights',       310, true),
  ('Koeksisters',   320, true),
  ('Lions',         330, true),
  ('Llamas',        340, true),
  ('Musketeers',    350, true),
  ('Panthers',      360, true),
  ('Pirates',       370, true),
  ('Power Rangers', 380, true),
  ('Prom Queens',   390, true),
  ('Proteas',       400, true),
  ('Raccoons',      410, true),
  ('Samurais',      420, true),
  ('Slayers',       430, true),
  ('Soccer Moms',   440, true),
  ('Spartans',      450, true),
  ('Surfers',       460, true),
  ('Swesties',      470, true),
  ('Targaryens',    480, true),
  ('Tigers',        490, true),
  ('TNT',           500, true),
  ('Tornadoes',     510, true),
  ('Warriors',      520, true),
  ('Weasels',       530, true),
  ('Wizards',       540, true),
  ('Wolves',        550, true),
  ('Wombats',       560, true),
  ('Hout Baes',     570, true),
  ('Rockets',       580, true),
  ('Jaguars',       590, true),
  ('Huntsmen',      600, true),
  ('Vikings',       610, true),
  ('Blitz',         620, true),
  ('Komorants',     630, true),
  ('Betties',       640, true),
  ('Rebels',        650, true),
  ('Vipers',        660, true),
  ('Bergscape',     670, true)
on conflict (name) do nothing;

-- 3.2 — exact-match typo map
insert into public.payroll_typo_map (key, canonical) values
  ('Assasins',     'Assassins'),
  ('Invicibles',   'Invincibles'),
  ('Durchmen',     'Dutchmen'),
  ('Dutchman',     'Dutchmen'),
  ('Powerrangers', 'Power Rangers'),
  ('Engineroom',   'Engine Room'),
  ('Warrio',       'Warriors'),
  ('Glads',        'Gladiators'),
  ('Proms',        'Prom Queens'),
  ('Tnt',          'TNT'),
  ('Tt',           'TNT'),
  ('Komarants',    'Komorants'),
  ('Dealmalers',   'Dealmakers'),
  ('Ln',           'Hout Baes'),
  ('Assassin',     'Assassins'),
  ('Baller',       'Ballers'),
  ('Charger',      'Chargers'),
  ('Gunslinger',   'Gunslingers'),
  ('Knight',       'Knights'),
  ('Pirate',       'Pirates'),
  ('Citysuns',     'City Sunsets'),
  ('City Suns',    'City Sunsets'),
  ('Soccermoms',   'Soccer Moms'),
  ('Houtbaes',     'Hout Baes')
on conflict (key) do nothing;

-- 3.3 — alias regex patterns (priority orders evaluation, first match wins)
insert into public.payroll_alias_patterns (pattern, target, priority) values
  ('^engine\s*room\b', 'Engine Room', 10),
  ('^justin\b',        'Tigers',      20),
  ('\bjustin\b',       'Tigers',      30),
  ('\bhubspot\b',      'Hout Baes',   40),
  ('^hout\s*baes\b',   'Hout Baes',   50)
on conflict do nothing;

-- 3.4 — per-employee default team
insert into public.payroll_default_team (agent_name, default_team) values
  ('Claire Murch', 'Nelio Assiss')
on conflict (agent_name) do nothing;

-- 3.5 — standalone short-codes to drop
insert into public.payroll_drop_standalone (code) values
  ('cm'), ('na'), ('va'), ('nc'), ('cma')
on conflict (code) do nothing;
