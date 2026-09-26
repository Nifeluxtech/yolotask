const { supabaseAdmin } = require('./supabase');
const { isEligibleForCampaign } = require('./targeting');
const { v4: uuidv4 } = require('uuid');

async function getTaskFeed(earnerId, profile) {
  const { data: campaigns, error } = await supabaseAdmin
    .from('campaigns').select(`*, task_types:task_type_id(*), campaign_targeting:campaign_targeting(gender), campaign_interests:campaign_interests(interest_id)`).eq('status', 'LIVE');
  if (error) throw error;

  const feed = [];
  for (const campaign of campaigns) {
    const { data: existing } = await supabaseAdmin.from('task_submissions').select('id').eq('campaign_id', campaign.id).eq('earner_id', earnerId).single();
    if (existing) continue;

    const formatted = { ...campaign, target_genders: campaign.campaign_targeting.map(t => t.gender), target_interest_ids: campaign.campaign_interests.map(t => t.interest_id) };
    if (await isEligibleForCampaign(formatted, profile)) {
      const isPremium = campaign.is_targeted;
      feed.push({
        id: campaign.id, title: campaign.title, task_type: campaign.task_types.name,
        reward: isPremium ? campaign.task_types.premium_earner_reward : campaign.task_types.base_earner_reward,
        slots_left: campaign.target_quantity - campaign.completed_quantity, is_premium: isPremium,
        destination_link: campaign.destination_link, instructions: campaign.instructions
      });
    }
  }
  return feed;
}

async function submitTaskProof(earnerId, campaignId, proofUrl) {
  // SECURITY PATCH: Strict URL Validation
  let validUrl;
  try {
    validUrl = new URL(proofUrl);
    if (!['https:', 'http:'].includes(validUrl.protocol)) throw new Error('Invalid protocol');
    if (['javascript:', 'data:', 'file:'].includes(validUrl.protocol)) throw new Error('Malicious URL');
  } catch (e) { throw { code: 'VALIDATION_ERROR', message: 'Invalid or unsafe proof URL.' }; }

  const { data: campaign, error: campError } = await supabaseAdmin.from('campaigns').select('*, task_types:task_type_id(*)').eq('id', campaignId).single();
  if (campError || !campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.' };
  if (campaign.status !== 'LIVE') throw { code: 'INVALID_STATE', message: 'Campaign not active.' };

  const { data: existing } = await supabaseAdmin.from('task_submissions').select('id').eq('campaign_id', campaignId).eq('earner_id', earnerId).single();
  if (existing) throw { code: 'DUPLICATE_SUBMISSION', message: 'Already submitted.' };

  const { data: submission, error: subError } = await supabaseAdmin.from('task_submissions').insert({
    id: uuidv4(), campaign_id: campaignId, earner_id: earnerId, proof_url: validUrl.href, status: 'PENDING_REVIEW'
  }).select().single();
  if (subError) throw subError;
  return submission;
}

async function getAdvertiserSubmissions(advertiserId) {
  const { data: campaigns } = await supabaseAdmin.from('campaigns').select('id, title').eq('advertiser_id', advertiserId);
  if (!campaigns || campaigns.length === 0) return [];
  
  const { data: submissions } = await supabaseAdmin.from('task_submissions').select('*, earner:earner_id(full_name, referral_code)').in('campaign_id', campaigns.map(c => c.id)).eq('status', 'PENDING_REVIEW').order('created_at', { ascending: false });
  const campMap = new Map(campaigns.map(c => [c.id, c.title]));
  return submissions.map(sub => ({ ...sub, campaign_title: campMap.get(sub.campaign_id) }));
}

async function reviewSubmission(advertiserId, submissionId, action) {
  if (!['APPROVED', 'REJECTED'].includes(action)) throw { code: 'VALIDATION_ERROR', message: 'Invalid action.' };
  const { data, error } = await supabaseAdmin.rpc('process_task_approval', { p_submission_id: submissionId, p_advertiser_id: advertiserId, p_action: action });
  if (error) throw { code: 'PROCESSING_ERROR', message: error.message };
  return data;
}

module.exports = { getTaskFeed, submitTaskProof, getAdvertiserSubmissions, reviewSubmission };
