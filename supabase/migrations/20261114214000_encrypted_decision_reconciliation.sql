BEGIN;

DO $preflight$
DECLARE
  v_item record;
  v_relation oid;
  v_actual_type oid;
  v_expected_type oid;
  v_not_null boolean;
  v_has_default boolean;
  v_identity "char";
  v_generated "char";
  v_role_name text;
  v_validator_oid oid;
  v_status_function_oid oid;
  v_status_column smallint;
  v_trigger_count integer;
  v_constraint_oid oid;
  v_constraint_type "char";
  v_constraint_validated boolean;
  v_constraint_definition text;
BEGIN
  IF pg_catalog.to_regnamespace('public') IS NULL
     OR pg_catalog.to_regnamespace('auth') IS NULL
     OR pg_catalog.to_regnamespace('securitres_private') IS NULL THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: a required schema is missing.';
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ] LOOP
    IF pg_catalog.to_regrole(v_role_name) IS NULL THEN
      RAISE EXCEPTION 'Encrypted decision reconciliation failed: required role % is missing.',
        v_role_name;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('profiles', 'id', 'uuid'),
      ('profiles', 'role', 'text'),
      ('profiles', 'program_id', 'uuid'),
      ('excuse_letters', 'id', 'uuid'),
      ('excuse_letters', 'student_id', 'uuid'),
      ('excuse_letters', 'status', 'text'),
      ('excuse_letters', 'dean_comment', 'text'),
      ('excuse_letters', 'dean_comment_envelope', 'jsonb'),
      ('excuse_letters', 'decided_at', 'timestamp with time zone'),
      ('excuse_letters', 'decided_by', 'uuid'),
      ('dean_program_assignments', 'id', 'uuid'),
      ('dean_program_assignments', 'dean_id', 'uuid'),
      ('dean_program_assignments', 'program_id', 'uuid'),
      ('dean_program_assignments', 'revoked_at', 'timestamp with time zone'),
      ('academic_programs', 'id', 'uuid'),
      ('academic_programs', 'is_active', 'boolean'),
      ('letter_status_events', 'id', 'uuid'),
      ('letter_status_events', 'letter_id', 'uuid'),
      ('letter_status_events', 'actor_id', 'uuid'),
      ('letter_status_events', 'old_status', 'text'),
      ('letter_status_events', 'new_status', 'text'),
      ('letter_status_events', 'comment', 'text'),
      ('letter_status_events', 'comment_envelope', 'jsonb')
    ) AS required_columns(table_name, column_name, type_name)
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_item.table_name)
    );
    IF v_relation IS NULL THEN
      RAISE EXCEPTION 'Encrypted decision reconciliation failed: public.% is missing.',
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
      RAISE EXCEPTION 'Encrypted decision reconciliation failed: public.%.% is missing.',
        v_item.table_name, v_item.column_name;
    END IF;

    v_expected_type := pg_catalog.to_regtype(v_item.type_name)::oid;
    IF v_actual_type IS DISTINCT FROM v_expected_type THEN
      RAISE EXCEPTION 'Encrypted decision reconciliation failed: public.%.% has an unexpected type.',
        v_item.table_name, v_item.column_name;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT *
    FROM (VALUES
      ('decision_event_id', 'uuid'),
      ('decision_event_comment_envelope', 'jsonb')
    ) AS target_columns(column_name, type_name)
  LOOP
    SELECT a.atttypid, a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated
    INTO v_actual_type, v_not_null, v_has_default, v_identity, v_generated
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.excuse_letters'::regclass
      AND a.attname = v_item.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF FOUND THEN
      v_expected_type := pg_catalog.to_regtype(v_item.type_name)::oid;
      IF v_actual_type IS DISTINCT FROM v_expected_type
         OR v_not_null
         OR v_has_default
         OR v_identity <> ''
         OR v_generated <> '' THEN
        RAISE EXCEPTION 'Encrypted decision reconciliation failed: public.excuse_letters.% is incompatible.',
          v_item.column_name;
      END IF;
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
         AND p.proconfig @> ARRAY['search_path=""']::text[]
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
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: the Phase 2A envelope validator is missing or incompatible.';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL
     OR pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: a required helper function is missing.';
  END IF;

  v_status_function_oid := pg_catalog.to_regprocedure(
    'public.record_letter_status_change()'
  );
  IF v_status_function_oid IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_language AS l
         ON l.oid = p.prolang
       WHERE p.oid = v_status_function_oid
         AND p.prorettype = 'trigger'::regtype
         AND l.lanname = 'plpgsql'
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=""']::text[]
         AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
         AND pg_catalog.md5(
           pg_catalog.regexp_replace(p.prosrc, '[[:space:]]+', '', 'g')
         ) = '45f666c27d5d3426c4a6487a1e5f8329'
     ) THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: record_letter_status_change() is not the reviewed pre-reconciliation definition.';
  END IF;

  SELECT a.attnum
  INTO v_status_column
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.excuse_letters'::regclass
    AND a.attname = 'status'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  SELECT count(*)
  INTO v_trigger_count
  FROM pg_catalog.pg_trigger AS t
  WHERE t.tgrelid = 'public.excuse_letters'::regclass
    AND t.tgname = 'on_excuse_letter_status_changed'
    AND t.tgfoid = v_status_function_oid
    AND t.tgtype = 17
    AND pg_catalog.array_to_string(t.tgattr, ',') = v_status_column::text
    AND t.tgqual IS NULL
    AND t.tgnargs = 0
    AND t.tgargs = ''::bytea
    AND t.tgenabled = 'O'
    AND NOT t.tgisinternal;

  IF v_trigger_count <> 1 THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: the status-change trigger differs from the reviewed trigger.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'decide_excuse_letter_encrypted'
  ) THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: a function named decide_excuse_letter_encrypted already exists; review it before proceeding.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conname = 'excuse_letters_decision_event_comment_envelope_phase1_check'
      AND c.conrelid <> 'public.excuse_letters'::regclass
  ) THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: the expected envelope constraint name is used by another table.';
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
  WHERE c.conrelid = 'public.excuse_letters'::regclass
    AND c.conname = 'excuse_letters_decision_event_comment_envelope_phase1_check';

  IF v_constraint_oid IS NOT NULL
     AND (
       v_constraint_type <> 'c'
       OR NOT v_constraint_validated
       OR v_constraint_definition <>
         'checkdecision_event_comment_envelopeisnullorsecuritres_private.is_valid_phase1_envelope(decision_event_comment_envelope)'
     ) THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: the existing decision-envelope constraint is incompatible.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letters'::regclass
      AND c.conname <> 'excuse_letters_decision_event_comment_envelope_phase1_check'
      AND c.contype = 'c'
      AND NOT c.convalidated
      AND pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
        '[[:space:]()]',
        '',
        'g'
      ) =
        'checkdecision_event_comment_envelopeisnullorsecuritres_private.is_valid_phase1_envelope(decision_event_comment_envelope)'
  ) THEN
    RAISE EXCEPTION 'Encrypted decision reconciliation failed: an equivalent decision-envelope constraint is unvalidated.';
  END IF;
