import { timingSafeEqual } from 'node:crypto';
import { createServiceSupabaseClient } from './_lib/create-service-supabase-client.js';
import nodemailer from 'nodemailer';

// Scheduled job: claim each eligible Dean's daily digest, send it, then record the outcome.
const response = (res, status, body) => res.status(status).json(body);

// Compare equal-length secret bytes with a timing-safe primitive.
function isAuthorized(req, cronSecret) {
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer ([^\s]+)$/i)
    : null;
  if (!match || match[0] !== authorization) return false;
  const provided = match[1];

  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(cronSecret);
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

// Use the University timezone so the database's per-day deduplication key matches the email schedule.
function getManilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Reject non-HTTPS production URLs before placing them in notification email content.
function getAppOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('APP_URL must use HTTPS.');
  }
  return url.origin;
}

// Keep provider error text out of logs and database notification records.
function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z0-9_-]{1,32}$/i.test(code) ? code : 'UNKNOWN';
}

// Nodemailer handles the SMTP connection; credentials are read only on the server.
function createTransporter(gmailUser, gmailAppPassword) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailAppPassword.replace(/\s/g, '') },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });
}

// Send a count-only reminder; the digest does not include letter reasons or decision remarks.
async function sendDigest(transporter, recipient, pendingCount, deanPortalUrl) {
  const pendingText = pendingCount === 0
    ? 'No letters are awaiting your review right now.'
    : `You currently have ${pendingCount} pending excuse letter${pendingCount === 1 ? '' : 's'} awaiting your review.`;
  const reviewPrompt = pendingCount === 0
    ? 'Please check the Dean dashboard for updates.'
    : 'Please log in to Securitres to review and process your pending submissions.';
  const callToAction = pendingCount === 0
    ? 'Open Dean dashboard'
    : 'View pending excuse letters';

  await transporter.sendMail({
    from: `Securitres Notification System <${process.env.GMAIL_USER}>`,
    to: recipient,
    subject: 'Securitres - Daily Pending Excuse Letters Reminder',
    text: [
      'Good day, Dean!',
      '',
      'This is your daily reminder from Securitres.',
      '',
      pendingText,
      '',
      reviewPrompt,
      deanPortalUrl,
      '',
      'Thank you!',
      'Securitres Notification System',
      'University of the Assumption',
    ].join('\n'),
    html: `
      <!doctype html>
      <html lang="en">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0;padding:24px;background:#f4f5ef;font-family:Arial,sans-serif;color:#192720">
          <main style="max-width:560px;margin:0 auto;padding:32px 28px;background:#ffffff;border:1px solid #e2e7df;border-radius:10px">
            <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#123c7a">Securitres · University of the Assumption</div>
            <h1 style="margin:22px 0 12px;font-size:24px;color:#08285f">Daily pending letter reminder</h1>
            <p style="font-size:16px;line-height:1.6">Good day, Dean!</p>
            <p style="font-size:15px;line-height:1.6">This is your daily reminder from Securitres.</p>
            <p style="margin:24px 0;padding:18px;background:#e4ebf7;border-radius:8px;font-size:18px;line-height:1.5">${pendingText}</p>
            <p style="font-size:14px;line-height:1.6">${reviewPrompt}</p>
            <p style="margin:28px 0">
              <a href="${deanPortalUrl}" style="display:inline-block;padding:13px 20px;border-radius:6px;background:#123c7a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">${callToAction}</a>
            </p>
            <p style="font-size:14px;line-height:1.6">Thank you!</p>
            <p style="margin:24px 0 0;color:#68756d;font-size:12px;line-height:1.6">Securitres Notification System<br>University of the Assumption</p>
          </main>
        </body>
      </html>
    `,
  });
}

// The claim token prevents a stale worker from overwriting a newer retry's result.
async function finishClaim(supabase, claim, digestDate, status, errorMessage) {
  try {
    const { data: recorded, error } = await supabase.rpc('finish_dean_daily_digest', {
      p_dean_id: claim.dean_id,
      p_digest_date: digestDate,
      p_claim_token: claim.claim_token,
      p_status: status,
      p_error_message: errorMessage,
    });
    if (error || !recorded) {
      console.error(`Could not record a ${status} Dean digest delivery.`, { code: error?.code });
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Could not record a ${status} Dean digest delivery.`, { code: safeErrorCode(error) });
    return false;
  }
}

// Vercel invokes this endpoint on its configured cron schedule.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return response(res, 405, { error: 'Method not allowed.' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.length < 32) {
    console.error('Daily Dean digest CRON_SECRET is missing or too short.');
    return response(res, 503, { error: 'Daily digest authorization is not configured.' });
  }
  if (!isAuthorized(req, cronSecret)) {
    return response(res, 401, { error: 'Unauthorized.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const appUrlSetting = process.env.APP_URL;
  if (!supabaseUrl || !serviceRoleKey
      || !gmailUser || !gmailAppPassword || !appUrlSetting) {
    console.error('Daily Dean digest is missing required server environment configuration.');
    return response(res, 503, { error: 'Daily digest delivery is not configured.' });
  }

  let deanPortalUrl;
  try {
    deanPortalUrl = new URL('/dean', getAppOrigin(appUrlSetting)).toString();
  } catch {
    return response(res, 503, { error: 'The application URL is invalid.' });
  }

  const digestDate = getManilaDate();
  const supabase = createServiceSupabaseClient(supabaseUrl, serviceRoleKey);
  let claimResult;
  try {
    claimResult = await supabase.rpc('claim_dean_daily_digests', {
      p_digest_date: digestDate,
    });
  } catch (error) {
    console.error('Could not claim the daily Dean digest deliveries.', { code: safeErrorCode(error) });
    return response(res, 500, { error: 'Could not prepare daily digest delivery.' });
  }
  const { data: claims, error: claimError } = claimResult;
  if (claimError) {
    console.error('Could not claim the daily Dean digest deliveries.', { code: safeErrorCode(claimError) });
    return response(res, 500, { error: 'Could not prepare daily digest delivery.' });
  }

  if (!claims?.length) {
    console.info('Daily Dean digest found no claimable deliveries.');
    return response(res, 200, { digestDate, sent: 0, failed: 0 });
  }

  const transporter = createTransporter(gmailUser, gmailAppPassword);
  let sent = 0;
  let failed = 0;

  for (const claim of claims) {
    try {
      await sendDigest(transporter, claim.dean_email, claim.pending_count, deanPortalUrl);
    } catch (error) {
      failed += 1;
      const errorCode = safeErrorCode(error);
      console.error('Daily Dean digest email delivery failed.', { code: errorCode });
      await finishClaim(supabase, claim, digestDate, 'failed', `Email delivery failed (${errorCode}).`);
      continue;
    }

    if (!await finishClaim(supabase, claim, digestDate, 'sent', null)) {
      failed += 1;
      console.error('Email was accepted, but its Dean digest delivery log could not be completed.', {
        code: 'DELIVERY_LOG',
      });
      continue;
    }
    sent += 1;
  }

  transporter.close();
  return response(res, failed ? 500 : 200, {
    digestDate,
    sent,
    failed,
  });
}
