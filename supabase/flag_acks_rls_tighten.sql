-- Tighten flag_acks RLS so a user can only write rows with THEIR own
-- staff.id in acked_by. Closes the gap where Manager A could overwrite
-- Manager B's ack and claim credit (or wipe it).
--
-- Run this AFTER flag_acks.sql, in the same quay-clock Supabase project.

-- 1) Lock down insert: acked_by must match the caller's staff.id, which
--    we derive via the auth_user_id mapping on public.staff.
drop policy if exists flag_acks_write_authn on public.flag_acks;
create policy flag_acks_insert_self on public.flag_acks
  for insert to authenticated
  with check (
    acked_by = (
      select id from public.staff where auth_user_id = auth.uid()
    )
  );

-- 2) Updates: only the staff member who originally acked can change the
--    row (and they can't reassign acked_by to someone else either).
drop policy if exists flag_acks_update_authn on public.flag_acks;
create policy flag_acks_update_self on public.flag_acks
  for update to authenticated
  using (
    acked_by = (select id from public.staff where auth_user_id = auth.uid())
  )
  with check (
    acked_by = (select id from public.staff where auth_user_id = auth.uid())
  );

-- 3) Deletes: same as update — only the owner can un-tick.
--    (Superusers who need to override can do so via the SQL editor.)
drop policy if exists flag_acks_delete_authn on public.flag_acks;
create policy flag_acks_delete_self on public.flag_acks
  for delete to authenticated
  using (
    acked_by = (select id from public.staff where auth_user_id = auth.uid())
  );

-- Select policy stays wide open to authenticated — every manager should
-- still see every ack so the team sees what's been handled.
