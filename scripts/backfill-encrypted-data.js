import { createServiceSupabaseClient } from '../api/_lib/create-service-supabase-client.js';
import { decryptValue, encryptValue } from '../api/_lib/encryption.js';
import { createStudentNumberIndex } from '../api/_lib/student-number-index.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pageSize = 250;
const environment = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';
const requiredConfirmation = '--confirm-encryption-backfill';
const maxRows = readLimit();
const allRows = process.argv.includes('--all');
const clearPlaintext = process.argv.includes('--clear-plaintext');
const dryRun = process.argv.includes('--dry-run');

function readLimit() {
  const argument = process.argv.find((value) => value.startsWith('--limit='));
  if (!argument) return null;
  const value = Number(argument.slice('--limit='.length));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('--limit must be a positive integer.');
  }
  return value;
}

function validateRun() {
  if (!process.argv.includes(requiredConfirmation)) {
    throw new Error(`Pass ${requiredConfirmation} to run this backfill.`);
  }
  if (maxRows && allRows) throw new Error('Use either --limit or --all, not both.');
  if (!maxRows && !allRows) throw new Error('Pass --limit=<rows> for a bounded run, or --all for a complete run.');
  if (dryRun && clearPlaintext) throw new Error('--dry-run cannot be combined with --clear-plaintext.');
  if (environment === 'production' && !process.argv.includes('--allow-production')) {
    throw new Error('Production requires the explicit --allow-production flag after approval.');
  }
}

function getEncryptionContext(table, rowId, field) {
  return {
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    table,
    rowId,
    field,
  };
}

function getSpecs() {
  return [
    {
      table: 'profiles',
      idField: 'id',
      fields: [
        { name: 'full_name', envelope: 'full_name_envelope' },
        { name: 'student_number', envelope: 'student_number_envelope' },
        { name: 'program', envelope: 'program_envelope' },
      ],
      extraFields: ['student_number_index'],
    },
    {
      table: 'excuse_letters',
      idField: 'id',
      fields: [
        { name: 'absence_start', envelope: 'absence_start_envelope' },
        { name: 'absence_end', envelope: 'absence_end_envelope' },
        { name: 'reason', envelope: 'reason_envelope' },
        { name: 'dean_comment', envelope: 'dean_comment_envelope' },
      ],
      extraFields: [],
    },
    {
      table: 'letter_status_events',
      idField: 'id',
      fields: [{ name: 'comment', envelope: 'comment_envelope' }],
      extraFields: [],
    },
    {
      table: 'excuse_letter_contacts',
      idField: 'letter_id',
      fields: [{ name: 'parent_guardian_phone', envelope: 'parent_guardian_phone_envelope' }],
      extraFields: [],
    },
    {
      table: 'excuse_evidence',
      idField: 'id',
      fields: [{ name: 'original_filename', envelope: 'original_filename_envelope' }],
      extraFields: [],
    },
  ];
}

function resultFor(table, field) {
  return {
    table,
    field,
    needsEncryption: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    skippedNull: 0,
    blindIndexNeedsWrite: 0,
    failed: 0,
  };
}

function verifyEnvelope(envelope, plaintext, table, rowId, field) {
  const decrypted = decryptValue(envelope, getEncryptionContext(table, rowId, field));
  if (plaintext !== null && decrypted !== plaintext) {
    throw new Error('DECRYPT_VERIFICATION_MISMATCH');
  }
}

export async function updateEnvelope(supabase, spec, row, field, envelope) {
  const { data: savedRows, error } = await supabase
    .from(spec.table)
    .update({ [field.envelope]: envelope })
    .eq(spec.idField, row[spec.idField])
    .eq(field.name, row[field.name])
    .is(field.envelope, null)
    .select(`${spec.idField}, ${field.name}, ${field.envelope}`);
  if (error) throw error;

  const saved = savedRows?.[0];
  if (!saved) throw new Error('ROW_CHANGED_DURING_ENCRYPTION');
  if (saved[field.name] !== row[field.name]) throw new Error('PLAINTEXT_CHANGED_DURING_ENCRYPTION');
  if (!saved[field.envelope]) throw new Error('ENVELOPE_WRITE_NOT_CONFIRMED');
  verifyEnvelope(saved[field.envelope], saved[field.name], spec.table, row[spec.idField], field.name);
  return saved[field.envelope];
}

export async function clearVerifiedPlaintext(
  supabase,
  spec,
  row,
  field,
  plaintext,
  verifiedEnvelope,
  shouldClear = clearPlaintext,
) {
  if (!shouldClear || plaintext === null || plaintext === undefined) return;
  if (!verifiedEnvelope) throw new Error('VERIFIED_ENVELOPE_REQUIRED_FOR_CLEAR');
  const { data, error } = await supabase
    .from(spec.table)
    .update({ [field.name]: null })
    .eq(spec.idField, row[spec.idField])
    .eq(field.name, plaintext)
    .eq(field.envelope, JSON.stringify(verifiedEnvelope))
    .select(spec.idField);
  if (error) throw error;
  if (!data?.length) throw new Error('ROW_CHANGED_BEFORE_PLAINTEXT_CLEAR');
}

