import { getSupabaseClient } from '../lib/supabase.js';

export const profileRoles = ['student', 'professor', 'dean'];

export async function getProfileForUser(userId) {
  if (!userId) {
    throw new Error('An authenticated user ID is required to load a profile.');
  }

  const { data, error } = await getSupabaseClient()
    .from('profiles')
    .select('id, role, full_name, student_number, program, program_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}
