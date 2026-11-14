import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import {
  ApiError,
  decryptText,
  decryptProfile,
  getEncryptionMode,
  respondWithError,
  sendJson,
} from '../api/_lib/secure-data.js';
import { EncryptionError, encryptValue, decryptValue } from '../api/_lib/encryption.js';
import {
  clearVerifiedPlaintext,
  ensureStudentNumberIndex,
  isStrictModeReady,
  isStudentNumberReadinessComplete,
  processRow,
  updateEnvelope,
} from '../scripts/backfill-encrypted-data.js';
import { createStudentNumberIndex } from '../api/_lib/student-number-index.js';

const encryptionContext = {
  environment: 'test',
  table: 'profiles',
  rowId: '00000000-0000-4000-8000-000000000001',
  field: 'full_name',
};
const testEnvironmentNames = [
  'VERCEL_ENV',
  'NODE_ENV',
  'SECURITRES_ENCRYPTION_MODE',
  'SECURITRES_KEK_ACTIVE_VERSION',
  'SECURITRES_KEK_V1_B64URL',
  'SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL',
];

async function withTestConfiguration(run, mode = 'legacy') {
  const previous = new Map(testEnvironmentNames.map((name) => [name, process.env[name]]));
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = 'test';
  process.env.SECURITRES_ENCRYPTION_MODE = mode;
  process.env.SECURITRES_KEK_ACTIVE_VERSION = '1';
  process.env.SECURITRES_KEK_V1_B64URL = randomBytes(32).toString('base64url');
  process.env.SECURITRES_STUDENT_NUMBER_HMAC_V1_B64URL = randomBytes(32).toString('base64url');
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(status) {
      this.statusCode = status;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createMockSupabase(table, initialRow, beforeUpdate) {
  const state = { ...initialRow };
  let updateAttempts = 0;
  let successfulUpdates = 0;
  let updateHookUsed = false;

  function from(requestedTable) {
    assert.equal(requestedTable, table);
    const query = {
      operation: null,
      values: null,
      filters: [],
      returning: false,
      update(values) {
        this.operation = 'update';
        this.values = values;
        updateAttempts += 1;
        return this;
      },
      select() {
        this.returning = true;
        if (!this.operation) this.operation = 'select';
        return this;
      },
      eq(field, value) {
        this.filters.push((row) => {
          let expected = value;
          if (typeof value === 'string' && /^[\[{]/.test(value)) {
            try { expected = JSON.parse(value); } catch { /* text comparison */ }
          }
          return JSON.stringify(row[field]) === JSON.stringify(expected);
        });
        return this;
      },
      is(field, value) {
        this.filters.push((row) => row[field] === value);
        return this;
      },
      async execute() {
        if (this.operation === 'update') {
          if (!updateHookUsed && beforeUpdate) {
            updateHookUsed = true;
            beforeUpdate(state);
          }
          if (!this.filters.every((matches) => matches(state))) {
            return { data: [], error: null };
          }
          Object.assign(state, this.values);
          successfulUpdates += 1;
          return { data: this.returning ? [{ ...state }] : null, error: null };
        }
        return { data: [{ ...state }], error: null };
      },
      maybeSingle() {
        return this.execute().then(({ data, error }) => ({
          data: data?.[0] || null,
          error,
        }));
      },
      then(resolve, reject) {
        return this.execute().then(resolve, reject);
      },
    };
    return query;
  }

  return {
    from,
    state,
    get updateAttempts() { return updateAttempts; },
    get successfulUpdates() { return successfulUpdates; },
  };
}

test('decrypt mode supports explicit legacy reads and rejects plaintext in strict mode', async () => {
  await withTestConfiguration(() => {
    assert.equal(decryptText(null, 'legacy value', 'profiles', encryptionContext.rowId, 'full_name'), 'legacy value');
    assert.equal(decryptText(null, null, 'profiles', encryptionContext.rowId, 'full_name'), null);
  }, 'legacy');

  await withTestConfiguration(() => {
    assert.throws(
      () => decryptText(null, 'unmigrated value', 'profiles', encryptionContext.rowId, 'full_name'),
      (error) => error instanceof ApiError && error.status === 503,
    );
    assert.equal(decryptText(null, null, 'profiles', encryptionContext.rowId, 'full_name'), null);
  }, 'strict');
});

test('invalid encryption mode configuration fails closed', async () => {
  await withTestConfiguration(() => {
    process.env.SECURITRES_ENCRYPTION_MODE = 'typo';
    assert.throws(
      () => getEncryptionMode(),
      (error) => error instanceof ApiError && error.status === 503,
    );
  });
});

test('present envelopes never fall back to plaintext after authentication failure', async () => {
  await withTestConfiguration(() => {
    const envelope = encryptValue('protected value', encryptionContext);
    envelope.tag = `${envelope.tag.startsWith('A') ? 'B' : 'A'}${envelope.tag.slice(1)}`;
    assert.throws(
      () => decryptText(envelope, 'must not be returned', 'profiles', encryptionContext.rowId, 'full_name'),
      (error) => error instanceof EncryptionError && error.code === 'AUTHENTICATION_FAILED',
    );
  }, 'legacy');
});

test('wrong KEK at the same version and unsupported envelope versions are rejected', async () => {
  await withTestConfiguration(() => {
    const envelope = encryptValue('protected value', encryptionContext);
    process.env.SECURITRES_KEK_V1_B64URL = randomBytes(32).toString('base64url');
    assert.throws(
      () => decryptValue(envelope, encryptionContext),
      (error) => error instanceof EncryptionError && error.code === 'AUTHENTICATION_FAILED',
    );

    process.env.SECURITRES_KEK_V1_B64URL = randomBytes(32).toString('base64url');
    const unsupported = encryptValue('protected value', encryptionContext);
    unsupported.formatVersion = 2;
    assert.throws(
      () => decryptValue(unsupported, encryptionContext),
      (error) => error instanceof EncryptionError && error.code === 'UNSUPPORTED_FORMAT',
    );
  });
});

test('sensitive API responses set no-store headers on success and errors', () => {
  const success = createResponse();
  sendJson(success, 200, { ok: true });
  assert.equal(success.headers['Cache-Control'], 'no-store, private');

  const failure = createResponse();
  respondWithError(failure, new ApiError(403, 'Not authorized.'));
  assert.equal(failure.headers['Cache-Control'], 'no-store, private');
});

test('backfill dry-run reports work without attempting database writes', async () => {
  const supabase = createMockSupabase('excuse_letters', {
    id: '00000000-0000-4000-8000-000000000002',
    reason: 'Existing reason',
    reason_envelope: null,
  });
  const result = {
    needsEncryption: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    skippedNull: 0,
    blindIndexNeedsWrite: 0,
    failed: 0,
  };

  await processRow(
    supabase,
    {
      table: 'excuse_letters',
      idField: 'id',
      fields: [{ name: 'reason', envelope: 'reason_envelope' }],
    },
    supabase.state,
    new Map([['excuse_letters.reason', result]]),
    { dryRun: true, clearPlaintext: false },
  );

  assert.equal(result.needsEncryption, 1);
  assert.equal(result.encrypted, 0);
  assert.equal(supabase.updateAttempts, 0);
  assert.equal(supabase.successfulUpdates, 0);
  assert.equal(supabase.state.reason, 'Existing reason');
  assert.equal(supabase.state.reason_envelope, null);
});

test('backfill skips null values without attempting encryption or writes', async () => {
  const supabase = createMockSupabase('excuse_letters', {
    id: '00000000-0000-4000-8000-000000000007',
    reason: null,
    reason_envelope: null,
  });
  const result = {
    needsEncryption: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    skippedNull: 0,
    blindIndexNeedsWrite: 0,
    failed: 0,
  };

  await processRow(
    supabase,
    {
      table: 'excuse_letters',
      idField: 'id',
      fields: [{ name: 'reason', envelope: 'reason_envelope' }],
    },
    supabase.state,
    new Map([['excuse_letters.reason', result]]),
    { dryRun: false, clearPlaintext: true },
  );

  assert.equal(result.skippedNull, 1);
  assert.equal(supabase.updateAttempts, 0);
});

test('backfill compare-and-swap prevents writing an envelope for a changed plaintext', async () => {
  await withTestConfiguration(async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000003',
      reason: 'snapshot value',
      reason_envelope: null,
    };
    const supabase = createMockSupabase(
      'excuse_letters',
      row,
      (state) => { state.reason = 'concurrent value'; },
    );

    await assert.rejects(
      updateEnvelope(
        supabase,
        {
        table: 'excuse_letters',
        idField: 'id',
        },
        row,
        { name: 'reason', envelope: 'reason_envelope' },
        encryptValue('snapshot value', {
          environment: 'test',
          table: 'excuse_letters',
          rowId: row.id,
          field: 'reason',
        }),
      ),
      /ROW_CHANGED_DURING_ENCRYPTION/,
    );

    assert.equal(supabase.state.reason, 'concurrent value');
    assert.equal(supabase.state.reason_envelope, null);
    assert.equal(supabase.successfulUpdates, 0);
  });
});

test('backfill compare-and-swap prevents clearing plaintext after its envelope changes', async () => {
  await withTestConfiguration(async () => {
    const verifiedEnvelope = encryptValue('same plaintext', {
      environment: 'test',
      table: 'excuse_letters',
      rowId: '00000000-0000-4000-8000-000000000004',
      field: 'reason',
    });
    const replacementEnvelope = encryptValue('different plaintext', {
      environment: 'test',
      table: 'excuse_letters',
      rowId: '00000000-0000-4000-8000-000000000004',
      field: 'reason',
    });
    const supabase = createMockSupabase(
      'excuse_letters',
      {
        id: '00000000-0000-4000-8000-000000000004',
        reason: 'same plaintext',
        reason_envelope: verifiedEnvelope,
      },
      (state) => { state.reason_envelope = replacementEnvelope; },
    );

    await assert.rejects(
      clearVerifiedPlaintext(
        supabase,
        { table: 'excuse_letters', idField: 'id' },
        supabase.state,
        { name: 'reason', envelope: 'reason_envelope' },
        'same plaintext',
        verifiedEnvelope,
        true,
      ),
      /ROW_CHANGED_BEFORE_PLAINTEXT_CLEAR/,
    );
    assert.equal(supabase.state.reason, 'same plaintext');
    assert.deepEqual(supabase.state.reason_envelope, replacementEnvelope);
    assert.equal(supabase.successfulUpdates, 0);
  });
});

test('blind-index compare-and-swap rejects a changed student number', async () => {
  await withTestConfiguration(async () => {
    const supabase = createMockSupabase(
      'profiles',
      {
        id: '00000000-0000-4000-8000-000000000005',
        student_number: 'OLD-001',
        student_number_index: null,
      },
      (state) => { state.student_number = 'NEW-002'; },
    );

    await assert.rejects(
      ensureStudentNumberIndex(supabase, { ...supabase.state }, false),
      /STUDENT_NUMBER_CHANGED_DURING_INDEXING/,
    );
    assert.equal(supabase.state.student_number, 'NEW-002');
    assert.equal(supabase.state.student_number_index, null);
    assert.equal(supabase.successfulUpdates, 0);
  });
});

test('blind-index writes bind the digest to the compared source number', async () => {
  await withTestConfiguration(async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000006',
      student_number: 'STUDENT-006',
      student_number_envelope: null,
      student_number_index: null,
    };
    const supabase = createMockSupabase('profiles', row);
    const result = await ensureStudentNumberIndex(supabase, row, false);

    assert.equal(result.verified, true);
    assert.equal(supabase.state.student_number_index, createStudentNumberIndex('STUDENT-006'));
    assert.equal(supabase.state.student_number, 'STUDENT-006');
  });
});

