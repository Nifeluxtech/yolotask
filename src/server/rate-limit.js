import { adminClient } from './supabase.js';

const WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Enforces a rate limit for a given scope (e.g. 'auth:login') and identifier
 * (an IP address for pre-auth actions, a profile id for authenticated ones).
 * Throws a 429 error when the limit is exceeded. Requires the `018_rate_limiting.sql`
 * migration (rate_limit_hits table + check_rate_limit function) to be applied in Supabase.
 */
export async function enforceRateLimit(req, scope, identifier) {
  if (!adminClient) return; // Supabase not configured (e.g. local dev without env vars) — skip rather than block.
  const key = identifier || clientIp(req);
  try {
    const { data, error } = await adminClient.rpc('check_rate_limit', {
      p_scope: scope,
      p_identifier: key,
      p_window_seconds: WINDOW_SECONDS,
      p_max_requests: MAX_REQUESTS
    });
    if (error) {
      console.error(`Rate limit check failed for ${scope}:`, error.message);
      return; // Fail open: an infra/config problem on our side shouldn't lock users out.
    }
    if (data === false) {
      throw Object.assign(new Error('Too many requests. Please slow down and try again shortly.'), { status: 429 });
    }
  } catch (error) {
    if (error.status === 429) throw error;
    console.error(`Rate limit check threw for ${scope}:`, error.message);
  }
}
