import { getSupabaseClient } from '../lib/supabase.js';

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

export async function createStudentLetter({ studentId, courseId, absenceStart, absenceEnd, reason, enrolledCourses }) {
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
