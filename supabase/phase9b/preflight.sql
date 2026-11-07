-- Read-only preflight for the Phase 9B migration. Run each SELECT separately.
-- An absent standard migration ledger does not establish that no SQL was applied.

-- Standard Supabase migration ledger presence. Only run the version query below
-- if ledger_exists is true.
SELECT
  pg_catalog.to_regclass('supabase_migrations.schema_migrations') AS ledger_relation,
  pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS ledger_exists;

-- CONDITIONAL: run only when the ledger_exists result above is true.
SELECT version
FROM supabase_migrations.schema_migrations
ORDER BY version;

-- Target objects and profiles.program_id must not already exist.
SELECT
  pg_catalog.to_regclass('public.academic_programs') IS NOT NULL AS academic_programs_exists,
  pg_catalog.to_regclass('public.dean_program_assignments') IS NOT NULL AS dean_program_assignments_exists,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('public.profiles')
      AND attname = 'program_id'
      AND attnum > 0
      AND NOT attisdropped
  ) AS profiles_program_id_exists;

-- Exact reviewed profile count and role counts.
SELECT
  count(*) AS total_profiles,
  count(*) FILTER (WHERE role = 'student') AS students,
  count(*) FILTER (WHERE role = 'professor') AS professors,
  count(*) FILTER (WHERE role = 'dean') AS deans
FROM public.profiles;

-- Only the reviewed student and Dean fields needed for preflight.
SELECT
  p.id,
  p.role,
  p.program AS legacy_program,
  pg_catalog.to_jsonb(p)->>'program_id' AS program_id
FROM public.profiles AS p
WHERE p.id = '6acac2cb-ba54-41a3-90fe-89e469ba1c5d'::uuid;

SELECT
  id,
  role,
  CASE
    WHEN full_name IS NULL THEN 'NULL'
    WHEN full_name = '' THEN 'empty string'
    WHEN full_name ~ '^[[:space:]]+$' THEN 'whitespace only'
    ELSE 'other value'
  END AS full_name_state,
  full_name,
  program
FROM public.profiles
WHERE id = 'ceae4f5d-9aa4-40e8-83d5-2c477baade61'::uuid;

-- Exactly two profile policies, with their full definitions.
SELECT
  count(*) AS total_profiles_policy_count,
  count(*) FILTER (WHERE policyname = 'profiles_select_self_or_dean') AS select_policy_count,
  count(*) FILTER (WHERE policyname = 'profiles_update_self') AS update_policy_count
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename = 'profiles';

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND tablename = 'profiles'
ORDER BY policyname;

-- Effective profile table and column privileges. program_id is expected absent pre-migration.
WITH roles(role_name) AS (
  VALUES ('anon'), ('authenticated'), ('service_role')
),
columns(column_name) AS (
  VALUES ('full_name'), ('student_number'), ('program'), ('program_id')
)
SELECT
  r.role_name,
  pg_catalog.has_table_privilege(r.role_name, 'public.profiles', 'SELECT') AS can_select_table,
  pg_catalog.has_table_privilege(r.role_name, 'public.profiles', 'UPDATE') AS can_update_table,
  c.column_name,
  a.attname IS NOT NULL AS column_exists,
  CASE WHEN a.attname IS NOT NULL THEN
    pg_catalog.has_column_privilege(r.role_name, 'public.profiles', c.column_name, 'UPDATE')
  END AS can_update_column
FROM roles AS r
CROSS JOIN columns AS c
LEFT JOIN pg_catalog.pg_attribute AS a
  ON a.attrelid = pg_catalog.to_regclass('public.profiles')
 AND a.attname = c.column_name
 AND a.attnum > 0
 AND NOT a.attisdropped
ORDER BY r.role_name, c.column_name;

-- Existing profile constraints/indexes and user-defined triggers.
SELECT
  conname,
  contype,
  pg_catalog.pg_get_constraintdef(oid, true) AS definition
FROM pg_catalog.pg_constraint
WHERE conrelid = pg_catalog.to_regclass('public.profiles')
ORDER BY conname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'profiles'
ORDER BY indexname;

SELECT
  t.tgname,
  t.tgenabled,
  pg_catalog.pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_catalog.pg_trigger AS t
WHERE t.tgrelid = pg_catalog.to_regclass('public.profiles')
  AND NOT t.tgisinternal
ORDER BY t.tgname;

-- Related functions, if any.
SELECT
  n.nspname AS schema_name,
  p.oid::regprocedure::text AS signature,
  pg_catalog.pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  p.proconfig AS function_settings,
  pg_catalog.pg_get_functiondef(p.oid) AS definition
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'securitres_private')
  AND (
    p.proname ILIKE '%program%'
    OR p.proname ILIKE '%dean%'
    OR p.proname ILIKE '%assignment%'
  )
ORDER BY n.nspname, p.proname, p.oid::regprocedure::text;

-- Exact letter inventory guard inputs; this query does not reveal letter text.
SELECT id, student_id, status
FROM public.excuse_letters
ORDER BY id;
