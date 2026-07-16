import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

if (SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
  console.warn(
    'Session Desk: public/js/config.js still has placeholder Supabase credentials. ' +
    'Edit that file with your real Project URL and anon key before deploying.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