END;
$preflight$;

DO $add_missing_columns$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.excuse_letters'::regclass
      AND a.attname = 'decision_event_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD COLUMN decision_event_id uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.excuse_letters'::regclass
      AND a.attname = 'decision_event_comment_envelope'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD COLUMN decision_event_comment_envelope jsonb;
  END IF;
END;
$add_missing_columns$;

DO $ensure_decision_envelope_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letters'::regclass
      AND c.conname = 'excuse_letters_decision_event_comment_envelope_phase1_check'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.excuse_letters'::regclass
      AND c.contype = 'c'
      AND c.convalidated
      AND pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid, true)),
        '[[:space:]()]',
        '',
        'g'
      ) =
        'checkdecision_event_comment_envelopeisnullorsecuritres_private.is_valid_phase1_envelope(decision_event_comment_envelope)'
  ) THEN
    ALTER TABLE public.excuse_letters
      ADD CONSTRAINT excuse_letters_decision_event_comment_envelope_phase1_check
      CHECK (
        decision_event_comment_envelope IS NULL
        OR securitres_private.is_valid_phase1_envelope(
          decision_event_comment_envelope
        )
      );
  END IF;
END;
$ensure_decision_envelope_constraint$;

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

ALTER FUNCTION public.record_letter_status_change()
  OWNER TO postgres;

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

ALTER FUNCTION public.decide_excuse_letter_encrypted(
  uuid, uuid, text, uuid, jsonb, jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.decide_excuse_letter_encrypted(
  uuid, uuid, text, uuid, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.decide_excuse_letter_encrypted(
  uuid, uuid, text, uuid, jsonb, jsonb
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
