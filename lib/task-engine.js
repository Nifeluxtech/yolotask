// /lib/task-engine.js
const { supabaseAdmin } = require('./supabase');

/**
 * Validates that a string is a proper http/https URL.
 * Blocks javascript:, data:, and malformed strings.
 */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Builds the personalized task feed for an Earner.
 * - Only shows LIVE campaigns with remaining budget
 * - Hides campaigns the earner already submitted
 * - Applies Premium targeting (gender + interests)
 */
async function getTaskFeed(earnerId, profile) {
  // 1. Fetch earner gender + interests for targeting
  const { data: earnerProfile } = await supabaseAdmin
    .from('profiles')
    .select('id, gender')
    .eq('id', earnerId)
    .single();

  const { data: earnerInterests } = await supabaseAdmin
    .from('user_interests')
    .select('interest_id')
    .eq('user_id', earnerId);

  const interestIds = (earnerInterests || []).map(i => i.interest_id);
  const earnerGender = earnerProfile?.gender || null;

  // 2. Fetch all LIVE campaigns with budget remaining
  const { data: campaigns, error } = await supabaseAdmin
    .from('campaigns')
    .select('*, task_types:task_type_id(name, base_earner_reward, premium_earner_reward)')
    .eq('status', 'LIVE')
    .gt('remaining_budget', 0)
    .order('created_at', { ascending: false });

  if (error) throw error;
  if (!campaigns || campaigns.length === 0) return [];

  const campaignIds = campaigns.map(c => c.id);

  // 3. Exclude campaigns the earner already submitted to
  const { data: mySubmissions } = await supabaseAdmin
    .from('task_submissions')
    .select('campaign_id, status')
    .eq('earner_id', earnerId)
    .in('campaign_id', campaignIds);

  const submittedMap = new Map((mySubmissions || []).map(s => [s.campaign_id, s.status]));

  // 4. Load targeting rules for targeted campaigns only
  const targetedIds = campaigns.filter(c => c.is_targeted).map(c => c.id);
  const genderMap = new Map();
  const interestMap = new Map();

  if (targetedIds.length > 0) {
    const { data: genderTargets } = await supabaseAdmin
      .from('campaign_targeting')
      .select('campaign_id, gender')
      .in('campaign_id', targetedIds);

    (genderTargets || []).forEach(g => {
      if (!genderMap.has(g.campaign_id)) genderMap.set(g.campaign_id, []);
      genderMap.get(g.campaign_id).push(g.gender);
    });

    const { data: interestTargets } = await supabaseAdmin
      .from('campaign_interests')
      .select('campaign_id, interest_id')
      .in('campaign_id', targetedIds);

    (interestTargets || []).forEach(i => {
      if (!interestMap.has(i.campaign_id)) interestMap.set(i.campaign_id, []);
      interestMap.get(i.campaign_id).push(i.interest_id);
    });
  }

  // 5. Filter + build the feed
  const feed = [];

  for (const c of campaigns) {
    // Skip if already submitted
    if (submittedMap.has(c.id)) continue;

    // Skip expired campaigns
    if (c.end_date && new Date(c.end_date) < new Date()) continue;

    // Skip if no slots left
    const slotsLeft = c.target_quantity - c.completed_quantity;
    if (slotsLeft <= 0) continue;

    // Apply targeting filters
    if (c.is_targeted) {
      const genders = genderMap.get(c.id) || [];
      const interests = interestMap.get(c.id) || [];

      // Gender filter
      if (genders.length > 0 && (!earnerGender || !genders.includes(earnerGender))) continue;

      // Interest filter (must match at least one)
      if (interests.length > 0 && !interests.some(i => interestIds.includes(i))) continue;
    }

    const reward = c.is_targeted
      ? Number(c.task_types?.premium_earner_reward || 0)
      : Number(c.task_types?.base_earner_reward || 0);

    feed.push({
      id: c.id,
      title: c.title,
      instructions: c.instructions,
      destination_link: c.destination_link,
      proof_requirements: c.proof_requirements,
      task_type: c.task_types?.name || 'Task',
      is_premium: c.is_targeted,
      reward: reward,
      slots_left: slotsLeft,
      end_date: c.end_date
    });
  }

  return feed;
}

