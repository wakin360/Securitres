import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getAuthorizedLetterComments,
  getAuthorizedLetterStatusHistoryComments,
} from '../src/services/letterComments.js';

const migrationPath = new URL(
  '../supabase/migrations/20261112220000_phase2a_comment_privacy_and_envelope_preparation.sql',
  import.meta.url,
);
const [
  migration,
  initialSchema,
  programAuthorization,
  decisionMigration,
  notificationMigration,
  professorIdentityMigration,
  encryptedMigration,
  studentService,
  deanService,
  professorService,
] = await Promise.all([
  readFile(migrationPath, 'utf8'),
  readFile(new URL('../supabase/migrations/20261019000000_initial_schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261107170000_phase9c_dean_program_authorization.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261102173200_secure_dean_letter_decisions.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261110000000_student_decision_email_notifications.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261110120000_professor_approved_letter_student_identity.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261113000000_encrypted_data_api.sql', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/studentLetters.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/deanReview.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/professorLetters.js', import.meta.url), 'utf8'),
]);

function functionDefinition(source, name) {
  const start = source.indexOf(`CREATE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `${name} definition should exist`);
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, `${name} definition should terminate`);
  return source.slice(start, end);
}

test('Student current comments are fetched through the authenticated encrypted-data API', () => {
  const commentsRpc = functionDefinition(migration, 'get_authorized_letter_comments');

  assert.match(commentsRpc, /auth\.uid\(\)/);
  assert.match(commentsRpc, /public\.current_profile_role\(\)/);
  assert.match(commentsRpc, /v_role = 'student' AND letter\.student_id = v_user_id/);
  assert.match(studentService, /getSecureData\('student-letters'\)/);
  assert.doesNotMatch(studentService, /dean_comment\s*,/);
  assert.match(encryptedMigration, /REVOKE ALL ON FUNCTION public\.get_authorized_letter_comments\(uuid\[\]\) FROM authenticated/);
});

test('Students cannot retrieve another Student’s current or historical comments', () => {
  const currentCommentsRpc = functionDefinition(migration, 'get_authorized_letter_comments');
  const historyRpc = functionDefinition(migration, 'get_authorized_letter_status_history_comments');

  assert.match(currentCommentsRpc, /letter\.student_id = v_user_id/);
  assert.match(historyRpc, /letter\.student_id = v_user_id/);
  assert.match(historyRpc, /RAISE EXCEPTION 'Letter history is not available to this account\.'/);
  assert.doesNotMatch(currentCommentsRpc, /p_student_id/);
});

test('authorized Deans use the database program-assignment helper for both comment locations', () => {
  const currentCommentsRpc = functionDefinition(migration, 'get_authorized_letter_comments');
  const historyRpc = functionDefinition(migration, 'get_authorized_letter_status_history_comments');

  assert.match(currentCommentsRpc, /v_role = 'dean'[\s\S]*?can_dean_access_letter\(letter\.id\)/);
  assert.match(historyRpc, /v_role = 'dean'[\s\S]*?can_dean_access_letter\(letter\.id\)/);
  assert.match(programAuthorization, /CREATE FUNCTION securitres_private\.can_dean_access_letter/);
  assert.match(programAuthorization, /assignment\.revoked_at IS NULL/);
  assert.match(programAuthorization, /program\.is_active IS TRUE/);
});

test('Deans outside the assigned program cannot retrieve letter or history comments', () => {
  const currentCommentsRpc = functionDefinition(migration, 'get_authorized_letter_comments');
  const historyRpc = functionDefinition(migration, 'get_authorized_letter_status_history_comments');

  assert.match(currentCommentsRpc, /AND securitres_private\.can_dean_access_letter\(letter\.id\)/);
  assert.match(historyRpc, /NOT EXISTS \([\s\S]*?can_dean_access_letter\(letter\.id\)/);
  assert.match(historyRpc, /ERRCODE = '42501'/);
});

test('authenticated PostgREST users cannot select excuse_letters.dean_comment directly', () => {
  const safeLetterGrant = migration.match(
    /GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.excuse_letters TO authenticated;/,
  )?.[1];

  assert.ok(safeLetterGrant);
  assert.match(migration, /REVOKE SELECT ON TABLE public\.excuse_letters\s+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE SELECT \(dean_comment\) ON TABLE public\.excuse_letters\s+FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(safeLetterGrant, /\bdean_comment\b/);
});

test('authenticated PostgREST users cannot select letter_status_events.comment directly', () => {
  const safeEventGrant = migration.match(
    /GRANT SELECT \(\s*id,\s*letter_id,([\s\S]*?)\) ON TABLE public\.letter_status_events TO authenticated;/,
  )?.[1];

  assert.ok(safeEventGrant);
  assert.match(migration, /REVOKE SELECT ON TABLE public\.letter_status_events\s+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE SELECT \(comment\) ON TABLE public\.letter_status_events\s+FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(safeEventGrant, /\bcomment\b/);
});

test('Professor-facing services and existing RPCs expose no comment retrieval bypass', () => {
  assert.doesNotMatch(professorService, /dean_comment|letter_status_events|authorized_letter_comments/);
  assert.match(programAuthorization, /public\.current_profile_role\(\)\) IS DISTINCT FROM 'dean'/);
  assert.match(decisionMigration, /public\.current_profile_role\(\)\) is distinct from 'dean'/i);
  assert.match(notificationMigration, /REVOKE ALL ON FUNCTION public\.claim_student_decision_notification[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(professorIdentityMigration, /RETURNS TABLE[\s\S]*full_name[\s\S]*student_number/);
  assert.doesNotMatch(professorIdentityMigration, /dean_comment|letter_status_events/);
});

test('permitted Student and Dean comment reads use authorized server-side endpoints', () => {
  assert.match(studentService, /getSecureData\('student-letters'\)/);
  assert.match(deanService, /getSecureData\('dean-letters'\)/);
  assert.match(encryptedMigration, /GRANT EXECUTE ON FUNCTION public\.decide_excuse_letter_encrypted[\s\S]*TO service_role/);
  assert.match(encryptedMigration, /REVOKE SELECT \([\s\S]*?dean_comment[\s\S]*?FROM anon, authenticated/);
});

test('historical comment rows and the existing status trigger are preserved', () => {
  assert.match(initialSchema, /INSERT INTO public\.letter_status_events[\s\S]*new\.dean_comment/i);
  assert.match(initialSchema, /\(new\.id, \(select auth\.uid\(\)\), old\.status, new\.status, new\.dean_comment\)/i);
  assert.match(initialSchema, /created_at timestamptz not null default now\(\)/i);
  assert.doesNotMatch(migration, /DROP TRIGGER|CREATE TRIGGER|DELETE FROM public\.letter_status_events|UPDATE public\.letter_status_events/i);
});

test('encrypted decisions retain the status trigger as a single atomic history writer', () => {
  assert.match(decisionMigration, /UPDATE public\.excuse_letters[\s\S]*SET status = p_decision/i);
  assert.match(initialSchema, /AFTER UPDATE OF status ON public\.excuse_letters/i);
  assert.match(initialSchema, /IF old\.status IS DISTINCT FROM new\.status THEN[\s\S]*INSERT INTO public\.letter_status_events/i);
  assert.match(encryptedMigration, /NEW\.decision_event_id/);
  assert.match(encryptedMigration, /NEW\.decision_event_comment_envelope/);
  assert.match(encryptedMigration, /UPDATE public\.excuse_letters AS letter[\s\S]*SET status = p_decision/);
  assert.match(encryptedMigration, /INSERT INTO public\.letter_status_events/);
  assert.doesNotMatch(encryptedMigration, /CREATE TRIGGER|DROP TRIGGER|DELETE FROM public\.letter_status_events/i);
});

test('Phase 1-compatible nullable envelopes are added without changing plaintext records', () => {
  const expectedColumns = [
    'full_name_envelope',
    'student_number_envelope',
    'program_envelope',
    'absence_start_envelope',
    'absence_end_envelope',
    'reason_envelope',
    'dean_comment_envelope',
    'comment_envelope',
    'parent_guardian_phone_envelope',
    'original_filename_envelope',
  ];

  for (const column of expectedColumns) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column} jsonb`));
    assert.match(migration, new RegExp(`${column} IS NULL\\s+OR securitres_private\\.is_valid_phase1_envelope\\(${column}\\)`));
  }
  assert.match(migration, /'formatVersion'[\s\S]*?'kekVersion'[\s\S]*?'plaintextType'[\s\S]*?'ciphertext'[\s\S]*?'iv'[\s\S]*?'tag'[\s\S]*?'wrappedDek'[\s\S]*?'dekWrapIv'[\s\S]*?'dekWrapTag'/);
  assert.match(migration, /4194304/);
  assert.match(migration, /char_length\(v_value\) <> CASE v_key[\s\S]*?WHEN 'wrappedDek' THEN 43/);
  assert.doesNotMatch(migration, /DROP COLUMN|UPDATE public\.(profiles|excuse_letters|letter_status_events|excuse_letter_contacts|excuse_evidence)/i);
});

test('letter-comment service batches safely, uses only authenticated RPC calls, and propagates errors', async () => {
  const ids = Array.from({ length: 501 }, (_, index) => `letter-${index}`);
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: args.p_letter_ids.map((letter_id) => ({ letter_id, dean_comment: `comment:${letter_id}` })),
        error: null,
      };
    },
  };

  const comments = await getAuthorizedLetterComments(client, ids);

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.name === 'get_authorized_letter_comments'));
  assert.deepEqual(calls.map((call) => call.args.p_letter_ids.length), [500, 1]);
  assert.equal(comments.get('letter-500'), 'comment:letter-500');

  const failure = { code: '42501' };
  await assert.rejects(
    getAuthorizedLetterStatusHistoryComments({
      rpc: async (name, args) => {
        assert.equal(name, 'get_authorized_letter_status_history_comments');
        assert.deepEqual(args, { p_letter_id: 'letter-1' });
        return { data: null, error: failure };
      },
    }, 'letter-1'),
    (error) => error === failure,
  );
});