export function isStudentNumberReadinessComplete(readiness) {
  return readiness.missingBlindIndexes === 0
    && readiness.inconsistentBlindIndexes === 0
    && readiness.invalidOrUndecryptableEnvelopes === 0
    && readiness.requiringRetry === 0;
}

export function isStrictModeReady(results, { dryRun: simulated, allRows: fullRun }) {
  if (!fullRun) return false;
  for (const result of results.values()) {
    if (result.field === 'student_number_readiness') continue;
    if (result.failed || result.blindIndexNeedsWrite) return false;
    if (simulated ? result.needsEncryption !== 0 : result.encrypted !== result.needsEncryption) {
      return false;
    }
  }
  return isStudentNumberReadinessComplete(results.get('profiles.student_number_readiness'));
}

export async function ensureStudentNumberIndex(supabase, row, simulate = dryRun, readiness) {
  const hasPlaintext = row.student_number !== null && row.student_number !== undefined;
  let envelopeStudentNumber = null;
  if (row.student_number_envelope) {
    try {
      envelopeStudentNumber = decryptValue(
        row.student_number_envelope,
        getEncryptionContext('profiles', row.id, 'student_number'),
      );
      if (readiness) readiness.validEncryptedStudentNumbers += 1;
    } catch (error) {
      if (readiness) readiness.invalidOrUndecryptableEnvelopes += 1;
      throw error;
    }
  }
  const source = hasPlaintext ? 'plaintext' : 'envelope';
  let studentNumber = hasPlaintext ? row.student_number : envelopeStudentNumber;
  if (hasPlaintext && envelopeStudentNumber !== null && envelopeStudentNumber !== studentNumber) {
    if (readiness) readiness.invalidOrUndecryptableEnvelopes += 1;
    throw new Error('STUDENT_NUMBER_ENVELOPE_MISMATCH');
  }
  if (studentNumber === null || studentNumber === undefined) {
    if (readiness) readiness.missingStudentNumbers += 1;
    if (row.student_number_index) {
      if (readiness) readiness.inconsistentBlindIndexes += 1;
      throw new Error('STUDENT_NUMBER_INDEX_WITHOUT_NUMBER');
    }
    return { verified: true, needsWrite: false, missing: true };
  }

  const index = createStudentNumberIndex(studentNumber);
  if (row.student_number_index) {
    if (row.student_number_index !== index) throw new Error('STUDENT_NUMBER_INDEX_MISMATCH');
    if (readiness) readiness.validBlindIndexes += 1;
    return { verified: true, needsWrite: false };
  }
  if (readiness) readiness.missingBlindIndexes += 1;
  if (simulate) return { verified: false, needsWrite: true };

  let query = supabase.from('profiles')
    .update({ student_number_index: index })
    .eq('id', row.id)
    .is('student_number_index', null);
  if (source === 'plaintext') {
    query = query.eq('student_number', row.student_number);
    query = row.student_number_envelope
      ? query.eq('student_number_envelope', JSON.stringify(row.student_number_envelope))
      : query.is('student_number_envelope', null);
  } else {
    query = query.eq('student_number_envelope', JSON.stringify(row.student_number_envelope));
  }
  const { data, error } = await query
    .select('id, student_number, student_number_envelope, student_number_index');
  if (error) throw error;
  const saved = data?.[0];
  if (!saved) throw new Error('STUDENT_NUMBER_CHANGED_DURING_INDEXING');
  if ((source === 'plaintext' && saved.student_number !== studentNumber)
      || (source === 'envelope'
        && JSON.stringify(saved.student_number_envelope) !== JSON.stringify(row.student_number_envelope))
      || saved.student_number_index !== index) {
    throw new Error('STUDENT_NUMBER_INDEX_NOT_CONFIRMED');
  }
  const verifiedNumber = saved.student_number !== null
    ? saved.student_number
    : decryptValue(saved.student_number_envelope, getEncryptionContext('profiles', row.id, 'student_number'));
  if (createStudentNumberIndex(verifiedNumber) !== saved.student_number_index) {
    throw new Error('STUDENT_NUMBER_INDEX_NOT_CONFIRMED');
  }
  if (readiness) readiness.validBlindIndexes += 1;
  if (readiness) readiness.missingBlindIndexes -= 1;
  return { verified: true, needsWrite: false };
}

