import { getSupabaseClient } from '../lib/supabase.js';
import { getSecureData, postSecureData } from './secureApi.js';
import { uploadStudentEvidence, validateEvidenceFile } from './studentEvidence.js';

const courseSelection = 'course_offerings (id, course_code, course_name, section)';

export async function getStudentCourses(studentId) {
  const { data, error } = await getSupabaseClient()
    .from('course_enrollments')
    .select(`course_id, ${courseSelection}`)
    .eq('student_id', studentId)
    .order('course_id');

  if (error) throw error;
  return data.map((enrollment) => enrollment.course_offerings);
}

export async function getStudentLetters(studentId) {
  const { data: { user }, error } = await getSupabaseClient().auth.getUser();
  if (error) throw error;
  if (!user || user.id !== studentId) throw new Error('You can only load your own letters.');
  return getSecureData('student-letters');
}

function requireAssignedProgram(programId) {
  if (!programId) {
    throw new Error('Your academic program is not assigned yet. Contact Student Affairs to complete your account setup.');
  }
}

export async function createStudentLetter({
  programId,
  courseId,
  absenceStart,
  absenceEnd,
  reason,
  parentGuardianPhone,
  enrolledCourses,
}) {
  requireAssignedProgram(programId);
  if (!enrolledCourses.some((course) => course.id === courseId)) {
    throw new Error('Choose a course in which you are currently enrolled.');
  }
  const normalizedParentGuardianPhone = String(parentGuardianPhone || '').trim();
  if (!normalizedParentGuardianPhone || normalizedParentGuardianPhone.length > 40) {
    throw new Error('Enter a parent or guardian phone number of 40 characters or fewer.');
  }

  const data = await postSecureData('create-student-letter', {
    courseId,
    absenceStart,
    absenceEnd,
    reason,
    parentGuardianPhone: normalizedParentGuardianPhone,
  });
  return {
    ...data,
    course_offerings: enrolledCourses.find((course) => course.id === courseId),
  };
}

export class StudentLetterSubmissionError extends Error {
  constructor({ letter, uploadedEvidenceCount, totalEvidenceCount, cause }) {
    const cleanupWarning = cause?.cleanupFailed
      ? ` Cleanup of the failed file also failed; contact support and provide letter ID ${letter.id}.`
      : '';
    super(
      `The letter was created, but evidence upload stopped after ${uploadedEvidenceCount} of ${totalEvidenceCount} files. Open the letter from your list to review saved files and add the remaining evidence.${cleanupWarning}`,
    );
    this.name = 'StudentLetterSubmissionError';
    this.letter = letter;
    this.uploadedEvidenceCount = uploadedEvidenceCount;
    this.totalEvidenceCount = totalEvidenceCount;
    this.evidenceError = cause;
  }
}

export async function createStudentLetterWithEvidence({
  programId,
  courseId,
  absenceStart,
  absenceEnd,
  reason,
  parentGuardianPhone,
  enrolledCourses,
  evidenceFiles = [],
  onEvidenceProgress,
}) {
  requireAssignedProgram(programId);

  for (const file of evidenceFiles) {
    const validationError = validateEvidenceFile(file);
    if (validationError) throw new Error(`${file?.name || 'Selected file'}: ${validationError}`);
  }

  const letter = await createStudentLetter({
    programId,
    courseId,
    absenceStart,
    absenceEnd,
    reason,
    parentGuardianPhone,
    enrolledCourses,
  });

  let uploadedEvidenceCount = 0;
  for (const [index, file] of evidenceFiles.entries()) {
    onEvidenceProgress?.(index + 1, evidenceFiles.length);
    try {
      await uploadStudentEvidence({ letterId: letter.id, file });
      uploadedEvidenceCount += 1;
    } catch (error) {
      throw new StudentLetterSubmissionError({
        letter,
        uploadedEvidenceCount,
        totalEvidenceCount: evidenceFiles.length,
        cause: error,
      });
    }
  }

  return letter;
}

export async function getStudentLetterDetails({ studentId, letterId }) {
  const { data: { user }, error } = await getSupabaseClient().auth.getUser();
  if (error) throw error;
  if (!user || user.id !== studentId) throw new Error('You can only load your own letters.');
  try {
    return await getSecureData('student-letters', { letterId });
  } catch (requestError) {
    if (requestError.status === 404) return null;
    throw requestError;
  }
}
