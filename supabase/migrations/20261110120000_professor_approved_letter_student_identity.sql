BEGIN;

CREATE OR REPLACE FUNCTION public.get_professor_approved_letter_student_identity(
  p_letter_id uuid
)
RETURNS TABLE (
  full_name text,
  student_number text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'An authenticated Professor is required.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS professor
    WHERE professor.id = (SELECT auth.uid())
      AND professor.role = 'professor'
  ) THEN
    RAISE EXCEPTION 'Only an authenticated Professor can access student identity.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT student.full_name, student.student_number
  FROM public.excuse_letters AS letter
  JOIN public.course_offerings AS course
    ON course.id = letter.course_id
  JOIN public.profiles AS student
    ON student.id = letter.student_id
   AND student.role = 'student'
  WHERE letter.id = p_letter_id
    AND letter.status = 'approved'
    AND course.professor_id = (SELECT auth.uid());
END;
$function$;

ALTER FUNCTION public.get_professor_approved_letter_student_identity(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_professor_approved_letter_student_identity(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_professor_approved_letter_student_identity(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.get_professor_approved_letter_student_identity(uuid) IS
  'Returns only a student full name and student number for an approved letter assigned to the authenticated Professor.';

COMMIT;
