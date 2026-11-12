BEGIN;

CREATE TABLE public.excuse_letter_contacts (
  letter_id uuid PRIMARY KEY REFERENCES public.excuse_letters (id) ON DELETE CASCADE,
  parent_guardian_phone text NOT NULL
    CHECK (length(btrim(parent_guardian_phone)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.excuse_letter_contacts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.excuse_letter_contacts FROM anon, authenticated;
GRANT SELECT, INSERT ON public.excuse_letter_contacts TO authenticated;

CREATE POLICY excuse_letter_contacts_select_owner_or_authorized_dean
  ON public.excuse_letter_contacts FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.id = excuse_letter_contacts.letter_id
        AND (
          letter.student_id = (SELECT auth.uid())
          OR securitres_private.can_dean_access_letter(letter.id)
        )
    )
  );

CREATE POLICY excuse_letter_contacts_insert_owner_pending
  ON public.excuse_letter_contacts FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_profile_role()) = 'student'
    AND EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.id = excuse_letter_contacts.letter_id
        AND letter.student_id = (SELECT auth.uid())
        AND letter.status = 'pending'
    )
  );

CREATE FUNCTION public.create_student_excuse_letter(
  p_course_id uuid,
  p_absence_start date,
  p_absence_end date,
  p_reason text,
  p_parent_guardian_phone text
)
RETURNS SETOF public.excuse_letters
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  created_letter public.excuse_letters;
BEGIN
  IF nullif(btrim(p_parent_guardian_phone), '') IS NULL
    OR length(btrim(p_parent_guardian_phone)) > 40
  THEN
    RAISE EXCEPTION 'Enter a parent or guardian phone number of 40 characters or fewer.';
  END IF;

  INSERT INTO public.excuse_letters (
    student_id,
    course_id,
    absence_start,
    absence_end,
    reason
  )
  VALUES (
    (SELECT auth.uid()),
    p_course_id,
    p_absence_start,
    p_absence_end,
    p_reason
  )
  RETURNING * INTO created_letter;

  INSERT INTO public.excuse_letter_contacts (letter_id, parent_guardian_phone)
  VALUES (created_letter.id, btrim(p_parent_guardian_phone));

  RETURN NEXT created_letter;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_student_excuse_letter(uuid, date, date, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_student_excuse_letter(uuid, date, date, text, text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
