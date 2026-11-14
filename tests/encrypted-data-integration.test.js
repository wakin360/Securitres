import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  decryptLetter,
  decryptLetterEvents,
  decryptProfile,
  encryptText,
} from '../api/_lib/secure-data.js';
import { getDeanEvidence, getDeanLetters } from '../api/secure-data.js';
import { decryptValue, EncryptionError } from '../api/_lib/encryption.js';
import { createStudentNumberIndex } from '../api/_lib/student-number-index.js';

const keyEnvironmentNames = [
  'VERCEL_ENV',
  'NODE_ENV',
  'SECURITRES_KEK_ACTIVE_VERSION',
  'SECURITRES_KEK_V1_B64URL',
];

async function withTestKey(run) {
  const previous = new Map(keyEnvironmentNames.map((name) => [name, process.env[name]]));
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = 'test';
  process.env.SECURITRES_KEK_ACTIVE_VERSION = '1';
  process.env.SECURITRES_KEK_V1_B64URL = randomBytes(32).toString('base64url');
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('profile and letter field envelopes round-trip with the stored field contexts', async () => {
  await withTestKey(() => {
    const profileId = '00000000-0000-4000-8000-000000000001';
    const letterId = '00000000-0000-4000-8000-000000000002';
    const profile = {
      id: profileId,
      role: 'student',
      program_id: 'program-1',
      full_name: null,
      full_name_envelope: encryptText('Taylor Example', 'profiles', profileId, 'full_name'),
      student_number: null,
      student_number_envelope: encryptText('2026000123', 'profiles', profileId, 'student_number'),
      program: null,
      program_envelope: encryptText('Computer Science', 'profiles', profileId, 'program'),
    };
    const letter = {
      id: letterId,
      absence_start: null,
      absence_start_envelope: encryptText('2026-11-12', 'excuse_letters', letterId, 'absence_start'),
      absence_end: null,
      absence_end_envelope: encryptText('2026-11-13', 'excuse_letters', letterId, 'absence_end'),
      reason: null,
      reason_envelope: encryptText('Medical appointment', 'excuse_letters', letterId, 'reason'),
      dean_comment: null,
      dean_comment_envelope: encryptText('Approved', 'excuse_letters', letterId, 'dean_comment'),
    };

    assert.equal(decryptProfile(profile).full_name, 'Taylor Example');
    assert.equal(decryptProfile(profile).student_number, '2026000123');
    assert.equal(decryptProfile(profile).program, 'Computer Science');
    const readableLetter = decryptLetter(letter, true);
    assert.equal(readableLetter.absence_start, '2026-11-12');
    assert.equal(readableLetter.absence_end, '2026-11-13');
    assert.equal(readableLetter.reason, 'Medical appointment');
    assert.equal(readableLetter.dean_comment, 'Approved');
    assert.equal('reason_envelope' in readableLetter, false);
  });
});

test('status history uses an envelope bound to the event row and field', async () => {
  await withTestKey(async () => {
    const eventId = '00000000-0000-4000-8000-000000000003';
    const envelope = encryptText(
      'Reviewed',
      'letter_status_events',
      eventId,
      'comment',
    );
    const client = {
      from(table) {
        assert.equal(table, 'letter_status_events');
        const query = {
          select() { return query; },
          eq() { return query; },
          order() { return query; },
          then(resolve, reject) {
            return Promise.resolve({
              data: [{
                id: eventId,
                old_status: 'pending',
                new_status: 'approved',
                comment: null,
                comment_envelope: envelope,
                created_at: '2026-11-13T10:00:00Z',
              }],
              error: null,
            }).then(resolve, reject);
          },
        };
        return query;
      },
    };

    const [event] = await decryptLetterEvents(client, '00000000-0000-4000-8000-000000000002');
    assert.equal(event.comment, 'Reviewed');
    assert.throws(
      () => decryptValue(envelope, {
        environment: 'test',
        table: 'excuse_letters',
        rowId: eventId,
        field: 'dean_comment',
      }),
      (error) => error instanceof EncryptionError && error.code === 'AUTHENTICATION_FAILED',
    );
  });
});

test('missing keys fail closed rather than producing a plaintext write', async () => {
  const previousVersion = process.env.SECURITRES_KEK_ACTIVE_VERSION;
  const previousKey = process.env.SECURITRES_KEK_V1_B64URL;
  delete process.env.SECURITRES_KEK_ACTIVE_VERSION;
  delete process.env.SECURITRES_KEK_V1_B64URL;
  try {
    assert.throws(
      () => encryptText('Sensitive value', 'profiles', 'profile-1', 'full_name'),
      (error) => error instanceof EncryptionError && error.code === 'MISSING_KEY',
    );
  } finally {
    if (previousVersion === undefined) delete process.env.SECURITRES_KEK_ACTIVE_VERSION;
    else process.env.SECURITRES_KEK_ACTIVE_VERSION = previousVersion;
    if (previousKey === undefined) delete process.env.SECURITRES_KEK_V1_B64URL;
    else process.env.SECURITRES_KEK_V1_B64URL = previousKey;
  }
});

test('student-number blind index is stable and requires its separate configured key', () => {
  const previous = process.env.SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL;
  process.env.SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL = randomBytes(32).toString('base64url');
  try {
    const first = createStudentNumberIndex('2026000123');
    assert.equal(first, createStudentNumberIndex('2026000123'));
    assert.notEqual(first, createStudentNumberIndex('2026000124'));
    assert.match(first, /^[0-9a-f]{64}$/);
  } finally {
    if (previous === undefined) delete process.env.SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL;
    else process.env.SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL = previous;
  }
});

test('database migration routes encrypted writes through scoped server RPCs and denies sensitive direct reads', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20261113000000_encrypted_data_api.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /create_student_excuse_letter_encrypted/);
  assert.match(migration, /decide_excuse_letter_encrypted/);
  assert.match(migration, /create_student_evidence_record_encrypted/);
  assert.match(migration, /REVOKE SELECT \([\s\S]*?dean_comment[\s\S]*?FROM anon, authenticated/);
  assert.match(migration, /REVOKE SELECT ON TABLE public\.excuse_letter_contacts FROM anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.decide_excuse_letter_encrypted[\s\S]*TO service_role/);
  assert.match(migration, /decision_event_id/);
  assert.match(migration, /decision_event_comment_envelope/);
  assert.match(migration, /profiles_student_number_index_key/);
});

