// /api/referrals.js — Referral data with milestone tracking (₦150 at 10 tasks)
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

const MILESTONE_TARGET = 10;
const MILESTONE_BONUS = 150;

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
        const code = profile.referral_code || 'N/A';

        // People I referred (with their IDs for milestone lookup)
        const { data: referred, error: refErr } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, role, created_at')
          .eq('referred_by', profile.id)
          .order('created_at', { ascending: false })
          .limit(100);
        if (refErr) throw refErr;

        // Rewards I earned from referrals (sign-up bonuses)
        const { data: rewards, error: rwErr } = await supabaseAdmin
          .from('wallet_ledger')
          .select('amount, created_at')
          .eq('user_id', profile.id)
          .eq('transaction_type', 'REFERRAL_REWARD_EARNER')
          .order('created_at', { ascending: false });
        if (rwErr) throw rwErr;

        // Milestone data for each referral
        const referredIds = (referred || []).map(r => r.id);
        let milestonesMap = new Map();
        if (referredIds.length > 0) {
          const { data: milestones } = await supabaseAdmin
            .from('referral_milestones')
            .select('referred_id, approved_tasks, bonus_paid, bonus_paid_at')
            .eq('referrer_id', profile.id)
            .in('referred_id', referredIds);
          milestonesMap = new Map((milestones || []).map(m => [m.referred_id, m]));
        }

        // Milestone bonus earnings (separate from sign-up bonuses)
        const { data: milestoneBonuses } = await supabaseAdmin
          .from('wallet_ledger')
          .select('amount')
          .eq('user_id', profile.id)
          .eq('transaction_type', 'REFERRAL_MILESTONE_BONUS');

        const signupsEarned = (rewards || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
        const milestonesEarned = (milestoneBonuses || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
        const totalEarned = signupsEarned + milestonesEarned;

        const milestonesUnlocked = (referred || []).filter(r => {
          const m = milestonesMap.get(r.id);
          return m && m.bonus_paid;
        }).length;

        return sendSuccess(res, {
          referral_code: code,
          total_referrals: (referred || []).length,
          total_earned: totalEarned,
          signups_earned: signupsEarned,
          milestones_earned: milestonesEarned,
          milestones_unlocked: milestonesUnlocked,
          milestone_target: MILESTONE_TARGET,
          milestone_bonus: MILESTONE_BONUS,
          referred_users: (referred || []).map(r => {
            const m = milestonesMap.get(r.id) || { approved_tasks: 0, bonus_paid: false };
            return {
              id: r.id,
              name: maskName(r.full_name),
              role: r.role,
              joined_at: r.created_at,
              approved_tasks: Number(m.approved_tasks || 0),
              tasks_remaining: Math.max(0, MILESTONE_TARGET - Number(m.approved_tasks || 0)),
              bonus_paid: !!m.bonus_paid,
              bonus_paid_at: m.bonus_paid_at || null,
              progress_pct: Math.min(100, Math.round((Number(m.approved_tasks || 0) / MILESTONE_TARGET) * 100))
            };
          }),
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
