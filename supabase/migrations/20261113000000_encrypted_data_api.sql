BEGIN;

ALTER TABLE public.profiles
  ALTER COLUMN full_name DROP NOT NULL,
  ADD COLUMN student_number_index text,
  ADD CONSTRAINT profiles_full_name_plaintext_or_envelope_check
    CHECK (full_name IS NOT NULL OR full_name_envelope IS NOT NULL),
  ADD CONSTRAINT profiles_student_number_index_format_check
    CHECK (student_number_index IS NULL OR student_number_index ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX profiles_student_number_index_key
  ON public.profiles (student_number_index)
  WHERE student_number_index IS NOT NULL;

ALTER TABLE public.excuse_letters
  ALTER COLUMN absence_start DROP NOT NULL,
  ALTER COLUMN absence_end DROP NOT NULL,
  ALTER COLUMN reason DROP NOT NULL,
  ADD COLUMN decision_event_id uuid,
  ADD COLUMN decision_event_comment_envelope jsonb,
  ADD CONSTRAINT excuse_letters_absence_start_plaintext_or_envelope_check
    CHECK (absence_start IS NOT NULL OR absence_start_envelope IS NOT NULL),
  ADD CONSTRAINT excuse_letters_absence_end_plaintext_or_envelope_check
    CHECK (absence_end IS NOT NULL OR absence_end_envelope IS NOT NULL),
  ADD CONSTRAINT excuse_letters_reason_plaintext_or_envelope_check
    CHECK (reason IS NOT NULL OR reason_envelope IS NOT NULL),
  ADD CONSTRAINT excuse_letters_decision_event_comment_envelope_phase1_check
    CHECK (decision_event_comment_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(decision_event_comment_envelope));

ALTER TABLE public.excuse_letter_contacts
  ALTER COLUMN parent_guardian_phone DROP NOT NULL,
  ADD CONSTRAINT excuse_letter_contacts_phone_plaintext_or_envelope_check
    CHECK (parent_guardian_phone IS NOT NULL OR parent_guardian_phone_envelope IS NOT NULL);

ALTER TABLE public.excuse_evidence
  ALTER COLUMN original_filename DROP NOT NULL,
  ADD CONSTRAINT excuse_evidence_filename_plaintext_or_envelope_check
    CHECK (original_filename IS NOT NULL OR original_filename_envelope IS NOT NULL);

CREATE OR REPLACE FUNCTION public.record_letter_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_event_id uuid := coalesce(NEW.decision_event_id, pg_catalog.gen_random_uuid());
  v_actor_id uuid := coalesce((SELECT auth.uid()), NEW.decided_by);
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF v_actor_id IS NULL THEN
      RAISE EXCEPTION 'A status transition requires an authenticated actor.'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.letter_status_events (
      id,
      letter_id,
      actor_id,
      old_status,
      new_status,
      comment,
      comment_envelope
    )
    VALUES (
      v_event_id,
      NEW.id,
      v_actor_id,
      OLD.status,
      NEW.status,
      CASE
        WHEN NEW.decision_event_comment_envelope IS NULL THEN NEW.dean_comment
        ELSE NULL
      END,
      NEW.decision_event_comment_envelope
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.create_student_excuse_letter_encrypted(
  p_letter_id uuid,
  p_student_id uuid,
  p_course_id uuid,
  p_absence_start_envelope jsonb,
  p_absence_end_envelope jsonb,
  p_reason_envelope jsonb,
  p_parent_guardian_phone_envelope jsonb
)
RETURNS TABLE (id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_letter public.excuse_letters;
BEGIN
  IF p_letter_id IS NULL
     OR p_student_id IS NULL
     OR p_course_id IS NULL
     OR NOT securitres_private.is_valid_phase1_envelope(p_absence_start_envelope)
     OR NOT securitres_private.is_valid_phase1_envelope(p_absence_end_envelope)
     OR NOT securitres_private.is_valid_phase1_envelope(p_reason_envelope)
     OR NOT securitres_private.is_valid_phase1_envelope(p_parent_guardian_phone_envelope)
     OR p_absence_start_envelope ->> 'plaintextType' IS DISTINCT FROM 'string'
     OR p_absence_end_envelope ->> 'plaintextType' IS DISTINCT FROM 'string'
     OR p_reason_envelope ->> 'plaintextType' IS DISTINCT FROM 'string'
     OR p_parent_guardian_phone_envelope ->> 'plaintextType' IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Encrypted letter fields are invalid.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS student
    JOIN public.course_enrollments AS enrollment
      ON enrollment.student_id = student.id
    WHERE student.id = p_student_id
      AND student.role = 'student'
      AND student.program_id IS NOT NULL
      AND enrollment.course_id = p_course_id
  ) THEN
    RAISE EXCEPTION 'The student is not enrolled in this course.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.excuse_letters (
    id,
    student_id,
    course_id,
    absence_start,
    absence_start_envelope,
    absence_end,
    absence_end_envelope,
    reason,
    reason_envelope
  )
  VALUES (
    p_letter_id,
    p_student_id,
    p_course_id,
    NULL,
    p_absence_start_envelope,
    NULL,
    p_absence_end_envelope,
    NULL,
    p_reason_envelope
  )
  RETURNING * INTO v_letter;

  INSERT INTO public.excuse_letter_contacts (
    letter_id,
    parent_guardian_phone,
    parent_guardian_phone_envelope
  )
  VALUES (
    v_letter.id,
    NULL,
    p_parent_guardian_phone_envelope
  );

  RETURN QUERY SELECT v_letter.id, v_letter.status;
END;
$function$;

CREATE FUNCTION public.decide_excuse_letter_encrypted(
  p_dean_id uuid,
  p_letter_id uuid,
  p_decision text,
  p_event_id uuid,
  p_dean_comment_envelope jsonb,
  p_event_comment_envelope jsonb
)
RETURNS TABLE (id uuid, status text, decided_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_student_program_id uuid;
  v_assignment_id uuid;
  v_updated public.excuse_letters;
BEGIN
  IF p_dean_id IS NULL
     OR p_letter_id IS NULL
     OR p_event_id IS NULL
     OR p_decision IS NULL
     OR p_decision NOT IN ('approved', 'disapproved')
     OR (p_dean_comment_envelope IS NULL) IS DISTINCT FROM (p_event_comment_envelope IS NULL)
     OR (p_dean_comment_envelope IS NOT NULL
       AND (NOT securitres_private.is_valid_phase1_envelope(p_dean_comment_envelope)
         OR p_dean_comment_envelope ->> 'plaintextType' IS DISTINCT FROM 'string'))
     OR (p_event_comment_envelope IS NOT NULL
       AND (NOT securitres_private.is_valid_phase1_envelope(p_event_comment_envelope)
         OR p_event_comment_envelope ->> 'plaintextType' IS DISTINCT FROM 'string')) THEN
    RAISE EXCEPTION 'The encrypted decision is invalid.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.profiles AS dean
  WHERE dean.id = p_dean_id
    AND dean.role = 'dean'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a Dean can decide excuse letters.'
      USING ERRCODE = '42501';
  END IF;

  SELECT student.program_id
  INTO v_student_program_id
  FROM public.excuse_letters AS letter
  JOIN public.profiles AS student
    ON student.id = letter.student_id
   AND student.role = 'student'
  WHERE letter.id = p_letter_id
  FOR UPDATE OF letter
  FOR SHARE OF student;

  IF v_student_program_id IS NULL THEN
    RAISE EXCEPTION 'This letter is not available to your Dean account.'
      USING ERRCODE = '42501';
  END IF;

  SELECT assignment.id
  INTO v_assignment_id
  FROM public.dean_program_assignments AS assignment
  JOIN public.academic_programs AS program
    ON program.id = assignment.program_id
   AND program.is_active IS TRUE
  WHERE assignment.dean_id = p_dean_id
    AND assignment.program_id = v_student_program_id
    AND assignment.revoked_at IS NULL
  FOR SHARE OF assignment, program;

  IF v_assignment_id IS NULL THEN
    RAISE EXCEPTION 'This letter is not available to your Dean account.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.excuse_letters AS letter
  SET status = p_decision,
      dean_comment = NULL,
      dean_comment_envelope = p_dean_comment_envelope,
      decided_at = pg_catalog.statement_timestamp(),
      decided_by = p_dean_id,
      decision_event_id = p_event_id,
      decision_event_comment_envelope = p_event_comment_envelope
  WHERE letter.id = p_letter_id
    AND letter.status = 'pending'
  RETURNING * INTO v_updated;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Letter was not found or is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.letter_status_events AS event
    WHERE event.id = p_event_id
      AND event.letter_id = p_letter_id
      AND event.actor_id = p_dean_id
      AND event.new_status = p_decision
  ) THEN
    RAISE EXCEPTION 'The decision history could not be recorded.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT v_updated.id, v_updated.status, v_updated.decided_at;
END;
$function$;

CREATE FUNCTION public.create_student_evidence_record_encrypted(
  p_evidence_id uuid,
  p_student_id uuid,
  p_letter_id uuid,
  p_storage_path text,
  p_original_filename_envelope jsonb,
  p_mime_type text,
  p_size_bytes bigint
)
RETURNS SETOF public.excuse_evidence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_evidence public.excuse_evidence;
BEGIN
  IF p_evidence_id IS NULL
     OR p_student_id IS NULL
     OR p_letter_id IS NULL
     OR p_storage_path IS NULL
     OR p_storage_path NOT LIKE p_student_id::text || '/' || p_letter_id::text || '/%'
     OR p_original_filename_envelope IS NULL
     OR NOT securitres_private.is_valid_phase1_envelope(p_original_filename_envelope)
     OR p_original_filename_envelope ->> 'plaintextType' IS DISTINCT FROM 'string'
     OR p_mime_type NOT IN ('application/pdf', 'image/jpeg', 'image/png')
     OR p_size_bytes IS NULL
     OR p_size_bytes < 1
     OR p_size_bytes > 8388608 THEN
    RAISE EXCEPTION 'Evidence metadata is invalid.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.excuse_letters AS letter
    WHERE letter.id = p_letter_id
      AND letter.student_id = p_student_id
      AND letter.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Evidence can only be attached to the student''s pending letter.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.excuse_evidence (
    id,
    letter_id,
    storage_path,
    original_filename,
    original_filename_envelope,
    mime_type,
    size_bytes
  )
  VALUES (
    p_evidence_id,
    p_letter_id,
    p_storage_path,
    NULL,
    p_original_filename_envelope,
    p_mime_type,
    p_size_bytes
  )
  RETURNING * INTO v_evidence;

  RETURN NEXT v_evidence;
END;
$function$;

ALTER FUNCTION public.create_student_excuse_letter_encrypted(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb) OWNER TO postgres;
ALTER FUNCTION public.decide_excuse_letter_encrypted(uuid, uuid, text, uuid, jsonb, jsonb) OWNER TO postgres;
ALTER FUNCTION public.create_student_evidence_record_encrypted(uuid, uuid, uuid, text, jsonb, text, bigint) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_student_excuse_letter_encrypted(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.decide_excuse_letter_encrypted(uuid, uuid, text, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_student_evidence_record_encrypted(uuid, uuid, uuid, text, jsonb, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_student_excuse_letter_encrypted(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.decide_excuse_letter_encrypted(uuid, uuid, text, uuid, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_student_evidence_record_encrypted(uuid, uuid, uuid, text, jsonb, text, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.create_student_excuse_letter(uuid, date, date, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_excuse_letter(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_professor_approved_letter_student_identity(uuid)
  FROM PUBLIC, anon, authenticated;

REVOKE SELECT ON TABLE public.profiles FROM anon, authenticated;
GRANT SELECT (id, role, program_id, created_at) ON TABLE public.profiles TO authenticated;
REVOKE UPDATE (full_name, student_number, program) ON TABLE public.profiles FROM authenticated;

REVOKE SELECT (
  absence_start,
  absence_end,
  reason,
  dean_comment,
  absence_start_envelope,
  absence_end_envelope,
  reason_envelope,
  dean_comment_envelope,
  decision_event_id,
  decision_event_comment_envelope
) ON TABLE public.excuse_letters FROM anon, authenticated;
REVOKE INSERT ON TABLE public.excuse_letters FROM authenticated;
REVOKE UPDATE (status, dean_comment, decided_at, decided_by) ON TABLE public.excuse_letters FROM authenticated;

REVOKE SELECT ON TABLE public.excuse_letter_contacts FROM anon, authenticated;
REVOKE INSERT ON TABLE public.excuse_letter_contacts FROM authenticated;

REVOKE SELECT ON TABLE public.excuse_evidence FROM anon, authenticated;
GRANT SELECT (id, letter_id, storage_path, mime_type, size_bytes, uploaded_at)
  ON TABLE public.excuse_evidence TO authenticated;
REVOKE INSERT ON TABLE public.excuse_evidence FROM authenticated;

REVOKE ALL ON FUNCTION public.get_authorized_letter_comments(uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_authorized_letter_status_history_comments(uuid) FROM authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