test('blind-index recovery decrypts an encrypted student number and compares its exact envelope', async () => {
  await withTestConfiguration(async () => {
    const id = '00000000-0000-4000-8000-000000000008';
    const envelope = encryptValue('STUDENT-008', {
      environment: 'test', table: 'profiles', rowId: id, field: 'student_number',
    });
    const row = { id, student_number: null, student_number_envelope: envelope, student_number_index: null };
    const supabase = createMockSupabase('profiles', row);
    const readiness = {
      validEncryptedStudentNumbers: 0, validBlindIndexes: 0,
      missingBlindIndexes: 0, inconsistentBlindIndexes: 0,
      missingStudentNumbers: 0, invalidOrUndecryptableEnvelopes: 0, requiringRetry: 0,
    };
    const result = await ensureStudentNumberIndex(supabase, row, false, readiness);
    assert.equal(result.verified, true);
    assert.equal(supabase.state.student_number, null);
    assert.equal(supabase.state.student_number_index, createStudentNumberIndex('STUDENT-008'));
    assert.equal(readiness.validEncryptedStudentNumbers, 1);
    assert.equal(readiness.validBlindIndexes, 1);
    assert.equal(readiness.missingBlindIndexes, 0);
  });
});

test('blind-index recovery verifies existing indexes and rejects inconsistent or invalid envelopes', async () => {
  await withTestConfiguration(async () => {
    const id = '00000000-0000-4000-8000-000000000009';
    const context = { environment: 'test', table: 'profiles', rowId: id, field: 'student_number' };
    const envelope = encryptValue('STUDENT-009', context);
    const correct = {
      id, student_number: null, student_number_envelope: envelope,
      student_number_index: createStudentNumberIndex('STUDENT-009'),
    };
    const readiness = {
      validEncryptedStudentNumbers: 0, validBlindIndexes: 0,
      missingBlindIndexes: 0, inconsistentBlindIndexes: 0,
      missingStudentNumbers: 0, invalidOrUndecryptableEnvelopes: 0, requiringRetry: 0,
    };
    assert.equal((await ensureStudentNumberIndex(createMockSupabase('profiles', correct), correct, true, readiness)).verified, true);
    const wrong = { ...correct, student_number_index: 'f'.repeat(64) };
    await assert.rejects(ensureStudentNumberIndex(createMockSupabase('profiles', wrong), wrong, true, readiness), /STUDENT_NUMBER_INDEX_MISMATCH/);
    const invalid = { ...correct, student_number_index: null, student_number_envelope: { ...envelope, tag: 'AAAA' } };
    await assert.rejects(ensureStudentNumberIndex(createMockSupabase('profiles', invalid), invalid, false, readiness));
    assert.equal(readiness.invalidOrUndecryptableEnvelopes, 1);
    const invalidBesidePlaintext = {
      ...invalid,
      student_number: 'STUDENT-009',
    };
    await assert.rejects(
      ensureStudentNumberIndex(createMockSupabase('profiles', invalidBesidePlaintext), invalidBesidePlaintext, false, readiness),
    );
    assert.equal(readiness.invalidOrUndecryptableEnvelopes, 2);
  });
});

