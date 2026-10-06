// /lib/auth.js
const { supabaseAdmin } = require('./supabase');

/**
 * Reads a platform_settings flag. Returns raw JSONB value or null.
 */
async function getPlatformFlag(key) {
  const { data } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  return data ? data.value : null;
}

/**
 * Extracts and verifies the user's JWT token from the request header.
 * Fetches their full profile. Enforces MAINTENANCE MODE for non-admins.
 */
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header.' };
  }

  const token = authHeader.split(' ')[1];

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    throw { code: 'UNAUTHORIZED', message: 'Invalid or expired session.' };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, is_suspended, created_at, referral_code, phone, avatar_url')
    .eq('id', user.id)
    .single();

  if (profileError) {
    console.error('CRITICAL DB QUERY ERROR:', profileError);
    throw { code: 'FORBIDDEN', message: `DB Error: ${profileError.message}` };
  }

  if (!profile) {
    throw { code: 'FORBIDDEN', message: 'User profile row is missing.' };
  }

  if (profile.is_suspended) {
    throw { code: 'FORBIDDEN', message: 'Account suspended.' };
  }

  // MAINTENANCE MODE GATE: admins pass, everyone else is blocked
  const maintenance = await getPlatformFlag('maintenance_mode');
  if ((maintenance === true || maintenance === 'true') && profile.role !== 'admin') {
    throw { code: 'MAINTENANCE', message: 'Platform is under maintenance. Please check back soon.', statusCode: 503 };
  }

  return { user, profile };
}

/**
 * Enforces role-based access on an endpoint.
 */
function requireRole(profile, allowedRoles) {
  if (!allowedRoles.includes(profile.role)) {
    throw { code: 'FORBIDDEN', message: 'Insufficient permissions.' };
  }
}

module.exports = { getAuthenticatedUser, requireRole, getPlatformFlag };
