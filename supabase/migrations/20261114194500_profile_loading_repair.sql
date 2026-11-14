BEGIN;

DO $preflight$
DECLARE
  v_profiles regclass := pg_catalog.to_regclass('public.profiles');
  v_expected record;
  v_table record;
  v_actual record;
  v_constraint record;
  v_function record;
  v_profile_index record;
  v_function_oid oid;
  v_profile_owner oid;
  v_profile_tablespace oid;
  v_relation regclass;
  v_student_index_attnum smallint;
  v_student_index_collation oid;
  v_expected_opclass oid;
BEGIN
  IF v_profiles IS NULL THEN
    RAISE EXCEPTION 'Profile repair preflight failed: public.profiles is missing.';
  END IF;

  IF pg_catalog.to_regnamespace('securitres_private') IS NULL THEN
    RAISE EXCEPTION 'Profile repair preflight failed: securitres_private is missing.';
  END IF;

  IF (
    SELECT pg_catalog.count(DISTINCT r.rolname)
    FROM pg_catalog.pg_roles AS r
    WHERE r.rolname = ANY (ARRAY['postgres', 'anon', 'authenticated', 'service_role'])
  ) <> 4 THEN
    RAISE EXCEPTION 'Profile repair preflight failed: a required Supabase role is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = v_profiles
      AND c.relkind = 'r'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Profile repair preflight failed: public.profiles must be a regular RLS-enabled table.';
  END IF;

  FOR v_table IN
    SELECT *
    FROM (VALUES
      ('public', 'excuse_evidence'),
      ('public', 'excuse_letter_contacts'),
      ('public', 'excuse_letters'),
      ('public', 'letter_status_events'),
      ('public', 'profiles')
    ) AS envelope_tables(schema_name, table_name)
    ORDER BY table_name
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', v_table.schema_name, v_table.table_name)
    );

    IF v_relation IS NOT NULL THEN
      IF v_table.table_name = 'profiles' THEN
        EXECUTE pg_catalog.format(
          'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
          v_table.schema_name,
          v_table.table_name
        );
      ELSE
        EXECUTE pg_catalog.format(
          'LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE',
          v_table.schema_name,
          v_table.table_name
        );
      END IF;
    END IF;
  END LOOP;

  SELECT c.relowner, c.reltablespace
  INTO v_profile_owner, v_profile_tablespace
  FROM pg_catalog.pg_class AS c
  WHERE c.oid = v_profiles;

  IF NOT pg_catalog.has_schema_privilege('authenticated', 'securitres_private', 'USAGE') THEN
    RAISE EXCEPTION 'Profile repair preflight failed: authenticated must already have USAGE on securitres_private.';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('id', 'uuid'),
      ('role', 'text'),
      ('program_id', 'uuid'),
      ('full_name', 'text'),
      ('student_number', 'text'),
      ('program', 'text'),
      ('created_at', 'timestamp with time zone')
    ) AS expected(column_name, type_name)
  LOOP
    SELECT a.atttypid, a.attnotnull
    INTO v_actual
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_profiles
      AND a.attname = v_expected.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF NOT FOUND
       OR v_actual.atttypid <> pg_catalog.to_regtype(v_expected.type_name)::oid THEN
      RAISE EXCEPTION 'Profile repair preflight failed: public.profiles.% must exist with type %.',
        v_expected.column_name, v_expected.type_name;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('full_name_envelope', 'pg_catalog.jsonb'),
      ('student_number_envelope', 'pg_catalog.jsonb'),
      ('program_envelope', 'pg_catalog.jsonb'),
      ('student_number_index', 'pg_catalog.text')
    ) AS expected(column_name, type_name)
  LOOP
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
    WHERE a.attrelid = v_profiles
      AND a.attname = v_expected.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF FOUND AND (
      v_actual.atttypid <> pg_catalog.to_regtype(v_expected.type_name)::oid
      OR v_actual.attnotnull
      OR v_actual.atthasdef
      OR v_actual.attidentity <> ''
      OR v_actual.attgenerated <> ''
      OR NOT v_actual.attislocal
      OR v_actual.attinhcount <> 0
      OR v_actual.attcollation IS DISTINCT FROM (
        SELECT t.typcollation
        FROM pg_catalog.pg_type AS t
        WHERE t.oid = pg_catalog.to_regtype(v_expected.type_name)::oid
      )
    ) THEN
      RAISE EXCEPTION 'Profile repair preflight failed: public.profiles.% has an incompatible definition.',
        v_expected.column_name;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('profiles_full_name_envelope_phase1_check',
       'checkfull_name_envelopeisnullorsecuritres_private.is_valid_phase1_envelopefull_name_envelope'),
      ('profiles_student_number_envelope_phase1_check',
       'checkstudent_number_envelopeisnullorsecuritres_private.is_valid_phase1_envelopestudent_number_envelope'),
      ('profiles_program_envelope_phase1_check',
       'checkprogram_envelopeisnullorsecuritres_private.is_valid_phase1_envelopeprogram_envelope'),
      ('profiles_full_name_plaintext_or_envelope_check',
       'checkfull_nameisnotnullorfull_name_envelopeisnotnull'),
      ('profiles_student_number_index_format_check',
       'checkstudent_number_indexisnullorstudent_number_index~''^[0-9a-f]{64}$''')
    ) AS expected(constraint_name, definition_key)
  LOOP
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
      ) AS definition_key
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = v_profiles
      AND c.conname = v_expected.constraint_name;

    IF FOUND AND (
      v_constraint.contype <> 'c'
      OR NOT v_constraint.convalidated
      OR v_constraint.condeferrable
      OR v_constraint.condeferred
      OR v_constraint.connoinherit
      OR NOT v_constraint.conislocal
      OR v_constraint.coninhcount <> 0
      OR v_constraint.definition_key <> v_expected.definition_key
    ) THEN
      RAISE EXCEPTION 'Profile repair preflight failed: constraint public.profiles.% has an incompatible or unvalidated definition.',
        v_expected.constraint_name;
    END IF;
  END LOOP;

  v_function_oid := pg_catalog.to_regprocedure(
    'securitres_private.is_valid_phase1_envelope(jsonb)'
  )::oid;

  IF v_function_oid IS NOT NULL THEN
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
    INTO v_function
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
    WHERE p.oid = v_function_oid;

    IF NOT FOUND
       OR v_function.owner_name IS DISTINCT FROM 'postgres'
       OR v_function.lanname IS DISTINCT FROM 'plpgsql'
       OR v_function.prokind IS DISTINCT FROM 'f'
       OR v_function.pronargs IS DISTINCT FROM 1
       OR v_function.pronargdefaults IS DISTINCT FROM 0
       OR v_function.argument_type IS DISTINCT FROM 'pg_catalog.jsonb'::regtype::oid
       OR v_function.proargnames IS DISTINCT FROM ARRAY['p_envelope']::text[]
       OR v_function.prorettype IS DISTINCT FROM 'pg_catalog.boolean'::regtype::oid
       OR v_function.proretset
       OR v_function.prosecdef
       OR v_function.proisstrict
       OR v_function.provolatile IS DISTINCT FROM 'i'
       OR v_function.proparallel IS DISTINCT FROM 's'
       OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
       OR v_function.body_hash NOT IN (
         '2599da9154a36f9e6a3edb689932658e',
         '3563efb83822012e615723fba37ac491'
       ) THEN
      RAISE EXCEPTION 'Profile repair preflight failed: the existing envelope validator has an unexpected identity or implementation.';
    END IF;
  END IF;

  SELECT a.attnum, a.attcollation
  INTO v_student_index_attnum, v_student_index_collation
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = v_profiles
    AND a.attname = 'student_number_index'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF pg_catalog.to_regclass('public.profiles_student_number_index_key') IS NOT NULL THEN
    SELECT
      c.relkind,
      c.relnamespace,
      c.relowner,
      c.reltablespace,
      c.relpersistence,
      c.reloptions,
      i.indrelid,
      i.indisunique,
      i.indisprimary,
      i.indisexclusion,
      i.indisvalid,
      i.indisready,
      i.indislive,
      i.indnatts,
      i.indnkeyatts,
      i.indkey[0] AS key_attnum,
      i.indcollation[0] AS index_collation,
      i.indclass[0] AS opclass_oid,
      i.indoption[0] AS sort_options,
      i.indexprs IS NULL AS has_no_expressions,
      pg_catalog.lower(
        pg_catalog.regexp_replace(
          pg_catalog.pg_get_expr(i.indpred, i.indrelid, true),
          '[[:space:]()]',
          '',
          'g'
        )
      ) AS predicate_key,
      am.amname
    INTO v_profile_index
    FROM pg_catalog.pg_class AS c
    LEFT JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.oid
    LEFT JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
    WHERE c.oid = pg_catalog.to_regclass('public.profiles_student_number_index_key');

    SELECT opc.oid
    INTO v_expected_opclass
    FROM pg_catalog.pg_opclass AS opc
    JOIN pg_catalog.pg_am AS am ON am.oid = opc.opcmethod
    JOIN pg_catalog.pg_namespace AS n ON n.oid = opc.opcnamespace
    WHERE n.nspname = 'pg_catalog'
      AND opc.opcname = 'text_ops'
      AND opc.opcdefault
      AND am.amname = 'btree'
      AND opc.opcintype = 'pg_catalog.text'::regtype;

    IF v_profile_index.relkind IS DISTINCT FROM 'i'
       OR v_profile_index.relnamespace IS DISTINCT FROM 'public'::regnamespace
       OR v_profile_index.relowner IS DISTINCT FROM v_profile_owner
       OR v_profile_index.reltablespace IS DISTINCT FROM v_profile_tablespace
       OR v_profile_index.relpersistence IS DISTINCT FROM 'p'
       OR v_profile_index.reloptions IS NOT NULL
       OR v_profile_index.indrelid IS DISTINCT FROM v_profiles::oid
       OR v_profile_index.indisunique IS DISTINCT FROM true
       OR v_profile_index.indisprimary
       OR v_profile_index.indisexclusion
       OR v_profile_index.indisvalid IS DISTINCT FROM true
       OR v_profile_index.indisready IS DISTINCT FROM true
       OR v_profile_index.indislive IS DISTINCT FROM true
       OR v_profile_index.indnatts IS DISTINCT FROM 1
       OR v_profile_index.indnkeyatts IS DISTINCT FROM 1
       OR v_profile_index.key_attnum IS DISTINCT FROM v_student_index_attnum
       OR v_profile_index.index_collation IS DISTINCT FROM v_student_index_collation
       OR v_profile_index.opclass_oid IS DISTINCT FROM v_expected_opclass
       OR v_profile_index.sort_options IS DISTINCT FROM 0
       OR v_profile_index.has_no_expressions IS DISTINCT FROM true
       OR v_profile_index.predicate_key IS DISTINCT FROM 'student_number_indexisnotnull'
       OR v_profile_index.amname IS DISTINCT FROM 'btree' THEN
      RAISE EXCEPTION 'Profile repair preflight failed: profiles_student_number_index_key has an incompatible definition.';
    END IF;
  END IF;

  IF NOT pg_catalog.has_table_privilege('service_role', v_profiles, 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', v_profiles, 'UPDATE') THEN
    RAISE EXCEPTION 'Profile repair preflight failed: service_role must already have SELECT and UPDATE on public.profiles; this migration does not broaden its table privileges.';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION securitres_private.is_valid_phase1_envelope(p_envelope jsonb)
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
  v_base64 text;
  v_canonical text;
  v_decoded bytea;
  v_padding text;
  v_expected_bytes integer;
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

  FOREACH v_key IN ARRAY ARRAY[
    'ciphertext',
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
    IF v_value !~ '^[A-Za-z0-9_-]*$' THEN
      RETURN false;
    END IF;

    IF v_key = 'ciphertext' THEN
      IF pg_catalog.char_length(v_value) > 4194304 THEN
        RETURN false;
      END IF;
      v_expected_bytes := NULL;
    ELSE
      IF pg_catalog.char_length(v_value) <> (
        CASE v_key
          WHEN 'iv' THEN 16
          WHEN 'dekWrapIv' THEN 16
          WHEN 'tag' THEN 22
          WHEN 'dekWrapTag' THEN 22
          WHEN 'wrappedDek' THEN 43
        END
      ) THEN
        RETURN false;
      END IF;

      v_expected_bytes := CASE v_key
        WHEN 'iv' THEN 12
        WHEN 'dekWrapIv' THEN 12
        WHEN 'tag' THEN 16
        WHEN 'dekWrapTag' THEN 16
        WHEN 'wrappedDek' THEN 32
      END;
    END IF;

    IF pg_catalog.char_length(v_value) % 4 = 1 THEN
      RETURN false;
    END IF;

    v_padding := CASE pg_catalog.char_length(v_value) % 4
      WHEN 0 THEN ''
      WHEN 2 THEN '=='
      WHEN 3 THEN '='
    END;
    v_base64 := pg_catalog.translate(v_value, '-_', '+/') || v_padding;

    BEGIN
      v_decoded := pg_catalog.decode(v_base64, 'base64');
    EXCEPTION
      WHEN data_exception THEN
        RETURN false;
    END;

    v_canonical := pg_catalog.rtrim(
      pg_catalog.translate(
        pg_catalog.replace(pg_catalog.encode(v_decoded, 'base64'), E'\n', ''),
        '+/',
        '-_'
      ),
      '='
    );

    IF v_canonical <> v_value
       OR (
         v_expected_bytes IS NOT NULL
         AND pg_catalog.octet_length(v_decoded) <> v_expected_bytes
       )
       OR (
         v_key = 'ciphertext'
         AND pg_catalog.octet_length(v_decoded) > 3145728
       ) THEN
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
  ALTER COLUMN full_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS full_name_envelope jsonb,
  ADD COLUMN IF NOT EXISTS student_number_envelope jsonb,
  ADD COLUMN IF NOT EXISTS program_envelope jsonb,
  ADD COLUMN IF NOT EXISTS student_number_index text;

DO $ensure_profile_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_full_name_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_full_name_envelope_phase1_check
      CHECK (full_name_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(full_name_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_student_number_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_student_number_envelope_phase1_check
      CHECK (student_number_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(student_number_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_program_envelope_phase1_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_program_envelope_phase1_check
      CHECK (program_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(program_envelope));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_full_name_plaintext_or_envelope_check'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE full_name IS NULL
        AND full_name_envelope IS NULL
    ) THEN
      RAISE EXCEPTION 'Profile repair failed: a profile has neither plaintext nor envelope full_name.';
    END IF;

    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_full_name_plaintext_or_envelope_check
      CHECK (full_name IS NOT NULL OR full_name_envelope IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_student_number_index_format_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_student_number_index_format_check
      CHECK (student_number_index IS NULL OR student_number_index ~ '^[0-9a-f]{64}$');
  END IF;
END;
$ensure_profile_constraints$;

DO $ensure_profile_index$
BEGIN
  IF pg_catalog.to_regclass('public.profiles_student_number_index_key') IS NULL THEN
    CREATE UNIQUE INDEX profiles_student_number_index_key
      ON public.profiles (student_number_index)
      WHERE student_number_index IS NOT NULL;
  END IF;
END;
$ensure_profile_index$;

DO $validate_existing_envelopes$
DECLARE
  v_item record;
  v_relation regclass;
  v_column_type oid;
  v_invalid boolean;
BEGIN
  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('public', 'profiles', 'full_name_envelope'),
      ('public', 'profiles', 'student_number_envelope'),
      ('public', 'profiles', 'program_envelope'),
      ('public', 'excuse_letters', 'absence_start_envelope'),
      ('public', 'excuse_letters', 'absence_end_envelope'),
      ('public', 'excuse_letters', 'reason_envelope'),
      ('public', 'excuse_letters', 'dean_comment_envelope'),
      ('public', 'excuse_letters', 'decision_event_comment_envelope'),
      ('public', 'letter_status_events', 'comment_envelope'),
      ('public', 'excuse_letter_contacts', 'parent_guardian_phone_envelope'),
      ('public', 'excuse_evidence', 'original_filename_envelope')
    ) AS envelope_columns(schema_name, table_name, column_name)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('%I.%I', v_item.schema_name, v_item.table_name)
    );

    IF v_relation IS NOT NULL THEN
      SELECT a.atttypid
      INTO v_column_type
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = v_relation
        AND a.attname = v_item.column_name
        AND a.attnum > 0
        AND NOT a.attisdropped;

      IF FOUND THEN
        IF v_column_type <> 'pg_catalog.jsonb'::regtype::oid THEN
          RAISE EXCEPTION 'Profile repair failed: %.%.% is not jsonb.',
            v_item.schema_name, v_item.table_name, v_item.column_name;
        END IF;

        EXECUTE pg_catalog.format(
          'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I IS NOT NULL AND NOT securitres_private.is_valid_phase1_envelope(%I))',
          v_item.schema_name,
          v_item.table_name,
          v_item.column_name,
          v_item.column_name
        )
        INTO v_invalid;

        IF v_invalid THEN
          RAISE EXCEPTION 'Profile repair failed: existing values in %.%.% do not satisfy the stricter envelope validator.',
            v_item.schema_name, v_item.table_name, v_item.column_name;
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$validate_existing_envelopes$;

REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

DO $profile_column_acl_cleanup$
DECLARE
  v_column record;
BEGIN
  FOR v_column IN
    SELECT a.attname
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.profiles'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$I) ON TABLE public.profiles FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT (%1$I) ON TABLE public.profiles FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE (%1$I) ON TABLE public.profiles FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE REFERENCES (%1$I) ON TABLE public.profiles FROM PUBLIC, anon, authenticated',
      v_column.attname
    );
  END LOOP;
END;
$profile_column_acl_cleanup$;

GRANT SELECT (id, role, program_id, created_at) ON TABLE public.profiles TO authenticated;
REVOKE UPDATE (full_name, student_number, program) ON TABLE public.profiles FROM authenticated;

DO $profile_acl_postcondition$
DECLARE
  v_profiles regclass := 'public.profiles'::regclass;
  v_column record;
BEGIN
  IF NOT pg_catalog.has_table_privilege('service_role', v_profiles, 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', v_profiles, 'UPDATE') THEN
    RAISE EXCEPTION 'Profile repair ACL check failed: service_role profile access changed.';
  END IF;

  IF pg_catalog.has_table_privilege('authenticated', v_profiles, 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', v_profiles, 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', v_profiles, 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', v_profiles, 'TRUNCATE')
     OR pg_catalog.has_table_privilege('authenticated', v_profiles, 'REFERENCES')
     OR pg_catalog.has_table_privilege('authenticated', v_profiles, 'TRIGGER')
     OR pg_catalog.has_table_privilege('anon', v_profiles, 'INSERT')
     OR pg_catalog.has_table_privilege('anon', v_profiles, 'UPDATE')
     OR pg_catalog.has_table_privilege('anon', v_profiles, 'DELETE')
     OR pg_catalog.has_table_privilege('anon', v_profiles, 'TRUNCATE')
     OR pg_catalog.has_table_privilege('anon', v_profiles, 'REFERENCES')
     OR pg_catalog.has_table_privilege('anon', v_profiles, 'TRIGGER') THEN
    RAISE EXCEPTION 'Profile repair ACL check failed: anon or authenticated retains unintended table-level privileges.';
  END IF;

  FOR v_column IN
    SELECT a.attname, a.attnum
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = v_profiles
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege('anon', v_profiles, v_column.attnum, 'SELECT')
       OR pg_catalog.has_column_privilege('anon', v_profiles, v_column.attnum, 'INSERT')
       OR pg_catalog.has_column_privilege('anon', v_profiles, v_column.attnum, 'UPDATE')
       OR pg_catalog.has_column_privilege('anon', v_profiles, v_column.attnum, 'REFERENCES')
       OR pg_catalog.has_column_privilege('authenticated', v_profiles, v_column.attnum, 'INSERT')
       OR pg_catalog.has_column_privilege('authenticated', v_profiles, v_column.attnum, 'UPDATE')
       OR pg_catalog.has_column_privilege('authenticated', v_profiles, v_column.attnum, 'REFERENCES') THEN
      RAISE EXCEPTION 'Profile repair ACL check failed: anon or authenticated retains an unintended column privilege on public.profiles.%.',
        v_column.attname;
    END IF;

    IF v_column.attname NOT IN ('id', 'role', 'program_id', 'created_at')
       AND pg_catalog.has_column_privilege('authenticated', v_profiles, v_column.attnum, 'SELECT') THEN
      RAISE EXCEPTION 'Profile repair ACL check failed: authenticated retains SELECT on restricted public.profiles.%.',
        v_column.attname;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_column_privilege('authenticated', v_profiles, 'id', 'SELECT')
     OR NOT pg_catalog.has_column_privilege('authenticated', v_profiles, 'role', 'SELECT')
     OR NOT pg_catalog.has_column_privilege('authenticated', v_profiles, 'program_id', 'SELECT')
     OR NOT pg_catalog.has_column_privilege('authenticated', v_profiles, 'created_at', 'SELECT') THEN
    RAISE EXCEPTION 'Profile repair ACL check failed: authenticated is missing intended profile SELECT access.';
  END IF;
END;
$profile_acl_postcondition$;

NOTIFY pgrst, 'reload schema';

COMMIT;
