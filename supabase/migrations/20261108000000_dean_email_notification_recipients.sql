CREATE OR REPLACE FUNCTION public.get_excuse_letter_notification_recipients(
  p_letter_id uuid
)
RETURNS TABLE(email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT DISTINCT auth_user.email::text
  FROM public.excuse_letters AS letter
  JOIN public.profiles AS student
    ON student.id = letter.student_id
   AND student.role = 'student'
  JOIN public.academic_programs AS program
    ON program.id = student.program_id
   AND program.is_active IS TRUE
  JOIN public.dean_program_assignments AS assignment
    ON assignment.program_id = program.id
   AND assignment.revoked_at IS NULL
  JOIN public.profiles AS dean
    ON dean.id = assignment.dean_id
   AND dean.role = 'dean'
  JOIN auth.users AS auth_user
    ON auth_user.id = dean.id
   AND auth_user.email_confirmed_at IS NOT NULL
  WHERE letter.id = p_letter_id
    AND letter.status = 'pending'
    AND auth_user.email IS NOT NULL;
$function$;

ALTER FUNCTION public.get_excuse_letter_notification_recipients(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_excuse_letter_notification_recipients(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_excuse_letter_notification_recipients(uuid)
  TO service_role;
