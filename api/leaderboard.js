import { adminClient, requireUser } from '../src/server/supabase.js';
import { ok, fail } from '../src/server/http.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return fail(res, 405, 'Leaderboard only supports GET.');
    await requireUser(req, ['earner', 'admin']);
    const { data, error } = await adminClient.from('earner_leaderboard').select('*').limit(50);
    if (error) throw error;
    return ok(res, { leaderboard: data || [] });
  } catch (error) {
    return fail(res, error.status || 400, error.message || 'Leaderboard request failed.');
  }
}
