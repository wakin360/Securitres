import { getSupabaseClient } from '../lib/supabase.js';

export async function sendStudentDecisionNotification(letterId) {
  const client = getSupabaseClient();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token) throw new Error('Your sign-in session expired. Sign in again to retry the student email.');

  const response = await fetch('/api/notify-student-decision', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ letterId }),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The student email service returned an invalid response.');
  }
  if (!response.ok) throw new Error(result.error || 'The student email could not be sent.');
  return result;
}

export async function getStudentDecisionNotification(letterId, notificationType) {
  const { data, error } = await getSupabaseClient()
    .from('student_decision_notifications')
    .select('notification_type, status, error_code, last_attempt_at')
    .eq('letter_id', letterId)
    .eq('notification_type', notificationType)
    .maybeSingle();

  if (error) throw error;
  return data;
}
