import { getSupabaseClient } from '../lib/supabase.js';
import { getSecureData, postSecureData } from './secureApi.js';

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
  await getAuthenticatedDean();
  return getSecureData('dean-letters');
}

export async function getDeanLetterDetails(letterId) {
  await getAuthenticatedDean();
  try {
    return await getSecureData('dean-letters', { letterId });
  } catch (requestError) {
    if (requestError.status === 404) return null;
    throw requestError;
  }
}

export async function getDeanEvidenceSignedUrl(evidenceId) {
  await getAuthenticatedDean();
  const { signedUrl } = await getSecureData('dean-evidence-url', { evidenceId });
  return signedUrl;
}

export async function submitDeanDecision({ letterId, decision, comment }) {
  await getAuthenticatedDean();
  const result = await postSecureData('decide-letter', {
    letterId,
    decision,
    comment: typeof comment === 'string' ? comment : '',
  });
  return result;
}
