import { getSupabaseClient } from '../lib/supabase.js';
import { getSecureData } from './secureApi.js';

export const profileRoles = ['student', 'professor', 'dean'];

export async function getProfileForUser(userId) {
  if (!userId) {
    throw new Error('An authenticated user ID is required to load a profile.');
  }

  const client = getSupabaseClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error) throw error;
  if (!user || user.id !== userId) throw new Error('You can only load your own profile.');
  return getSecureData('profile');
}
