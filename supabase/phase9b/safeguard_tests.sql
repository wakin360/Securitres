-- ISOLATED TEST ONLY: run only on a disposable local/test database after
-- applying Phase 9B there. The outer transaction is always rolled back.
-- This creates temporary program/assignment rows inside the transaction.
-- Prerequisite: the profile UUID assigned to v_operator_id below must exist
-- so the test assignment's required assigned_by foreign key can be satisfied.

BEGIN;

DO $tests$
DECLARE
  v_program_id uuid;
  v_dean_id uuid := 'ceae4f5d-9aa4-40e8-83d5-2c477baade61';
  v_operator_id uuid := 'c9f0d1be-67b5-42f7-ae0e-23f294d8c45e';
  v_assignment_id uuid;
BEGIN
  SELECT id INTO v_program_id
  FROM public.academic_programs
  WHERE canonical_name = 'BS Information Technology'
    AND is_active IS TRUE;

  IF v_program_id IS NULL THEN
    RAISE EXCEPTION 'Test prerequisite missing: active BS Information Technology program.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = v_operator_id
  ) THEN
    RAISE EXCEPTION 'Test prerequisite missing: the v_operator_id profile must exist.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.dean_program_assignments) THEN
    RAISE EXCEPTION 'Run only in a disposable database with an empty assignment history.';
  END IF;

  BEGIN
    INSERT INTO public.dean_program_assignments (
      dean_id,
      program_id,
      assigned_at,
      assigned_by
    )
    VALUES (
      v_dean_id,
      v_program_id,
      pg_catalog.statement_timestamp() - interval '1 day',
      v_operator_id
    );
    RAISE EXCEPTION 'Expected backdated assignment timestamp to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.academic_programs
    SET canonical_name = 'BS Information Technology Renamed Test'
    WHERE id = v_program_id;
    RAISE EXCEPTION 'Expected canonical-name rename to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.academic_programs (canonical_name, is_active)
    VALUES ('Phase 9B Inactive Insert Test', false);
    RAISE EXCEPTION 'Expected insertion of an inactive program to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.academic_programs
    SET is_active = false
    WHERE id = v_program_id;
    RAISE EXCEPTION 'Expected program deactivation to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.academic_programs
    WHERE id = v_program_id;
    RAISE EXCEPTION 'Expected program deletion to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO public.dean_program_assignments (
    dean_id,
    program_id,
    assigned_by
  )
  VALUES (v_dean_id, v_program_id, v_operator_id)
  RETURNING id INTO v_assignment_id;

  BEGIN
    INSERT INTO public.dean_program_assignments (
      dean_id,
      program_id,
      assigned_by
    )
    VALUES (v_dean_id, v_program_id, v_operator_id);
    RAISE EXCEPTION 'Expected duplicate active Dean/program assignment to be rejected.';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.dean_program_assignments
    SET assigned_by = v_dean_id
    WHERE id = v_assignment_id;
    RAISE EXCEPTION 'Expected assignment attribution mutation to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.dean_program_assignments
    SET revoked_at = assigned_at,
        revoked_by = v_operator_id
    WHERE id = v_assignment_id;
    RAISE EXCEPTION 'Expected backdated revocation timestamp to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.dean_program_assignments
    WHERE id = v_assignment_id;
    RAISE EXCEPTION 'Expected assignment-history deletion to be rejected.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE public.dean_program_assignments
  SET revoked_at = pg_catalog.statement_timestamp(),
      revoked_by = v_operator_id
  WHERE id = v_assignment_id;

  BEGIN
    UPDATE public.dean_program_assignments
    SET revoked_at = NULL,
        revoked_by = NULL
    WHERE id = v_assignment_id;
    RAISE EXCEPTION 'Expected revoked assignment to remain immutable.';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$tests$;

ROLLBACK;
