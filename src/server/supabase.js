import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !serviceKey) console.warn('Server Supabase credentials are not configured.');
if (!url || !anonKey) console.warn('Supabase anon key is not configured; immediate server-side sign-in will be unavailable.');

// Keep this client exclusively for trusted database/Auth-admin operations. Never
// call auth.signInWithPassword() on it: Supabase stores that user session on the
// client and can replace the service-role Authorization header with a user JWT.
export const adminClient = url && serviceKey
  ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Password sign-in belongs on an isolated public-key client. The resulting
// session is returned to the browser, while adminClient remains service-role.
export const authClient = url && anonKey
  ? createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

export async function requireUser(req, allowedRoles = []) {
  if (!adminClient) throw Object.assign(new Error('Supabase server configuration is missing.'), { status: 500 });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data.user) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  const { data: profile, error: profileError } = await adminClient.from('profiles').select('*').eq('id', data.user.id).single();
  if (profileError || !profile) throw Object.assign(new Error('Profile not found.'), { status: 403 });
  if (allowedRoles.length && !allowedRoles.includes(profile.role)) throw Object.assign(new Error('You are not authorized for this action.'), { status: 403 });
  return { authUser: data.user, profile };
}

export async function rpc(name, args = {}) {
  if (!adminClient) throw new Error('Supabase server configuration is missing.');
  const result = await adminClient.rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
}
