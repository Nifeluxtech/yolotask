const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['earner']);

    switch (action) {
      case 'get_stats': {
        const { data: referrals } = await supabaseAdmin.from('referrals').select('status').eq('referrer_id', profile.id);
        const total = referrals.length;
        const completed = referrals.filter(r => r.status === 'COMPLETED').length;
        return sendSuccess(res, { referral_code: profile.referral_code, stats: { total, completed, pending: total - completed } });
      }
      case 'check_in': {
        const { data, error } = await supabaseAdmin.rpc('process_daily_checkin', { p_user_id: profile.id });
        if (error) throw error;
        return sendSuccess(res, { reward: data.reward }, 'Checked in!');
      }
      default: return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
};
