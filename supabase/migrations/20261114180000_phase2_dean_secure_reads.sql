BEGIN;

CREATE FUNCTION securitres_private.lock_dean_read_scope(
  p_dean_id uuid,
  p_letter_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_student_id uuid;
  v_program_id uuid;
BEGIN
  IF p_dean_id IS NULL THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
  FROM public.profiles AS dean
  WHERE dean.id = p_dean_id
    AND dean.role = 'dean'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_letter_id IS NULL THEN
    PERFORM 1
    FROM public.profiles AS student
    WHERE student.role = 'student'
      AND EXISTS (
        SELECT 1
        FROM public.dean_program_assignments AS assignment
        JOIN public.academic_programs AS program
          ON program.id = assignment.program_id
         AND program.is_active IS TRUE
        WHERE assignment.dean_id = p_dean_id
          AND assignment.program_id = student.program_id
          AND assignment.revoked_at IS NULL
      )
    FOR SHARE OF student;

    PERFORM 1
    FROM public.dean_program_assignments AS assignment
    JOIN public.academic_programs AS program
      ON program.id = assignment.program_id
     AND program.is_active IS TRUE
    WHERE assignment.dean_id = p_dean_id
      AND assignment.revoked_at IS NULL
    FOR SHARE OF assignment, program;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dean resource is not available.'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN;
  END IF;

  SELECT student.id, student.program_id
  INTO v_student_id, v_program_id
  FROM public.excuse_letters AS letter
  JOIN public.profiles AS student
    ON student.id = letter.student_id
   AND student.role = 'student'
  WHERE letter.id = p_letter_id
  FOR SHARE OF letter, student;

  IF v_student_id IS NULL OR v_program_id IS NULL THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
  FROM public.academic_programs AS program
  WHERE program.id = v_program_id
    AND program.is_active IS TRUE
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
  FROM public.dean_program_assignments AS assignment
  WHERE assignment.dean_id = p_dean_id
    AND assignment.program_id = v_program_id
    AND assignment.revoked_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

ALTER FUNCTION securitres_private.lock_dean_read_scope(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.lock_dean_read_scope(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_dean_letters_encrypted(
  p_dean_id uuid,
  p_letter_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500,
  p_offset integer DEFAULT 0
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row record;
  v_result jsonb;
  v_found boolean := false;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500
     OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Dean letter pagination is invalid.'
      USING ERRCODE = '22023';
  END IF;

  PERFORM securitres_private.lock_dean_read_scope(p_dean_id, p_letter_id);

  FOR v_row IN
    SELECT
      letter.id AS letter_id,
      letter.course_id,
      letter.absence_start,
      letter.absence_start_envelope,
      letter.absence_end,
      letter.absence_end_envelope,
      letter.reason,
      letter.reason_envelope,
      letter.status,
      letter.dean_comment,
      letter.dean_comment_envelope,
      letter.submitted_at,
      student.id AS profile_id,
      student.full_name,
      student.full_name_envelope,
      student.student_number,
      student.student_number_envelope,
      student.program,
      student.program_envelope,
      course.course_code,
      course.course_name,
      course.section,
      professor.id AS professor_id,
      professor.full_name AS professor_full_name,
      professor.full_name_envelope AS professor_full_name_envelope,
      contact.parent_guardian_phone,
      contact.parent_guardian_phone_envelope
    FROM public.excuse_letters AS letter
    JOIN public.profiles AS student
      ON student.id = letter.student_id
     AND student.role = 'student'
    LEFT JOIN public.course_offerings AS course
      ON course.id = letter.course_id
    LEFT JOIN public.profiles AS professor
      ON professor.id = course.professor_id
     AND professor.role = 'professor'
    LEFT JOIN public.excuse_letter_contacts AS contact
      ON contact.letter_id = letter.id
    WHERE (p_letter_id IS NULL OR letter.id = p_letter_id)
      AND EXISTS (
        SELECT 1
        FROM public.dean_program_assignments AS assignment
        JOIN public.academic_programs AS program
          ON program.id = assignment.program_id
         AND program.is_active IS TRUE
        WHERE assignment.dean_id = p_dean_id
          AND assignment.program_id = student.program_id
          AND assignment.revoked_at IS NULL
      )
    ORDER BY letter.submitted_at DESC, letter.id ASC
    LIMIT CASE WHEN p_letter_id IS NULL THEN p_limit ELSE 1 END
    OFFSET CASE WHEN p_letter_id IS NULL THEN p_offset ELSE 0 END
  LOOP
    v_found := true;
    v_result := pg_catalog.jsonb_build_object(
      'id', v_row.letter_id,
      'absence_start', v_row.absence_start,
      'absence_start_envelope', v_row.absence_start_envelope,
      'absence_end', v_row.absence_end,
      'absence_end_envelope', v_row.absence_end_envelope,
      'reason', v_row.reason,
      'reason_envelope', v_row.reason_envelope,
      'status', v_row.status,
      'dean_comment', v_row.dean_comment,
      'dean_comment_envelope', v_row.dean_comment_envelope,
      'submitted_at', v_row.submitted_at,
      'course', CASE
        WHEN v_row.course_id IS NULL THEN NULL
        ELSE pg_catalog.jsonb_build_object(
          'course_code', v_row.course_code,
          'course_name', v_row.course_name,
          'section', v_row.section,
          'professor', CASE
            WHEN v_row.professor_id IS NULL THEN NULL
            ELSE pg_catalog.jsonb_build_object(
              'id', v_row.professor_id,
              'full_name', v_row.professor_full_name,
              'full_name_envelope', v_row.professor_full_name_envelope
            )
          END
        )
      END,
      'student', pg_catalog.jsonb_build_object(
        'id', v_row.profile_id,
        'full_name', v_row.full_name,
        'full_name_envelope', v_row.full_name_envelope,
        'student_number', v_row.student_number,
        'student_number_envelope', v_row.student_number_envelope,
        'program', v_row.program,
        'program_envelope', v_row.program_envelope
      ),
      'contact', CASE
        WHEN v_row.parent_guardian_phone IS NULL
         AND v_row.parent_guardian_phone_envelope IS NULL THEN NULL
        ELSE pg_catalog.jsonb_build_object(
          'parent_guardian_phone', v_row.parent_guardian_phone,
          'parent_guardian_phone_envelope', v_row.parent_guardian_phone_envelope
        )
      END
    );

    IF p_letter_id IS NOT NULL THEN
      v_result := v_result || pg_catalog.jsonb_build_object(
        'statusEvents',
        coalesce(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', event.id,
                'old_status', event.old_status,
                'new_status', event.new_status,
                'comment', event.comment,
                'comment_envelope', event.comment_envelope,
                'created_at', event.created_at
              )
              ORDER BY event.created_at ASC, event.id ASC
            )
            FROM public.letter_status_events AS event
            WHERE event.letter_id = v_row.letter_id
          ),
          '[]'::jsonb
        ),
        'evidence',
        coalesce(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', evidence.id,
                'original_filename', evidence.original_filename,
                'original_filename_envelope', evidence.original_filename_envelope,
                'mime_type', evidence.mime_type,
                'size_bytes', evidence.size_bytes,
                'uploaded_at', evidence.uploaded_at
              )
              ORDER BY evidence.uploaded_at ASC, evidence.id ASC
            )
            FROM public.excuse_evidence AS evidence
            WHERE evidence.letter_id = v_row.letter_id
          ),
          '[]'::jsonb
        )
      );
    END IF;

    RETURN NEXT v_result;
  END LOOP;

  IF p_letter_id IS NOT NULL AND NOT v_found THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$function$;

