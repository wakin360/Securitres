BEGIN;

DO $preflight$
DECLARE
  v_item record;
  v_relation oid;
  v_actual_type oid;
  v_expected_type oid;
  v_attnotnull boolean;
  v_attgenerated "char";
  v_role_name text;
  v_validator_oid oid;
  v_legacy_oid oid;
  v_constraint_oid oid;
  v_constraint_type "char";
  v_constraint_validated boolean;
  v_constraint_definition text;
  v_expected_legacy_body text := $legacy$
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
$legacy$;
BEGIN
  IF pg_catalog.to_regnamespace('public') IS NULL
     OR pg_catalog.to_regnamespace('auth') IS NULL
     OR pg_catalog.to_regnamespace('securitres_private') IS NULL THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: a required schema is missing.';
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ] LOOP
    IF pg_catalog.to_regrole(v_role_name) IS NULL THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: required role % is missing.',
        v_role_name;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('profiles', 'id', 'uuid'),
      ('profiles', 'role', 'text'),
      ('profiles', 'program_id', 'uuid'),
      ('course_enrollments', 'student_id', 'uuid'),
      ('course_enrollments', 'course_id', 'uuid'),
      ('excuse_letters', 'id', 'uuid'),
      ('excuse_letters', 'student_id', 'uuid'),
      ('excuse_letters', 'course_id', 'uuid'),
      ('excuse_letters', 'absence_start', 'date'),
      ('excuse_letters', 'absence_start_envelope', 'jsonb'),
      ('excuse_letters', 'absence_end', 'date'),
      ('excuse_letters', 'absence_end_envelope', 'jsonb'),
      ('excuse_letters', 'reason', 'text'),
      ('excuse_letters', 'reason_envelope', 'jsonb'),
      ('excuse_letters', 'status', 'text'),
      ('excuse_letter_contacts', 'letter_id', 'uuid'),
      ('excuse_letter_contacts', 'parent_guardian_phone', 'text'),
      ('excuse_letter_contacts', 'parent_guardian_phone_envelope', 'jsonb')
    ) AS required_columns(table_name, column_name, type_name)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', 'public', v_item.table_name)
    );
    IF v_relation IS NULL THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: public.% is missing.',
        v_item.table_name;
    END IF;

    SELECT a.atttypid
    INTO v_actual_type
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_relation
      AND a.attname = v_item.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: public.%.% is missing.',
        v_item.table_name, v_item.column_name;
    END IF;

    v_expected_type := pg_catalog.to_regtype(v_item.type_name)::oid;
    IF v_actual_type IS DISTINCT FROM v_expected_type THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: public.%.% has an unexpected type.',
        v_item.table_name, v_item.column_name;
    END IF;
  END LOOP;

  SELECT a.attnotnull, a.attgenerated
  INTO v_attnotnull, v_attgenerated
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.excuse_letters'::regclass
    AND a.attname = 'status'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF NOT FOUND
     OR NOT v_attnotnull
     OR v_attgenerated <> '' THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: excuse_letters.status must be a non-generated NOT NULL column.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attrdef AS d
    WHERE d.adrelid = 'public.excuse_letters'::regclass
      AND d.adnum = (
        SELECT a.attnum
        FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = 'public.excuse_letters'::regclass
          AND a.attname = 'status'
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
      AND pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_expr(d.adbin, d.adrelid, true)),
        '[[:space:]()]',
        '',
        'g'
      ) = '''pending''::text'
  ) THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: excuse_letters.status must default to pending.';
  END IF;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('excuse_letters', 'absence_start'),
      ('excuse_letters', 'absence_end'),
      ('excuse_letters', 'reason'),
      ('excuse_letter_contacts', 'parent_guardian_phone')
    ) AS writable_columns(table_name, column_name)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', 'public', v_item.table_name)
    );

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = v_relation
        AND a.attname = v_item.column_name
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attgenerated <> ''
    ) THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: public.%.% must not be a generated column.',
        v_item.table_name, v_item.column_name;
    END IF;
  END LOOP;

  v_validator_oid := pg_catalog.to_regprocedure(
    'securitres_private.is_valid_phase1_envelope(jsonb)'
  );
  IF v_validator_oid IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_language AS l
         ON l.oid = p.prolang
       WHERE p.oid = v_validator_oid
         AND p.prorettype = 'pg_catalog.bool'::regtype
         AND p.proargnames = ARRAY['p_envelope']::text[]
         AND l.lanname = 'plpgsql'
         AND NOT p.prosecdef
         AND NOT p.proisstrict
         AND p.provolatile = 'i'
         AND p.proparallel = 's'
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
         AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
         AND pg_catalog.md5(
           pg_catalog.btrim(
             pg_catalog.replace(
               pg_catalog.replace(p.prosrc, E'\r\n', E'\n'),
               E'\r',
               E'\n'
             ),
             E' \t\n'
           )
         ) = '6e25de459a2b2d6851bc05ca426902c8'
         AND pg_catalog.has_function_privilege(
           'postgres', p.oid, 'EXECUTE'
         )
     ) THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: the strict Phase 1 envelope validator is missing or incompatible.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_student_excuse_letter_encrypted'
  ) THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: a function named create_student_excuse_letter_encrypted already exists; review it before proceeding.';
  END IF;

  v_legacy_oid := pg_catalog.to_regprocedure(
    'public.create_student_excuse_letter(uuid, date, date, text, text)'
  );

  IF v_legacy_oid IS NULL
     AND EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_namespace AS n
         ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'create_student_excuse_letter'
     ) THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: an unexpected overload of the legacy plaintext RPC exists.';
  END IF;

  IF v_legacy_oid IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_language AS l
         ON l.oid = p.prolang
       WHERE p.oid = v_legacy_oid
         AND p.pronargs = 5
         AND p.pronargdefaults = 0
         AND p.proargnames = ARRAY[
           'p_course_id',
           'p_absence_start',
           'p_absence_end',
           'p_reason',
           'p_parent_guardian_phone'
         ]::text[]
         AND p.prorettype = 'public.excuse_letters'::regtype
         AND p.proretset
         AND l.lanname = 'plpgsql'
         AND NOT p.prosecdef
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
         AND pg_catalog.btrim(
           pg_catalog.replace(
             pg_catalog.replace(p.prosrc, E'\r\n', E'\n'),
             E'\r',
             E'\n'
           ),
           E' \t\n'
         ) = pg_catalog.btrim(
           pg_catalog.replace(
             pg_catalog.replace(v_expected_legacy_body, E'\r\n', E'\n'),
             E'\r',
             E'\n'
           ),
           E' \t\n'
         )
     ) THEN
    RAISE EXCEPTION 'Student submission reconciliation failed: the legacy plaintext RPC differs from its reviewed definition.';
  END IF;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      (
        'excuse_letters',
        'excuse_letters_absence_start_plaintext_or_envelope_check',
        'checkabsence_startisnotnullorabsence_start_envelopeisnotnull'
      ),
      (
        'excuse_letters',
        'excuse_letters_absence_end_plaintext_or_envelope_check',
        'checkabsence_endisnotnullorabsence_end_envelopeisnotnull'
      ),
      (
        'excuse_letters',
        'excuse_letters_reason_plaintext_or_envelope_check',
        'checkreasonisnotnullorreason_envelopeisnotnull'
      ),
      (
        'excuse_letter_contacts',
        'excuse_letter_contacts_phone_plaintext_or_envelope_check',
        'checkparent_guardian_phoneisnotnullorparent_guardian_phone_envelopeisnotnull'
      )
    ) AS expected_constraints(table_name, constraint_name, definition_key)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', 'public', v_item.table_name)
    );

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS c
      WHERE c.conname = v_item.constraint_name
        AND c.conrelid <> v_relation
    ) THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: constraint name % is used by another table.',
        v_item.constraint_name;
    END IF;

    SELECT c.oid, c.contype, c.convalidated,
           pg_catalog.regexp_replace(
             pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
             '[[:space:]()]',
             '',
             'g'
           )
    INTO v_constraint_oid, v_constraint_type, v_constraint_validated,
         v_constraint_definition
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = v_relation
      AND c.conname = v_item.constraint_name;

    IF v_constraint_oid IS NOT NULL
       AND (
         v_constraint_type <> 'c'
         OR NOT v_constraint_validated
         OR v_constraint_definition <> v_item.definition_key
       ) THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: existing constraint % is incompatible or unvalidated.',
        v_item.constraint_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_relation
        AND c.conname <> v_item.constraint_name
        AND c.contype = 'c'
        AND pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
          '[[:space:]()]',
          '',
          'g'
        ) = v_item.definition_key
    ) THEN
      RAISE EXCEPTION 'Student submission reconciliation failed: an equivalent constraint for % exists under another name.',
        v_item.constraint_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.excuse_letters
    WHERE absence_start IS NULL
      AND absence_start_envelope IS NULL
  ) THEN
    RAISE EXCEPTION 'Student submission reconciliation aborted: existing excuse_letters rows have neither absence_start nor absence_start_envelope.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excuse_letters
    WHERE absence_end IS NULL
      AND absence_end_envelope IS NULL
  ) THEN
    RAISE EXCEPTION 'Student submission reconciliation aborted: existing excuse_letters rows have neither absence_end nor absence_end_envelope.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excuse_letters
    WHERE reason IS NULL
      AND reason_envelope IS NULL
  ) THEN
    RAISE EXCEPTION 'Student submission reconciliation aborted: existing excuse_letters rows have neither reason nor reason_envelope.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excuse_letter_contacts
    WHERE parent_guardian_phone IS NULL
      AND parent_guardian_phone_envelope IS NULL
  ) THEN
    RAISE EXCEPTION 'Student submission reconciliation aborted: existing excuse_letter_contacts rows have neither parent_guardian_phone nor its envelope.';
  END IF;
END;
$preflight$;

ALTER TABLE public.excuse_letters
  ALTER COLUMN absence_start DROP NOT NULL,
  ALTER COLUMN absence_end DROP NOT NULL,
  ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE public.excuse_letter_contacts
  ALTER COLUMN parent_guardian_phone DROP NOT NULL;

DO $add_missing_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letters'::regclass
      AND c.conname = 'excuse_letters_absence_start_plaintext_or_envelope_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_absence_start_plaintext_or_envelope_check
      CHECK (
        absence_start IS NOT NULL
        OR absence_start_envelope IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letters'::regclass
      AND c.conname = 'excuse_letters_absence_end_plaintext_or_envelope_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_absence_end_plaintext_or_envelope_check
      CHECK (
        absence_end IS NOT NULL
        OR absence_end_envelope IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letters'::regclass
      AND c.conname = 'excuse_letters_reason_plaintext_or_envelope_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_reason_plaintext_or_envelope_check
      CHECK (
        reason IS NOT NULL
        OR reason_envelope IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letter_contacts'::regclass
      AND c.conname = 'excuse_letter_contacts_phone_plaintext_or_envelope_check'
  ) THEN
    ALTER TABLE public.excuse_letter_contacts
      ADD CONSTRAINT excuse_letter_contacts_phone_plaintext_or_envelope_check
      CHECK (
        parent_guardian_phone IS NOT NULL
        OR parent_guardian_phone_envelope IS NOT NULL
      );
  END IF;
END;
$add_missing_constraints$;

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

ALTER FUNCTION public.create_student_excuse_letter_encrypted(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_student_excuse_letter_encrypted(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_student_excuse_letter_encrypted(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb
) TO service_role;

DO $revoke_legacy_plaintext_rpc$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.create_student_excuse_letter(uuid, date, date, text, text)'
  ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_student_excuse_letter(uuid, date, date, text, text) FROM PUBLIC, anon, authenticated';
  END IF;
END;
$revoke_legacy_plaintext_rpc$;

NOTIFY pgrst, 'reload schema';

COMMIT;
