const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['admin']); // STRICT ADMIN CHECK

    switch (action) {
      
      case 'get_dashboard_stats': {
        const [users, campaigns, submissions, withdrawals] = await Promise.all([
          supabaseAdmin.from('profiles').select('id, role', { count: 'exact', head: true }),
          supabaseAdmin.from('campaigns').select('id, status', { count: 'exact', head: true }).eq('status', 'LIVE'),
          supabaseAdmin.from('task_submissions').select('id', { count: 'exact', head: true }).eq('status', 'PENDING_REVIEW'),
          supabaseAdmin.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status', 'PENDING')
        ]);

        return sendSuccess(res, {
          totalUsers: users.count,
          activeCampaigns: campaigns.count,
          pendingSubmissions: submissions.count,
          pendingWithdrawals: withdrawals.count
        });
      }

      case 'get_campaigns_for_review': {
        const { data, error } = await supabaseAdmin
          .from('campaigns')
          .select(`
            *,
            advertiser:advertiser_id (full_name, email),
            task_types:task_type_id (name)
          `)
          .eq('status', 'SUBMITTED')
          .order('created_at', { ascending: false });

        if (error) throw error;
        return sendSuccess(res, { campaigns: data });
      }

      case 'review_campaign': {
        const { campaignId, action: reviewAction, adminNote } = req.body;
        if (!campaignId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Missing required fields.', 400);

        const { data, error } = await supabaseAdmin.rpc('admin_review_campaign', {
          p_campaign_id: campaignId,
          p_admin_id: profile.id,
          p_action: reviewAction,
          p_admin_note: adminNote || null
        });

        if (error) throw error;
        return sendSuccess(res, {}, `Campaign ${reviewAction.toLowerCase()} successfully.`);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown admin action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Admin API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
    const { sendNotification, sendAnnouncement } = require('../lib/notifications');

// Add new action for Admin Announcements
case 'create_announcement': {
  const { title, message, type } = req.body;
  if (!title || !message) return sendError(res, 'VALIDATION_ERROR', 'Title and message required.', 400);
  
  await sendAnnouncement(title, message, type);
  return sendSuccess(res, {}, 'Announcement published successfully.');
}

// Inside 'review_campaign' action (after successful DB RPC call):
if (reviewAction === 'APPROVED') {
  await sendNotification(campaign.advertiser_id, 'Campaign Approved!', `Your campaign "${campaign.title}" is now LIVE and visible to earners.`, 'CAMPAIGN');
} else if (reviewAction === 'REJECTED') {
  await sendNotification(campaign.advertiser_id, 'Campaign Rejected', `Your campaign "${campaign.title}" was rejected. Reason: ${adminNote || 'See admin feedback.'}`, 'CAMPAIGN');
}

// Inside 'process_withdrawal' action (after successful DB RPC call):
if (wdAction === 'COMPLETED') {
  await sendNotification(withdrawal.user_id, 'Withdrawal Processed', `Your withdrawal of ₦${withdrawal.amount} has been successfully processed to your bank account.`, 'WALLET');
} else if (wdAction === 'REJECTED') {
  await sendNotification(withdrawal.user_id, 'Withdrawal Rejected', `Your withdrawal request of ₦${withdrawal.amount} was rejected. Funds have been returned to your available balance.`, 'WALLET');
      }
  }
  case 'process_withdrawal': {
        const { withdrawalId, action: wdAction } = req.body;
        if (!withdrawalId || !wdAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);

        const { error } = await supabaseAdmin.rpc('admin_process_withdrawal', {
          p_withdrawal_id: withdrawalId,
          p_admin_id: profile.id,
          p_action: wdAction
        });

        if (error) throw error;
        return sendSuccess(res, {}, `Withdrawal ${wdAction.toLowerCase()} successfully.`);
    const { sendNotification, sendAnnouncement } = require('../lib/notifications');

// Add new action for Admin Announcements
case 'create_announcement': {
  const { title, message, type } = req.body;
  if (!title || !message) return sendError(res, 'VALIDATION_ERROR', 'Title and message required.', 400);
  
  await sendAnnouncement(title, message, type);
  return sendSuccess(res, {}, 'Announcement published successfully.');
}

// Inside 'review_campaign' action (after successful DB RPC call):
if (reviewAction === 'APPROVED') {
  await sendNotification(campaign.advertiser_id, 'Campaign Approved!', `Your campaign "${campaign.title}" is now LIVE and visible to earners.`, 'CAMPAIGN');
} else if (reviewAction === 'REJECTED') {
  await sendNotification(campaign.advertiser_id, 'Campaign Rejected', `Your campaign "${campaign.title}" was rejected. Reason: ${adminNote || 'See admin feedback.'}`, 'CAMPAIGN');
}

// Inside 'process_withdrawal' action (after successful DB RPC call):
if (wdAction === 'COMPLETED') {
  await sendNotification(withdrawal.user_id, 'Withdrawal Processed', `Your withdrawal of ₦${withdrawal.amount} has been successfully processed to your bank account.`, 'WALLET');
} else if (wdAction === 'REJECTED') {
  await sendNotification(withdrawal.user_id, 'Withdrawal Rejected', `Your withdrawal request of ₦${withdrawal.amount} was rejected. Funds have been returned to your available balance.`, 'WALLET');
}
  }
};
