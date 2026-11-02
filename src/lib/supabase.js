import { createClient } from '@supabase/supabase-js';

const configuredSupabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

function getSupabaseUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/rest\/v1\/?$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

const supabaseUrl = getSupabaseUrl(configuredSupabaseUrl);
export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey)
  : null;

export function getSupabaseClient() {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.',
    );
  }
  return supabase;
}
