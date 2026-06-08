-- Red-flag acknowledgements: lets managers mark flags as 'attended to'
-- so the team sees one consolidated to-do list.
--
-- Run this in the Supabase SQL editor against the quay-clock project.

create table if not exists public.flag_acks (
  flag_key  text primary key,
  acked_by  text,                  -- staff.id (e.g. 'alan'); plain text, not FK
  acked_at  timestamptz not null default now(),
  note      text
);

alter table public.flag_acks enable row level security;

-- Any authenticated dashboard user can read every ack.
drop policy if exists flag_acks_select_authn on public.flag_acks;
create policy flag_acks_select_authn on public.flag_acks
  for select to authenticated using (true);

-- Any authenticated user can ack / un-ack a flag.
drop policy if exists flag_acks_write_authn on public.flag_acks;
create policy flag_acks_write_authn on public.flag_acks
  for insert to authenticated with check (true);

drop policy if exists flag_acks_update_authn on public.flag_acks;
create policy flag_acks_update_authn on public.flag_acks
  for update to authenticated using (true) with check (true);

drop policy if exists flag_acks_delete_authn on public.flag_acks;
create policy flag_acks_delete_authn on public.flag_acks
  for delete to authenticated using (true);

-- Stream changes so the dashboard re-renders when someone else ticks a flag.
alter publication supabase_realtime add table public.flag_acks;
