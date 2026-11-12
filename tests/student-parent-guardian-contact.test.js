import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, studentLetters, deanReview, migration] = await Promise.all([
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/studentLetters.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/services/deanReview.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261112180000_parent_guardian_contact.sql', import.meta.url), 'utf8'),
]);

test('student submission requires and persists a parent or guardian phone number', () => {
  assert.match(app, /name="parentGuardianPhone" type="tel"[^>]*required/);
  assert.match(app, /data\.get\('parentGuardianPhone'\)/);
  assert.match(app, /parentGuardianPhone,\s*enrolledCourses: studentCourses/);
  assert.match(studentLetters, /\.rpc\('create_student_excuse_letter'/);
  assert.match(studentLetters, /p_parent_guardian_phone: normalizedParentGuardianPhone/);
});

test('contact details are readable by the owner and authorized Dean only', () => {
  const selectPolicy = migration.match(/CREATE POLICY excuse_letter_contacts_select_owner_or_authorized_dean[\s\S]*?\n  \);/)?.[0];
  assert.ok(selectPolicy);
  assert.match(selectPolicy, /letter\.student_id = \(SELECT auth\.uid\(\)\)/i);
  assert.match(selectPolicy, /can_dean_access_letter/);
  assert.doesNotMatch(selectPolicy, /professor/i);
  assert.match(studentLetters, /contact:excuse_letter_contacts!excuse_letter_contacts_letter_id_fkey/);
  assert.match(deanReview, /contact:excuse_letter_contacts!excuse_letter_contacts_letter_id_fkey/);
});

test('letter and contact are created together through a guarded database function', () => {
  assert.match(migration, /CREATE FUNCTION public\.create_student_excuse_letter/);
  assert.match(migration, /INSERT INTO public\.excuse_letters/);
  assert.match(migration, /INSERT INTO public\.excuse_letter_contacts/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_student_excuse_letter[\s\S]*TO authenticated/);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/);
});

test('missing contact migration errors explain how to recover', () => {
  assert.match(app, /error\?\.code === 'PGRST202'[\s\S]*create_student_excuse_letter/);
  assert.match(app, /'PGRST200'[\s\S]*excuse_letter_contacts/);
  assert.match(app, /Apply migration 20261112180000_parent_guardian_contact\.sql, then retry\./);
});
