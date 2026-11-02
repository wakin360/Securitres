import { getSupabaseClient } from '../lib/supabase.js';

const bucketName = 'excuse-evidence';
const signedUrlLifetimeSeconds = 60;
const maximumFileSize = 8 * 1024 * 1024;
const allowedTypes = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
]);

export class EvidenceUploadError extends Error {
  constructor(message, cleanupFailed = false) {
    super(message);
    this.name = 'EvidenceUploadError';
    this.cleanupFailed = cleanupFailed;
  }
}

async function getAuthenticatedStudent() {
  const client = getSupabaseClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error('You must be signed in to access evidence.');

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (profile?.role !== 'student') throw new Error('Only the letter owner can manage student evidence.');

  return { client, user };
}

async function getOwnedLetter(client, userId, letterId) {
  const { data, error } = await client
    .from('excuse_letters')
    .select('id, student_id, status')
    .eq('id', letterId)
    .eq('student_id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('The letter was not found or is not accessible.');
  return data;
}

function publicEvidenceRecord(record) {
  return {
    id: record.id,
    letter_id: record.letter_id,
    original_filename: record.original_filename,
    mime_type: record.mime_type,
    size_bytes: record.size_bytes,
    uploaded_at: record.uploaded_at,
  };
}

export function validateEvidenceFile(file) {
  if (!file || typeof file.size !== 'number' || typeof file.type !== 'string') {
    return 'Choose a file to upload.';
  }
  if (file.size === 0) return 'Empty files cannot be uploaded.';
  if (file.size > maximumFileSize) return 'Evidence files must be 8 MB or smaller.';
  if (!allowedTypes.has(file.type)) return 'Choose a PDF, JPG, or PNG file.';
  return '';
}

export async function getStudentEvidence(letterId) {
  const { client, user } = await getAuthenticatedStudent();
  await getOwnedLetter(client, user.id, letterId);

  const { data, error } = await client
    .from('excuse_evidence')
    .select('id, letter_id, storage_path, original_filename, mime_type, size_bytes, uploaded_at')
    .eq('letter_id', letterId)
    .order('uploaded_at', { ascending: true });

  if (error) throw error;
  return data.map(publicEvidenceRecord);
}

export async function uploadStudentEvidence({ letterId, file }) {
  const validationError = validateEvidenceFile(file);
  if (validationError) throw new EvidenceUploadError(validationError);

  const { client, user } = await getAuthenticatedStudent();
  const letter = await getOwnedLetter(client, user.id, letterId);
  if (letter.status !== 'pending') {
    throw new EvidenceUploadError('Evidence can only be uploaded while the letter is pending.');
  }

  const extension = allowedTypes.get(file.type);
  const storagePath = `${user.id}/${letter.id}/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await client.storage
    .from(bucketName)
    .upload(storagePath, file, { contentType: file.type, upsert: false });

  if (uploadError) throw uploadError;

  const { data: evidence, error: insertError } = await client
    .from('excuse_evidence')
    .insert({
      letter_id: letter.id,
      storage_path: storagePath,
      original_filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    })
    .select('id, letter_id, storage_path, original_filename, mime_type, size_bytes, uploaded_at')
    .single();

  if (insertError) {
    const { error: cleanupError } = await client.storage.from(bucketName).remove([storagePath]);
    if (cleanupError) {
      if (import.meta.env.DEV) console.error('Evidence metadata insert and uploaded-object cleanup both failed.', { insertError, cleanupError });
      throw new EvidenceUploadError('The evidence record could not be saved, and the uploaded file could not be removed. Contact support with the letter ID.', true);
    }
    throw insertError;
  }

  return publicEvidenceRecord(evidence);
}

export async function getStudentEvidenceSignedUrl(evidenceId) {
  const { client, user } = await getAuthenticatedStudent();
  const { data: evidence, error: evidenceError } = await client
    .from('excuse_evidence')
    .select('letter_id, storage_path')
    .eq('id', evidenceId)
    .maybeSingle();

  if (evidenceError) throw evidenceError;
  if (!evidence) throw new Error('The evidence was not found or is not accessible.');
  await getOwnedLetter(client, user.id, evidence.letter_id);

  const { data, error } = await client.storage
    .from(bucketName)
    .createSignedUrl(evidence.storage_path, signedUrlLifetimeSeconds);

  if (error) throw error;
  return data.signedUrl;
}
