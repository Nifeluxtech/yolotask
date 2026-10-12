// /api/campaigns.js — Full campaign lifecycle: browse, start, submit, track
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { sendNotification, pushToUser } = require('../lib/notifications');

/** Helper: Always join platforms/task_types to prevent "Other" labels */
async function fetchCampaignWithMeta(queryBuilder) {
  return await queryBuilder.select(`
    *,
    platforms:platform_id(id, name, logo_url),
    task_types:task_type_id(id, name, base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward)
  `);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    const auth = await getAuthenticatedUser(req);
    const profile = auth.profile;

    switch (action) {
      // ═══════════════════════════════════════════
      // BROWSE ACTIVE CAMPAIGNS (Earner Dashboard)
      // ═══════════════════════════════════════════
      case 'get_active_campaigns': {
        requireRole(profile, ['earner', 'advertiser']);
        
        let builder = supabaseAdmin.from('campaigns')
          .eq('status', 'ACTIVE')
          .order('created_at', { ascending: false });

        // Optional filters from request body
        if (req.body.platformId) builder = builder.eq('platform_id', req.body.platformId);
        if (req.body.taskTypeId) builder = builder.eq('task_type_id', req.body.taskTypeId);
        if (req.body.search) {
          const term = `%${req.body.search}%`;
          builder = builder.or(`title.ilike.${term},description.ilike.${term}`);
        }

        const { data, error } = await fetchCampaignWithMeta(builder);
        if (error) throw error;

        // Normalize response shape for frontend safety
        const campaigns = (data || []).map(c => ({
          ...c,
          platform_name: c.platforms?.name || 'General',
          platform_logo: c.platforms?.logo_url || null,
          task_type_name: c.task_types?.name || 'Task',
          earn_amount: c.tier === 'PREMIUM'
            ? Number(c.task_types?.premium_earner_reward || 0)
            : Number(c.task_types?.base_earner_reward || 0),
          slots_left: Math.max(0, (c.total_slots || 0) - (c.filled_slots || 0))
        }));

        return sendSuccess(res, { campaigns });
      }

      // ═══════════════════════════════════════════
      // SINGLE CAMPAIGN DETAILS
      // ═══════════════════════════════════════════
      case 'get_campaign_details': {
        requireRole(profile, ['earner', 'advertiser']);
        const { campaignId } = req.body;
        if (!campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);

        const { data, error } = await fetchCampaignWithMeta(
          supabaseAdmin.from('campaigns').eq('id', campaignId).single()
        );
        if (error) throw error;

        // Check if this user already has an active submission for this campaign
        const { data: existingSub } = await supabaseAdmin.from('task_submissions')
          .select('id, status')
          .eq('campaign_id', campaignId)
          .eq('earner_id', profile.id)
          .in('status', ['PENDING', 'UNDER_REVIEW'])
          .maybeSingle();

        return sendSuccess(res, { 
          campaign: {
            ...data,
            platform_name: data.platforms?.name || 'General',
            platform_logo: data.platforms?.logo_url || null,
            task_type_name: data.task_types?.name || 'Task',
            earn_amount: data.tier === 'PREMIUM'
              ? Number(data.task_types?.premium_earner_reward || 0)
              : Number(data.task_types?.base_earner_reward || 0),
            slots_left: Math.max(0, (data.total_slots || 0) - (data.filled_slots || 0)),
            has_pending_submission: !!existingSub
          }
        });
      }

      // ═══════════════════════════════════════════
      // START TASK (Claim Slot + Create Submission)
      // ═══════════════════════════════════════════
      case 'start_task': {
        requireRole(profile, ['earner']);
        const { campaignId } = req.body;
        if (!campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);

        // 1. Verify campaign exists, is active, and has slots
        const { data: camp, error: campErr } = await supabaseAdmin.from('campaigns')
          .select('*')
          .eq('id', campaignId)
          .eq('status', 'ACTIVE')
          .single();
        if (campErr || !camp) return sendError(res, 'NOT_FOUND', 'Campaign not found or inactive.', 404);
        if ((camp.total_slots || 0) <= (camp.filled_slots || 0)) {
          return sendError(res, 'SLOTS_FULL', 'This campaign is fully booked.', 400);
        }

        // 2. Prevent duplicate pending submissions per campaign
        const { data: dupCheck } = await supabaseAdmin.from('task_submissions')
          .select('id')
          .eq('campaign_id', campaignId)
          .eq('earner_id', profile.id)
          .in('status', ['PENDING', 'UNDER_REVIEW'])
          .maybeSingle();
        if (dupCheck) {
          return sendError(res, 'ALREADY_STARTED', 'You already have an active submission for this task.', 400);
        }

        // 3. Atomically increment filled_slots AND create submission in one RPC call
        //    This prevents race conditions where two users claim the last slot simultaneously
        const { data: subResult, error: rpcErr } = await supabaseAdmin.rpc('claim_campaign_slot', {
          p_campaign_id: campaignId,
          p_earner_id: profile.id
        });
        if (rpcErr) throw rpcErr;
        if (!subResult || !subResult.submission_id) {
          return sendError(res, 'CLAIM_FAILED', 'Could not claim slot. Try again.', 500);
        }

        return sendSuccess(res, {
          submissionId: subResult.submission_id,
          expiresAt: subResult.expires_at,
          message: 'Slot claimed! Complete the task and submit proof before expiry.'
        }, 'Task started successfully.');
      }

      // ═══════════════════════════════════════════
      // SUBMIT PROOF (Upload Evidence)
      // ═══════════════════════════════════════════
      case 'submit_proof': {
        requireRole(profile, ['earner']);
        const { submissionId, proofUrl, comment } = req.body;
        if (!submissionId || !proofUrl) {
          return sendError(res, 'VALIDATION_ERROR', 'Submission ID and proof URL required.', 400);
        }

        // 1. Verify submission belongs to this user and is still PENDING
        const { data: sub, error: subErr } = await supabaseAdmin.from('task_submissions')
          .select('*, campaigns:campaign_id(title, verification_window_hours)')
          .eq('id', submissionId)
          .eq('earner_id', profile.id)
          .eq('status', 'PENDING')
          .single();
        if (subErr || !sub) return sendError(res, 'NOT_FOUND', 'Submission not found or already processed.', 404);

        // 2. Check expiry window
        const createdAt = new Date(sub.created_at).getTime();
        const windowHours = sub.campaigns?.verification_window_hours || 24;
        const deadline = createdAt + (windowHours * 60 * 60 * 1000);
        if (Date.now() > deadline) {
          await supabaseAdmin.from('task_submissions')
            .update({ status: 'EXPIRED', updated_at: new Date().toISOString() })
            .eq('id', submissionId);
          return sendError(res, 'EXPIRED', 'Submission window closed. Contact support if this seems wrong.', 400);
        }

        // 3. Update submission with proof
        const { error: updErr } = await supabaseAdmin.from('task_submissions')
          .update({
            proof_url: proofUrl,
            comment: (comment || '').trim().slice(0, 500) || null,
            status: 'UNDER_REVIEW',
            submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', submissionId);
        if (updErr) throw updErr;

        // 4. Notify advertiser their task has a new review item
        const { data: advProfile } = await supabaseAdmin.from('profiles')
          .select('id').eq('id', sub.campaigns?.advertiser_id).single();
        if (advProfile) {
          await sendNotification(advProfile.id, 'New Task Submission', 
            `"${sub.campaigns?.title}" received a new proof submission awaiting your review.`, 'CAMPAIGN');
        }

        return sendSuccess(res, {}, 'Proof submitted! You\'ll be notified when reviewed.');
      }

      // ═══════════════════════════════════════════
      // MY TASKS (Earner History & Active)
      // ═══════════════════════════════════════════
      case 'get_my_tasks': {
        requireRole(profile, ['earner']);
        const statusFilter = req.body.status; // optional: PENDING | UNDER_REVIEW | APPROVED | REJECTED | EXPIRED
        
        let builder = supabaseAdmin.from('task_submissions')
          .eq('earner_id', profile.id)
          .order('created_at', { ascending: false });
        
        if (statusFilter) builder = builder.eq('status', statusFilter);

        const { data, error } = await builder.select(`
          *,
          campaigns:campaign_id(id, title, description, target_link, instructions, status, verification_window_hours),
          platforms:campaigns(platform_id->platforms(name, logo_url))
        `);
        if (error) throw error;

        const tasks = (data || []).map(t => ({
          ...t,
          platform_name: t.platforms?.name || 'General',
          platform_logo: t.platforms?.logo_url || null,
          campaign_title: t.campaigns?.title || 'Unknown Task',
          campaign_link: t.campaigns?.target_link || '#',
          is_expired: (() => {
            if (!t.campaigns?.verification_window_hours || t.status !== 'PENDING') return false;
            const deadline = new Date(t.created_at).getTime() + (t.campaigns.verification_window_hours * 3600000);
            return Date.now() > deadline;
          })()
        }));

        return sendSuccess(res, { tasks });
      }

      // ═══════════════════════════════════════════
      // ADVERTISER: VIEW OWN CAMPAIGN SUBMISSIONS
      // ═══════════════════════════════════════════
      case 'get_campaign_submissions': {
        requireRole(profile, ['advertiser']);
        const { campaignId } = req.body;
        if (!campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);

        // Verify ownership
        const { data: camp } = await supabaseAdmin.from('campaigns')
          .select('advertiser_id').eq('id', campaignId).single();
        if (!camp || camp.advertiser_id !== profile.id) {
          return sendError(res, 'FORBIDDEN', 'You do not own this campaign.', 403);
        }

        const { data, error } = await supabaseAdmin.from('task_submissions')
          .eq('campaign_id', campaignId)
          .order('submitted_at', { ascending: false })
          .select(`
            *,
            profiles:earner_id(full_name, avatar_url, email)
          `);
        if (error) throw error;

        return sendSuccess(res, { submissions: data || [] });
      }

      // ═══════════════════════════════════════════
      // ADVERTISER: REVIEW A SUBMISSION
      // ═══════════════════════════════════════════
      case 'review_submission': {
        requireRole(profile, ['advertiser']);
        const { submissionId, reviewAction, adminNote } = req.body;
        if (!submissionId || !['APPROVE', 'REJECT'].includes(reviewAction)) {
          return sendError(res, 'VALIDATION_ERROR', 'Valid submissionId and reviewAction required.', 400);
        }

        // 1. Load submission + verify advertiser owns the parent campaign
        const { data: sub, error: subErr } = await supabaseAdmin.from('task_submissions')
          .select('*, campaigns:campaign_id(advertiser_id, title, task_type_id)')
          .eq('id', submissionId)
          .eq('status', 'UNDER_REVIEW')
          .single();
        if (subErr || !sub) return sendError(res, 'NOT_FOUND', 'Submission not found or already reviewed.', 404);
        if (sub.campaigns.advertiser_id !== profile.id) {
          return sendError(res, 'FORBIDDEN', 'Not your campaign.', 403);
        }

        // 2. Execute approval/rejection via atomic RPC (handles wallet credit/debit safely)
        const finalStatus = reviewAction === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        const { error: rpcErr } = await supabaseAdmin.rpc('process_task_review', {
          p_submission_id: submissionId,
          p_advertiser_id: profile.id,
          p_action: finalStatus,
          p_note: (adminNote || '').trim().slice(0, 500) || null
        });
        if (rpcErr) throw rpcErr;

        // 3. Notify earner
        const msg = finalStatus === 'APPROVED'
          ? `✅ Your "${sub.campaigns.title}" submission was approved! Rewards credited to wallet.`
          : `❌ Your "${sub.campaigns.title}" submission was rejected.${adminNote ? ' Reason: ' + adminNote : ''}`;
        await sendNotification(sub.earner_id, 
          finalStatus === 'APPROVED' ? 'Task Approved!' : 'Task Rejected', msg, 'TASK');
        pushToUser(sub.earner_id,
          finalStatus === 'APPROVED' ? 'Rewards Credited 💰' : 'Submission Update', msg);

        return sendSuccess(res, {}, `Submission ${finalStatus.toLowerCase()}.`);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Campaigns API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
