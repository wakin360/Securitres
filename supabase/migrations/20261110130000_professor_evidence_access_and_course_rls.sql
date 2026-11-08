BEGIN;

CREATE FUNCTION securitres_private.can_student_access_course(p_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (SELECT public.current_profile_role()) = 'student'
    AND EXISTS (
      SELECT 1
      FROM public.course_enrollments AS enrollment
      WHERE enrollment.course_id = p_course_id
        AND enrollment.student_id = (SELECT auth.uid())
    );
$function$;

ALTER FUNCTION securitres_private.can_student_access_course(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.can_student_access_course(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION securitres_private.can_student_access_course(uuid)
  TO authenticated;

CREATE FUNCTION securitres_private.can_dean_access_course(p_course_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND (SELECT public.current_profile_role()) = 'dean'
    AND EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.course_id = p_course_id
        AND securitres_private.can_dean_access_letter(letter.id)
    );
$function$;

ALTER FUNCTION securitres_private.can_dean_access_course(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.can_dean_access_course(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION securitres_private.can_dean_access_course(uuid)
  TO authenticated;

CREATE POLICY course_enrollments_select_authorized_scope
  ON public.course_enrollments
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    (
      (SELECT public.current_profile_role()) = 'student'
      AND student_id = (SELECT auth.uid())
    )
    OR (
      (SELECT public.current_profile_role()) = 'professor'
      AND EXISTS (
        SELECT 1
        FROM public.course_offerings AS course
        WHERE course.id = public.course_enrollments.course_id
          AND course.professor_id = (SELECT auth.uid())
      )
    )
  );

CREATE POLICY course_offerings_select_authorized_scope
  ON public.course_offerings
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    (
      (SELECT public.current_profile_role()) = 'professor'
      AND professor_id = (SELECT auth.uid())
    )
    OR securitres_private.can_student_access_course(id)
    OR securitres_private.can_dean_access_course(id)
  );

CREATE POLICY evidence_select_authorized_role_scope
  ON public.excuse_evidence
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.id = letter_id
        AND (
          (
            (SELECT public.current_profile_role()) = 'student'
            AND letter.student_id = (SELECT auth.uid())
          )
          OR securitres_private.can_dean_access_letter(letter.id)
          OR (
            (SELECT public.current_profile_role()) = 'professor'
            AND letter.status = 'approved'
            AND EXISTS (
              SELECT 1
              FROM public.course_offerings AS course
              WHERE course.id = letter.course_id
                AND course.professor_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

CREATE POLICY users_download_evidence_authorized_role_scope
  ON storage.objects
  AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    bucket_id <> 'excuse-evidence'
    OR EXISTS (
      SELECT 1
      FROM public.excuse_evidence AS evidence
      JOIN public.excuse_letters AS letter
        ON letter.id = evidence.letter_id
      WHERE evidence.storage_path = objects.name
        AND (
          (
            (SELECT public.current_profile_role()) = 'student'
            AND letter.student_id = (SELECT auth.uid())
          )
          OR securitres_private.can_dean_access_letter(letter.id)
          OR (
            (SELECT public.current_profile_role()) = 'professor'
            AND letter.status = 'approved'
            AND EXISTS (
              SELECT 1
              FROM public.course_offerings AS course
              WHERE course.id = letter.course_id
                AND course.professor_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

COMMENT ON POLICY course_offerings_select_authorized_scope
  ON public.course_offerings IS
  'Restricts course reads to an assigned Professor, an enrolled student, or a Dean authorized for a related letter.';

COMMENT ON POLICY evidence_select_authorized_role_scope
  ON public.excuse_evidence IS
  'Restricts evidence reads to the owning student, an authorized Dean, or a Professor assigned to the approved letter course.';

COMMENT ON POLICY users_download_evidence_authorized_role_scope
  ON storage.objects IS
  'Restricts excuse-evidence downloads and signed URL creation to authorized students, Deans, and Professors assigned to approved letter courses.';

COMMIT;
