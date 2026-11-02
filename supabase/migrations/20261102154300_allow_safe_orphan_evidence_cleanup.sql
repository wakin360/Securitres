create schema if not exists securitres_private;
revoke all on schema securitres_private from public, anon, authenticated;
grant usage on schema securitres_private to authenticated;

create or replace function securitres_private.can_delete_orphaned_evidence(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and (select public.current_profile_role()) = 'student'
    and (storage.foldername(object_name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(object_name), 1) = 2
    and storage.filename(object_name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|png)$'
    and exists (
      select 1
      from public.excuse_letters as l
      where l.id::text = (storage.foldername(object_name))[2]
        and l.student_id = (select auth.uid())
    )
    and not exists (
      select 1
      from public.excuse_evidence as e
      where e.storage_path = object_name
    );
$$;

revoke all on function securitres_private.can_delete_orphaned_evidence(text)
  from public, anon, authenticated;
grant execute on function securitres_private.can_delete_orphaned_evidence(text)
  to authenticated;

drop policy if exists "students_remove_own_pending_letter_uploads"
  on storage.objects;
drop policy if exists "students_remove_own_orphaned_letter_uploads"
  on storage.objects;

create policy "students_remove_own_orphaned_letter_uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'excuse-evidence'
    and (select securitres_private.can_delete_orphaned_evidence(name))
  );

comment on policy "students_remove_own_orphaned_letter_uploads" on storage.objects is
  'Allows cleanup of unreferenced generated-path uploads for the authenticated student’s own letter regardless of letter status. A security-definer check verifies no evidence row references the object.';
