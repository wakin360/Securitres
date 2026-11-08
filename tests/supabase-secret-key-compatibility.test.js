import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServiceSupabaseClient } from '../api/_lib/create-service-supabase-client.js';

const digestApi = await readFile(new URL('../api/send-dean-daily-digest.js', import.meta.url), 'utf8');
const studentApi = await readFile(new URL('../api/notify-student-decision.js', import.meta.url), 'utf8');
const frontendClient = await readFile(new URL('../src/lib/supabase.js', import.meta.url), 'utf8');

test('secret-format key is passed directly as the API key without an Authorization header', async () => {
  const serviceKey = 'sb_secret_test-only-not-a-real-key';
  let capturedRequest;
  const mockFetch = async (input, init) => {
    capturedRequest = { input: String(input), headers: new Headers(init?.headers) };
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
    });
  };
  const supabase = createServiceSupabaseClient('https://example.invalid', serviceKey, mockFetch);

  await supabase.rpc('claim_dean_daily_digests', { p_digest_date: '2026-01-01' });

  assert.equal(capturedRequest.headers.get('apikey'), serviceKey);
  assert.equal(capturedRequest.headers.has('authorization'), false);
  assert.match(capturedRequest.input, /\/rest\/v1\/rpc\/claim_dean_daily_digests$/);
});

test('legacy service-role JWTs retain the SDK Authorization behavior', async () => {
  const legacyServiceKey = 'legacy-service-role-jwt';
  let capturedHeaders;
  const mockFetch = async (_input, init) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
    });
  };
  const supabase = createServiceSupabaseClient(
    'https://example.invalid',
    legacyServiceKey,
    mockFetch,
  );

  await supabase.rpc('claim_dean_daily_digests', { p_digest_date: '2026-01-01' });

  assert.equal(capturedHeaders.get('apikey'), legacyServiceKey);
  assert.equal(capturedHeaders.get('authorization'), `Bearer ${legacyServiceKey}`);
});

test('service clients disable session persistence and token refresh', () => {
  const mockFetch = async () => new Response('{}', { status: 200 });
  const supabase = createServiceSupabaseClient(
    'https://example.invalid',
    'sb_secret_test-only-not-a-real-key',
    mockFetch,
  );

  assert.equal(supabase.auth.persistSession, false);
  assert.equal(supabase.auth.autoRefreshToken, false);
});

test('both APIs retain their expected privileged RPC calls and authorization checks', () => {
  assert.match(digestApi, /createServiceSupabaseClient\(supabaseUrl, serviceRoleKey\)/);
  assert.match(digestApi, /isAuthorized\(req, cronSecret\)/);
  assert.match(digestApi, /claim_dean_daily_digests/);
  assert.match(digestApi, /finish_dean_daily_digest/);

  assert.match(studentApi, /createServiceSupabaseClient\(supabaseUrl, serviceRoleKey\)/);
  assert.match(studentApi, /userClient\.auth\.getUser\(accessToken\)/);
  assert.match(studentApi, /claim_student_decision_notification/);
  assert.match(studentApi, /finish_student_decision_notification/);
});

test('the publishable-key Dean session client remains separate from the service client', () => {
  assert.match(studentApi, /createClient\(supabaseUrl, publishableKey/);
  assert.match(studentApi, /global:\s*\{\s*headers:\s*\{\s*Authorization:/);
  assert.match(frontendClient, /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(frontendClient, /SUPABASE_SERVICE_ROLE_KEY|sb_secret_/);
});
