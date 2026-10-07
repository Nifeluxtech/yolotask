// /api/referrals.js
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

function maskName(fullName) {
  const parts = String(fullName || 'Unknown').trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['earner', 'advertiser']);

    switch (action) {
      case 'get_referral_data': {
        // My code
        const code = profile.referral_code || 'N/A';

        // People I referred
        const { data: referred, error: refErr } = await supabaseAdmin
          .from('profiles')
          .select('full_name, role, created_at')
          .eq('referred_by', profile.id)
          .order('created_at', { ascending: false })
          .limit(100);

        if (refErr) throw refErr;

        // Rewards I earned from referrals
        const { data: rewards, error: rwErr } = await supabaseAdmin
          .from('wallet_ledger')
          .select('amount, created_at')
          .eq('user_id', profile.id)
          .eq('transaction_type', 'REFERRAL_REWARD_EARNER')
          .order('created_at', { ascending: false });

        if (rwErr) throw rwErr;

        const totalEarned = (rewards || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);

        return sendSuccess(res, {
          referral_code: code,
          total_referrals: (referred || []).length,
          total_earned: totalEarned,
          referred_users: (referred || []).map(r => ({
            name: maskName(r.full_name),
            role: r.role,
            joined_at: r.created_at
          })),
          reward_history: (rewards || []).map(r => ({ amount: Number(r.amount), at: r.created_at }))
        });
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Referrals API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