export async function processRow(supabase, spec, row, results, options = {}) {
  const simulate = options.dryRun ?? dryRun;
  const clear = options.clearPlaintext ?? clearPlaintext;
  let studentNumberIndexVerified = false;
  if (spec.table === 'profiles') {
    const readiness = results.get('profiles.student_number_readiness');
    try {
      const indexResult = await ensureStudentNumberIndex(supabase, row, simulate, readiness);
      studentNumberIndexVerified = indexResult.verified && !indexResult.missing;
      if (indexResult.needsWrite) results.get('profiles.student_number').blindIndexNeedsWrite += 1;
    } catch (error) {
      const result = results.get('profiles.student_number');
      result.failed += 1;
      if (error?.message === 'STUDENT_NUMBER_INDEX_MISMATCH') readiness.inconsistentBlindIndexes += 1;
      else if (error?.message?.includes('CHANGED_DURING_INDEXING')
        || error?.message === 'STUDENT_NUMBER_INDEX_NOT_CONFIRMED') readiness.requiringRetry += 1;
      console.error('Backfill failure: profiles.student_number_index.', {
        code: error?.code || error?.name || 'UNKNOWN',
      });
    }
  }

  for (const field of spec.fields) {
    const result = results.get(`${spec.table}.${field.name}`);
    const plaintext = row[field.name];
    const existingEnvelope = row[field.envelope];
    try {
      if (existingEnvelope) {
        verifyEnvelope(existingEnvelope, plaintext, spec.table, row[spec.idField], field.name);
        if (!simulate
            && (field.name !== 'student_number' || studentNumberIndexVerified || plaintext === null)) {
          await clearVerifiedPlaintext(
            supabase,
            spec,
            row,
            field,
            plaintext,
            existingEnvelope,
            clear,
          );
        }
        result.alreadyEncrypted += 1;
        continue;
      }
      if (plaintext === null || plaintext === undefined) {
        result.skippedNull += 1;
        continue;
      }
      result.needsEncryption += 1;
      if (simulate) continue;

      const envelope = encryptValue(
        plaintext,
        getEncryptionContext(spec.table, row[spec.idField], field.name),
      );
      verifyEnvelope(envelope, plaintext, spec.table, row[spec.idField], field.name);
      const verifiedEnvelope = await updateEnvelope(supabase, spec, row, field, envelope);
      if (spec.table === 'profiles' && field.name === 'student_number') {
        results.get('profiles.student_number_readiness').validEncryptedStudentNumbers += 1;
      }
      if (field.name !== 'student_number' || studentNumberIndexVerified) {
        await clearVerifiedPlaintext(
          supabase,
          spec,
          row,
          field,
          plaintext,
          verifiedEnvelope,
          clear,
        );
      }
      result.encrypted += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`Backfill failure: ${spec.table}.${field.name}.`, {
        code: error?.code || error?.name || 'UNKNOWN',
      });
    }
  }
}

export async function processTable(supabase, spec, results, options = {}) {
  const fields = [spec.idField, ...spec.extraFields];
  for (const field of spec.fields) fields.push(field.name, field.envelope);
  let processed = 0;
  for (let from = 0; ; from += pageSize) {
    const remaining = maxRows ? maxRows - processed : pageSize;
    if (remaining <= 0) break;
    const to = from + Math.min(pageSize, remaining) - 1;
    const { data, error } = await supabase
      .from(spec.table)
      .select([...new Set(fields)].join(','))
      .order(spec.idField, { ascending: true })
      .range(from, to);
    if (error) throw error;
    for (const row of data || []) await processRow(supabase, spec, row, results, options);
    processed += (data || []).length;
    if (!data || data.length < Math.min(pageSize, remaining)) break;
  }
}

async function main() {
  validateRun();
  const probeContext = getEncryptionContext(
    'profiles',
    '00000000-0000-4000-8000-000000000000',
    'full_name',
  );
  const probeEnvelope = encryptValue('configuration-check', probeContext);
  if (decryptValue(probeEnvelope, probeContext) !== 'configuration-check') {
    throw new Error('ENCRYPTION_CONFIGURATION_VERIFICATION_FAILED');
  }
  createStudentNumberIndex('configuration-check');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in the server environment.');
  }

  const supabase = createServiceSupabaseClient(supabaseUrl, serviceRoleKey);
  const specs = getSpecs();
  const results = new Map();
  for (const spec of specs) {
    for (const field of spec.fields) {
      results.set(`${spec.table}.${field.name}`, resultFor(spec.table, field.name));
    }
  }
  results.set('profiles.student_number_readiness', {
    table: 'profiles', field: 'student_number_readiness',
    validEncryptedStudentNumbers: 0, validBlindIndexes: 0,
    missingBlindIndexes: 0, inconsistentBlindIndexes: 0,
    missingStudentNumbers: 0, invalidOrUndecryptableEnvelopes: 0,
    requiringRetry: 0,
  });

  for (const spec of specs) {
    await processTable(supabase, spec, results, { dryRun, clearPlaintext });
  }

  let failures = 0;
  for (const result of results.values()) {
    failures += result.failed || result.missingBlindIndexes || result.inconsistentBlindIndexes
      || result.invalidOrUndecryptableEnvelopes || result.requiringRetry || 0;
    console.log(JSON.stringify(result));
  }
  console.log(JSON.stringify({
    complete: failures === 0
      && isStudentNumberReadinessComplete(results.get('profiles.student_number_readiness')),
    strictModeReady: failures === 0 && isStrictModeReady(results, { dryRun, allRows }),
    mode: dryRun ? 'dry-run' : 'write',
    environment,
    failures,
  }));
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('Encrypted-data backfill stopped.', { code: error?.code || error?.name || 'UNKNOWN' });
    process.exitCode = 1;
  });
}
