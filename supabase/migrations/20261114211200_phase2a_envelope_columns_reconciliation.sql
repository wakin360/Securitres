BEGIN;

DO $preflight$
DECLARE
  v_table record;
  v_expected record;
  v_actual record;
  v_constraint record;
  v_validator record;
  v_relation regclass;
  v_validator_oid oid;
BEGIN
  IF pg_catalog.to_regnamespace('public') IS NULL
     OR pg_catalog.to_regnamespace('securitres_private') IS NULL THEN
    RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: a required schema is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'postgres'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'authenticated'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'service_role'
  ) THEN
    RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: a required Supabase role is missing.';
  END IF;

  FOR v_table IN
    SELECT *
    FROM (VALUES
      ('public', 'excuse_evidence'),
      ('public', 'excuse_letter_contacts'),
      ('public', 'excuse_letters'),
      ('public', 'letter_status_events')
    ) AS required_tables(schema_name, table_name)
    ORDER BY table_name
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', v_table.schema_name, v_table.table_name)
    );

    IF v_relation IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS c
      WHERE c.oid = v_relation
        AND c.relkind IN ('r', 'p')
    ) THEN
      RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: %.% must be a table.',
        v_table.schema_name, v_table.table_name;
    END IF;

    EXECUTE pg_catalog.format(
      'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
      v_table.schema_name,
      v_table.table_name
    );
  END LOOP;

  IF NOT pg_catalog.has_schema_privilege(
       'authenticated', 'securitres_private', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: authenticated must have USAGE on securitres_private.';
  END IF;

  v_validator_oid := pg_catalog.to_regprocedure(
    'securitres_private.is_valid_phase1_envelope(jsonb)'
  )::oid;

  IF v_validator_oid IS NULL THEN
    RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: securitres_private.is_valid_phase1_envelope(jsonb) is missing.';
  END IF;

  SELECT
    pg_catalog.pg_get_userbyid(p.proowner) AS owner_name,
    l.lanname,
    p.prokind,
    p.pronargs,
    p.pronargdefaults,
    p.proargtypes[0] AS argument_type,
    p.proargnames,
    p.prorettype,
    p.proretset,
    p.prosecdef,
    p.proisstrict,
    p.provolatile,
    p.proparallel,
    p.proconfig,
    pg_catalog.md5(
      pg_catalog.regexp_replace(
        pg_catalog.replace(
          pg_catalog.replace(p.prosrc, E'\r\n', E'\n'),
          E'\r',
          E'\n'
        ),
        '^[[:space:]]+|[[:space:]]+$',
        '',
        'g'
      )
    ) AS body_hash
  INTO v_validator
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.oid = v_validator_oid;

  IF NOT FOUND
     OR v_validator.owner_name IS DISTINCT FROM 'postgres'
     OR v_validator.lanname IS DISTINCT FROM 'plpgsql'
     OR v_validator.prokind IS DISTINCT FROM 'f'
     OR v_validator.pronargs IS DISTINCT FROM 1
     OR v_validator.pronargdefaults IS DISTINCT FROM 0
     OR v_validator.argument_type IS DISTINCT FROM 'pg_catalog.jsonb'::regtype::oid
     OR v_validator.proargnames IS DISTINCT FROM ARRAY['p_envelope']::text[]
     OR v_validator.prorettype IS DISTINCT FROM 'pg_catalog.bool'::regtype::oid
     OR v_validator.proretset
     OR v_validator.prosecdef
     OR v_validator.proisstrict
     OR v_validator.provolatile IS DISTINCT FROM 'i'
     OR v_validator.proparallel IS DISTINCT FROM 's'
     OR v_validator.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
     OR v_validator.body_hash NOT IN (
       '6e25de459a2b2d6851bc05ca426902c8'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated', v_validator_oid, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_validator_oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: the existing envelope validator is incompatible or lacks intended EXECUTE privileges.';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('excuse_evidence', 'original_filename_envelope'),
      ('excuse_letter_contacts', 'parent_guardian_phone_envelope'),
      ('excuse_letters', 'absence_start_envelope'),
      ('excuse_letters', 'absence_end_envelope'),
      ('excuse_letters', 'reason_envelope'),
      ('excuse_letters', 'dean_comment_envelope'),
      ('letter_status_events', 'comment_envelope')
    ) AS target_columns(table_name, column_name)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_expected.table_name)
    );

    SELECT
      a.atttypid,
      a.attnotnull,
      a.atthasdef,
      a.attidentity,
      a.attgenerated,
      a.attcollation,
      a.attislocal,
      a.attinhcount
    INTO v_actual
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_relation
      AND a.attname = v_expected.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF FOUND AND (
      v_actual.atttypid IS DISTINCT FROM 'pg_catalog.jsonb'::regtype::oid
      OR v_actual.attnotnull
      OR v_actual.atthasdef
      OR v_actual.attidentity <> ''
      OR v_actual.attgenerated <> ''
      OR v_actual.attcollation IS DISTINCT FROM
        (SELECT t.typcollation
         FROM pg_catalog.pg_type AS t
         WHERE t.oid = 'pg_catalog.jsonb'::regtype::oid)
      OR NOT v_actual.attislocal
      OR v_actual.attinhcount <> 0
    ) THEN
      RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: public.%.% has an incompatible column definition.',
        v_expected.table_name, v_expected.column_name;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('excuse_evidence',
       'excuse_evidence_filename_envelope_phase1_check',
       'checkoriginal_filename_envelopeisnullorsecuritres_private.is_valid_phase1_envelopeoriginal_filename_envelope'),
      ('excuse_letter_contacts',
       'excuse_letter_contacts_phone_envelope_phase1_check',
       'checkparent_guardian_phone_envelopeisnullorsecuritres_private.is_valid_phase1_envelopeparent_guardian_phone_envelope'),
      ('excuse_letters',
       'excuse_letters_absence_start_envelope_phase1_check',
       'checkabsence_start_envelopeisnullorsecuritres_private.is_valid_phase1_envelopeabsence_start_envelope'),
      ('excuse_letters',
       'excuse_letters_absence_end_envelope_phase1_check',
       'checkabsence_end_envelopeisnullorsecuritres_private.is_valid_phase1_envelopeabsence_end_envelope'),
      ('excuse_letters',
       'excuse_letters_reason_envelope_phase1_check',
       'checkreason_envelopeisnullorsecuritres_private.is_valid_phase1_envelopereason_envelope'),
      ('excuse_letters',
       'excuse_letters_dean_comment_envelope_phase1_check',
       'checkdean_comment_envelopeisnullorsecuritres_private.is_valid_phase1_envelopedean_comment_envelope'),
      ('letter_status_events',
       'letter_status_events_comment_envelope_phase1_check',
       'checkcomment_envelopeisnullorsecuritres_private.is_valid_phase1_envelopecomment_envelope')
    ) AS target_constraints(table_name, constraint_name, definition_key)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_expected.table_name)
    );

    SELECT
      c.contype,
      c.convalidated,
      c.condeferrable,
      c.condeferred,
      c.connoinherit,
      c.conislocal,
      c.coninhcount,
      pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(c.oid, true),
          '[[:space:]()]|::text',
          '',
          'g'
        )
      ) AS actual_definition_key
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = v_relation
      AND c.conname = v_expected.constraint_name;

    IF FOUND AND (
      v_constraint.contype IS DISTINCT FROM 'c'
      OR NOT v_constraint.convalidated
      OR v_constraint.condeferrable
      OR v_constraint.condeferred
      OR v_constraint.connoinherit
      OR NOT v_constraint.conislocal
      OR v_constraint.coninhcount <> 0
      OR v_constraint.actual_definition_key IS DISTINCT FROM
        v_expected.definition_key
    ) THEN
      RAISE EXCEPTION 'Phase 2A reconciliation preflight failed: constraint public.%.% has an incompatible or unvalidated definition.',
        v_expected.table_name, v_expected.constraint_name;
    END IF;
  END LOOP;
