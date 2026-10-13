// /api/campaigns.js — Campaign lifecycle, advertiser management, and task browsing
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { sendNotification, pushToUser } = require('../lib/notifications');
const { createCampaign, submitForReview, getAdvertiserCampaigns } = require('../lib/campaign-engine');

async function fetchCampaignWithMeta(queryBuilder) {
  return queryBuilder.select(`
    *,
    platforms:platform_id(id, name, logo_url),
    task_types:task_type_id(id, name, base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward)
  `);
}

function normalizeCampaign(c) {
  const type = c.task_types || {};
  return {
    ...c,
    platform_name: c.platforms?.name || 'General',
    platform_logo: c.platforms?.logo_url || null,
    task_type_name: type.name || 'Task',
    earn_amount: c.is_targeted ? Number(type.premium_earner_reward || 0) : Number(type.base_earner_reward || 0),
    slots_left: Math.max(0, Number(c.target_quantity || 0) - Number(c.completed_quantity || 0))
  };
}

async function getReferenceData() {
  const [platforms, taskTypes, interests] = await Promise.all([
    supabaseAdmin.from('platforms').select('id, name, logo_url').eq('is_active', true).order('sort_order', { ascending: true }).order('name'),
    supabaseAdmin.from('task_types').select('id, name, base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward').eq('is_active', true).order('name'),
    supabaseAdmin.from('interests').select('id, name').order('name')
  ]);
  if (platforms.error) throw platforms.error;
  if (taskTypes.error) throw taskTypes.error;
  if (interests.error) throw interests.error;
  return { platforms: platforms.data || [], task_types: taskTypes.data || [], interests: interests.data || [] };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body || {};
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);
    const { profile } = await getAuthenticatedUser(req);

    switch (action) {
      case 'get_reference_data': {
        requireRole(profile, ['advertiser', 'admin']);
        return sendSuccess(res, await getReferenceData());
      }

      case 'get_advertiser_settings': {
        requireRole(profile, ['advertiser']);
        const { data, error } = await supabaseAdmin.from('profiles').select('business_name, business_website, business_contact_email, auto_approve_enabled, auto_approve_hours, low_balance_threshold, campaign_defaults').eq('id', profile.id).single();
        if (error) throw error;
        return sendSuccess(res, { settings: data || {} });
      }

      case 'update_advertiser_settings': {
        requireRole(profile, ['advertiser']);
        const allowedHours = Math.min(336, Math.max(12, Number(req.body.auto_approve_hours) || 48));
        const defaults = req.body.campaign_defaults && typeof req.body.campaign_defaults === 'object' ? req.body.campaign_defaults : {};
        const patch = {
          business_name: String(req.body.business_name || '').trim().slice(0, 160) || null,
          business_website: String(req.body.business_website || '').trim().slice(0, 300) || null,
          business_contact_email: String(req.body.business_contact_email || '').trim().slice(0, 200) || null,
          auto_approve_enabled: !!req.body.auto_approve_enabled,
          auto_approve_hours: allowedHours,
          low_balance_threshold: req.body.low_balance_threshold === null || req.body.low_balance_threshold === '' ? null : Math.max(0, Number(req.body.low_balance_threshold) || 0),
          campaign_defaults: {
            task_type_id: defaults.task_type_id || null,
            is_targeted: !!defaults.is_targeted,
            genders: Array.isArray(defaults.genders) ? defaults.genders.slice(0, 2) : [],
            interest_ids: Array.isArray(defaults.interest_ids) ? defaults.interest_ids.slice(0, 20) : []
          },
          updated_at: new Date().toISOString()
        };
        const { error } = await supabaseAdmin.from('profiles').update(patch).eq('id', profile.id);
        if (error) throw error;
        return sendSuccess(res, {}, 'Business settings saved.');
      }

      case 'create': {
        requireRole(profile, ['advertiser']);
        const payload = {
          ...req.body,
          task_type_id: req.body.task_type_id,
          title: String(req.body.title || '').trim(),
          instructions: String(req.body.instructions || '').trim(),
          destination_link: String(req.body.destination_link || '').trim(),
          is_targeted: !!req.body.is_targeted,
          target_quantity: Number(req.body.target_quantity),
          target_genders: Array.isArray(req.body.target_genders) ? req.body.target_genders : [],
          target_interest_ids: Array.isArray(req.body.target_interest_ids) ? req.body.target_interest_ids : []
        };
        if (!payload.title || !payload.task_type_id || !payload.instructions || !payload.destination_link) {
          return sendError(res, 'VALIDATION_ERROR', 'Title, task type, instructions, and destination link are required.', 400);
        }
        const campaign = await createCampaign(profile.id, payload);
        return sendSuccess(res, { campaign }, 'Campaign draft created.');
      }

      case 'get_list': {
        requireRole(profile, ['advertiser']);
        const campaigns = await getAdvertiserCampaigns(profile.id);
        return sendSuccess(res, { campaigns: (campaigns || []).map(normalizeCampaign) });
      }

      case 'submit': {
        requireRole(profile, ['advertiser']);
        const result = await submitForReview(profile.id, req.body.campaignId);
        return sendSuccess(res, result, 'Campaign submitted for review.');
      }

      case 'update_campaign': {
        requireRole(profile, ['advertiser']);
        const id = req.body.campaignId;
        if (!id) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        const patch = {};
        if (req.body.title !== undefined) patch.title = String(req.body.title).trim().slice(0, 200);
        if (req.body.instructions !== undefined) patch.instructions = String(req.body.instructions).trim().slice(0, 5000);
        if (req.body.destination_link !== undefined) patch.destination_link = String(req.body.destination_link).trim().slice(0, 1000);
        const { error } = await supabaseAdmin.from('campaigns').update(patch).eq('id', id).eq('advertiser_id', profile.id).in('status', ['DRAFT', 'LIVE', 'PAUSED']);
        if (error) throw error;
        return sendSuccess(res, {}, 'Campaign updated.');
      }

      case 'change_status': {
        requireRole(profile, ['advertiser']);
        const { campaignId, newStatus } = req.body;
        if (!campaignId || !['LIVE', 'PAUSED', 'CANCELLED'].includes(newStatus)) return sendError(res, 'VALIDATION_ERROR', 'Invalid campaign status change.', 400);
        const { data: campaign, error: loadError } = await supabaseAdmin.from('campaigns').select('id, status').eq('id', campaignId).eq('advertiser_id', profile.id).single();
        if (loadError || !campaign) return sendError(res, 'NOT_FOUND', 'Campaign not found.', 404);
        if (newStatus === 'LIVE' && !['PAUSED', 'LIVE'].includes(campaign.status)) return sendError(res, 'INVALID_STATE', 'Only paused campaigns can be resumed.', 400);
        if (newStatus === 'PAUSED' && campaign.status !== 'LIVE') return sendError(res, 'INVALID_STATE', 'Only live campaigns can be paused.', 400);
        const { error } = await supabaseAdmin.from('campaigns').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', campaignId).eq('advertiser_id', profile.id);
        if (error) throw error;
        return sendSuccess(res, {}, `Campaign ${newStatus.toLowerCase()}.`);
      }

      case 'get_active_campaigns': {
        requireRole(profile, ['earner', 'advertiser']);
        let builder = supabaseAdmin.from('campaigns').eq('status', 'LIVE').order('created_at', { ascending: false });
        if (req.body.platformId) builder = builder.eq('platform_id', req.body.platformId);
        if (req.body.taskTypeId) builder = builder.eq('task_type_id', req.body.taskTypeId);
        const { data, error } = await fetchCampaignWithMeta(builder);
        if (error) throw error;
        return sendSuccess(res, { campaigns: (data || []).map(normalizeCampaign) });
      }

      case 'get_campaign_details': {
        requireRole(profile, ['earner', 'advertiser']);
        if (!req.body.campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        const { data, error } = await fetchCampaignWithMeta(supabaseAdmin.from('campaigns').eq('id', req.body.campaignId).single());
        if (error) throw error;
        return sendSuccess(res, { campaign: normalizeCampaign(data) });
      }

      case 'start_task': {
        requireRole(profile, ['earner']);
        const { campaignId } = req.body;
        const { data: camp } = await supabaseAdmin.from('campaigns').select('*').eq('id', campaignId).eq('status', 'LIVE').single();
        if (!camp) return sendError(res, 'NOT_FOUND', 'Campaign not found or inactive.', 404);
        const { data, error } = await supabaseAdmin.rpc('claim_campaign_slot', { p_campaign_id: campaignId, p_earner_id: profile.id });
        if (error) throw error;
        if (!data?.submission_id) return sendError(res, 'CLAIM_FAILED', 'Could not claim slot. Try again.', 500);
        return sendSuccess(res, { submissionId: data.submission_id, expiresAt: data.expires_at }, 'Task started successfully.');
      }

      case 'submit_proof': {
        requireRole(profile, ['earner']);
        const { submissionId, proofUrl, comment } = req.body;
        if (!submissionId || !proofUrl) return sendError(res, 'VALIDATION_ERROR', 'Submission ID and proof URL required.', 400);
        const { error } = await supabaseAdmin.from('task_submissions').update({ proof_url: proofUrl, comment: String(comment || '').trim().slice(0, 500) || null, status: 'UNDER_REVIEW', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', submissionId).eq('earner_id', profile.id).eq('status', 'PENDING');
        if (error) throw error;
        return sendSuccess(res, {}, 'Proof submitted.');
      }

      case 'get_my_tasks': {
        requireRole(profile, ['earner']);
        const { data, error } = await supabaseAdmin.from('task_submissions').select('*, campaigns:campaign_id(id, title, description, target_link, destination_link, instructions, status, verification_window_hours, task_type_id, is_targeted, platforms:platform_id(name, logo_url), task_types:task_type_id(name))').eq('earner_id', profile.id).order('created_at', { ascending: false });
        if (error) throw error;
        return sendSuccess(res, { tasks: (data || []).map(t => ({ ...t, platform_name: t.campaigns?.platforms?.name || 'General', platform_logo: t.campaigns?.platforms?.logo_url || null, task_type_name: t.campaigns?.task_types?.name || 'Task', campaign_title: t.campaigns?.title || 'Unknown Task' })) });
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
