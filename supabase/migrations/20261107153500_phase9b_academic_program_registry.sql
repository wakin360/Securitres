BEGIN;

DO $migration$
DECLARE
  v_count bigint;
  v_student_count bigint;
  v_professor_count bigint;
  v_dean_count bigint;
  v_student_role text;
  v_student_program text;
  v_auth_update_columns text[];
  v_direct_auth_update_columns text[];
  v_letter_differences bigint;
BEGIN
  IF pg_catalog.to_regclass('public.academic_programs') IS NOT NULL
     OR pg_catalog.to_regclass('public.dean_program_assignments') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: a target registry or assignment table already exists.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.profiles'::regclass
      AND a.attname = 'program_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: profiles.program_id already exists.';
  END IF;

  SELECT count(*)
  INTO v_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'profiles';

  IF v_count <> 2 OR (
    SELECT count(*)
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND (
        (
          policyname = 'profiles_select_self_or_dean'
          AND permissive = 'PERMISSIVE'
          AND roles = ARRAY['authenticated']::name[]
          AND cmd = 'SELECT'
          AND qual IS NOT DISTINCT FROM $policy$((id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text))$policy$
          AND with_check IS NULL
        )
        OR
        (
          policyname = 'profiles_update_self'
          AND permissive = 'PERMISSIVE'
          AND roles = ARRAY['authenticated']::name[]
          AND cmd = 'UPDATE'
          AND qual IS NOT DISTINCT FROM $policy$(id = ( SELECT auth.uid() AS uid))$policy$
          AND with_check IS NOT DISTINCT FROM $policy$(id = ( SELECT auth.uid() AS uid))$policy$
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: profiles must have exactly the two reviewed policies with unchanged definitions.';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE role = 'student'),
    count(*) FILTER (WHERE role = 'professor'),
    count(*) FILTER (WHERE role = 'dean')
  INTO v_count, v_student_count, v_professor_count, v_dean_count
  FROM public.profiles;

  IF v_count <> 3
     OR v_student_count <> 1
     OR v_professor_count <> 1
     OR v_dean_count <> 1 THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: expected exactly three profiles with one student, one professor, and one Dean.';
  END IF;

  SELECT role, program
  INTO v_student_role, v_student_program
  FROM public.profiles
  WHERE id = '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid;

  IF v_student_role IS DISTINCT FROM 'student'
     OR v_student_program IS DISTINCT FROM 'BS Information Technology' THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: the expected student profile or legacy program value does not match.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = 'ceae4f5d-9aa4-40e8-83d5-2c477baade61'::uuid
      AND role = 'dean'
      AND full_name = ''
      AND program IS NULL
  ) THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: the expected Dean profile state does not match.';
  END IF;

  SELECT count(*)
  INTO v_count
  FROM pg_catalog.pg_constraint AS con
  WHERE con.conrelid = 'public.profiles'::regclass;

  IF v_count <> 4
     OR (SELECT count(*) FROM pg_catalog.pg_index WHERE indrelid = 'public.profiles'::regclass) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.profiles'::regclass AND contype = 'p'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.profiles'::regclass AND contype = 'f'
         AND confrelid = 'auth.users'::regclass
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
         AND pg_catalog.pg_get_constraintdef(oid) ILIKE '%role%'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.profiles'::regclass AND contype = 'u'
         AND pg_catalog.pg_get_constraintdef(oid) ILIKE '%student_number%'
     ) THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: the reviewed profiles constraint or index inventory changed.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.profiles'::regclass
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: public.profiles has an unexpected user-defined trigger.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'securitres_private')
      AND (
        p.proname ILIKE '%program%'
        OR p.proname ILIKE '%dean%'
        OR p.proname ILIKE '%assignment%'
      )
  ) THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: related program, Dean, or assignment functions already exist.';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.profiles', 'UPDATE')
     OR NOT pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.profiles', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: effective profiles table privileges differ from the reviewed state.';
  END IF;

  SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname::text)
  INTO v_auth_update_columns
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = 'public.profiles'::regclass
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND pg_catalog.has_column_privilege(
      'authenticated', 'public.profiles', a.attname::text, 'UPDATE'
    );

  IF v_auth_update_columns IS DISTINCT FROM ARRAY['full_name', 'program', 'student_number']::text[] THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: effective authenticated profile column UPDATE privileges differ from the reviewed state.';
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT a.attname::text ORDER BY a.attname::text)
  INTO v_direct_auth_update_columns
  FROM pg_catalog.pg_attribute AS a
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
  WHERE a.attrelid = 'public.profiles'::regclass
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND acl.grantee = 'authenticated'::regrole
    AND acl.privilege_type = 'UPDATE';

  IF v_direct_auth_update_columns IS DISTINCT FROM ARRAY['full_name', 'program', 'student_number']::text[] THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: direct authenticated profile column UPDATE grants differ from the reviewed state.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS a
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
    WHERE a.attrelid = 'public.profiles'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND acl.grantee IN (0, 'anon'::regrole)
      AND acl.privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: profiles has an unexpected direct PUBLIC or anon column UPDATE grant.';
  END IF;

  WITH expected(letter_id, student_id, status) AS (
    VALUES
      ('0e9b3eb0-0372-45dd-8baa-603e75b62364'::uuid, '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid, 'approved'::text),
      ('3baad9cf-eb4e-400c-a99d-68b8af59b655'::uuid, '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid, 'pending'::text),
      ('4b46dbef-7636-4cab-bbc1-201b5e6b6336'::uuid, '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid, 'disapproved'::text),
      ('5e6caf5a-b61a-4efc-83f2-14aeeca1862d'::uuid, '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid, 'approved'::text)
  ),
  actual AS (
    SELECT id AS letter_id, student_id, status
    FROM public.excuse_letters
  ),
  differences AS (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  )
  SELECT count(*) INTO v_letter_differences FROM differences;

  IF v_letter_differences <> 0 THEN
    RAISE EXCEPTION 'Phase 9B preflight failed: the exact reviewed excuse-letter inventory changed.';
  END IF;
END
$migration$;

CREATE TABLE public.academic_programs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  canonical_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT academic_programs_canonical_name_normalized CHECK (
    canonical_name <> ''
    AND canonical_name = pg_catalog.regexp_replace(
      pg_catalog.btrim(canonical_name),
      '[[:space:]]+',
      ' ',
      'g'
    )
  )
);

CREATE UNIQUE INDEX academic_programs_canonical_name_ci_uidx
  ON public.academic_programs (
    pg_catalog.lower(
      pg_catalog.regexp_replace(
        pg_catalog.btrim(canonical_name),
        '[[:space:]]+',
        ' ',
        'g'
      )
    )
  );

CREATE FUNCTION public.guard_academic_program_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $program_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Academic program records cannot be deleted in Phase 9B.'
      USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Academic programs must be active in Phase 9B.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.canonical_name IS DISTINCT FROM OLD.canonical_name THEN
      RAISE EXCEPTION 'Academic program identity and canonical name are immutable in Phase 9B.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Academic program deactivation is prohibited in Phase 9B.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Unsupported academic program operation.'
    USING ERRCODE = '0A000';
END;
$program_guard$;

ALTER FUNCTION public.guard_academic_program_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_academic_program_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER academic_programs_phase9b_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.academic_programs
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_academic_program_mutation();

CREATE TABLE public.dean_program_assignments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  dean_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  program_id uuid NOT NULL REFERENCES public.academic_programs (id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  assigned_by uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.profiles (id) ON DELETE RESTRICT,
  CONSTRAINT dean_program_assignments_revocation_pair CHECK (
    (revoked_at IS NULL) = (revoked_by IS NULL)
  ),
  CONSTRAINT dean_program_assignments_revocation_order CHECK (
    revoked_at IS NULL OR revoked_at >= assigned_at
  )
);

CREATE UNIQUE INDEX dean_program_assignments_one_active_uidx
  ON public.dean_program_assignments (dean_id, program_id)
  WHERE revoked_at IS NULL;

CREATE INDEX dean_program_assignments_dean_history_idx
  ON public.dean_program_assignments (dean_id, assigned_at DESC);

CREATE INDEX dean_program_assignments_program_history_idx
  ON public.dean_program_assignments (program_id, assigned_at DESC);

CREATE FUNCTION public.guard_dean_program_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $assignment_guard$
DECLARE
  v_dean_role text;
  v_program_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Dean assignment history cannot be deleted.'
      USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'Assignments must be created active and revoked separately.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.assigned_at IS DISTINCT FROM pg_catalog.statement_timestamp() THEN
      RAISE EXCEPTION 'Assignment time must use the database statement timestamp.'
        USING ERRCODE = '23514';
    END IF;

    SELECT p.role INTO v_dean_role
    FROM public.profiles AS p
    WHERE p.id = NEW.dean_id;

    IF v_dean_role IS DISTINCT FROM 'dean' THEN
      RAISE EXCEPTION 'The assigned profile must have the Dean role.'
        USING ERRCODE = '23514';
    END IF;

    SELECT ap.is_active INTO v_program_active
    FROM public.academic_programs AS ap
    WHERE ap.id = NEW.program_id;

    IF v_program_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'The assigned academic program must exist and be active.'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A revoked assignment is immutable.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.dean_id IS DISTINCT FROM OLD.dean_id
       OR NEW.program_id IS DISTINCT FROM OLD.program_id
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by THEN
      RAISE EXCEPTION 'Assignment identity and attribution are immutable.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'The only permitted assignment update is a complete revocation.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.revoked_at IS DISTINCT FROM pg_catalog.statement_timestamp()
       OR NEW.revoked_at < OLD.assigned_at THEN
      RAISE EXCEPTION 'Revocation time must use the database statement timestamp and follow assignment time.'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Unsupported Dean assignment operation.'
    USING ERRCODE = '0A000';
END;
$assignment_guard$;

ALTER FUNCTION public.guard_dean_program_assignment() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_dean_program_assignment()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER dean_program_assignments_phase9b_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.dean_program_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_dean_program_assignment();

ALTER TABLE public.profiles
  ADD COLUMN program_id uuid;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_program_id_student_only
  CHECK (program_id IS NULL OR role = 'student');

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_program_id_fkey
  FOREIGN KEY (program_id)
  REFERENCES public.academic_programs (id)
  ON DELETE RESTRICT;

CREATE INDEX profiles_program_id_idx
  ON public.profiles (program_id)
  WHERE program_id IS NOT NULL;

REVOKE UPDATE (program_id) ON TABLE public.profiles
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.academic_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dean_program_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.academic_programs
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.dean_program_assignments
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.academic_programs (canonical_name)
VALUES ('BS Information Technology');

DO $migration$
DECLARE
  v_rows_updated bigint;
BEGIN
  UPDATE public.profiles AS p
  SET program_id = ap.id
  FROM public.academic_programs AS ap
  WHERE p.id = '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid
    AND p.role = 'student'
    AND p.program = 'BS Information Technology'
    AND p.program_id IS NULL
    AND ap.canonical_name = 'BS Information Technology';

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated <> 1 THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: expected exactly one student program backfill.';
  END IF;
END
$migration$;

COMMENT ON TABLE public.academic_programs IS
  'Canonical academic program registry. Names are immutable and all programs remain active during Phase 9B.';
COMMENT ON TABLE public.dean_program_assignments IS
  'Append-only Dean-to-program assignment history. No initial Dean assignment is inserted by this migration.';
COMMENT ON COLUMN public.dean_program_assignments.assigned_by IS
  'Asserted profile UUID attribution; this value does not independently prove the SQL executor identity or authority.';
COMMENT ON COLUMN public.dean_program_assignments.revoked_by IS
  'Asserted profile UUID attribution; this value does not independently prove the SQL executor identity or authority.';

DO $migration$
BEGIN
  IF (SELECT count(*) FROM public.academic_programs) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.academic_programs
       WHERE canonical_name = 'BS Information Technology'
         AND is_active IS TRUE
     ) THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: canonical program registry does not match expected state.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    JOIN public.academic_programs AS ap ON ap.id = p.program_id
    WHERE p.id = '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid
      AND p.program = 'BS Information Technology'
      AND ap.canonical_name = 'BS Information Technology'
  ) THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: student program_id backfill is absent or mismatched.';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.profiles'::regclass
        AND conname = 'profiles_program_id_student_only'
        AND contype = 'c'
        AND convalidated) <> 1 THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: profiles.program_id student-only constraint is missing or unvalidated.';
  END IF;

  IF (SELECT count(*) FROM public.dean_program_assignments) <> 0 THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: migration must not insert Dean assignments.';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'profiles') <> 2 THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: profiles policy count changed.';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('academic_programs', 'dean_program_assignments')) <> 0 THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: no policies may be added to Phase 9B tables.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'public.academic_programs'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
             WHERE oid = 'public.dean_program_assignments'::regclass) THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: RLS is not enabled on both new tables.';
  END IF;

  IF pg_catalog.has_column_privilege(
       'anon', 'public.profiles', 'program_id', 'UPDATE'
     )
     OR pg_catalog.has_column_privilege(
       'authenticated', 'public.profiles', 'program_id', 'UPDATE'
     ) THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: browser roles must not UPDATE profiles.program_id.';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'public.academic_programs', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.academic_programs', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.dean_program_assignments', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.dean_program_assignments', 'SELECT') THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: browser roles must not read the new tables.';
  END IF;

  IF pg_catalog.has_table_privilege('service_role', 'public.academic_programs', 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', 'public.academic_programs', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.academic_programs', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.academic_programs', 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.dean_program_assignments', 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', 'public.dean_program_assignments', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.dean_program_assignments', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.dean_program_assignments', 'DELETE') THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: service_role must not have SELECT, INSERT, UPDATE, or DELETE on the new tables.';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.academic_programs'::regclass
        AND tgname = 'academic_programs_phase9b_guard'
        AND NOT tgisinternal) <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.dean_program_assignments'::regclass
           AND tgname = 'dean_program_assignments_phase9b_guard'
           AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'Phase 9B postcondition failed: registry or assignment safeguards are missing.';
  END IF;
END
$migration$;

COMMIT;