test('decision RPC locks and validates the Dean profile before locking the letter', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20261113000000_encrypted_data_api.sql', import.meta.url),
    'utf8',
  );
  const functionStart = migration.indexOf('CREATE FUNCTION public.decide_excuse_letter_encrypted(');
  const functionEnd = migration.indexOf('$function$;', functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const decisionFunction = migration.slice(functionStart, functionEnd);
  const deanProfileRead = decisionFunction.indexOf('FROM public.profiles AS dean');
  const deanProfileLock = decisionFunction.indexOf('FOR SHARE;', deanProfileRead);
  const letterLock = decisionFunction.indexOf('SELECT student.program_id');

  assert.notEqual(deanProfileRead, -1);
  assert.notEqual(deanProfileLock, -1);
  assert.ok(deanProfileRead < deanProfileLock);
  assert.ok(deanProfileLock < letterLock, 'the Dean row lock must precede the letter lock');
  assert.match(
    decisionFunction,
    /PERFORM 1\s+FROM public\.profiles AS dean\s+WHERE dean\.id = p_dean_id\s+AND dean\.role = 'dean'\s+FOR SHARE;\s+IF NOT FOUND THEN\s+RAISE EXCEPTION 'Only a Dean can decide excuse letters\.'\s+USING ERRCODE = '42501';/s,
  );
});

