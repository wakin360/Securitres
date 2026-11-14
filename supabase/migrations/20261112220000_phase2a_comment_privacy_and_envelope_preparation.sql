BEGIN;

CREATE FUNCTION securitres_private.is_valid_phase1_envelope(p_envelope jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  v_expected_keys text[] := ARRAY[
    'formatVersion',
    'kekVersion',
    'plaintextType',
    'ciphertext',
    'iv',
    'tag',
    'wrappedDek',
    'dekWrapIv',
    'dekWrapTag'
  ];
  v_key text;
  v_value text;
BEGIN
  IF p_envelope IS NULL
     OR pg_catalog.jsonb_typeof(p_envelope) IS DISTINCT FROM 'object'
     OR p_envelope - v_expected_keys <> '{}'::jsonb
     OR NOT (p_envelope ?& v_expected_keys) THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_envelope -> 'formatVersion') IS DISTINCT FROM 'number'
     OR p_envelope ->> 'formatVersion' <> '1'
     OR pg_catalog.jsonb_typeof(p_envelope -> 'kekVersion') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;

  v_value := p_envelope ->> 'kekVersion';
  IF v_value !~ '^[1-9][0-9]*$'
     OR v_value::numeric > 9007199254740991 THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_envelope -> 'plaintextType') IS DISTINCT FROM 'string'
     OR p_envelope ->> 'plaintextType' NOT IN ('string', 'buffer', 'uint8array')
     OR pg_catalog.jsonb_typeof(p_envelope -> 'ciphertext') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;

  v_value := p_envelope ->> 'ciphertext';
  IF pg_catalog.char_length(v_value) > 4194304
     OR v_value !~ '^[A-Za-z0-9_-]*$' THEN
    RETURN false;
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'iv',
    'dekWrapIv',
    'tag',
    'dekWrapTag',
    'wrappedDek'
  ] LOOP
    IF pg_catalog.jsonb_typeof(p_envelope -> v_key) IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;

    v_value := p_envelope ->> v_key;
    IF v_value !~ '^[A-Za-z0-9_-]+$'
       OR pg_catalog.char_length(v_value) <> CASE v_key
         WHEN 'iv' THEN 16
         WHEN 'dekWrapIv' THEN 16
         WHEN 'tag' THEN 22
         WHEN 'dekWrapTag' THEN 22
         WHEN 'wrappedDek' THEN 43
       END THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$function$;

ALTER FUNCTION securitres_private.is_valid_phase1_envelope(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.is_valid_phase1_envelope(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION securitres_private.is_valid_phase1_envelope(jsonb)
  TO authenticated, service_role;

ALTER TABLE public.profiles
  ADD COLUMN full_name_envelope jsonb,
  ADD COLUMN student_number_envelope jsonb,
  ADD COLUMN program_envelope jsonb,
  ADD CONSTRAINT profiles_full_name_envelope_phase1_check
    CHECK (full_name_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(full_name_envelope)),
  ADD CONSTRAINT profiles_student_number_envelope_phase1_check
    CHECK (student_number_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(student_number_envelope)),
  ADD CONSTRAINT profiles_program_envelope_phase1_check
    CHECK (program_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(program_envelope));

ALTER TABLE public.excuse_letters
  ADD COLUMN absence_start_envelope jsonb,
  ADD COLUMN absence_end_envelope jsonb,
  ADD COLUMN reason_envelope jsonb,
  ADD COLUMN dean_comment_envelope jsonb,
  ADD CONSTRAINT excuse_letters_absence_start_envelope_phase1_check
    CHECK (absence_start_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(absence_start_envelope)),
  ADD CONSTRAINT excuse_letters_absence_end_envelope_phase1_check
    CHECK (absence_end_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(absence_end_envelope)),
  ADD CONSTRAINT excuse_letters_reason_envelope_phase1_check
    CHECK (reason_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(reason_envelope)),
  ADD CONSTRAINT excuse_letters_dean_comment_envelope_phase1_check
    CHECK (dean_comment_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(dean_comment_envelope));

ALTER TABLE public.letter_status_events
  ADD COLUMN comment_envelope jsonb,
  ADD CONSTRAINT letter_status_events_comment_envelope_phase1_check
    CHECK (comment_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(comment_envelope));

ALTER TABLE public.excuse_letter_contacts
  ADD COLUMN parent_guardian_phone_envelope jsonb,
  ADD CONSTRAINT excuse_letter_contacts_phone_envelope_phase1_check
    CHECK (parent_guardian_phone_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(parent_guardian_phone_envelope));

ALTER TABLE public.excuse_evidence
  ADD COLUMN original_filename_envelope jsonb,
  ADD CONSTRAINT excuse_evidence_filename_envelope_phase1_check
    CHECK (original_filename_envelope IS NULL
      OR securitres_private.is_valid_phase1_envelope(original_filename_envelope));

REVOKE SELECT ON TABLE public.excuse_letters
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT (dean_comment) ON TABLE public.excuse_letters
  FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  student_id,
  course_id,
  absence_start,
  absence_end,
  reason,
  status,
  submitted_at,
  decided_at,
  decided_by,
  created_at
) ON TABLE public.excuse_letters TO authenticated;

REVOKE SELECT ON TABLE public.letter_status_events
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT (comment) ON TABLE public.letter_status_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id,
  letter_id,
  actor_id,
  old_status,
  new_status,
  created_at
) ON TABLE public.letter_status_events TO authenticated;

