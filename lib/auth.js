const { supabaseAdmin } = require('./supabase');

// Middleware to verify JWT and fetch user profile
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header.' };
  }

  const token = authHeader.split(' ')[1];
  
  // Verify token with Supabase
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  
  if (error || !user) {
    throw { code: 'UNAUTHORIZED', message: 'Invalid or expired session.' };
  }

  // Fetch full profile including role
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    throw { code: 'FORBIDDEN', message: 'User profile not found.' };
  }

  if (profile.is_suspended) {
    throw { code: 'FORBIDDEN', message: 'Your account has been suspended.' };
  }

  return { user, profile };
}

// Helper to enforce specific roles
function requireRole(profile, allowedRoles) {
  if (!allowedRoles.includes(profile.role)) {
    throw { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' };
  }
}

module.exports = { getAuthenticatedUser, requireRole };
