import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/migrations/20261110000000_student_decision_email_notifications.sql',
  import.meta.url,
);
const migration = (await readFile(migrationUrl, 'utf8')).replace(/\r\n/g, '\n');

const missingEmailBranch = migration.match(
  /IF v_email IS NULL OR NOT v_email_confirmed THEN([\s\S]*?)\n  END IF;\n\n  INSERT INTO public\.student_decision_notifications AS existing/,
)?.[1];
assert.ok(missingEmailBranch, 'missing/unconfirmed email branch should exist');

const conflictUpdate = missingEmailBranch.match(
  /ON CONFLICT \(letter_id, notification_type\) DO UPDATE([\s\S]*?)RETURNING existing\.status INTO v_existing_status;/,
)?.[1];
assert.ok(conflictUpdate, 'missing/unconfirmed branch should upsert its notification row');

test('recent failed SMTP record is updated to current missing/unconfirmed state without incrementing attempts', () => {
  assert.match(conflictUpdate, /SET student_id = EXCLUDED\.student_id/);
  assert.match(conflictUpdate, /status = 'failed'/);
  assert.match(conflictUpdate, /claim_token = NULL/);
  assert.match(conflictUpdate, /last_attempt_at = v_now/);
  assert.match(conflictUpdate, /sent_at = NULL/);
  assert.match(conflictUpdate, /error_code = EXCLUDED\.error_code/);
  assert.doesNotMatch(conflictUpdate, /attempt_count\s*=/);
  assert.match(conflictUpdate, /WHERE existing\.status = 'failed'\s+OR/);
  assert.doesNotMatch(conflictUpdate, /existing\.status = 'failed'\s+AND[\s\S]*?INTERVAL '5 minutes'/);
});

test('sent notification is not eligible for missing/unconfirmed update', () => {
  assert.doesNotMatch(conflictUpdate, /existing\.status = 'sent'/);
  assert.match(missingEmailBranch, /WHEN v_existing_status = 'sent' THEN 'already_sent'/);
});

test('active sending claim is preserved and expired sending claims can be cleared', () => {
  assert.match(conflictUpdate, /existing\.status = 'sending'\s+AND existing\.last_attempt_at <= v_now - INTERVAL '15 minutes'/);
  assert.match(missingEmailBranch, /WHEN v_existing_status = 'sending' THEN 'in_progress'/);
  assert.match(missingEmailBranch, /claim_token = NULL/);
});

test('actual email-send failures retain five-minute retry and 15-minute stale-claim limits', () => {
  const sendRetryUpsert = migration.match(
    /INSERT INTO public\.student_decision_notifications AS existing \([\s\S]*?ON CONFLICT \(letter_id, notification_type\) DO UPDATE([\s\S]*?)RETURNING existing\.claim_token INTO v_claim_token;/,
  )?.[1];
  assert.ok(sendRetryUpsert, 'email-send retry upsert should exist');
  assert.match(sendRetryUpsert, /existing\.status = 'failed'\s+AND existing\.last_attempt_at <= v_now - INTERVAL '5 minutes'/);
  assert.match(sendRetryUpsert, /existing\.status = 'sending'\s+AND existing\.last_attempt_at <= v_now - INTERVAL '15 minutes'/);
});
