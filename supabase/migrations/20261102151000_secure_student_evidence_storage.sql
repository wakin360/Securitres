do $$
begin
  update storage.buckets
  set public = false,
      file_size_limit = 8388608,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png']
  where id = 'excuse-evidence';

  if not found then
    raise exception 'The private excuse-evidence bucket must exist before applying this migration.';
  end if;
end;
$$;

drop policy if exists "students_attach_evidence_to_own_pending_letters"
  on public.excuse_evidence;

create policy "students_attach_evidence_to_own_pending_letters"
  on public.excuse_evidence for insert to authenticated
  with check (
    (select public.current_profile_role()) = 'student'
    and exists (
      select 1
      from public.excuse_letters as l
      where l.id = letter_id
        and l.student_id = (select auth.uid())
        and l.status = 'pending'
        and (storage.foldername(storage_path))[1] = (select auth.uid())::text
        and (storage.foldername(storage_path))[2] = l.id::text
        and array_length(storage.foldername(storage_path), 1) = 2
        and case mime_type
          when 'application/pdf' then storage.filename(storage_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'
          when 'image/jpeg' then storage.filename(storage_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
          when 'image/png' then storage.filename(storage_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
          else false
        end
    )
  );

drop policy if exists "students_upload_to_own_pending_letter_folder"
  on storage.objects;

create policy "students_upload_to_own_pending_letter_folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'excuse-evidence'
    and (select public.current_profile_role()) = 'student'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 2
    and exists (
      select 1
      from public.excuse_letters as l
      where l.id::text = (storage.foldername(name))[2]
        and l.student_id = (select auth.uid())
        and l.status = 'pending'
        and case metadata ->> 'mimetype'
          when 'application/pdf' then storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'
          when 'image/jpeg' then storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
          when 'image/png' then storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'
          else false
        end
    )
  );

drop policy if exists "students_remove_own_pending_letter_uploads"
  on storage.objects;

create policy "students_remove_own_pending_letter_uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'excuse-evidence'
    and (select public.current_profile_role()) = 'student'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 2
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|png)$'
    and exists (
      select 1
      from public.excuse_letters as l
      where l.id::text = (storage.foldername(name))[2]
        and l.student_id = (select auth.uid())
        and l.status = 'pending'
    )
  );

grant delete on storage.objects to authenticated;

comment on policy "students_remove_own_pending_letter_uploads" on storage.objects is
  'Allows compensating cleanup of generated-path uploads for the authenticated student’s own pending letter. No evidence deletion UI is provided.';
