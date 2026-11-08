import { createClient } from '@supabase/supabase-js';
import { createServiceSupabaseClient } from './_lib/create-service-supabase-client.js';
import nodemailer from 'nodemailer';

const letterIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(res, status, body) {
  return res.status(status).json(body);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'UNKNOWN';
}

function getAppOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('APP_URL must use HTTPS.');
  }
  return url.origin;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'Asia/Manila',
  }).format(new Date(value));
}

function createTransporter(gmailUser, gmailAppPassword) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailAppPassword.replace(/\s/g, '') },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });
}

async function sendDecisionEmail(transporter, details, appOrigin) {
  const isApproved = details.decision === 'approved';
  const statusLabel = isApproved ? 'APPROVED' : 'REJECTED';
  const subject = isApproved
    ? 'Your Securitres Excuse Letter Has Been Approved'
    : 'Update Regarding Your Securitres Excuse Letter';
  const letterUrl = new URL('/', appOrigin);
  letterUrl.searchParams.set('letter', details.letter_id);
  const studentName = details.student_name?.trim() || 'Student';
  const submittedDate = formatDate(details.submitted_at);
  const reviewedDate = formatDate(details.decided_at);
  const remarks = details.dean_comment?.trim() || 'No additional remarks were provided.';
  const safeName = escapeHtml(studentName);
  const safeLetterId = escapeHtml(details.letter_id);
  const safeUrl = escapeHtml(letterUrl.toString());
  const safeRemarks = escapeHtml(remarks).replace(/\r?\n/g, '<br>');
  const introduction = isApproved
    ? 'Good news! Your excuse letter has been approved.'
    : 'Your excuse letter has been reviewed. Unfortunately, your submission has been rejected.';
  const plainRemarks = isApproved ? [] : ['', "Dean's remarks:", remarks];
  const htmlRemarks = isApproved
    ? ''
    : `<p style="font-size:14px;line-height:1.6"><strong>Dean's remarks:</strong><br>${safeRemarks}</p>`;

  await transporter.sendMail({
    from: `Securitres Notification System <${process.env.GMAIL_USER}>`,
    to: details.recipient_email,
    subject,
    text: [
      `Hello ${studentName},`,
      '',
      introduction,
      '',
      'Here are the details of your submission:',
      `Excuse Letter ID: ${details.letter_id}`,
      `Date Submitted: ${submittedDate}`,
      `Status: ${statusLabel}`,
      `Date Reviewed: ${reviewedDate}`,
      ...plainRemarks,
      '',
      'Please log in to Securitres to view your excuse letter and its updated status.',
      letterUrl.toString(),
      '',
      'Thank you for using Securitres.',
      'Securitres Notification System',
    ].join('\n'),
    html: `
      <!doctype html>
      <html lang="en">
        <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0;padding:24px;background:#f4f5ef;font-family:Arial,sans-serif;color:#192720">
          <main style="max-width:560px;margin:0 auto;padding:32px 28px;background:#ffffff;border:1px solid #e2e7df;border-radius:10px">
            <div style="font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#123c7a">Securitres · University of the Assumption</div>
            <h1 style="margin:22px 0 12px;font-size:24px;color:#08285f">${statusLabel === 'APPROVED' ? 'Excuse letter approved' : 'Excuse letter decision'}</h1>
            <p style="font-size:16px;line-height:1.6">Hello ${safeName},</p>
            <p style="font-size:15px;line-height:1.6">${introduction}</p>
            <div style="margin:24px 0;padding:18px;background:#e4ebf7;border-radius:8px;font-size:14px;line-height:1.8">
              <strong>Excuse Letter ID:</strong> ${safeLetterId}<br>
              <strong>Date Submitted:</strong> ${escapeHtml(submittedDate)}<br>
              <strong>Status:</strong> ${statusLabel}<br>
              <strong>Date Reviewed:</strong> ${escapeHtml(reviewedDate)}
            </div>
            ${htmlRemarks}
            <p style="font-size:14px;line-height:1.6">Please log in to Securitres to view your excuse letter and its updated status.</p>
            <p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;padding:13px 20px;border-radius:6px;background:#123c7a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">View My Excuse Letter</a></p>
            <p style="font-size:14px;line-height:1.6">Thank you for using Securitres.</p>
            <p style="margin:24px 0 0;color:#68756d;font-size:12px;line-height:1.6">Securitres Notification System</p>
          </main>
        </body>
      </html>
    `,
  });
}