test('missing number is reported and dry-run does not write a recovered index', async () => {
  await withTestConfiguration(async () => {
    const id = '00000000-0000-4000-8000-000000000010';
    const empty = { id, student_number: null, student_number_envelope: null, student_number_index: null };
    const readiness = {
      validEncryptedStudentNumbers: 0, validBlindIndexes: 0,
      missingBlindIndexes: 0, inconsistentBlindIndexes: 0,
      missingStudentNumbers: 0, invalidOrUndecryptableEnvelopes: 0, requiringRetry: 0,
    };
    assert.equal((await ensureStudentNumberIndex(createMockSupabase('profiles', empty), empty, true, readiness)).missing, true);
    assert.equal(readiness.missingStudentNumbers, 1);

    const envelope = encryptValue('STUDENT-010', {
      environment: 'test', table: 'profiles', rowId: id, field: 'student_number',
    });
    const encrypted = { ...empty, student_number_envelope: envelope };
    const supabase = createMockSupabase('profiles', encrypted);
    const result = await ensureStudentNumberIndex(supabase, encrypted, true, readiness);
    assert.equal(result.needsWrite, true);
    assert.equal(supabase.updateAttempts, 0);
  });
});

test('blind-index CAS rejects concurrent changes to either source value', async () => {
  await withTestConfiguration(async () => {
    const id = '00000000-0000-4000-8000-000000000011';
    const envelope = encryptValue('STUDENT-011', {
      environment: 'test', table: 'profiles', rowId: id, field: 'student_number',
    });
    for (const [source, row, mutate] of [
      ['envelope', { id, student_number: null, student_number_envelope: envelope, student_number_index: null }, (state) => { state.student_number_envelope = encryptValue('CHANGED', { environment: 'test', table: 'profiles', rowId: id, field: 'student_number' }); }],
      ['plaintext', { id, student_number: 'STUDENT-011', student_number_envelope: null, student_number_index: null }, (state) => { state.student_number = 'CHANGED'; }],
      ['plaintext-with-envelope', { id, student_number: 'STUDENT-011', student_number_envelope: envelope, student_number_index: null }, (state) => { state.student_number_envelope = encryptValue('CHANGED', { environment: 'test', table: 'profiles', rowId: id, field: 'student_number' }); }],
    ]) {
      const supabase = createMockSupabase('profiles', row, mutate);
      await assert.rejects(ensureStudentNumberIndex(supabase, row, false), /STUDENT_NUMBER_CHANGED_DURING_INDEXING/);
      assert.equal(supabase.state.student_number_index, null, source);
    }
  });
});

