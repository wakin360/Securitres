create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'student' check (role in ('student', 'professor', 'dean')),
  full_name text not null default '',
  student_number text unique,
  program text,
  created_at timestamptz not null default now()
);

create table public.course_offerings (
  id uuid primary key default gen_random_uuid(),
  course_code text not null,
  course_name text not null,
  section text not null,
  professor_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (course_code, section)
);

create table public.course_enrollments (
  course_id uuid not null references public.course_offerings (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (course_id, student_id)
);

create table public.excuse_letters (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id),
  course_id uuid not null references public.course_offerings (id),
  absence_start date not null,
  absence_end date not null,
  reason text not null check (length(trim(reason)) > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'disapproved')),
  dean_comment text,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (absence_end >= absence_start),
  check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or (status in ('approved', 'disapproved') and decided_at is not null and decided_by is not null)
  )
);

create index excuse_letters_student_submitted_idx
  on public.excuse_letters (student_id, submitted_at desc);
create index excuse_letters_course_status_idx
  on public.excuse_letters (course_id, status);

create table public.excuse_evidence (
  id uuid primary key default gen_random_uuid(),
  letter_id uuid not null references public.excuse_letters (id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  uploaded_at timestamptz not null default now(),
  check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
);

create table public.letter_status_events (
  id uuid primary key default gen_random_uuid(),
  letter_id uuid not null references public.excuse_letters (id) on delete cascade,
  actor_id uuid not null references public.profiles (id),
  old_status text not null,
  new_status text not null,
  comment text,
  created_at timestamptz not null default now()
);

create index letter_status_events_letter_created_idx
  on public.letter_status_events (letter_id, created_at desc);

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles as p
  where p.id = (select auth.uid())
$$;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

create or replace function public.record_letter_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    insert into public.letter_status_events (letter_id, actor_id, old_status, new_status, comment)
    values (new.id, (select auth.uid()), old.status, new.status, new.dean_comment);
  end if;
  return new;
end;
$$;

create trigger on_excuse_letter_status_changed
  after update of status on public.excuse_letters
  for each row execute procedure public.record_letter_status_change();

alter table public.profiles enable row level security;
alter table public.course_offerings enable row level security;
alter table public.course_enrollments enable row level security;
alter table public.excuse_letters enable row level security;
alter table public.excuse_evidence enable row level security;
alter table public.letter_status_events enable row level security;

revoke all on public.profiles, public.course_offerings, public.course_enrollments,
  public.excuse_letters, public.excuse_evidence, public.letter_status_events from anon, authenticated;

grant select on public.profiles, public.course_offerings, public.course_enrollments,
  public.excuse_letters, public.excuse_evidence, public.letter_status_events to authenticated;
grant update (full_name, student_number, program) on public.profiles to authenticated;
grant insert on public.excuse_letters to authenticated;
grant update (status, dean_comment, decided_at, decided_by) on public.excuse_letters to authenticated;
grant insert on public.excuse_evidence to authenticated;

create policy "profiles_select_self_or_dean"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.current_profile_role()) = 'dean');

create policy "profiles_update_self"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "course_offerings_select_for_signed_in_users"
  on public.course_offerings for select to authenticated
  using (true);

create policy "course_enrollments_select_own_or_course_professor_or_dean"
  on public.course_enrollments for select to authenticated
  using (
    student_id = (select auth.uid())
    or (select public.current_profile_role()) = 'dean'
    or exists (
      select 1 from public.course_offerings as c
      where c.id = course_id and c.professor_id = (select auth.uid())
    )
  );

create policy "letters_select_student_dean_or_assigned_professor"
  on public.excuse_letters for select to authenticated
  using (
    student_id = (select auth.uid())
    or (select public.current_profile_role()) = 'dean'
    or (
      status = 'approved'
      and exists (
        select 1 from public.course_offerings as c
        where c.id = course_id and c.professor_id = (select auth.uid())
      )
    )
  );

create policy "students_insert_pending_letters_for_enrolled_courses"
  on public.excuse_letters for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and status = 'pending'
    and decided_at is null
    and decided_by is null
    and exists (
      select 1 from public.course_enrollments as e
      where e.course_id = course_id and e.student_id = (select auth.uid())
    )
  );

create policy "deans_update_letter_decisions"
  on public.excuse_letters for update to authenticated
  using ((select public.current_profile_role()) = 'dean' and status = 'pending')
  with check (
    (select public.current_profile_role()) = 'dean'
    and status in ('approved', 'disapproved')
    and decided_by = (select auth.uid())
    and decided_at is not null
  );

create policy "evidence_select_when_letter_is_visible"
  on public.excuse_evidence for select to authenticated
  using (
    exists (
      select 1 from public.excuse_letters as l
      where l.id = letter_id
        and (
          l.student_id = (select auth.uid())
          or (select public.current_profile_role()) = 'dean'
          or (
            l.status = 'approved'
            and exists (
              select 1 from public.course_offerings as c
              where c.id = l.course_id and c.professor_id = (select auth.uid())
            )
          )
        )
    )
  );

create policy "students_attach_evidence_to_own_pending_letters"
  on public.excuse_evidence for insert to authenticated
  with check (
    exists (
      select 1 from public.excuse_letters as l
      where l.id = letter_id
        and l.student_id = (select auth.uid())
        and l.status = 'pending'
    )
  );

create policy "letter_events_select_when_letter_is_visible"
  on public.letter_status_events for select to authenticated
  using (
    exists (
      select 1 from public.excuse_letters as l
      where l.id = letter_id
        and (
          l.student_id = (select auth.uid())
          or (select public.current_profile_role()) = 'dean'
          or (
            l.status = 'approved'
            and exists (
              select 1 from public.course_offerings as c
              where c.id = l.course_id and c.professor_id = (select auth.uid())
            )
          )
        )
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'excuse-evidence',
  'excuse-evidence',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "students_upload_to_own_pending_letter_folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'excuse-evidence'
    and exists (
      select 1 from public.excuse_letters as l
      where l.id::text = (storage.foldername(name))[1]
        and l.student_id = (select auth.uid())
        and l.status = 'pending'
    )
  );

create policy "users_download_evidence_for_visible_letters"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'excuse-evidence'
    and exists (
      select 1
      from public.excuse_evidence as e
      join public.excuse_letters as l on l.id = e.letter_id
      where e.storage_path = name
        and (
          l.student_id = (select auth.uid())
          or (select public.current_profile_role()) = 'dean'
          or (
            l.status = 'approved'
            and exists (
              select 1 from public.course_offerings as c
              where c.id = l.course_id and c.professor_id = (select auth.uid())
            )
          )
        )
    )
  );
