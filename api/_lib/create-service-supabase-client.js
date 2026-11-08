import { createClient } from '@supabase/supabase-js';

export function createServiceSupabaseClient(
  supabaseUrl,
  serviceRoleKey,
  fetchImplementation = globalThis.fetch,
) {
  const isSecretApiKey = serviceRoleKey.startsWith('sb_secret_');
  const serviceFetch = (input, init = {}) => {
    if (!isSecretApiKey) return fetchImplementation(input, init);

    const headers = new Headers(init.headers);
    headers.delete('Authorization');
    return fetchImplementation(input, { ...init, headers });
  };

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: serviceFetch },
  });
}
