// /api/admin.js
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { getPlatformStats } = require('../lib/analytics');
const { sendNotification, sendAnnouncement, sendEmailBroadcast, pushToUser } = require('../lib/notifications');

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

      // ---------- STORAGE HYGIENE: delete proofs of decided tasks ----------
      case 'purge_decided_proofs': {
        const { data: rows, error } = await supabaseAdmin
          .from('task_submissions')
          .select('id, proof_url')
          .in('status', ['APPROVED', 'REJECTED'])
          .not('proof_url', 'is', null)
          .limit(100);

        if (error) throw error;
        if (!rows || rows.length === 0) return sendSuccess(res, { purged: 0 });

        const paths = rows
          .map(r => {
            try { return decodeURIComponent(r.proof_url.split('/proofs/').pop().split('?')[0]); } catch (e) { return null; }
          })
          .filter(p => p && p.endsWith('.jpg'));

        let purged = 0;
        if (paths.length > 0) {
          const { error: rmErr } = await supabaseAdmin.storage.from('proofs').remove(paths);
          if (rmErr) console.error('purge storage error:', rmErr);
          else purged = paths.length;
        }

        await supabaseAdmin
          .from('task_submissions')
          .update({ proof_url: null })
          .in('id', rows.map(r => r.id));

        return sendSuccess(res, { purged }, `Purged ${purged} decided proof images.`);
      }

      // ---------- PLATFORM CATALOG ----------
      case 'get_platforms': {
        const { data, error } = await supabaseAdmin
          .from('platforms').select('*').order('sort_order', { ascending: true }).order('name');
        if (error) throw error;
        return sendSuccess(res, { platforms: data || [] });
      }

      case 'add_platform': {
        const { name, logo_url } = req.body;
        if (!name || !String(name).trim()) return sendError(res, 'VALIDATION_ERROR', 'Platform name required.', 400);
        const { data, error } = await supabaseAdmin
          .from('platforms')
          .insert({ name: String(name).trim(), logo_url: (logo_url || '').trim() || null })
          .select().single();
        if (error) {
          if (error.code === '23505') throw { code: 'DUPLICATE', message: 'Platform already exists.', statusCode: 400 };
          throw error;
        }
        return sendSuccess(res, { platform: data }, 'Platform added.');
      }

      case 'update_platform': {
        const { id, name, logo_url, is_active } = req.body;
        if (!id) return sendError(res, 'VALIDATION_ERROR', 'Platform ID required.', 400);
        const patch = {};
        if (name !== undefined) patch.name = String(name).trim();
        if (logo_url !== undefined) patch.logo_url = (logo_url || '').trim() || null;
        if (is_active !== undefined) patch.is_active = !!is_active;
        const { error } = await supabaseAdmin.from('platforms').update(patch).eq('id', id);
        if (error) throw error;
        return sendSuccess(res, {}, 'Platform updated.');
      }

      case 'delete_platform': {
        const { id } = req.body;
        if (!id) return sendError(res, 'VALIDATION_ERROR', 'Platform ID required.', 400);
        const { error } = await supabaseAdmin.from('platforms').delete().eq('id', id);
        if (error) throw error;
        return sendSuccess(res, {}, 'Platform removed. Its campaigns now show as Other.');
      }

      case 'get_task_types': {
        const { data, error } = await supabaseAdmin.from('task_types').select('*').order('name');
        if (error) throw error;
        return sendSuccess(res, { task_types: data || [] });
      }

      case 'add_task_type': {
        const { name, base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward } = req.body;
        if (!name || !String(name).trim()) return sendError(res, 'VALIDATION_ERROR', 'Task type name required.', 400);
        const nums = [base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward].map(Number);
        if (nums.some(n => isNaN(n) || n < 0)) return sendError(res, 'VALIDATION_ERROR', 'All prices must be numbers ≥ 0.', 400);
        if (nums[1] >= nums[0] || nums[3] >= nums[2]) {
          return sendError(res, 'VALIDATION_ERROR', 'Earner reward must be lower than advertiser cost (platform margin).', 400);
        }
        const { data, error } = await supabaseAdmin
          .from('task_types')
          .insert({
            name: String(name).trim(),
            base_advertiser_cost: nums[0], base_earner_reward: nums[1],
            premium_advertiser_cost: nums[2], premium_earner_reward: nums[3],
            is_active: true
          })
          .select().single();
        if (error) {
          if (error.code === '23505') throw { code: 'DUPLICATE', message: 'Task type already exists.', statusCode: 400 };
          throw error;
        }
        return sendSuccess(res, { task_type: data }, 'Task type added.');
      }

      case 'update_task_type': {
        const { id, name, base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward, is_active } = req.body;
        if (!id) return sendError(res, 'VALIDATION_ERROR', 'Task type ID required.', 400);
        const patch = {};
        if (name !== undefined) patch.name = String(name).trim();
        if (base_advertiser_cost !== undefined) patch.base_advertiser_cost = Number(base_advertiser_cost);
        if (base_earner_reward !== undefined) patch.base_earner_reward = Number(base_earner_reward);
        if (premium_advertiser_cost !== undefined) patch.premium_advertiser_cost = Number(premium_advertiser_cost);
        if (premium_earner_reward !== undefined) patch.premium_earner_reward = Number(premium_earner_reward);
        if (is_active !== undefined) patch.is_active = !!is_active;
        const { error } = await supabaseAdmin.from('task_types').update(patch).eq('id', id);
        if (error) throw error;
        return sendSuccess(res, {}, 'Task type updated.');
      }

      // ---------- CORE ADMIN TOOLS ----------
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
        const { title, message, type, sendEmail } = req.body;
        if (!title || !message) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        if (sendEmail && !process.env.RESEND_API_KEY) {
          return sendError(res, 'EMAIL_NOT_CONFIGURED', 'Add RESEND_API_KEY to Vercel environment variables.', 500);
        }
        await sendAnnouncement(title, message, type);
        let emailResult = null;
        if (sendEmail) emailResult = await sendEmailBroadcast(title, message);
        const msg = emailResult
          ? `Published. Email sent to ${emailResult.sent} users${emailResult.failed ? ` (${emailResult.failed} failed)` : ''}.`
          : 'Published to in-app notifications.';
        return sendSuccess(res, { email: emailResult }, msg);
      }

      case 'get_leaderboard': {
        const period = req.body.period === 'month' ? 'month' : 'week';
        const kind = req.body.kind === 'referrals' ? 'referrals' : 'tasks';
        const { data, error } = await supabaseAdmin.rpc('get_leaderboard', { p_kind: kind, p_period: period });
        if (error) throw error;
        return sendSuccess(res, { leaders: data || [], period, kind });
      }

      case 'reward_leader': {
        const { userId, amount, note, period } = req.body;
        const amt = Number(amount);
        if (!userId) return sendError(res, 'VALIDATION_ERROR', 'User ID required.', 400);
        if (!amt || amt <= 0 || amt > 100000) return sendError(res, 'VALIDATION_ERROR', 'Reward must be between ₦1 and ₦100,000.', 400);
        const cleanNote = String(note || 'Leadership bonus').slice(0, 140);
        const periodLabel = String(period || '').slice(0, 40);

        const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', userId).single();
        if (!wallet) return sendError(res, 'WALLET_NOT_FOUND', 'This user has no wallet.', 404);
        const { error: updErr } = await supabaseAdmin.from('wallets')
          .update({ available_balance: Number(wallet.available_balance) + amt, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        if (updErr) throw updErr;

        const { error: ledErr } = await supabaseAdmin.from('wallet_ledger').insert({
          user_id: userId, transaction_type: 'ADMIN_BONUS', amount: amt, direction: 'CREDIT', status: 'COMPLETED', reference: 'BONUS-' + Date.now()
        });
        if (ledErr) throw ledErr;

        const { error: audErr } = await supabaseAdmin.from('reward_audit').insert({
          admin_id: profile.id, user_id: userId, amount: amt, note: cleanNote, period_label: periodLabel
        });
        if (audErr) throw audErr;

        await sendNotification(userId, 'Leadership Bonus!', `You received ₦${amt.toLocaleString()} for outstanding performance (${cleanNote}). Keep shining!`, 'WALLET');
        pushToUser(userId, 'Leadership Bonus!', `₦${amt.toLocaleString()} bonus credited to your wallet.`);
        return sendSuccess(res, {}, `Reward of ₦${amt.toLocaleString()} sent successfully.`);
      }

      case 'get_reward_history': {
        const { data: rows, error } = await supabaseAdmin.from('reward_audit')
          .select('id, user_id, amount, note, period_label, created_at')
          .order('created_at', { ascending: false }).limit(50);
        if (error) throw error;
        if (!rows || rows.length === 0) return sendSuccess(res, { rewards: [] });
        const userIds = [...new Set(rows.map(r => r.user_id))];
        const { data: users } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', userIds);
        const nameMap = new Map((users || []).map(u => [u.id, u.full_name]));
        return sendSuccess(res, { rewards: rows.map(r => ({ ...r, user_name: nameMap.get(r.user_id) || 'Unknown User' })) });
      }

      case 'get_withdrawals': {
        const { data } = await supabaseAdmin.from('withdrawals').select('*, profiles:user_id(full_name)').order('created_at', { ascending: false });
        return sendSuccess(res, { withdrawals: data || [] });
      }

      case 'get_users': {
        const { data } = await supabaseAdmin.from('profiles')
          .select('id, full_name, role, is_suspended, created_at')
          .order('created_at', { ascending: false }).limit(100);
        return sendSuccess(res, { users: data || [] });
      }

      case 'update_user_status': {
        const { userId, isSuspended } = req.body;
        if (!userId) return sendError(res, 'VALIDATION_ERROR', 'User ID required.', 400);
        const { error } = await supabaseAdmin.from('profiles')
          .update({ is_suspended: isSuspended, updated_at: new Date().toISOString() }).eq('id', userId);
        if (error) throw error;
        return sendSuccess(res, {}, `User ${isSuspended ? 'suspended' : 'unsuspended'} successfully.`);
      }

      case 'get_escalated_tasks': {
        const { data } = await supabaseAdmin.from('task_submissions')
          .select('id, campaign_id, earner_id, proof_url, status, created_at, comment, campaign:campaign_id(title, advertiser_id), earner:earner_id(full_name, referral_code)')
          .eq('status', 'UNDER_REVIEW').order('created_at', { ascending: false });
        return sendSuccess(res, { tasks: data || [] });
      }

      case 'get_platform_settings': {
        const keys = Object.keys(SETTING_RULES);
        const { data, error } = await supabaseAdmin.from('platform_settings').select('key, value').in('key', keys);
        if (error) throw error;
        const map = {};
        (data || []).forEach(row => { map[row.key] = row.value; });
        return sendSuccess(res, { settings: map });
      }

      case 'update_platform_settings': {
        const updates = req.body.settings;
        if (!updates || typeof updates !== 'object') return sendError(res, 'VALIDATION_ERROR', 'Invalid settings payload.', 400);
        const rows = [];
        for (const [key, raw] of Object.entries(updates)) {
          const rule = SETTING_RULES[key];
          if (!rule) return sendError(res, 'VALIDATION_ERROR', `Unknown setting: ${key}`, 400);
          if (rule.type === 'boolean') rows.push({ key, value: !!raw });
          else {
            const num = Number(raw);
            if (isNaN(num) || num < rule.min || num > rule.max) return sendError(res, 'VALIDATION_ERROR', `${key} must be between ${rule.min} and ${rule.max}.`, 400);
            rows.push({ key, value: num });
          }
        }
        if (rows.length === 0) return sendError(res, 'VALIDATION_ERROR', 'Nothing to update.', 400);
        const { error } = await supabaseAdmin.from('platform_settings').upsert(rows, { onConflict: 'key' });
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
