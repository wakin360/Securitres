import { getSupabaseClient } from '../lib/supabase.js';
import { getSecureData } from './secureApi.js';

const bucketName = 'excuse-evidence';
const signedUrlLifetimeSeconds = 60;
const pageSize = 500;
const courseSelection = 'id, course_code, course_name, section';
export function createProfessorLetterService(getClient = getSupabaseClient, requestSecureData = getSecureData) {
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
    await getAuthenticatedProfessor();
    return requestSecureData('professor-letters');
  }

  async function getProfessorLetterDetails(letterId) {
    if (!letterId) throw new Error('A letter ID is required.');

    await getAuthenticatedProfessor();
    try {
      return await requestSecureData('professor-letters', { letterId });
    } catch (requestError) {
      if (requestError.status === 404) return null;
      throw requestError;
    }
  }

  async function getProfessorLetterStudentIdentity(letterId) {
    if (!letterId) throw new Error('A letter ID is required.');

    await getAuthenticatedProfessor();
    try {
      return await requestSecureData('professor-identity', { letterId });
    } catch (requestError) {
      if (requestError.status === 404) return null;
      throw requestError;
    }
  }

  async function getProfessorEvidence(letterId) {
    if (!letterId) throw new Error('A letter ID is required.');

    await getAuthenticatedProfessor();
    return requestSecureData('professor-evidence', { letterId });
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