test('Dean read RPC results are decrypted and reduced to interface fields', async () => {
  await withTestKey(async () => {
    const deanId = '00000000-0000-4000-8000-000000000010';
    const letterId = '00000000-0000-4000-8000-000000000011';
    const studentId = '00000000-0000-4000-8000-000000000012';
    const professorId = '00000000-0000-4000-8000-000000000013';
    const eventId = '00000000-0000-4000-8000-000000000014';
    const evidenceId = '00000000-0000-4000-8000-000000000015';
    const letter = {
      id: letterId,
      absence_start: null,
      absence_start_envelope: encryptText('2026-11-12', 'excuse_letters', letterId, 'absence_start'),
      absence_end: null,
      absence_end_envelope: encryptText('2026-11-13', 'excuse_letters', letterId, 'absence_end'),
      reason: null,
      reason_envelope: encryptText('Medical appointment', 'excuse_letters', letterId, 'reason'),
      status: 'pending',
      dean_comment: null,
      dean_comment_envelope: null,
      submitted_at: '2026-11-13T10:00:00Z',
      student: {
        id: studentId,
        full_name: null,
        full_name_envelope: encryptText('Taylor Example', 'profiles', studentId, 'full_name'),
        student_number: null,
        student_number_envelope: encryptText('2026000123', 'profiles', studentId, 'student_number'),
        program: null,
        program_envelope: encryptText('Computer Science', 'profiles', studentId, 'program'),
      },
      course: {
        course_code: 'CS101',
        course_name: 'Introduction to Computing',
        section: 'A',
        professor: {
          id: professorId,
          full_name: null,
          full_name_envelope: encryptText('Jordan Professor', 'profiles', professorId, 'full_name'),
        },
      },
      contact: {
        parent_guardian_phone: null,
        parent_guardian_phone_envelope: encryptText(
          '555-0101',
          'excuse_letter_contacts',
          letterId,
          'parent_guardian_phone',
        ),
      },
      statusEvents: [{
        id: eventId,
        old_status: null,
        new_status: 'pending',
        comment: null,
        comment_envelope: null,
        created_at: '2026-11-13T10:00:00Z',
      }],
      evidence: [{
        id: evidenceId,
        original_filename: null,
        original_filename_envelope: encryptText(
          'clinic-note.pdf',
          'excuse_evidence',
          evidenceId,
          'original_filename',
        ),
        mime_type: 'application/pdf',
        size_bytes: 1024,
        uploaded_at: '2026-11-13T10:00:00Z',
      }],
    };
    const calls = [];
    const client = {
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === 'get_dean_evidence_encrypted') {
          return { data: JSON.parse(JSON.stringify(letter.evidence)), error: null };
        }
        return { data: [JSON.parse(JSON.stringify(letter))], error: null };
      },
    };

    const [listed] = await getDeanLetters(client, deanId);
    assert.equal(calls[0].name, 'get_dean_letters_encrypted');
    assert.equal(calls[0].args.p_dean_id, deanId);
    assert.equal(listed.student.full_name, 'Taylor Example');
    assert.equal(listed.student.student_number, '2026000123');
    assert.equal(listed.course.professor.full_name, 'Jordan Professor');
    assert.equal(listed.contact.parent_guardian_phone, '555-0101');
    assert.equal('student_id' in listed, false);
    assert.equal('course_id' in listed, false);
    assert.equal('id' in listed.student, false);
    assert.equal('id' in listed.course.professor, false);
    assert.equal('full_name_envelope' in listed.student, false);

    const detail = await getDeanLetters(client, deanId, letterId);
    assert.equal(detail.statusEvents[0].new_status, 'pending');
    assert.equal('comment_envelope' in detail.statusEvents[0], false);
    assert.equal(detail.evidence[0].original_filename, 'clinic-note.pdf');
    assert.equal('storage_path' in detail.evidence[0], false);
    assert.doesNotMatch(
      JSON.stringify(detail),
      /_envelope|storage_path|student_number_index|encryption_key/i,
    );

    const [evidence] = await getDeanEvidence(client, deanId, letterId);
    assert.equal(evidence.original_filename, 'clinic-note.pdf');
    assert.equal('storage_path' in evidence, false);
  });
});

test('Dean read RPC maps only the defined authorization failure to a non-disclosing 404', async () => {
  const client = {
    async rpc() {
      return {
        data: null,
        error: { code: 'P0001', message: 'Dean resource is not available.' },
      };
    },
  };
  await assert.rejects(
    getDeanLetters(client, '00000000-0000-4000-8000-000000000010'),
    (error) => error.status === 404 && /not found or is not accessible/.test(error.message),
  );
  await assert.rejects(
    getDeanLetters({
      async rpc() {
        return { data: null, error: { code: 'P0001', message: 'Unexpected database error.' } };
      },
    }, '00000000-0000-4000-8000-000000000010'),
    (error) => error.code === 'P0001',
  );
});