async function finishClaim(supabase, letterId, decision, claimToken, status, errorCode) {
  try {
    const { data: recorded, error } = await supabase.rpc('finish_student_decision_notification', {
      p_letter_id: letterId,
      p_notification_type: decision,
      p_claim_token: claimToken,
      p_status: status,
      p_error_code: errorCode,
    });
    if (error || !recorded) {
      console.error(`Could not record a ${status} student decision email.`, {
        code: error ? safeErrorCode(error) : 'CLAIM_MISMATCH',
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error(`Could not record a ${status} student decision email.`, { code: safeErrorCode(error) });
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { error: 'Method not allowed.' });
  }

  const accessToken = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return respond(res, 401, { error: 'Sign in as the Dean who made this decision.' });

  const letterId = req.body?.letterId;
  if (typeof letterId !== 'string' || !letterIdPattern.test(letterId)) {
    return respond(res, 400, { error: 'A valid excuse-letter ID is required.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    console.error('Student decision email is missing Supabase server configuration.');
    return respond(res, 503, { error: 'Student email notifications are not configured.' });
  }

  const userClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  let user;
  try {
    const { data, error } = await userClient.auth.getUser(accessToken);
    if (error || !data.user) return respond(res, 401, { error: 'Your sign-in session is invalid or expired.' });
    user = data.user;
  } catch (error) {
    console.error('Could not verify the Dean session for student decision email.', { code: safeErrorCode(error) });
    return respond(res, 502, { error: 'Could not verify your account. Please try again.' });
  }

  const supabase = createServiceSupabaseClient(supabaseUrl, serviceRoleKey);
  let claim;
  try {
    const { data, error } = await supabase.rpc('claim_student_decision_notification', {
      p_letter_id: letterId,
      p_dean_id: user.id,
    });
    if (error) {
      console.error('Could not claim the student decision email.', { code: error.code });
      if (error.code === '42501') return respond(res, 403, { error: 'This decision is not available to your Dean account.' });
      return respond(res, 500, { error: 'Could not prepare the student email.' });
    }
    claim = data?.[0];
  } catch (error) {
    console.error('Could not claim the student decision email.', { code: safeErrorCode(error) });
    return respond(res, 500, { error: 'Could not prepare the student email.' });
  }

  if (!claim) return respond(res, 500, { error: 'Could not prepare the student email.' });
  if (claim.outcome === 'missing_email' || claim.outcome === 'unconfirmed_email') {
    return respond(res, 422, { error: 'The student account does not have a confirmed email address.' });
  }
  if (claim.outcome === 'already_sent') {
    return respond(res, 200, { sent: true, alreadySent: true });
  }
  if (claim.outcome === 'in_progress') {
    return respond(res, 202, { sent: false, inProgress: true });
  }
  if (claim.outcome === 'retry_wait') {
    res.setHeader('Retry-After', '300');
    return respond(res, 429, { error: 'Please wait five minutes before retrying this email.' });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const appUrlSetting = process.env.APP_URL;
  let appOrigin;
  let configurationError;
  if (!gmailUser || !gmailAppPassword || !appUrlSetting) {
    configurationError = 'CONFIGURATION';
  } else {
    try {
      appOrigin = getAppOrigin(appUrlSetting);
    } catch {
      configurationError = 'APP_URL';
    }
  }

  if (configurationError) {
    await finishClaim(supabase, letterId, claim.decision, claim.claim_token, 'failed', configurationError);
    console.error('Student decision email delivery is missing valid server configuration.', { code: configurationError });
    return respond(res, 503, { error: 'Student email delivery is not configured.' });
  }

  let transporter;
  try {
    transporter = createTransporter(gmailUser, gmailAppPassword);
    await sendDecisionEmail(transporter, { ...claim, letter_id: letterId }, appOrigin);
  } catch (error) {
    const errorCode = safeErrorCode(error);
    console.error('Student decision email delivery failed.', { code: errorCode });
    await finishClaim(supabase, letterId, claim.decision, claim.claim_token, 'failed', errorCode);
    return respond(res, 502, { error: 'The decision was saved, but the student email could not be delivered. You can retry it.' });
  } finally {
    transporter?.close();
  }

  if (!await finishClaim(supabase, letterId, claim.decision, claim.claim_token, 'sent', null)) {
    return respond(res, 502, { error: 'The email was accepted, but its delivery status could not be recorded. Wait before retrying.' });
  }

  return respond(res, 200, { sent: true });
}
