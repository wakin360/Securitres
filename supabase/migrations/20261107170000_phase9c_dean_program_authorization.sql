BEGIN;

DO $preflight$
DECLARE
  v_expected record;
  v_matches integer;
BEGIN
  IF pg_catalog.to_regnamespace('public') IS NULL
     OR pg_catalog.to_regnamespace('auth') IS NULL
     OR pg_catalog.to_regnamespace('storage') IS NULL
     OR pg_catalog.to_regnamespace('securitres_private') IS NULL THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a required schema is missing.';
  END IF;

  IF pg_catalog.to_regclass('public.profiles') IS NULL
     OR pg_catalog.to_regclass('public.academic_programs') IS NULL
     OR pg_catalog.to_regclass('public.dean_program_assignments') IS NULL
     OR pg_catalog.to_regclass('public.excuse_letters') IS NULL
     OR pg_catalog.to_regclass('public.letter_status_events') IS NULL
     OR pg_catalog.to_regclass('public.excuse_evidence') IS NULL
     OR pg_catalog.to_regclass('public.course_enrollments') IS NULL
     OR pg_catalog.to_regclass('public.course_offerings') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: an expected relation is missing.';
  END IF;

  IF (
    SELECT count(*)
    FROM (VALUES
      ('public.profiles', 'id'),
      ('public.profiles', 'role'),
      ('public.profiles', 'program_id'),
      ('public.academic_programs', 'id'),
      ('public.academic_programs', 'is_active'),
      ('public.dean_program_assignments', 'id'),
      ('public.dean_program_assignments', 'dean_id'),
      ('public.dean_program_assignments', 'program_id'),
      ('public.dean_program_assignments', 'revoked_at'),
      ('public.excuse_letters', 'id'),
      ('public.excuse_letters', 'student_id'),
      ('public.excuse_letters', 'course_id'),
      ('public.excuse_letters', 'absence_start'),
      ('public.excuse_letters', 'absence_end'),
      ('public.excuse_letters', 'reason'),
      ('public.excuse_letters', 'status'),
      ('public.excuse_letters', 'dean_comment'),
      ('public.excuse_letters', 'submitted_at'),
      ('public.excuse_letters', 'decided_at'),
      ('public.excuse_letters', 'decided_by'),
      ('public.excuse_letters', 'created_at'),
      ('public.letter_status_events', 'letter_id'),
      ('public.excuse_evidence', 'letter_id'),
      ('public.excuse_evidence', 'storage_path'),
      ('public.excuse_evidence', 'mime_type'),
      ('public.course_enrollments', 'student_id'),
      ('public.course_enrollments', 'course_id'),
      ('public.course_offerings', 'id'),
      ('public.course_offerings', 'professor_id'),
      ('storage.objects', 'bucket_id'),
      ('storage.objects', 'name'),
      ('storage.objects', 'metadata')
    ) AS expected(relation_name, column_name)
    JOIN pg_catalog.pg_attribute AS a
      ON a.attrelid = pg_catalog.to_regclass(expected.relation_name)
     AND a.attname = expected.column_name
     AND a.attnum > 0
     AND NOT a.attisdropped
  ) <> 32 THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a required column is missing.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.profiles', 'profiles_id_fkey', 'id', 'auth', 'users', 'id', 'c'),
      ('public.profiles', 'profiles_program_id_fkey', 'program_id',
        'public', 'academic_programs', 'id', 'r'),
      ('public.dean_program_assignments', 'dean_program_assignments_dean_id_fkey',
        'dean_id', 'public', 'profiles', 'id', 'r'),
      ('public.dean_program_assignments', 'dean_program_assignments_program_id_fkey',
        'program_id', 'public', 'academic_programs', 'id', 'r'),
      ('public.dean_program_assignments', 'dean_program_assignments_assigned_by_fkey',
        'assigned_by', 'public', 'profiles', 'id', 'r'),
      ('public.dean_program_assignments', 'dean_program_assignments_revoked_by_fkey',
        'revoked_by', 'public', 'profiles', 'id', 'r'),
      ('public.excuse_letters', 'excuse_letters_student_id_fkey',
        'student_id', 'public', 'profiles', 'id', 'a'),
      ('public.excuse_letters', 'excuse_letters_course_id_fkey',
        'course_id', 'public', 'course_offerings', 'id', 'a'),
      ('public.excuse_letters', 'excuse_letters_decided_by_fkey',
        'decided_by', 'public', 'profiles', 'id', 'a'),
      ('public.letter_status_events', 'letter_status_events_letter_id_fkey',
        'letter_id', 'public', 'excuse_letters', 'id', 'c'),
      ('public.letter_status_events', 'letter_status_events_actor_id_fkey',
        'actor_id', 'public', 'profiles', 'id', 'a'),
      ('public.excuse_evidence', 'excuse_evidence_letter_id_fkey',
        'letter_id', 'public', 'excuse_letters', 'id', 'c'),
      ('public.course_enrollments', 'course_enrollments_course_id_fkey',
        'course_id', 'public', 'course_offerings', 'id', 'c'),
      ('public.course_enrollments', 'course_enrollments_student_id_fkey',
        'student_id', 'public', 'profiles', 'id', 'c'),
      ('public.course_offerings', 'course_offerings_professor_id_fkey',
        'professor_id', 'public', 'profiles', 'id', 'a')
    ) AS expected(
      relation_name, constraint_name, local_column,
      referenced_schema, referenced_table, referenced_column, delete_action
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS c
      JOIN pg_catalog.pg_class AS local_table ON local_table.oid = c.conrelid
      JOIN pg_catalog.pg_namespace AS local_ns ON local_ns.oid = local_table.relnamespace
      JOIN pg_catalog.pg_class AS referenced_table ON referenced_table.oid = c.confrelid
      JOIN pg_catalog.pg_namespace AS referenced_ns ON referenced_ns.oid = referenced_table.relnamespace
      JOIN pg_catalog.pg_attribute AS local_col
        ON local_col.attrelid = c.conrelid AND local_col.attnum = c.conkey[1]
      JOIN pg_catalog.pg_attribute AS referenced_col
        ON referenced_col.attrelid = c.confrelid AND referenced_col.attnum = c.confkey[1]
      WHERE c.contype = 'f'
        AND c.conname = expected.constraint_name
        AND local_ns.nspname || '.' || local_table.relname = expected.relation_name
        AND local_col.attname = expected.local_column
        AND referenced_ns.nspname = expected.referenced_schema
        AND referenced_table.relname = expected.referenced_table
        AND referenced_col.attname = expected.referenced_column
        AND cardinality(c.conkey) = 1
        AND cardinality(c.confkey) = 1
        AND c.convalidated
        AND c.confdeltype = expected.delete_action
    )
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a reviewed foreign-key mapping or delete action differs.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_class AS idx ON idx.oid = i.indexrelid
    WHERE i.indrelid = 'public.dean_program_assignments'::regclass
      AND idx.relname = 'dean_program_assignments_one_active_uidx'
      AND i.indisvalid
      AND i.indisunique
      AND pg_catalog.pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX dean_program_assignments_one_active_uidx ON public.dean_program_assignments USING btree (dean_id, program_id) WHERE (revoked_at IS NULL)'
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: the reviewed active-assignment index is missing or differs.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.profiles'),
      ('public.academic_programs'),
      ('public.dean_program_assignments'),
      ('public.excuse_letters'),
      ('public.letter_status_events'),
      ('public.excuse_evidence'),
      ('public.course_enrollments'),
      ('storage.objects')
    ) AS expected(relation_name)
    LEFT JOIN pg_catalog.pg_class AS c
      ON c.oid = pg_catalog.to_regclass(expected.relation_name)
    WHERE c.oid IS NULL OR NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: RLS is disabled on an affected table.';
  END IF;

  IF pg_catalog.has_column_privilege(
       'authenticated', 'public.profiles', 'role', 'UPDATE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS a
       CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
       WHERE a.attrelid = 'public.profiles'::regclass
         AND a.attname = 'role'
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND acl.grantee = 'authenticated'::regrole
         AND acl.privilege_type = 'UPDATE'
     ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: authenticated can update profiles.role.';
  END IF;

  IF pg_catalog.has_column_privilege(
       'anon', 'public.profiles', 'program_id', 'UPDATE'
     )
     OR pg_catalog.has_column_privilege(
       'authenticated', 'public.profiles', 'program_id', 'UPDATE'
     ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a browser role can update profiles.program_id.';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       'authenticated', 'securitres_private', 'USAGE'
     )
     OR pg_catalog.has_schema_privilege(
       'anon', 'securitres_private', 'USAGE'
     ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: securitres_private schema privileges differ.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
    WHERE c.oid IN (
        'public.academic_programs'::regclass,
        'public.dean_program_assignments'::regclass
      )
      AND acl.grantee IN (
        0,
        'anon'::regrole,
        'authenticated'::regrole,
        'service_role'::regrole
      )
  )
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('anon', 'public.academic_programs'),
         ('authenticated', 'public.academic_programs'),
         ('service_role', 'public.academic_programs'),
         ('anon', 'public.dean_program_assignments'),
         ('authenticated', 'public.dean_program_assignments'),
         ('service_role', 'public.dean_program_assignments')
       ) AS role_table(role_name, relation_name)
       CROSS JOIN (VALUES
         ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
       ) AS privilege(privilege_name)
       WHERE pg_catalog.has_table_privilege(
         role_table.role_name,
         role_table.relation_name,
         privilege.privilege_name
       )
     ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: browser/service roles have unexpected privileges on Phase 9B registry tables.';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND tablename = 'profiles') <> 2
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'excuse_letters') <> 2
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'excuse_evidence') <> 2
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'letter_status_events') <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'course_enrollments') <> 1
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'storage' AND tablename = 'objects') <> 3
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'academic_programs') <> 0
     OR (SELECT count(*) FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'dean_program_assignments') <> 0 THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: the complete reviewed policy inventory differs.';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('public', 'profiles', 'profiles_select_self_or_dean',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'SELECT',
       $p$((id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text))$p$,
       NULL::text),
      ('public', 'profiles', 'profiles_update_self',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'UPDATE',
       $p$(id = ( SELECT auth.uid() AS uid))$p$,
       $p$(id = ( SELECT auth.uid() AS uid))$p$),
      ('public', 'excuse_letters', 'letters_select_student_dean_or_assigned_professor',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'SELECT',
       $p$((student_id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text) OR ((status = 'approved'::text) AND (EXISTS ( SELECT 1
   FROM course_offerings c
  WHERE ((c.id = excuse_letters.course_id) AND (c.professor_id = ( SELECT auth.uid() AS uid)))))))$p$,
       NULL::text),
      ('public', 'excuse_letters', 'students_insert_pending_letters_for_enrolled_courses',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'INSERT',
       NULL::text,
       $p$((( SELECT current_profile_role() AS current_profile_role) = 'student'::text) AND (student_id = ( SELECT auth.uid() AS uid)) AND (status = 'pending'::text) AND (decided_at IS NULL) AND (decided_by IS NULL) AND (EXISTS ( SELECT 1
   FROM course_enrollments e
  WHERE ((e.course_id = excuse_letters.course_id) AND (e.student_id = ( SELECT auth.uid() AS uid))))))$p$),
      ('public', 'excuse_evidence', 'evidence_select_when_letter_is_visible',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'SELECT',
       $p$(EXISTS ( SELECT 1
   FROM excuse_letters l
  WHERE ((l.id = excuse_evidence.letter_id) AND ((l.student_id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text) OR ((l.status = 'approved'::text) AND (EXISTS ( SELECT 1
           FROM course_offerings c
          WHERE ((c.id = l.course_id) AND (c.professor_id = ( SELECT auth.uid() AS uid))))))))))$p$,
       NULL::text),
      ('public', 'excuse_evidence', 'students_attach_evidence_to_own_pending_letters',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'INSERT',
       NULL::text,
       $p$((( SELECT current_profile_role() AS current_profile_role) = 'student'::text) AND (EXISTS ( SELECT 1
   FROM excuse_letters l
  WHERE ((l.id = excuse_evidence.letter_id) AND (l.student_id = ( SELECT auth.uid() AS uid)) AND (l.status = 'pending'::text) AND ((storage.foldername(excuse_evidence.storage_path))[1] = (( SELECT auth.uid() AS uid))::text) AND ((storage.foldername(excuse_evidence.storage_path))[2] = (l.id)::text) AND (array_length(storage.foldername(excuse_evidence.storage_path), 1) = 2) AND
        CASE excuse_evidence.mime_type
            WHEN 'application/pdf'::text THEN (storage.filename(excuse_evidence.storage_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'::text)
            WHEN 'image/jpeg'::text THEN (storage.filename(excuse_evidence.storage_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'::text)
            WHEN 'image/png'::text THEN (storage.filename(excuse_evidence.storage_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'::text)
            ELSE false
        END))))$p$),
      ('public', 'letter_status_events', 'letter_events_select_when_letter_is_visible',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'SELECT',
       $p$(EXISTS ( SELECT 1
   FROM excuse_letters l
  WHERE ((l.id = letter_status_events.letter_id) AND ((l.student_id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text) OR ((l.status = 'approved'::text) AND (EXISTS ( SELECT 1
           FROM course_offerings c
          WHERE ((c.id = l.course_id) AND (c.professor_id = ( SELECT auth.uid() AS uid))))))))))$p$,
       NULL::text),
      ('public', 'course_enrollments', 'course_enrollments_select_own_or_course_professor_or_dean',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'SELECT',
       $p$((student_id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text) OR (EXISTS ( SELECT 1
   FROM course_offerings c
  WHERE ((c.id = course_enrollments.course_id) AND (c.professor_id = ( SELECT auth.uid() AS uid))))))$p$,
       NULL::text),
      ('storage', 'objects', 'students_remove_own_orphaned_letter_uploads',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'DELETE',
       $p$((bucket_id = 'excuse-evidence'::text) AND ( SELECT securitres_private.can_delete_orphaned_evidence(objects.name) AS can_delete_orphaned_evidence))$p$,
       NULL::text),
      ('storage', 'objects', 'students_upload_to_own_pending_letter_folder',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'INSERT',
       NULL::text,
       $p$((bucket_id = 'excuse-evidence'::text) AND (( SELECT current_profile_role() AS current_profile_role) = 'student'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) AND (array_length(storage.foldername(name), 1) = 2) AND (EXISTS ( SELECT 1
   FROM excuse_letters l
  WHERE (((l.id)::text = (storage.foldername(objects.name))[2]) AND (l.student_id = ( SELECT auth.uid() AS uid)) AND (l.status = 'pending'::text) AND
        CASE (objects.metadata ->> 'mimetype'::text)
              WHEN 'application/pdf'::text THEN (storage.filename(objects.name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$'::text)
              WHEN 'image/jpeg'::text THEN (storage.filename(objects.name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'::text)
              WHEN 'image/png'::text THEN (storage.filename(objects.name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$'::text)
            ELSE false
        END))))$p$),
      ('storage', 'objects', 'users_download_evidence_for_visible_letters',
       'PERMISSIVE', ARRAY['authenticated']::name[], 'SELECT',
       $p$((bucket_id = 'excuse-evidence'::text) AND (EXISTS ( SELECT 1
   FROM (excuse_evidence e
     JOIN excuse_letters l ON ((l.id = e.letter_id)))
  WHERE ((e.storage_path = objects.name) AND ((l.student_id = ( SELECT auth.uid() AS uid)) OR (( SELECT current_profile_role() AS current_profile_role) = 'dean'::text) OR ((l.status = 'approved'::text) AND (EXISTS ( SELECT 1
           FROM course_offerings c
          WHERE ((c.id = l.course_id) AND (c.professor_id = ( SELECT auth.uid() AS uid)))))))))))$p$,
       NULL::text)
    ) AS expected(
      schema_name, table_name, policy_name,
      permissive, roles, command, qual, with_check
    )
  LOOP
    SELECT count(*)
    INTO v_matches
    FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = v_expected.schema_name
      AND p.tablename = v_expected.table_name
      AND p.policyname = v_expected.policy_name
      AND p.permissive = v_expected.permissive
      AND p.roles = v_expected.roles
      AND p.cmd = v_expected.command
      AND (
        (p.qual IS NULL AND v_expected.qual IS NULL)
        OR (
          p.qual IS NOT NULL
          AND v_expected.qual IS NOT NULL
          AND regexp_replace(p.qual, '[[:space:]]+', '', 'g')
              = regexp_replace(v_expected.qual, '[[:space:]]+', '', 'g')
        )
      )
      AND (
        (p.with_check IS NULL AND v_expected.with_check IS NULL)
        OR (
          p.with_check IS NOT NULL
          AND v_expected.with_check IS NOT NULL
          AND regexp_replace(p.with_check, '[[:space:]]+', '', 'g')
              = regexp_replace(v_expected.with_check, '[[:space:]]+', '', 'g')
        )
      );

    IF v_matches <> 1 THEN
      RAISE EXCEPTION 'Phase 9C preflight failed: policy %.% differs from the reviewed definition.',
        v_expected.table_name, v_expected.policy_name;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_schema_privilege(
    'authenticated', 'securitres_private', 'USAGE'
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: authenticated lacks private-schema USAGE.';
  END IF;

  IF pg_catalog.to_regprocedure('public.current_profile_role()') IS NULL
     OR pg_catalog.to_regprocedure('public.record_letter_status_change()') IS NULL
     OR pg_catalog.to_regprocedure('public.decide_excuse_letter(uuid,text,text)') IS NULL
     OR pg_catalog.to_regprocedure('securitres_private.can_delete_orphaned_evidence(text)') IS NULL THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a reviewed function is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.current_profile_role()'::regprocedure
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND pg_catalog.md5(pg_catalog.regexp_replace(
        p.prosrc, '[[:space:]]+', '', 'g'
      )) = 'c588f8966b79ec72381f751c8ce53de9'
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: current_profile_role definition, settings, owner, or privileges differ.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'securitres_private.can_delete_orphaned_evidence(text)'::regprocedure
      AND p.prorettype = 'boolean'::regtype
      AND p.proargnames = ARRAY['object_name']::text[]
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND p.provolatile = 's'
      AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND pg_catalog.md5(pg_catalog.regexp_replace(
        p.prosrc, '[[:space:]]+', '', 'g'
      )) = 'a33722074f7c4330a97bbfc32bcb79f5'
      AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: orphan-evidence helper definition, settings, owner, or privileges differ.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.decide_excuse_letter(uuid,text,text)'::regprocedure
      AND p.prorettype = 'public.excuse_letters'::regtype
      AND p.pronargdefaults = 1
      AND p.proargnames = ARRAY['p_letter_id', 'p_decision', 'p_comment']::text[]
      AND pg_catalog.pg_get_expr(p.proargdefaults, 0) = 'NULL::text'
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      AND pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: the reviewed decision RPC signature, settings, owner, or grants differ.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.record_letter_status_change()'::regprocedure
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND pg_catalog.md5(pg_catalog.regexp_replace(
        p.prosrc, '[[:space:]]+', '', 'g'
      )) = '45f666c27d5d3426c4a6487a1e5f8329'
  ) OR (
    SELECT count(*)
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_attribute AS status_column
      ON status_column.attrelid = t.tgrelid
     AND status_column.attname = 'status'
     AND status_column.attnum > 0
     AND NOT status_column.attisdropped
    WHERE t.tgrelid = 'public.excuse_letters'::regclass
      AND t.tgname = 'on_excuse_letter_status_changed'
      AND t.tgfoid = 'public.record_letter_status_change()'::regprocedure
      AND t.tgtype = 17
      AND pg_catalog.array_to_string(t.tgattr, ',') = status_column.attnum::text
      AND t.tgqual IS NULL
      AND t.tgnargs = 0
      AND t.tgargs = ''::bytea
      AND t.tgenabled = 'O'
      AND NOT t.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: the existing status-history function or trigger structure differs.';
  END IF;

  IF pg_catalog.to_regprocedure('public.guard_academic_program_mutation()') IS NULL
     OR pg_catalog.to_regprocedure('public.guard_dean_program_assignment()') IS NULL THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a Phase 9B mutation-guard function is missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.guard_academic_program_mutation()'::regprocedure
      AND p.prorettype = 'trigger'::regtype
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND pg_catalog.md5(pg_catalog.regexp_replace(
        p.prosrc, '[[:space:]]+', '', 'g'
      )) = '0a7e0752924b0bc2f4e60bb8d4f86bf0'
      AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.guard_dean_program_assignment()'::regprocedure
      AND p.prorettype = 'trigger'::regtype
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
      AND pg_catalog.md5(pg_catalog.regexp_replace(
        p.prosrc, '[[:space:]]+', '', 'g'
      )) = '889b979987d0968bcd1b41717e99f18e'
      AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a Phase 9B mutation-guard function definition, security setting, owner, or privilege differs.';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.academic_programs'::regclass
      AND t.tgname = 'academic_programs_phase9b_guard'
      AND t.tgfoid = 'public.guard_academic_program_mutation()'::regprocedure
      AND t.tgtype = 31
      AND coalesce(pg_catalog.array_to_string(t.tgattr, ','), '') = ''
      AND t.tgqual IS NULL
      AND t.tgnargs = 0
      AND t.tgargs = ''::bytea
      AND t.tgenabled = 'O'
      AND NOT t.tgisinternal
  ) <> 1 OR (
    SELECT count(*)
    FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.dean_program_assignments'::regclass
      AND t.tgname = 'dean_program_assignments_phase9b_guard'
      AND t.tgfoid = 'public.guard_dean_program_assignment()'::regprocedure
      AND t.tgtype = 31
      AND coalesce(pg_catalog.array_to_string(t.tgattr, ','), '') = ''
      AND t.tgqual IS NULL
      AND t.tgnargs = 0
      AND t.tgargs = ''::bytea
      AND t.tgenabled = 'O'
      AND NOT t.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a Phase 9B mutation-guard trigger differs.';
  END IF;

  IF pg_catalog.to_regprocedure('securitres_private.can_dean_access_program(uuid)') IS NOT NULL
     OR pg_catalog.to_regprocedure('securitres_private.can_dean_access_letter(uuid)') IS NOT NULL
     OR pg_catalog.to_regprocedure('securitres_private.can_dean_read_profile(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 9C preflight failed: a proposed helper function already exists.';
  END IF;
END
$preflight$;

CREATE FUNCTION securitres_private.can_dean_access_program(p_program_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS dean
      JOIN public.academic_programs AS program
        ON program.id = p_program_id
       AND program.is_active IS TRUE
      JOIN public.dean_program_assignments AS assignment
        ON assignment.dean_id = dean.id
       AND assignment.program_id = program.id
       AND assignment.revoked_at IS NULL
      WHERE dean.id = (SELECT auth.uid())
        AND dean.role = 'dean'
    );
$function$;

ALTER FUNCTION securitres_private.can_dean_access_program(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.can_dean_access_program(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION securitres_private.can_dean_access_program(uuid)
  TO authenticated;

CREATE FUNCTION securitres_private.can_dean_access_letter(p_letter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS dean
      JOIN public.dean_program_assignments AS assignment
        ON assignment.dean_id = dean.id
       AND assignment.revoked_at IS NULL
      JOIN public.academic_programs AS program
        ON program.id = assignment.program_id
       AND program.is_active IS TRUE
      JOIN public.profiles AS student
        ON student.program_id = program.id
       AND student.role = 'student'
      JOIN public.excuse_letters AS letter
        ON letter.student_id = student.id
       AND letter.id = p_letter_id
      WHERE dean.id = (SELECT auth.uid())
        AND dean.role = 'dean'
    );
$function$;

ALTER FUNCTION securitres_private.can_dean_access_letter(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.can_dean_access_letter(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION securitres_private.can_dean_access_letter(uuid)
  TO authenticated;

CREATE FUNCTION securitres_private.can_dean_read_profile(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.profiles AS dean
      WHERE dean.id = (SELECT auth.uid())
        AND dean.role = 'dean'
        AND (
          EXISTS (
            SELECT 1
            FROM public.profiles AS student
            JOIN public.excuse_letters AS letter
              ON letter.student_id = student.id
            WHERE student.id = p_profile_id
              AND student.role = 'student'
              AND securitres_private.can_dean_access_letter(letter.id)
          )
          OR EXISTS (
            SELECT 1
            FROM public.profiles AS professor
            JOIN public.course_offerings AS course
              ON course.professor_id = professor.id
            JOIN public.excuse_letters AS letter
              ON letter.course_id = course.id
            WHERE professor.id = p_profile_id
              AND professor.role = 'professor'
              AND securitres_private.can_dean_access_letter(letter.id)
          )
        )
    );
$function$;

ALTER FUNCTION securitres_private.can_dean_read_profile(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION securitres_private.can_dean_read_profile(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION securitres_private.can_dean_read_profile(uuid)
  TO authenticated;

GRANT SELECT ON public.academic_programs TO authenticated;

CREATE POLICY academic_programs_select_own_or_assigned
  ON public.academic_programs
  FOR SELECT TO authenticated
  USING (
    is_active IS TRUE
    AND (
      EXISTS (
        SELECT 1
        FROM public.profiles AS student
        WHERE student.id = (SELECT auth.uid())
          AND student.role = 'student'
          AND student.program_id = academic_programs.id
      )
      OR securitres_private.can_dean_access_program(academic_programs.id)
    )
  );

DROP POLICY profiles_select_self_or_dean ON public.profiles;
CREATE POLICY profiles_select_self_or_dean
  ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR securitres_private.can_dean_read_profile(id)
  );

DROP POLICY letters_select_student_dean_or_assigned_professor
  ON public.excuse_letters;
CREATE POLICY letters_select_student_dean_or_assigned_professor
  ON public.excuse_letters
  FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR securitres_private.can_dean_access_letter(id)
    OR (
      status = 'approved'
      AND EXISTS (
        SELECT 1
        FROM public.course_offerings AS course
        WHERE course.id = course_id
          AND course.professor_id = (SELECT auth.uid())
      )
    )
  );

DROP POLICY letter_events_select_when_letter_is_visible
  ON public.letter_status_events;
CREATE POLICY letter_events_select_when_letter_is_visible
  ON public.letter_status_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.id = letter_id
        AND (
          letter.student_id = (SELECT auth.uid())
          OR securitres_private.can_dean_access_letter(letter.id)
          OR (
            letter.status = 'approved'
            AND EXISTS (
              SELECT 1
              FROM public.course_offerings AS course
              WHERE course.id = letter.course_id
                AND course.professor_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

DROP POLICY evidence_select_when_letter_is_visible
  ON public.excuse_evidence;
CREATE POLICY evidence_select_when_letter_is_visible
  ON public.excuse_evidence
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.excuse_letters AS letter
      WHERE letter.id = letter_id
        AND (
          letter.student_id = (SELECT auth.uid())
          OR securitres_private.can_dean_access_letter(letter.id)
          OR (
            letter.status = 'approved'
            AND EXISTS (
              SELECT 1
              FROM public.course_offerings AS course
              WHERE course.id = letter.course_id
                AND course.professor_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

DROP POLICY course_enrollments_select_own_or_course_professor_or_dean
  ON public.course_enrollments;
CREATE POLICY course_enrollments_select_own_or_course_professor_or_dean
  ON public.course_enrollments
  FOR SELECT TO authenticated
  USING (
    student_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.course_offerings AS course
      WHERE course.id = course_id
        AND course.professor_id = (SELECT auth.uid())
    )
  );

DROP POLICY users_download_evidence_for_visible_letters
  ON storage.objects;
CREATE POLICY users_download_evidence_for_visible_letters
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'excuse-evidence'
    AND EXISTS (
      SELECT 1
      FROM public.excuse_evidence AS evidence
      JOIN public.excuse_letters AS letter
        ON letter.id = evidence.letter_id
      WHERE evidence.storage_path = objects.name
        AND (
          letter.student_id = (SELECT auth.uid())
          OR securitres_private.can_dean_access_letter(letter.id)
          OR (
            letter.status = 'approved'
            AND EXISTS (
              SELECT 1
              FROM public.course_offerings AS course
              WHERE course.id = letter.course_id
                AND course.professor_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

CREATE OR REPLACE FUNCTION public.decide_excuse_letter(
  p_letter_id uuid,
  p_decision text,
  p_comment text DEFAULT NULL
)
RETURNS public.excuse_letters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $decision$
DECLARE
  v_dean_id uuid;
  v_student_id uuid;
  v_program_id uuid;
  v_assignment_id uuid;
  updated_letter public.excuse_letters;
BEGIN
  IF (SELECT auth.uid()) IS NULL
     OR (SELECT public.current_profile_role()) IS DISTINCT FROM 'dean' THEN
    RAISE EXCEPTION 'Only an authenticated Dean can decide excuse letters.'
      USING ERRCODE = '42501';
  END IF;

  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'disapproved') THEN
    RAISE EXCEPTION 'Decision must be approved or disapproved.'
      USING ERRCODE = '22023';
  END IF;

  SELECT profile.id
  INTO v_dean_id
  FROM public.profiles AS profile
  WHERE profile.id = (SELECT auth.uid())
    AND profile.role = 'dean'
  FOR SHARE;

  IF v_dean_id IS NULL THEN
    RAISE EXCEPTION 'Only an authenticated Dean can decide excuse letters.'
      USING ERRCODE = '42501';
  END IF;

  SELECT letter.student_id
  INTO v_student_id
  FROM public.excuse_letters AS letter
  WHERE letter.id = p_letter_id
  FOR UPDATE;

  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'Letter was not found or is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT student.program_id
  INTO v_program_id
  FROM public.profiles AS student
  WHERE student.id = v_student_id
    AND student.role = 'student'
  FOR SHARE;

  IF v_program_id IS NULL THEN
    RAISE EXCEPTION 'Letter was not found or is not assigned to this Dean.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.academic_programs AS program
  WHERE program.id = v_program_id
    AND program.is_active IS TRUE
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Letter was not found or is not assigned to this Dean.'
      USING ERRCODE = '42501';
  END IF;

  SELECT assignment.id
  INTO v_assignment_id
  FROM public.dean_program_assignments AS assignment
  WHERE assignment.dean_id = v_dean_id
    AND assignment.program_id = v_program_id
    AND assignment.revoked_at IS NULL
  FOR SHARE;

  IF v_assignment_id IS NULL THEN
    RAISE EXCEPTION 'Letter was not found or is not assigned to this Dean.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.excuse_letters AS letter
  SET status = p_decision,
      dean_comment = NULLIF(pg_catalog.btrim(p_comment), ''),
      decided_at = pg_catalog.now(),
      decided_by = (SELECT auth.uid())
  WHERE letter.id = p_letter_id
    AND letter.status = 'pending'
  RETURNING letter.* INTO updated_letter;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Letter was not found or is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN updated_letter;
END;
$decision$;

COMMIT;
