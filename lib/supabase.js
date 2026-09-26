const { createClient } = require('@supabase/supabase-js');

// Server-side client (Bypasses RLS, used for admin operations and trusted API logic)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Client-side client (Respects RLS, used for basic queries if needed)
const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = { supabaseAdmin, supabaseAnon };
