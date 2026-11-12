import { getSupabaseClient } from '../lib/supabase.js';

const bucketName = 'excuse-evidence';
const signedUrlLifetimeSeconds = 60;
const letterSelection = `
  id,
  student_id,
  course_id,
  absence_start,
  absence_end,
  reason,
  status,
  dean_comment,
  submitted_at,
  decided_at,
  decided_by,
  course:course_offerings!excuse_letters_course_id_fkey (
    id,
    course_code,
    course_name,
    section,
    professor:profiles!course_offerings_professor_id_fkey (full_name)
  ),
  student:profiles!excuse_letters_student_id_fkey (
    id,
    full_name,
    student_number,
    program
  )
`;
const letterDetailSelection = `${letterSelection},
  contact:excuse_letter_contacts!excuse_letter_contacts_letter_id_fkey (
    parent_guardian_phone
  )
`;

async function getAuthenticatedDean() {
  const client = getSupabaseClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error('You must be signed in to access Dean review.');

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (profile?.role !== 'dean') throw new Error('Only an authenticated Dean can review letters.');

  return client;
}

export async function getDeanLetters() {
  const client = await getAuthenticatedDean();
  const pageSize = 500;
  const letters = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('excuse_letters')
      .select(letterSelection)
      .order('submitted_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    letters.push(...data);
    if (data.length < pageSize) return letters;
  }
}

export async function getDeanLetterDetails(letterId) {
  const client = await getAuthenticatedDean();
  const { data: letter, error: letterError } = await client
    .from('excuse_letters')
    .select(letterDetailSelection)
    .eq('id', letterId)
    .maybeSingle();

  if (letterError) throw letterError;
  if (!letter) return null;

  const [eventsResult, evidenceResult] = await Promise.all([
    client
      .from('letter_status_events')
      .select('id, old_status, new_status, comment, created_at')
      .eq('letter_id', letter.id)
      .order('created_at', { ascending: true }),
    client
      .from('excuse_evidence')
      .select('id, original_filename, mime_type, size_bytes, uploaded_at')
      .eq('letter_id', letter.id)
      .order('uploaded_at', { ascending: true }),
  ]);

  if (eventsResult.error) throw eventsResult.error;
  if (evidenceResult.error) throw evidenceResult.error;

  return {
    ...letter,
    statusEvents: eventsResult.data,
    evidence: evidenceResult.data,
  };
}

export async function getDeanEvidenceSignedUrl(evidenceId) {
  const client = await getAuthenticatedDean();
  const { data: evidence, error: evidenceError } = await client
    .from('excuse_evidence')
    .select('letter_id, storage_path')
    .eq('id', evidenceId)
    .maybeSingle();

  if (evidenceError) throw evidenceError;
  if (!evidence) throw new Error('The evidence was not found or is not accessible.');

  const { data: letter, error: letterError } = await client
    .from('excuse_letters')
    .select('id')
    .eq('id', evidence.letter_id)
    .maybeSingle();

  if (letterError) throw letterError;
  if (!letter) throw new Error('The letter was not found or is not accessible.');

  const { data, error } = await client.storage
    .from(bucketName)
    .createSignedUrl(evidence.storage_path, signedUrlLifetimeSeconds);

  if (error) throw error;
  return data.signedUrl;
}

export async function submitDeanDecision({ letterId, decision, comment }) {
  const client = await getAuthenticatedDean();
  const { data, error } = await client.rpc('decide_excuse_letter', {
    p_letter_id: letterId,
    p_decision: decision,
    p_comment: comment.trim() || null,
  });

  if (error) throw error;
  return data;
}
