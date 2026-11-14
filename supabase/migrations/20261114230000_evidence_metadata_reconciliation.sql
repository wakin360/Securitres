BEGIN;

DO $preflight$
DECLARE
  v_item record;
  v_relation oid;
  v_actual_type oid;
  v_expected_type oid;
  v_actual_not_null boolean;
  v_actual_generated "char";
  v_role_name text;
  v_validator_oid oid;
  v_validator record;
  v_constraint_oid oid;
  v_constraint_type "char";
  v_constraint_validated boolean;
  v_constraint_definition text;
BEGIN
  IF pg_catalog.to_regnamespace('public') IS NULL
     OR pg_catalog.to_regnamespace('securitres_private') IS NULL THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: a required schema is missing.';
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ] LOOP
    IF pg_catalog.to_regrole(v_role_name) IS NULL THEN
      RAISE EXCEPTION 'Evidence metadata reconciliation failed: required role % is missing.',
        v_role_name;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('public', 'excuse_evidence'),
      ('public', 'excuse_letters')
    ) AS required_tables(schema_name, table_name)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', v_item.schema_name, v_item.table_name)
    );

    IF v_relation IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      WHERE c.oid = v_relation
        AND c.relkind IN ('r', 'p')
    ) THEN
      RAISE EXCEPTION 'Evidence metadata reconciliation failed: %.% must be a table.',
        v_item.schema_name, v_item.table_name;
    END IF;
  END LOOP;

  LOCK TABLE public.excuse_evidence, public.excuse_letters
    IN ACCESS EXCLUSIVE MODE;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('excuse_evidence', 'id', 'uuid', true),
      ('excuse_evidence', 'letter_id', 'uuid', true),
      ('excuse_evidence', 'storage_path', 'text', true),
      ('excuse_evidence', 'original_filename', 'text', NULL::boolean),
      ('excuse_evidence', 'original_filename_envelope', 'jsonb', false),
      ('excuse_evidence', 'mime_type', 'text', true),
      ('excuse_evidence', 'size_bytes', 'bigint', true),
      ('excuse_evidence', 'uploaded_at', 'timestamp with time zone', true),
      ('excuse_letters', 'id', 'uuid', true),
      ('excuse_letters', 'student_id', 'uuid', true),
      ('excuse_letters', 'status', 'text', true)
    ) AS required_columns(table_name, column_name, type_name, expected_not_null)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', 'public', v_item.table_name)
    );

    SELECT a.atttypid, a.attnotnull, a.attgenerated
    INTO v_actual_type, v_actual_not_null, v_actual_generated
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_relation
      AND a.attname = v_item.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Evidence metadata reconciliation failed: public.%.% is missing.',
        v_item.table_name, v_item.column_name;
    END IF;

    v_expected_type := pg_catalog.to_regtype(v_item.type_name)::oid;
    IF v_actual_type IS DISTINCT FROM v_expected_type THEN
      RAISE EXCEPTION 'Evidence metadata reconciliation failed: public.%.% has an unexpected type.',
        v_item.table_name, v_item.column_name;
    END IF;

    IF v_item.expected_not_null IS NOT NULL
       AND v_actual_not_null IS DISTINCT FROM v_item.expected_not_null THEN
      RAISE EXCEPTION 'Evidence metadata reconciliation failed: public.%.% has unexpected nullability.',
        v_item.table_name, v_item.column_name;
    END IF;

    IF v_actual_generated <> '' THEN
      RAISE EXCEPTION 'Evidence metadata reconciliation failed: public.%.% must not be a generated column.',
        v_item.table_name, v_item.column_name;
    END IF;
  END LOOP;

  v_validator_oid := pg_catalog.to_regprocedure(
    'securitres_private.is_valid_phase1_envelope(jsonb)'
  );
  IF v_validator_oid IS NULL THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: securitres_private.is_valid_phase1_envelope(jsonb) is missing.';
  END IF;

  SELECT
    pg_catalog.pg_get_userbyid(p.proowner) AS owner_name,
    l.lanname,
    p.pronargs,
    p.pronargdefaults,
    p.proargnames,
    p.prorettype,
    p.prosecdef,
    p.proisstrict,
    p.provolatile,
    p.proparallel,
    p.proconfig,
    pg_catalog.md5(
      pg_catalog.btrim(
        pg_catalog.replace(
          pg_catalog.replace(p.prosrc, E'\r\n', E'\n'),
          E'\r',
          E'\n'
        ),
        E' \t\n'
      )
    ) AS body_hash
  INTO v_validator
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.oid = v_validator_oid;

  IF NOT FOUND
     OR v_validator.owner_name IS DISTINCT FROM 'postgres'
     OR v_validator.lanname IS DISTINCT FROM 'plpgsql'
     OR v_validator.pronargs IS DISTINCT FROM 1
     OR v_validator.pronargdefaults IS DISTINCT FROM 0
     OR v_validator.proargnames IS DISTINCT FROM ARRAY['p_envelope']::text[]
     OR v_validator.prorettype IS DISTINCT FROM 'pg_catalog.bool'::regtype::oid
     OR v_validator.prosecdef
     OR v_validator.proisstrict
     OR v_validator.provolatile IS DISTINCT FROM 'i'
     OR v_validator.proparallel IS DISTINCT FROM 's'
     OR v_validator.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
     OR v_validator.body_hash IS DISTINCT FROM '6e25de459a2b2d6851bc05ca426902c8'
     OR NOT pg_catalog.has_function_privilege(
       'postgres', v_validator_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: the strict envelope validator is incompatible.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_student_evidence_record_encrypted'
  ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: a function named create_student_evidence_record_encrypted already exists; review it before proceeding.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conname = 'excuse_evidence_filename_plaintext_or_envelope_check'
      AND c.conrelid <> 'public.excuse_evidence'::regclass
  ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: the plaintext-or-envelope constraint name is used by another table.';
  END IF;

  SELECT
    c.oid,
    c.contype,
    c.convalidated,
    pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
      '[[:space:]()]',
      '',
      'g'
    )
  INTO v_constraint_oid, v_constraint_type, v_constraint_validated,
       v_constraint_definition
  FROM pg_catalog.pg_constraint AS c
  WHERE c.conrelid = 'public.excuse_evidence'::regclass
    AND c.conname = 'excuse_evidence_filename_plaintext_or_envelope_check';

  IF v_constraint_oid IS NOT NULL
     AND (
       v_constraint_type <> 'c'
       OR NOT v_constraint_validated
       OR v_constraint_definition <>
         'checkoriginal_filenameisnotnullororiginal_filename_envelopeisnotnull'
     ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: the existing plaintext-or-envelope constraint is incompatible or unvalidated.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_evidence'::regclass
      AND c.conname <> 'excuse_evidence_filename_plaintext_or_envelope_check'
      AND c.contype = 'c'
      AND pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
        '[[:space:]()]',
        '',
        'g'
      ) = 'checkoriginal_filenameisnotnullororiginal_filename_envelopeisnotnull'
  ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: an equivalent plaintext-or-envelope constraint exists under another name.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_evidence'::regclass
      AND c.conname = 'excuse_evidence_filename_envelope_phase1_check'
      AND c.contype = 'c'
      AND c.convalidated
      AND pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
        '[[:space:]()]',
        '',
        'g'
      ) = 'checkoriginal_filename_envelopeisnullorsecuritres_private.is_valid_phase1_envelopeoriginal_filename_envelope'
  ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation failed: the existing envelope-validation constraint is missing, unvalidated, or incompatible.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excuse_evidence
    WHERE original_filename IS NULL
      AND original_filename_envelope IS NULL
  ) THEN
    RAISE EXCEPTION 'Evidence metadata reconciliation aborted: existing evidence rows have neither original_filename nor original_filename_envelope.';
  END IF;
END;
$preflight$;

ALTER TABLE public.excuse_evidence
  ALTER COLUMN original_filename DROP NOT NULL;

DO $add_missing_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_evidence'::regclass
      AND c.conname = 'excuse_evidence_filename_plaintext_or_envelope_check'
  ) THEN
    ALTER TABLE public.excuse_evidence
      ADD CONSTRAINT excuse_evidence_filename_plaintext_or_envelope_check
      CHECK (
        original_filename IS NOT NULL
        OR original_filename_envelope IS NOT NULL
      );
  END IF;
END;
$add_missing_constraint$;

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

ALTER FUNCTION public.create_student_evidence_record_encrypted(
  uuid, uuid, uuid, text, jsonb, text, bigint
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_student_evidence_record_encrypted(
  uuid, uuid, uuid, text, jsonb, text, bigint
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.create_student_evidence_record_encrypted(
  uuid, uuid, uuid, text, jsonb, text, bigint
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
