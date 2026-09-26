const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { getPlatformStats } = require('../lib/analytics');
const { sendNotification, sendAnnouncement } = require('../lib/notifications');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['admin']);

    switch (action) {
      case 'get_dashboard_stats': {
        return sendSuccess(res, { stats: await getPlatformStats() });
      }
      case 'get_campaigns_for_review': {
        const { data } = await supabaseAdmin.from('campaigns').select('*, advertiser:advertiser_id(full_name), task_types:task_type_id(name)').eq('status', 'SUBMITTED').order('created_at', { ascending: false });
        return sendSuccess(res, { campaigns: data });
      }
      case 'review_campaign': {
        const { campaignId, reviewAction, adminNote } = req.body;
        if (!campaignId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        
        const { data: campaign } = await supabaseAdmin.from('campaigns').select('title, advertiser_id').eq('id', campaignId).single();
        const { error } = await supabaseAdmin.rpc('admin_review_campaign', { p_campaign_id: campaignId, p_admin_id: profile.id, p_action: reviewAction, p_admin_note: adminNote });
        if (error) throw error;

        if (reviewAction === 'APPROVED') await sendNotification(campaign.advertiser_id, 'Campaign Approved!', `Your campaign "${campaign.title}" is now LIVE.`, 'CAMPAIGN');
        else if (reviewAction === 'REJECTED') await sendNotification(campaign.advertiser_id, 'Campaign Rejected', `Your campaign "${campaign.title}" was rejected.`, 'CAMPAIGN');
        
        return sendSuccess(res, {}, `Campaign ${reviewAction.toLowerCase()}.`);
      }
      case 'process_withdrawal': {
        const { withdrawalId, action: wdAction } = req.body;
        if (!withdrawalId || !wdAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        
        const { data: withdrawal } = await supabaseAdmin.from('withdrawals').select('user_id, amount').eq('id', withdrawalId).single();
        const { error } = await supabaseAdmin.rpc('admin_process_withdrawal', { p_withdrawal_id: withdrawalId, p_admin_id: profile.id, p_action: wdAction });
        if (error) throw error;

        const msg = wdAction === 'COMPLETED' ? `Withdrawal of ₦${withdrawal.amount} processed.` : `Withdrawal rejected. Funds returned.`;
        await sendNotification(withdrawal.user_id, wdAction === 'COMPLETED' ? 'Withdrawal Processed' : 'Withdrawal Rejected', msg, 'WALLET');
        
        return sendSuccess(res, {}, msg);
      }
      case 'create_announcement': {
        const { title, message, type } = req.body;
        if (!title || !message) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        await sendAnnouncement(title, message, type);
        return sendSuccess(res, {}, 'Published.');
      }
      case 'get_leaderboard': {
        const { data } = await supabaseAdmin.from('earner_reputation').select('*, profiles:user_id(full_name)').order('tasks_completed', { ascending: false }).limit(50);
        return sendSuccess(res, { leaders: data });
      }
      default: return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
  case 'get_withdrawals': {
        const { data } = await supabaseAdmin
          .from('withdrawals')
          .select('*, profiles:user_id(full_name, email)')
          .order('created_at', { ascending: false });
        return sendSuccess(res, { withdrawals: data });
      }
      case 'get_users': {
        try {
          // We temporarily omit 'role' from the select to see if the column itself is the blocker.
          // If this works, we know 100% the 'role' column mapping is corrupted.
          const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, is_suspended, created_at') 
            .order('created_at', { ascending: false })
            .limit(100);

          if (error) {
            console.error("Supabase get_users error:", error);
            return sendError(res, 'DATABASE_ERROR', error.message, 500);
          }

          return sendSuccess(res, { users: data });
        } catch (err) {
          console.error("API get_users crash:", err);
          return sendError(res, 'INTERNAL_ERROR', 'Failed to fetch users.', 500);
        }
      }
};
