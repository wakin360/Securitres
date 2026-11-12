import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);
const [vercelConfig, digestApi, initialMigration, followupMigration, readme] = await Promise.all([
  readFile(new URL('vercel.json', projectRoot), 'utf8').then(JSON.parse),
  readFile(new URL('api/send-dean-daily-digest.js', projectRoot), 'utf8'),
  readFile(new URL('supabase/migrations/20261109000000_dean_daily_pending_digest.sql', projectRoot), 'utf8'),
  readFile(new URL('supabase/migrations/20261112100000_send_daily_dean_reminder_without_pending_letters.sql', projectRoot), 'utf8'),
  readFile(new URL('README.md', projectRoot), 'utf8'),
]);

test('daily cron targets the digest endpoint at midnight UTC, which is 8 a.m. in Manila', () => {
  const digestCron = vercelConfig.crons.find(({ path }) => path === '/api/send-dean-daily-digest');
  assert.equal(digestCron?.schedule, '0 0 * * *');
  assert.equal(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date('2026-11-12T00:00:00Z')), '08');
  assert.match(readme, /Hobby plans allow daily cron jobs but may run them with up to 59 minutes of timing variance/);
});

test('cron endpoint requires a long secret and accepts only its Bearer authorization header', () => {
  assert.match(digestApi, /process\.env\.CRON_SECRET/);
  assert.match(digestApi, /cronSecret\.length < 32/);
  assert.match(digestApi, /authorization\.match\(\/\^Bearer \(\[\^\\s\]\+\)\$\/i\)/);
  assert.match(digestApi, /match\[0\] !== authorization/);
  assert.match(digestApi, /if \(!isAuthorized\(req, cronSecret\)\)/);
  assert.match(digestApi, /catch \(error\) \{\s+console\.error\('Could not claim the daily Dean digest deliveries\.', \{ code: safeErrorCode\(error\) \}\)/);
});

test('follow-up claim includes eligible Deans with zero pending letters', () => {
  assert.match(followupMigration, /CHECK \(pending_count >= 0\)/);
  assert.match(followupMigration, /LEFT JOIN public\.profiles AS student/);
  assert.match(followupMigration, /LEFT JOIN public\.excuse_letters AS letter/);
  assert.match(followupMigration, /count\(DISTINCT letter\.id\)::integer AS pending_count/);
  assert.match(digestApi, /pendingCount === 0/);
  assert.match(digestApi, /Please check the Dean dashboard for updates\./);
});

test('Dean eligibility requires a confirmed Auth email and a current assignment to an active program', () => {
  for (const migration of [initialMigration, followupMigration]) {
    assert.match(migration, /auth_user\.email_confirmed_at IS NOT NULL/);
    assert.match(migration, /auth_user\.email IS NOT NULL/);
    assert.match(migration, /assignment\.revoked_at IS NULL/);
    assert.match(migration, /program\.is_active IS TRUE/);
    assert.match(migration, /WHERE dean\.role = 'dean'/);
  }
});

test('digest obtains recipient emails from Auth and keeps one daily claim per Dean', () => {
  assert.match(followupMigration, /auth_user\.email::text AS dean_email/);
  assert.match(initialMigration, /UNIQUE \(dean_id, digest_date\)/);
  assert.match(followupMigration, /ON CONFLICT \(dean_id, digest_date\) DO UPDATE/);
  assert.match(followupMigration, /existing\.status = 'failed'/);
  assert.match(followupMigration, /existing\.status = 'sending'/);
  assert.doesNotMatch(followupMigration, /existing\.status = 'sent'[\s\S]*?OR/);
});

test('finish RPC only completes the matching active claim and remains service-role only', () => {
  assert.match(initialMigration, /AND log\.status = 'sending'/);
  assert.match(initialMigration, /AND log\.claim_token = p_claim_token/);
  assert.match(initialMigration, /GRANT EXECUTE ON FUNCTION public\.finish_dean_daily_digest[\s\S]*TO service_role/);
});

test('endpoint requires all server email and Supabase settings before processing claims', () => {
  for (const setting of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GMAIL_USER',
    'GMAIL_APP_PASSWORD',
    'APP_URL',
  ]) {
    assert.ok(digestApi.includes(`process.env.${setting}`), `${setting} should be read server-side`);
  }
  assert.match(digestApi, /daily reminder from Securitres/);
  assert.match(digestApi, /View pending excuse letters/);
});

test('HTML email uses matching zero-pending and positive-pending wording and CTA', () => {
  assert.match(digestApi, /const pendingText = pendingCount === 0\s+\? 'No letters are awaiting your review right now\.'\s+: `You currently have \$\{pendingCount\} pending excuse letter\$\{pendingCount === 1 \? '' : 's'\} awaiting your review\.`;/);
  assert.match(digestApi, /<p style="margin:24px 0;padding:18px;background:#e4ebf7;border-radius:8px;font-size:18px;line-height:1\.5">\$\{pendingText\}<\/p>/);
  assert.match(digestApi, /const callToAction = pendingCount === 0\s+\? 'Open Dean dashboard'\s+: 'View pending excuse letters';/);
  assert.match(digestApi, /<a href="\$\{deanPortalUrl\}" style="display:inline-block;padding:13px 20px;border-radius:6px;background:#123c7a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">\$\{callToAction\}<\/a>/);
  assert.doesNotMatch(digestApi, /safeCount/);
});
