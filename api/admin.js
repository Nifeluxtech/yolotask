// /api/admin.js
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { getPlatformStats } = require('../lib/analytics');
const { sendNotification, sendAnnouncement } = require('../lib/notifications');

const SETTING_RULES = {
  daily_checkin_reward:        { type: 'number', min: 0,   max: 10000 },
  min_withdrawal_amount:       { type: 'number', min: 100, max: 1000000 },
  referral_reward_earner:      { type: 'number', min: 0,   max: 10000 },
  referral_reward_advertiser_pct: { type: 'number', min: 0, max: 1 },
  maintenance_mode:            { type: 'boolean' },
  registrations_open:          { type: 'boolean' }
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['admin']);

    switch (action) {
      case 'get_dashboard_stats': {
        const stats = await getPlatformStats();
        return sendSuccess(res, { stats });
      }

      case 'get_campaigns_for_review': {
        const { data } = await supabaseAdmin
          .from('campaigns')
          .select('*, advertiser:advertiser_id(full_name), task_types:task_type_id(name)')
          .eq('status', 'SUBMITTED')
          .order('created_at', { ascending: false });
        return sendSuccess(res, { campaigns: data || [] });
      }

      case 'review_campaign': {
        const { campaignId, reviewAction, adminNote } = req.body;
        if (!campaignId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);

        const { data: campaign } = await supabaseAdmin.from('campaigns').select('title, advertiser_id').eq('id', campaignId).single();
        const { error } = await supabaseAdmin.rpc('admin_review_campaign', {
          p_campaign_id: campaignId, p_admin_id: profile.id, p_action: reviewAction, p_admin_note: adminNote
        });
        if (error) throw error;

        if (reviewAction === 'APPROVED') await sendNotification(campaign.advertiser_id, 'Campaign Approved!', `Your campaign "${campaign.title}" is now LIVE.`, 'CAMPAIGN');
        else if (reviewAction === 'REJECTED') await sendNotification(campaign.advertiser_id, 'Campaign Rejected', `Your campaign "${campaign.title}" was rejected.`, 'CAMPAIGN');

        return sendSuccess(res, {}, `Campaign ${reviewAction.toLowerCase()}.`);
      }

      case 'process_withdrawal': {
        const { withdrawalId, action: wdAction } = req.body;
        if (!withdrawalId || !wdAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);

        const { data: withdrawal } = await supabaseAdmin.from('withdrawals').select('user_id, amount').eq('id', withdrawalId).single();
        const { error } = await supabaseAdmin.rpc('admin_process_withdrawal', {
          p_withdrawal_id: withdrawalId, p_admin_id: profile.id, p_action: wdAction
        });
        if (error) throw error;

        const msg = wdAction === 'COMPLETED' ? `Withdrawal of ₦${withdrawal.amount} processed.` : 'Withdrawal rejected. Funds returned.';
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
        const { data } = await supabaseAdmin
          .from('earner_reputation')
          .select('*, profiles:user_id(full_name)')
          .order('tasks_completed', { ascending: false })
          .limit(50);
        return sendSuccess(res, { leaders: data || [] });
      }

      case 'get_withdrawals': {
        const { data } = await supabaseAdmin
          .from('withdrawals')
          .select('*, profiles:user_id(full_name)')
          .order('created_at', { ascending: false });
        return sendSuccess(res, { withdrawals: data || [] });
      }

      case 'get_users': {
        const { data } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, role, is_suspended, created_at')
          .order('created_at', { ascending: false })
          .limit(100);
        return sendSuccess(res, { users: data || [] });
      }

      case 'update_user_status': {
        const { userId, isSuspended } = req.body;
        if (!userId) return sendError(res, 'VALIDATION_ERROR', 'User ID required.', 400);

        const { error } = await supabaseAdmin
          .from('profiles')
          .update({ is_suspended: isSuspended, updated_at: new Date().toISOString() })
          .eq('id', userId);

        if (error) throw error;
        return sendSuccess(res, {}, `User ${isSuspended ? 'suspended' : 'unsuspended'} successfully.`);
      }

      case 'get_escalated_tasks': {
        const { data } = await supabaseAdmin
          .from('task_submissions')
          .select('id, campaign_id, earner_id, proof_url, created_at, campaign:campaign_id(title, advertiser_id), earner:earner_id(full_name, referral_code)')
          .eq('status', 'UNDER_REVIEW')
          .order('created_at', { ascending: false });
        return sendSuccess(res, { tasks: data || [] });
      }

      // ---------- PLATFORM SETTINGS ----------
      case 'get_platform_settings': {
        const keys = Object.keys(SETTING_RULES);
        const { data, error } = await supabaseAdmin
          .from('platform_settings')
          .select('key, value')
          .in('key', keys);
        if (error) throw error;

        const map = {};
        (data || []).forEach(row => { map[row.key] = row.value; });
        return sendSuccess(res, { settings: map });
      }

      case 'update_platform_settings': {
        const updates = req.body.settings;
        if (!updates || typeof updates !== 'object') {
          return sendError(res, 'VALIDATION_ERROR', 'Invalid settings payload.', 400);
        }

        const rows = [];
        for (const [key, raw] of Object.entries(updates)) {
          const rule = SETTING_RULES[key];
          if (!rule) return sendError(res, 'VALIDATION_ERROR', `Unknown setting: ${key}`, 400);

          if (rule.type === 'boolean') {
            rows.push({ key, value: !!raw });
          } else {
            const num = Number(raw);
            if (isNaN(num) || num < rule.min || num > rule.max) {
              return sendError(res, 'VALIDATION_ERROR', `${key} must be between ${rule.min} and ${rule.max}.`, 400);
            }
            rows.push({ key, value: num });
          }
        }

        if (rows.length === 0) return sendError(res, 'VALIDATION_ERROR', 'Nothing to update.', 400);

        const { error } = await supabaseAdmin
          .from('platform_settings')
          .upsert(rows, { onConflict: 'key' });

        if (error) throw error;
        return sendSuccess(res, {}, 'Platform settings updated. Changes are live immediately.');
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown admin action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Admin API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
};
