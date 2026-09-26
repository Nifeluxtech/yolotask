const { supabaseAdmin } = require('./supabase');

// CRITICAL: The 'async' keyword MUST be here for 'await' to work
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header.' };
  }

  const token = authHeader.split(' ')[1];
  
  // This line requires the function to be async
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  
  if (error || !user) {
    throw { code: 'UNAUTHORIZED', message: 'Invalid or expired session.' };
  }

  // Explicitly select columns to avoid PostgREST enum cache bugs
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, is_suspended, created_at, referral_code')
    .eq('id', user.id)
    .single();

  // EXPOSE THE REAL ERROR
  if (profileError) {
    console.error("CRITICAL DB QUERY ERROR:", profileError);
    throw { code: 'FORBIDDEN', message: `DB Error: ${profileError.message}` };
  }
  if (!profile) {
    throw { code: 'FORBIDDEN', message: 'User profile row is missing.' };
  }

  if (profile.is_suspended) {
    throw { code: 'FORBIDDEN', message: 'Account suspended.' };
  }

  return { user, profile };
}

function requireRole(profile, allowedRoles) {
  if (!allowedRoles.includes(profile.role)) {
    throw { code: 'FORBIDDEN', message: 'Insufficient permissions.' };
  }
}

module.exports = { getAuthenticatedUser, requireRole };
