import { getSupabaseClient } from '../lib/supabase.js';

const bucketName = 'excuse-evidence';
const signedUrlLifetimeSeconds = 60;
const pageSize = 500;
const courseSelection = 'id, course_code, course_name, section';
const letterSelection = `
  id,
  course_id,
  absence_start,
  absence_end,
  reason,
  status,
  submitted_at,
  decided_at,
  course:course_offerings!excuse_letters_course_id_fkey (
    id,
    course_code,
    course_name,
    section
  )
`;

export function createProfessorLetterService(getClient = getSupabaseClient) {
  async function getAuthenticatedProfessor() {
    const client = getClient();
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError) throw authError;
    if (!user) throw new Error('You must be signed in to access Professor letters.');

    const { data: profile, error: profileError } = await client
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (profile?.role !== 'professor') {
      throw new Error('Only an authenticated Professor can access assigned course letters.');
    }

    return { client, user };
  }

  async function getAssignedCourses(client, professorId) {
    const courses = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from('course_offerings')
        .select(courseSelection)
        .eq('professor_id', professorId)
        .order('course_code', { ascending: true })
        .order('section', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw error;
      courses.push(...data);
      if (data.length < pageSize) return courses;
    }
  }

  async function getProfessorCourses() {
    const { client, user } = await getAuthenticatedProfessor();
    return getAssignedCourses(client, user.id);
  }

  async function getProfessorLetters() {
    const { client, user } = await getAuthenticatedProfessor();
    const courses = await getAssignedCourses(client, user.id);
    const courseIds = courses.map((course) => course.id);
    if (courseIds.length === 0) return [];

    const letters = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from('excuse_letters')
        .select(letterSelection)
        .in('course_id', courseIds)
        .eq('status', 'approved')
        .order('decided_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw error;
      letters.push(...data);
      if (data.length < pageSize) return letters;
    }
  }

  async function getProfessorLetterDetails(letterId) {
    if (!letterId) throw new Error('A letter ID is required.');

    const { client } = await getAuthenticatedProfessor();
    const { data, error } = await client
      .from('excuse_letters')
      .select(letterSelection)
      .eq('id', letterId)
      .eq('status', 'approved')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function getProfessorLetterStudentIdentity(letterId) {
    if (!letterId) throw new Error('A letter ID is required.');

    const { client } = await getAuthenticatedProfessor();
    const { data, error } = await client.rpc(
      'get_professor_approved_letter_student_identity',
      { p_letter_id: letterId },
    );

    if (error) throw error;
    const identity = Array.isArray(data) ? data[0] : null;
    if (!identity) return null;

    return {
      full_name: identity.full_name,
      student_number: identity.student_number,
    };
  }

  async function getProfessorEvidence(letterId) {
    if (!letterId) throw new Error('A letter ID is required.');

    const { client } = await getAuthenticatedProfessor();
    const { data: letter, error: letterError } = await client
      .from('excuse_letters')
      .select('id')
      .eq('id', letterId)
      .eq('status', 'approved')
      .maybeSingle();

    if (letterError) throw letterError;
    if (!letter) throw new Error('The approved letter was not found or is not accessible.');

    const { data, error } = await client
      .from('excuse_evidence')
      .select('id, letter_id, original_filename, mime_type, size_bytes, uploaded_at')
      .eq('letter_id', letter.id)
      .order('uploaded_at', { ascending: true });

    if (error) throw error;
    return data;
  }

  async function getProfessorEvidenceSignedUrl(evidenceId) {
    if (!evidenceId) throw new Error('An evidence ID is required.');

    const { client } = await getAuthenticatedProfessor();
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
      .eq('status', 'approved')
      .maybeSingle();

    if (letterError) throw letterError;
    if (!letter) throw new Error('The approved letter was not found or is not accessible.');

    const { data, error } = await client.storage
      .from(bucketName)
      .createSignedUrl(evidence.storage_path, signedUrlLifetimeSeconds);

    if (error) throw error;
    return data.signedUrl;
  }

  return {
    getProfessorCourses,
    getProfessorLetters,
    getProfessorLetterDetails,
    getProfessorLetterStudentIdentity,
    getProfessorEvidence,
    getProfessorEvidenceSignedUrl,
  };
}

const professorLetterService = createProfessorLetterService();

export const getProfessorCourses = (...args) => professorLetterService.getProfessorCourses(...args);
export const getProfessorLetters = (...args) => professorLetterService.getProfessorLetters(...args);
export const getProfessorLetterDetails = (...args) => professorLetterService.getProfessorLetterDetails(...args);
export const getProfessorLetterStudentIdentity = (...args) => professorLetterService.getProfessorLetterStudentIdentity(...args);
export const getProfessorEvidence = (...args) => professorLetterService.getProfessorEvidence(...args);
export const getProfessorEvidenceSignedUrl = (...args) => professorLetterService.getProfessorEvidenceSignedUrl(...args);