END;
$preflight$;

ALTER TABLE public.excuse_evidence
  ADD COLUMN IF NOT EXISTS original_filename_envelope jsonb;

ALTER TABLE public.excuse_letter_contacts
  ADD COLUMN IF NOT EXISTS parent_guardian_phone_envelope jsonb;

ALTER TABLE public.excuse_letters
  ADD COLUMN IF NOT EXISTS absence_start_envelope jsonb,
  ADD COLUMN IF NOT EXISTS absence_end_envelope jsonb,
  ADD COLUMN IF NOT EXISTS reason_envelope jsonb,
  ADD COLUMN IF NOT EXISTS dean_comment_envelope jsonb;

ALTER TABLE public.letter_status_events
  ADD COLUMN IF NOT EXISTS comment_envelope jsonb;

DO $ensure_envelope_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.excuse_evidence'::regclass
      AND conname = 'excuse_evidence_filename_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.excuse_evidence
      ADD CONSTRAINT excuse_evidence_filename_envelope_phase1_check
      CHECK (original_filename_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(original_filename_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.excuse_letter_contacts'::regclass
      AND conname = 'excuse_letter_contacts_phone_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.excuse_letter_contacts
      ADD CONSTRAINT excuse_letter_contacts_phone_envelope_phase1_check
      CHECK (parent_guardian_phone_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(parent_guardian_phone_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.excuse_letters'::regclass
      AND conname = 'excuse_letters_absence_start_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_absence_start_envelope_phase1_check
      CHECK (absence_start_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(absence_start_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.excuse_letters'::regclass
      AND conname = 'excuse_letters_absence_end_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_absence_end_envelope_phase1_check
      CHECK (absence_end_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(absence_end_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.excuse_letters'::regclass
      AND conname = 'excuse_letters_reason_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_reason_envelope_phase1_check
      CHECK (reason_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(reason_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.excuse_letters'::regclass
      AND conname = 'excuse_letters_dean_comment_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_dean_comment_envelope_phase1_check
      CHECK (dean_comment_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(dean_comment_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.letter_status_events'::regclass
      AND conname = 'letter_status_events_comment_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.letter_status_events
      ADD CONSTRAINT letter_status_events_comment_envelope_phase1_check
      CHECK (comment_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(comment_envelope));
  END IF;
END;
$ensure_envelope_constraints$;

NOTIFY pgrst, 'reload schema';

COMMIT;
