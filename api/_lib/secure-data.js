import { createClient } from '@supabase/supabase-js';
import { decryptValue, encryptValue, EncryptionError } from './encryption.js';
import { createServiceSupabaseClient } from './create-service-supabase-client.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, private');
  return res.status(status).json(body);
}

export async function authenticateRequest(req) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new ApiError(401, 'Sign in to continue.');

  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    throw new ApiError(503, 'Server-side Supabase access is not configured.');
  }

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, 'Your sign-in session is invalid or expired.');

  const userSupabase = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  return {
    user: data.user,
    supabase: createServiceSupabaseClient(supabaseUrl, serviceRoleKey),
    userSupabase,
  };
}

export function requireRole(profile, expectedRole) {
  if (profile?.role !== expectedRole) {
    throw new ApiError(403, `Only an authenticated ${expectedRole} can access this data.`);
  }
}

export async function getProfile(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role, program_id, full_name, full_name_envelope, student_number, student_number_envelope, student_number_index, program, program_envelope')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new ApiError(403, 'The account profile is unavailable.');
  return data;
}

export function encryptionContext(table, rowId, field) {
  const environment = process.env.SECURITRES_ENCRYPTION_CONTEXT
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || 'development';

  return { environment, table, rowId, field };
}

export function encryptText(value, table, rowId, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be text.`);
  return encryptValue(value, encryptionContext(table, rowId, field));
}

export function getEncryptionMode() {
  const mode = process.env.SECURITRES_ENCRYPTION_MODE || 'legacy';
  if (mode !== 'legacy' && mode !== 'strict') {
    throw new ApiError(503, 'Server-side encryption mode is not configured correctly.');
  }
  return mode;
}

export function decryptText(envelope, plaintext, table, rowId, field) {
  const mode = getEncryptionMode();
  if (envelope !== null && envelope !== undefined) {
    return decryptValue(envelope, encryptionContext(table, rowId, field));
  }
  if (plaintext === null || plaintext === undefined) return null;
  if (mode === 'legacy') return plaintext;
  throw new ApiError(503, 'An encrypted value is required but is not available.');
}

export async function getAuthorizedLetter(supabase, profile, letterId, role) {
  const { data: letter, error } = await supabase
    .from('excuse_letters')
    .select('id, student_id, course_id, status')
    .eq('id', letterId)
    .maybeSingle();
  if (error) throw error;
  if (!letter) throw new ApiError(404, 'The letter was not found or is not accessible.');

  if (role === 'student') {
    if (letter.student_id !== profile.id) {
      throw new ApiError(404, 'The letter was not found or is not accessible.');
    }
  } else if (role === 'professor') {
    if (letter.status !== 'approved') {
      throw new ApiError(404, 'The approved letter was not found or is not accessible.');
    }
    const { data: course, error: courseError } = await supabase
      .from('course_offerings')
      .select('id')
      .eq('id', letter.course_id)
      .eq('professor_id', profile.id)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!course) throw new ApiError(404, 'The approved letter was not found or is not accessible.');
  } else {
    throw new ApiError(500, 'This letter access path is not supported.');
  }

  return letter;
}

export function decryptProfile(profile) {
  return {
    id: profile.id,
    role: profile.role,
    program_id: profile.program_id,
    full_name: decryptText(profile.full_name_envelope, profile.full_name, 'profiles', profile.id, 'full_name'),
    student_number: decryptText(profile.student_number_envelope, profile.student_number, 'profiles', profile.id, 'student_number'),
    program: decryptText(profile.program_envelope, profile.program, 'profiles', profile.id, 'program'),
  };
}

export function decryptLetter(letter, includeDeanComment) {
  const result = {
    ...letter,
    absence_start: decryptText(letter.absence_start_envelope, letter.absence_start, 'excuse_letters', letter.id, 'absence_start'),
    absence_end: decryptText(letter.absence_end_envelope, letter.absence_end, 'excuse_letters', letter.id, 'absence_end'),
    reason: decryptText(letter.reason_envelope, letter.reason, 'excuse_letters', letter.id, 'reason'),
  };
  delete result.absence_start_envelope;
  delete result.absence_end_envelope;
  delete result.reason_envelope;
  if (includeDeanComment) {
    result.dean_comment = decryptText(
      letter.dean_comment_envelope,
      letter.dean_comment,
      'excuse_letters',
      letter.id,
      'dean_comment',
    );
  }
  delete result.dean_comment_envelope;
  if (!includeDeanComment) delete result.dean_comment;
  return result;
}

export function decryptLetterEventRows(events) {
  return (events || []).map((event) => ({
    id: event.id,
    old_status: event.old_status,
    new_status: event.new_status,
    comment: decryptText(
      event.comment_envelope,
      event.comment,
      'letter_status_events',
      event.id,
      'comment',
    ),
    created_at: event.created_at,
  }));
}

export async function decryptLetterEvents(supabase, letterId) {
  const { data, error } = await supabase
    .from('letter_status_events')
    .select('id, old_status, new_status, comment, comment_envelope, created_at')
    .eq('letter_id', letterId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;

  return decryptLetterEventRows(data || []);
}

export function respondWithError(res, error) {
  if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message });
  if (error instanceof EncryptionError
      && ['MISSING_KEY', 'UNKNOWN_KEY_VERSION', 'INVALID_CONFIGURATION'].includes(error.code)) {
    return sendJson(res, 503, { error: 'Server-side encryption keys are not configured correctly.' });
  }
  if (['PGRST202', 'PGRST204', '42703'].includes(error?.code)) {
    return sendJson(res, 503, {
      error: 'The encrypted-data database migration must be applied before this operation is available.',
    });
  }
  console.error('Encrypted-data API request failed.', { code: error?.code || error?.name || 'UNKNOWN' });
  return sendJson(res, 500, { error: 'The encrypted-data request could not be completed.' });
}