/**
 * Submits an Earner's proof for a task.
 * Validates URL format, campaign state, and prevents duplicates.
 */
async function submitTaskProof(earnerId, campaignId, proofUrl) {
  if (!isValidUrl(proofUrl)) {
    throw { code: 'VALIDATION_ERROR', message: 'Invalid proof URL. Must start with http:// or https://', statusCode: 400 };
  }

  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('id, status, remaining_budget, target_quantity, completed_quantity')
    .eq('id', campaignId)
    .single();

  if (!campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.', statusCode: 404 };
  if (campaign.status !== 'LIVE') throw { code: 'CAMPAIGN_CLOSED', message: 'This campaign is not accepting submissions.', statusCode: 400 };
  if (Number(campaign.remaining_budget) <= 0) throw { code: 'CAMPAIGN_FULL', message: 'This campaign has no remaining budget.', statusCode: 400 };
  if (campaign.completed_quantity >= campaign.target_quantity) throw { code: 'CAMPAIGN_FULL', message: 'All slots for this campaign are filled.', statusCode: 400 };

  // Prevent duplicate submissions
  const { data: existing } = await supabaseAdmin
    .from('task_submissions')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('earner_id', earnerId)
    .maybeSingle();

  if (existing) throw { code: 'DUPLICATE_SUBMISSION', message: 'You have already submitted this task.', statusCode: 400 };

  const { error } = await supabaseAdmin
    .from('task_submissions')
    .insert({
      campaign_id: campaignId,
      earner_id: earnerId,
      proof_url: proofUrl,
      status: 'PENDING_REVIEW'
    });

  if (error) throw { code: 'SUBMISSION_FAILED', message: error.message, statusCode: 500 };

  return { success: true };
}

/**
 * Fetches all PENDING_REVIEW submissions across an Advertiser's campaigns.
 * Uses separate queries (no complex joins) to avoid PostgREST crashes.
 */
async function getAdvertiserSubmissions(advertiserId) {
  const { data: campaigns, error: campError } = await supabaseAdmin
    .from('campaigns')
    .select('id, title')
    .eq('advertiser_id', advertiserId);

  if (campError) throw campError;
  if (!campaigns || campaigns.length === 0) return [];

  const campaignIds = campaigns.map(c => c.id);

  const { data: submissions, error: subError } = await supabaseAdmin
    .from('task_submissions')
    .select('id, campaign_id, earner_id, proof_url, status, created_at, earner:earner_id(full_name, referral_code)')
    .in('campaign_id', campaignIds)
    .eq('status', 'PENDING_REVIEW')
    .order('created_at', { ascending: false });

  if (subError) throw subError;
  if (!submissions) return [];

  const campaignMap = new Map(campaigns.map(c => [c.id, c.title]));

  return submissions.map(sub => ({
    ...sub,
    campaign_title: campaignMap.get(sub.campaign_id) || 'Unknown Campaign',
    earner: sub.earner || { full_name: 'Unknown User', referral_code: 'N/A' }
  }));
}

/**
 * Advertiser approves or rejects a submission.
 * Delegates all financial math to the atomic SQL function.
 */
async function reviewSubmission(advertiserId, submissionId, action) {
  if (!['APPROVED', 'REJECTED'].includes(action)) {
    throw { code: 'VALIDATION_ERROR', message: 'Invalid review action.', statusCode: 400 };
  }

  const { data, error } = await supabaseAdmin.rpc('process_task_approval', {
    p_submission_id: submissionId,
    p_advertiser_id: advertiserId,
    p_action: action
  });

  if (error) throw { code: 'REVIEW_FAILED', message: error.message, statusCode: 400 };

  return data;
}

module.exports = {
  isValidUrl,
  getTaskFeed,
  submitTaskProof,
  getAdvertiserSubmissions,
  reviewSubmission
};