test('profile reads retain plaintext and plaintext clearing remains explicit in backfill', async () => {
  const api = await readFile(new URL('../api/secure-data.js', import.meta.url), 'utf8');
  const backfill = await readFile(new URL('../scripts/backfill-encrypted-data.js', import.meta.url), 'utf8');
  const profileAction = api.slice(api.indexOf("if (action === 'profile')"), api.indexOf("if (action === 'student-letters')"));
  assert.doesNotMatch(profileAction, /\.update\(\{\s*(?:full_name|student_number|program):\s*null/);
  assert.ok(profileAction.indexOf('decryptProfile(profile)') < profileAction.indexOf('encryptText('));
  assert.match(profileAction, /encryptionMode === 'legacy'/);
  assert.match(backfill, /if \(!shouldClear \|\| plaintext === null/);
  assert.match(backfill, /--clear-plaintext/);
});

test('profile decryption enforces strict and legacy mode expectations', async () => {
  await withTestConfiguration(() => {
    const id = '00000000-0000-4000-8000-000000000013';
    const base = {
      id, role: 'student', program_id: 'program-1',
      full_name: 'Plain name', full_name_envelope: null,
      student_number: null, student_number_envelope: null,
      program: null, program_envelope: null,
    };
    assert.throws(
      () => decryptProfile(base),
      (error) => error instanceof ApiError && error.status === 503,
    );

    const valid = {
      ...base,
      full_name: null,
      full_name_envelope: encryptValue('Encrypted name', {
        environment: 'test', table: 'profiles', rowId: id, field: 'full_name',
      }),
    };
    assert.equal(decryptProfile(valid).full_name, 'Encrypted name');
    const invalid = {
      ...valid,
      full_name_envelope: { ...valid.full_name_envelope, tag: 'A'.repeat(22) },
    };
    assert.throws(() => decryptProfile(invalid), EncryptionError);
  }, 'strict');

  await withTestConfiguration(() => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000014',
      role: 'student', program_id: 'program-1',
      full_name: 'Legacy name', full_name_envelope: null,
      student_number: null, student_number_envelope: null,
      program: null, program_envelope: null,
    };
    assert.equal(decryptProfile(profile).full_name, 'Legacy name');
  }, 'legacy');
});

test('verified plaintext retirement remains available only when explicitly requested', async () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000012',
    reason: 'verified text',
    reason_envelope: { formatVersion: 1 },
  };
  const supabase = createMockSupabase('excuse_letters', row);
  await clearVerifiedPlaintext(
    supabase,
    { table: 'excuse_letters', idField: 'id' },
    row,
    { name: 'reason', envelope: 'reason_envelope' },
    row.reason,
    row.reason_envelope,
    true,
  );
  assert.equal(supabase.state.reason, null);
});

