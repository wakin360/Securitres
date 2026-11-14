-- Read-only post-migration verification for Phase 9B. Run each SELECT separately.
-- Run immediately after migration, before controlled student mapping or Dean assignment provisioning.

-- Registry seed and profile mapping state.
SELECT id, canonical_name, is_active, created_at
FROM public.academic_programs
ORDER BY canonical_name;

SELECT role,
       count(*) AS profile_count,
       count(*) FILTER (WHERE program_id IS NOT NULL) AS mapped_profile_count
FROM public.profiles
GROUP BY role
ORDER BY role;

-- The Phase 9B migration intentionally inserts no Dean assignment.
SELECT count(*) AS dean_assignment_count
FROM public.dean_program_assignments;

-- Ensure profile policy count and definitions are unchanged.
SELECT
  count(*) AS total_profiles_policy_count,
  count(*) FILTER (WHERE policyname = 'profiles_select_self_or_dean') AS select_policy_count,
  count(*) FILTER (WHERE policyname = 'profiles_update_self') AS update_policy_count
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename = 'profiles';

SELECT
  count(*) AS profiles_policy_count,
  count(*) FILTER (
    WHERE policyname = 'profiles_select_self_or_dean'
      AND permissive = 'PERMISSIVE'
      AND roles = ARRAY['authenticated']::name[]
      AND cmd = 'SELECT'
      AND qual IS NOT DISTINCT FROM
        $policy$((id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text))$policy$
      AND with_check IS NULL
  ) AS expected_select_policy_count,
  count(*) FILTER (
    WHERE policyname = 'profiles_update_self'
      AND permissive = 'PERMISSIVE'
      AND roles = ARRAY['authenticated']::name[]
      AND cmd = 'UPDATE'
      AND qual IS NOT DISTINCT FROM
        $policy$(id = ( SELECT auth.uid() AS uid))$policy$
      AND with_check IS NOT DISTINCT FROM
        $policy$(id = ( SELECT auth.uid() AS uid))$policy$
  ) AS expected_update_policy_count
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename = 'profiles';

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('profiles', 'academic_programs', 'dean_program_assignments')
ORDER BY tablename, policyname;

-- RLS and browser-role access on new tables; program_id is not browser-updatable.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS row_level_security_enabled,
  pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') AS anon_can_select,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_can_select,
  pg_catalog.has_table_privilege('anon', c.oid, 'UPDATE') AS anon_can_update,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'UPDATE') AS authenticated_can_update
FROM pg_catalog.pg_class AS c
WHERE c.oid IN (
  'public.academic_programs'::regclass,
  'public.dean_program_assignments'::regclass
)
ORDER BY c.relname;

-- service_role must have no table-level SELECT, INSERT, UPDATE, or DELETE
-- privilege on either new table.
SELECT
  table_name,
  pg_catalog.has_table_privilege('service_role', table_name, 'SELECT') AS service_role_can_select,
  pg_catalog.has_table_privilege('service_role', table_name, 'INSERT') AS service_role_can_insert,
  pg_catalog.has_table_privilege('service_role', table_name, 'UPDATE') AS service_role_can_update,
  pg_catalog.has_table_privilege('service_role', table_name, 'DELETE') AS service_role_can_delete
FROM (
  VALUES
    ('public.academic_programs'::text),
    ('public.dean_program_assignments'::text)
) AS new_tables(table_name)
ORDER BY table_name;

SELECT
  role_name,
  pg_catalog.has_column_privilege(
    role_name, 'public.profiles', 'program_id', 'UPDATE'
  ) AS can_update_program_id
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
ORDER BY role_name;

-- Constraints, indexes, trigger definitions, and guard-function settings/owners.
SELECT
  conname,
  contype,
  convalidated,
  pg_catalog.pg_get_constraintdef(oid, true) AS definition
FROM pg_catalog.pg_constraint
WHERE conrelid = 'public.profiles'::regclass
  AND conname = 'profiles_program_id_student_only';

SELECT
  conrelid::regclass::text AS relation_name,
  conname,
  contype,
  pg_catalog.pg_get_constraintdef(oid, true) AS definition
FROM pg_catalog.pg_constraint
WHERE conrelid IN (
  'public.profiles'::regclass,
  'public.academic_programs'::regclass,
  'public.dean_program_assignments'::regclass
)
ORDER BY relation_name, conname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('profiles', 'academic_programs', 'dean_program_assignments')
ORDER BY tablename, indexname;

SELECT
  t.tgrelid::regclass::text AS relation_name,
  t.tgname,
  t.tgenabled,
  pg_catalog.pg_get_triggerdef(t.oid, true) AS trigger_definition,
  p.oid::regprocedure::text AS function_signature,
  pg_catalog.pg_get_userbyid(p.proowner) AS function_owner,
  p.prosecdef AS security_definer,
  p.proconfig AS function_settings
FROM pg_catalog.pg_trigger AS t
JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
WHERE t.tgrelid IN (
  'public.academic_programs'::regclass,
  'public.dean_program_assignments'::regclass
)
  AND NOT t.tgisinternal
ORDER BY relation_name, t.tgname;

SELECT
  p.oid::regprocedure::text AS function_signature,
  pg_catalog.pg_get_userbyid(p.proowner) AS function_owner,
  p.prosecdef AS security_definer,
  p.proconfig AS function_settings,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'guard_academic_program_mutation',
    'guard_dean_program_assignment'
  )
ORDER BY p.proname;
