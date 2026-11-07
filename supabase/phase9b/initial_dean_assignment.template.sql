-- OPERATOR TEMPLATE ONLY. Do not execute until Dean identity and authority have
-- been independently verified and the migration-history path is approved.
-- Replace both NULL UUID placeholders with verified profile IDs.
-- assigned_by is asserted UUID attribution; it does not prove who executed SQL
-- or that the person had authority.

DO $assignment$
DECLARE
  v_dean_id uuid := NULL; -- Replace with independently verified Dean profile UUID.
  v_assigned_by uuid := NULL; -- Replace with the authorized operator's profile UUID.
  v_program_id uuid;
  v_assignment_id uuid;
BEGIN
  IF v_dean_id IS NULL OR v_assigned_by IS NULL THEN
    RAISE EXCEPTION 'Set both independently verified UUID placeholders before use.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = v_dean_id
      AND p.role = 'dean'
  ) THEN
    RAISE EXCEPTION 'The supplied profile UUID is not a Dean.';
  END IF;

  SELECT ap.id INTO v_program_id
  FROM public.academic_programs AS ap
  WHERE ap.canonical_name = 'BS Information Technology'
    AND ap.is_active IS TRUE;

  IF v_program_id IS NULL THEN
    RAISE EXCEPTION 'The active BS Information Technology program was not found.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_assigned_by
  ) THEN
    RAISE EXCEPTION 'The assigned_by profile UUID does not exist.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.dean_program_assignments AS a
    WHERE a.dean_id = v_dean_id
      AND a.program_id = v_program_id
      AND a.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'An active assignment for this Dean and program already exists.';
  END IF;

  INSERT INTO public.dean_program_assignments (
    dean_id,
    program_id,
    assigned_by
  )
  VALUES (
    v_dean_id,
    v_program_id,
    v_assigned_by
  )
  RETURNING id INTO v_assignment_id;

  RAISE NOTICE 'Created Dean program assignment %; retain this ID in the authorized organizational audit record.',
    v_assignment_id;
END
$assignment$;
