import { getSupabaseClient } from '../lib/supabase.js';
import { uploadStudentEvidence, validateEvidenceFile } from './studentEvidence.js';

const courseSelection = 'course_offerings (id, course_code, course_name, section)';
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
  created_at,
  ${courseSelection}
`;

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
  const { data, error } = await getSupabaseClient()
    .from('excuse_letters')
    .select(letterSelection)
    .eq('student_id', studentId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

function requireAssignedProgram(programId) {
  if (!programId) {
    throw new Error('Your academic program is not assigned yet. Contact Student Affairs to complete your account setup.');
  }
}

export async function createStudentLetter({ studentId, programId, courseId, absenceStart, absenceEnd, reason, enrolledCourses }) {
  requireAssignedProgram(programId);
  if (!enrolledCourses.some((course) => course.id === courseId)) {
    throw new Error('Choose a course in which you are currently enrolled.');
  }

  const { data, error } = await getSupabaseClient()
    .from('excuse_letters')
    .insert({
      student_id: studentId,
      course_id: courseId,
      absence_start: absenceStart,
      absence_end: absenceEnd,
      reason,
    })
    .select(letterSelection)
    .single();

  if (error) throw error;
  return data;
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
  studentId,
  programId,
  courseId,
  absenceStart,
  absenceEnd,
  reason,
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
    studentId,
    programId,
    courseId,
    absenceStart,
    absenceEnd,
    reason,
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
  const { data: letter, error: letterError } = await getSupabaseClient()
    .from('excuse_letters')
    .select(letterSelection)
    .eq('id', letterId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (letterError) throw letterError;
  if (!letter) return null;

  const { data: statusEvents, error: eventsError } = await getSupabaseClient()
    .from('letter_status_events')
    .select('id, old_status, new_status, comment, created_at')
    .eq('letter_id', letter.id)
    .order('created_at', { ascending: true });

  if (eventsError) throw eventsError;
  return { ...letter, statusEvents };
}
