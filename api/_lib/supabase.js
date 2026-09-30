import { createClient } from "@supabase/supabase-js";

// SUPABASE_SECRET_KEY = la "secret key" del proyecto (nunca la publishable/anon
// en el proxy — este código corre en el servidor, no en el navegador).
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);
