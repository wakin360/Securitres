drop policy if exists "students_insert_pending_letters_for_enrolled_courses"
  on public.excuse_letters;

create policy "students_insert_pending_letters_for_enrolled_courses"
  on public.excuse_letters for insert to authenticated
  with check (
    (select public.current_profile_role()) = 'student'
    and student_id = (select auth.uid())
    and status = 'pending'
    and decided_at is null
    and decided_by is null
    and exists (
      select 1 from public.course_enrollments as e
      where e.course_id = excuse_letters.course_id and e.student_id = (select auth.uid())
    )
  );