test('Dean read migration restricts RPC execution and locks authorization rows before reads', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/20261114180000_phase2_dean_secure_reads.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /SECURITY DEFINER\s+SET search_path = ''/i);
  assert.match(migration, /FOR SHARE OF assignment, program/);
  assert.match(migration, /FOR SHARE OF student/);
  assert.match(migration, /FOR SHARE OF letter, student/);
  assert.match(migration, /FOR SHARE;\s+IF NOT FOUND THEN/);
  assert.match(migration, /dean\.role = 'dean'/);
  assert.match(migration, /student\.role = 'student'/);
  assert.match(migration, /program\.is_active IS TRUE/);
  assert.match(migration, /assignment\.dean_id = p_dean_id/);
  assert.match(migration, /assignment\.revoked_at IS NULL/);
  assert.match(migration, /letter\.id = p_letter_id/);
  const listScope = migration.slice(
    migration.indexOf('IF p_letter_id IS NULL THEN'),
    migration.indexOf('RETURN;', migration.indexOf('IF p_letter_id IS NULL THEN')),
  );
  assert.ok(
    listScope.indexOf('FOR SHARE OF student') < listScope.indexOf('FOR SHARE OF assignment, program'),
    'list operations lock student rows before assignments to match the decision lock order',
  );
  for (const signature of [
    'public.get_dean_letters_encrypted(uuid, uuid, integer, integer)',
    'public.get_dean_evidence_encrypted(uuid, uuid)',
    'public.get_dean_evidence_storage_path(uuid, uuid)',
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      migration,
      new RegExp(`REVOKE ALL ON FUNCTION ${escaped}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role;[\\s\\S]*?GRANT EXECUTE ON FUNCTION ${escaped}[\\s\\S]*?TO service_role;`),
    );
  }
  assert.match(migration, /evidence\.storage_path/, 'the storage path is only selected by the private API RPC');
  const letterRpc = migration.slice(
    migration.indexOf('CREATE FUNCTION public.get_dean_letters_encrypted'),
    migration.indexOf('CREATE FUNCTION public.get_dean_evidence_encrypted'),
  );
  assert.doesNotMatch(letterRpc, /'student_id'|'course_id'|'program_id'|'student_number_index'|'storage_path'/);
});

test('Dean evidence download uses a server endpoint rather than querying Storage paths in the browser', async () => {
  const source = await readFile(
    new URL('../src/services/deanReview.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /getSecureData\('dean-evidence-url', \{ evidenceId \}\)/);
  assert.doesNotMatch(source, /\.from\('excuse_evidence'\)/);
  assert.doesNotMatch(source, /\.createSignedUrl\(/);
});

test('decision API binds the existing service-role RPC to the verified user ID', async () => {
  const api = await readFile(new URL('../api/secure-data.js', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../api/_lib/secure-data.js', import.meta.url), 'utf8');
  assert.match(helper, /auth\.getUser\(token\)/);
  assert.match(helper, /if \(error \|\| !data\.user\) throw new ApiError\(401/);
  assert.match(api, /p_dean_id:\s*user\.id/);
  assert.match(api, /rpc\('decide_excuse_letter_encrypted'/);
  assert.doesNotMatch(api, /body\??\.deanId|body\??\.programId/);
  assert.doesNotMatch(helper, /dean_program_assignments|academic_programs/);
});

test('Dean-only read actions enforce the verified profile role and Storage rechecks access', async () => {
  const api = await readFile(new URL('../api/secure-data.js', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../api/_lib/secure-data.js', import.meta.url), 'utf8');
  const storagePolicies = await readFile(
    new URL('../supabase/migrations/20261107170000_phase9c_dean_program_authorization.sql', import.meta.url),
    'utf8',
  );
  assert.match(api, /if \(action === 'dean-letters'\) \{\s*requireRole\(profile, 'dean'\)/);
  assert.match(api, /if \(action === 'dean-evidence-url'\) \{\s*requireRole\(profile, 'dean'\)/);
  assert.match(api, /getDeanEvidenceSignedUrl\(\s*supabase,\s*userSupabase,\s*user\.id/);
  assert.match(api, /userSupabase\.storage/);
  assert.match(helper, /global: \{ headers: \{ Authorization: `Bearer \$\{token\}` \} \}/);
  assert.match(storagePolicies, /users_download_evidence_for_visible_letters/);
  assert.match(storagePolicies, /securitres_private\.can_dean_access_letter\(letter\.id\)/);
});
