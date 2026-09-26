const { supabaseAdmin } = require('./supabase');
const { isEligibleForCampaign } = require('./targeting');
const { v4: uuidv4 } = require('uuid');

// Get task feed for an earner
async function getTaskFeed(earnerId, profile) {
  // Fetch all LIVE campaigns with their task types and targeting
  const { data: campaigns, error } = await supabaseAdmin
    .from('campaigns')
    .select(`
      *,
      task_types:task_type_id (*),
      campaign_targeting:campaign_targeting (gender),
      campaign_interests:campaign_interests (interest_id)
    `)
    .eq('status', 'LIVE')
    .order('created_at', { ascending: false });

  if (error) throw error;

  const feed = [];

  for (const campaign of campaigns) {
    // Check if user already submitted
    const { data: existing } = await supabaseAdmin
      .from('task_submissions')
      .select('id')
      .eq('campaign_id', campaign.id)
      .eq('earner_id', earnerId)
      .single();

    if (existing) continue; // Skip if already submitted

    // Format targeting data for the helper
    const formattedCampaign = {
      ...campaign,
      target_genders: campaign.campaign_targeting.map(t => t.gender),
      target_interest_ids: campaign.campaign_interests.map(t => t.interest_id)
    };

    const eligible = await isEligibleForCampaign(formattedCampaign, profile);
    
    if (eligible) {
      // Determine if Premium (Targeted) or Base (General)
      const isPremium = campaign.is_targeted;
      const reward = isPremium ? campaign.task_types.premium_earner_reward : campaign.task_types.base_earner_reward;

      feed.push({
        id: campaign.id,
        title: campaign.title,
        task_type: campaign.task_types.name,
        reward: reward,
        slots_left: campaign.target_quantity - campaign.completed_quantity,
        is_premium: isPremium,
        destination_link: campaign.destination_link,
        instructions: campaign.instructions
      });
    }
  }

  return feed;
}

// Submit task proof securely
async function submitTaskProof(earnerId, campaignId, proofUrl) {
  // 1. Validate URL
  if (!proofUrl || !proofUrl.startsWith('http')) {
    throw { code: 'VALIDATION_ERROR', message: 'Invalid proof URL.' };
  }

  // 2. Fetch Campaign & Task Type
  const { data: campaign, error: campError } = await supabaseAdmin
    .from('campaigns')
    .select('*, task_types:task_type_id(*)')
    .eq('id', campaignId)
    .single();

  if (campError || !campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.' };
  if (campaign.status !== 'LIVE') throw { code: 'INVALID_STATE', message: 'Campaign is not active.' };

  // 3. Check Eligibility & Previous Submission
  const { data: existing } = await supabaseAdmin
    .from('task_submissions')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('earner_id', earnerId)
    .single();

  if (existing) throw { code: 'DUPLICATE_SUBMISSION', message: 'You have already submitted this task.' };

  // 4. Insert Submission
  const { data: submission, error: subError } = await supabaseAdmin
    .from('task_submissions')
    .insert({
      id: uuidv4(),
      campaign_id: campaignId,
      earner_id: earnerId,
      proof_url: proofUrl,
      status: 'PENDING_REVIEW'
    })
    .select()
    .single();

  if (subError) throw subError;

  return submission;
}

module.exports = { getTaskFeed, submitTaskProof };