test('strict-mode readiness fails when a required blind index is missing or inconsistent', () => {
  const readiness = {
    missingBlindIndexes: 0,
    inconsistentBlindIndexes: 0,
    invalidOrUndecryptableEnvelopes: 0,
    requiringRetry: 0,
  };
  assert.equal(isStudentNumberReadinessComplete(readiness), true);
  assert.equal(isStudentNumberReadinessComplete({ ...readiness, missingBlindIndexes: 1 }), false);
  assert.equal(isStudentNumberReadinessComplete({ ...readiness, inconsistentBlindIndexes: 1 }), false);
});

test('strict-mode readiness requires a full run and all encryption/index work completed', () => {
  const readiness = {
    field: 'student_number_readiness',
    missingBlindIndexes: 0,
    inconsistentBlindIndexes: 0,
    invalidOrUndecryptableEnvelopes: 0,
    requiringRetry: 0,
  };
  const results = new Map([
    ['profiles.student_number_readiness', readiness],
    ['profiles.full_name', {
      field: 'full_name', failed: 0, blindIndexNeedsWrite: 0,
      needsEncryption: 1, encrypted: 0,
    }],
  ]);
  assert.equal(isStrictModeReady(results, { dryRun: true, allRows: true }), false);
  assert.equal(isStrictModeReady(results, { dryRun: false, allRows: false }), false);
  results.get('profiles.full_name').encrypted = 1;
  assert.equal(isStrictModeReady(results, { dryRun: false, allRows: true }), true);
  results.get('profiles.student_number_readiness').missingBlindIndexes = 1;
  assert.equal(isStrictModeReady(results, { dryRun: false, allRows: true }), false);
});

