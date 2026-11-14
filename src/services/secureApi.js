import { getSupabaseClient } from '../lib/supabase.js';

async function request(path, options) {
  const client = getSupabaseClient();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token) throw new Error('Your sign-in session expired. Sign in again and retry.');

  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The secure data service returned an invalid response.');
  }
  if (!response.ok) {
    const error = new Error(result.error || 'The secure data request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function getSecureData(action, params = {}) {
  const query = new URLSearchParams({ action, ...params });
  return request(`/api/secure-data?${query}`, { method: 'GET' });
}

export function postSecureData(action, data = {}) {
  return request('/api/secure-data', {
    method: 'POST',
    body: JSON.stringify({ ...data, action }),
  });
}