ALTER FUNCTION public.get_dean_letters_encrypted(uuid, uuid, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_dean_letters_encrypted(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_dean_letters_encrypted(uuid, uuid, integer, integer)
  TO service_role;

CREATE FUNCTION public.get_dean_evidence_encrypted(
  p_dean_id uuid,
  p_letter_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM securitres_private.lock_dean_read_scope(p_dean_id, p_letter_id);

  RETURN QUERY
  SELECT pg_catalog.jsonb_build_object(
    'id', evidence.id,
    'original_filename', evidence.original_filename,
    'original_filename_envelope', evidence.original_filename_envelope,
    'mime_type', evidence.mime_type,
    'size_bytes', evidence.size_bytes,
    'uploaded_at', evidence.uploaded_at
  )
  FROM public.excuse_evidence AS evidence
  WHERE evidence.letter_id = p_letter_id
  ORDER BY evidence.uploaded_at ASC, evidence.id ASC;
END;
$function$;

ALTER FUNCTION public.get_dean_evidence_encrypted(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_dean_evidence_encrypted(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_dean_evidence_encrypted(uuid, uuid)
  TO service_role;

CREATE FUNCTION public.get_dean_evidence_storage_path(
  p_dean_id uuid,
  p_evidence_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_letter_id uuid;
  v_storage_path text;
BEGIN
  SELECT evidence.letter_id, evidence.storage_path
  INTO v_letter_id, v_storage_path
  FROM public.excuse_evidence AS evidence
  WHERE evidence.id = p_evidence_id
  FOR SHARE;

  IF v_letter_id IS NULL OR v_storage_path IS NULL THEN
    RAISE EXCEPTION 'Dean resource is not available.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM securitres_private.lock_dean_read_scope(p_dean_id, v_letter_id);
  RETURN v_storage_path;
END;
$function$;

ALTER FUNCTION public.get_dean_evidence_storage_path(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_dean_evidence_storage_path(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_dean_evidence_storage_path(uuid, uuid)
  TO service_role;

COMMIT;