test('installed PostgREST client serializes JSONB equality as exact JSON text', async () => {
  const envelope = {
    formatVersion: 1,
    kekVersion: 1,
    plaintextType: 'string',
    ciphertext: 'abc_123',
    iv: '0123456789abcdef',
    tag: '0123456789abcdefghijkl',
    wrappedDek: '0123456789abcdefghijklmnopqrstuvwxy01234567890',
    dekWrapIv: 'fedcba9876543210',
    dekWrapTag: 'abcdefghijklmnopqrstuv',
  };
  let requestUrl;
  const client = createClient('https://example.supabase.co', 'test-publishable-key', {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        requestUrl = new URL(String(input));
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' },
        });
      },
    },
  });
  await client.from('profiles')
    .update({ student_number_index: 'a'.repeat(64) })
    .eq('student_number', 'STUDENT-TEST')
    .eq('student_number_envelope', JSON.stringify(envelope))
    .eq('reason_envelope', JSON.stringify(envelope))
    .select('id');

  assert.equal(
    requestUrl.searchParams.get('student_number_envelope'),
    `eq.${JSON.stringify(envelope)}`,
  );
  assert.notEqual(requestUrl.searchParams.get('student_number_envelope'), 'eq.[object Object]');
  assert.equal(requestUrl.searchParams.get('reason_envelope'), `eq.${JSON.stringify(envelope)}`);
});