CREATE FUNCTION public.get_authorized_letter_comments(p_letter_ids uuid[])
RETURNS TABLE (
  letter_id uuid,
  dean_comment text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_role text := (SELECT public.current_profile_role());
BEGIN
  IF v_user_id IS NULL
     OR v_role IS NULL
     OR v_role NOT IN ('student', 'dean') THEN
    RAISE EXCEPTION 'Letter comments are not available to this account.'
      USING ERRCODE = '42501';
  END IF;

  IF p_letter_ids IS NULL OR pg_catalog.cardinality(p_letter_ids) > 500 THEN
    RAISE EXCEPTION 'A valid set of at most 500 letter IDs is required.'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT letter.id, letter.dean_comment
  FROM public.excuse_letters AS letter
  WHERE letter.id = ANY (p_letter_ids)
    AND (
      (v_role = 'student' AND letter.student_id = v_user_id)
      OR (
        v_role = 'dean'
        AND securitres_private.can_dean_access_letter(letter.id)
      )
    );
END;
$function$;

ALTER FUNCTION public.get_authorized_letter_comments(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_authorized_letter_comments(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_authorized_letter_comments(uuid[])
  TO authenticated;

CREATE FUNCTION public.get_authorized_letter_status_history_comments(p_letter_id uuid)
RETURNS TABLE (
  id uuid,
  old_status text,
  new_status text,
  comment text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_role text := (SELECT public.current_profile_role());
BEGIN
  IF v_user_id IS NULL
     OR v_role IS NULL
     OR v_role NOT IN ('student', 'dean') THEN
    RAISE EXCEPTION 'Letter history is not available to this account.'
      USING ERRCODE = '42501';
  END IF;

  IF p_letter_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.excuse_letters AS letter
       WHERE letter.id = p_letter_id
         AND (
           (v_role = 'student' AND letter.student_id = v_user_id)
           OR (
             v_role = 'dean'
             AND securitres_private.can_dean_access_letter(letter.id)
           )
         )
     ) THEN
    RAISE EXCEPTION 'Letter history is not available to this account.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT event.id, event.old_status, event.new_status, event.comment, event.created_at
  FROM public.letter_status_events AS event
  WHERE event.letter_id = p_letter_id
  ORDER BY event.created_at ASC, event.id ASC;
END;
$function$;

ALTER FUNCTION public.get_authorized_letter_status_history_comments(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_authorized_letter_status_history_comments(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_authorized_letter_status_history_comments(uuid)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
