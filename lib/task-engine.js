// /lib/task-engine.js
const { supabaseAdmin } = require('./supabase');

function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}

function verificationLabel(hours) {
  const h = Number(hours) || 48;
  if (h <= 24) return 'Verification in ≤24h';
  if (h <= 48) return 'Verification in 24–48h';
  return `Verification in ≤${h}h`;
}

/**
 * Earner feed + filter catalogs.
 * Returns { tasks, platforms, task_types }
 */
async function getTaskFeed(earnerId, profile) {
  const { data: earnerProfile } = await supabaseAdmin
    .from('profiles').select('id, gender, hidden_task_types').eq('id', earnerId).single();

  const { data: earnerInterests } = await supabaseAdmin
    .from('user_interests').select('interest_id').eq('user_id', earnerId);

  const interestIds = (earnerInterests || []).map(i => i.interest_id);
  const earnerGender = earnerProfile?.gender || null;
  const hiddenTaskTypes = earnerProfile?.hidden_task_types || [];

  const { data: campaigns, error } = await supabaseAdmin
    .from('campaigns')
    .select('*, task_types:task_type_id(name, base_earner_reward, premium_earner_reward)')
    .eq('status', 'LIVE')
    .gt('remaining_budget', 0)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Filter catalogs for the UI (always returned, even if no campaigns)
  const [platformsRes, typesRes] = await Promise.all([
    supabaseAdmin.from('platforms').select('id, name, logo_url').eq('is_active', true).order('sort_order', { ascending: true }).order('name'),
    supabaseAdmin.from('task_types').select('id, name').eq('is_active', true).order('name')
  ]);
  const platforms = platformsRes.data || [];
  const task_types = typesRes.data || [];

  if (!campaigns || campaigns.length === 0) return { tasks: [], platforms, task_types };

  const campaignIds = campaigns.map(c => c.id);
  const { data: mySubmissions } = await supabaseAdmin
    .from('task_submissions').select('campaign_id, status')
    .eq('earner_id', earnerId).in('campaign_id', campaignIds);
  const submittedMap = new Map((mySubmissions || []).map(s => [s.campaign_id, s.status]));

  // Platform map
  const platformIds = [...new Set(campaigns.map(c => c.platform_id).filter(Boolean))];
  let platformMap = new Map();
  if (platformIds.length > 0) {
    const { data: plats } = await supabaseAdmin.from('platforms').select('id, name, logo_url').in('id', platformIds);
    platformMap = new Map((plats || []).map(p => [p.id, p]));
  }

  // Advertiser approval windows for verification chip
  const advertiserIds = [...new Set(campaigns.map(c => c.advertiser_id))];
  const { data: advs } = await supabaseAdmin.from('profiles').select('id, auto_approve_hours').in('id', advertiserIds);
  const hoursMap = new Map((advs || []).map(a => [a.id, a.auto_approve_hours]));

  // Targeting
  const targetedIds = campaigns.filter(c => c.is_targeted).map(c => c.id);
  const genderMap = new Map();
  const interestMap = new Map();
  if (targetedIds.length > 0) {
    const { data: g } = await supabaseAdmin.from('campaign_targeting').select('campaign_id, gender').in('campaign_id', targetedIds);
    (g || []).forEach(x => { if (!genderMap.has(x.campaign_id)) genderMap.set(x.campaign_id, []); genderMap.get(x.campaign_id).push(x.gender); });
    const { data: i } = await supabaseAdmin.from('campaign_interests').select('campaign_id, interest_id').in('campaign_id', targetedIds);
    (i || []).forEach(x => { if (!interestMap.has(x.campaign_id)) interestMap.set(x.campaign_id, []); interestMap.get(x.campaign_id).push(x.interest_id); });
  }

  const feed = [];
  for (const c of campaigns) {
    if (submittedMap.has(c.id)) continue;
    if (c.end_date && new Date(c.end_date) < new Date()) continue;
    if (hiddenTaskTypes.includes(c.task_type_id)) continue;
    const slotsLeft = c.target_quantity - c.completed_quantity;
    if (slotsLeft <= 0) continue;

    if (c.is_targeted) {
      const genders = genderMap.get(c.id) || [];
      const interests = interestMap.get(c.id) || [];
      if (genders.length > 0 && (!earnerGender || !genders.includes(earnerGender))) continue;
      if (interests.length > 0 && !interests.some(i => interestIds.includes(i))) continue;
    }

    const plat = c.platform_id ? platformMap.get(c.platform_id) : null;
    const reward = c.is_targeted
      ? Number(c.task_types?.premium_earner_reward || 0)
      : Number(c.task_types?.base_earner_reward || 0);

    feed.push({
      id: c.id,
      title: c.title,                                   // campaign title (subtitle on card)
      task_type: c.task_types?.name || 'Other Task',    // bold title on card
      task_type_id: c.task_type_id,
      platform_name: plat?.name || 'Other',
      platform_logo: plat?.logo_url || null,            // null → YOLOTASK logo in UI
      verification_label: verificationLabel(hoursMap.get(c.advertiser_id)),
      instructions: c.instructions,
      destination_link: c.destination_link,
      proof_requirements: c.proof_requirements,
      is_premium: c.is_targeted,
      reward,
      slots_left: slotsLeft,
      end_date: c.end_date
    });
  }

  return { tasks: feed, platforms, task_types };
}

async function submitTaskProof(earnerId, campaignId, proofUrl) {
  if (!isValidUrl(proofUrl)) {
    throw { code: 'VALIDATION_ERROR', message: 'Invalid proof URL. Must start with http:// or https://', statusCode: 400 };
  }
  const { data: campaign } = await supabaseAdmin.from('campaigns')
    .select('id, status, remaining_budget, target_quantity, completed_quantity').eq('id', campaignId).single();
  if (!campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.', statusCode: 404 };
  if (campaign.status !== 'LIVE') throw { code: 'CAMPAIGN_CLOSED', message: 'This campaign is not accepting submissions.', statusCode: 400 };
  if (Number(campaign.remaining_budget) <= 0) throw { code: 'CAMPAIGN_FULL', message: 'This campaign has no remaining budget.', statusCode: 400 };
  if (campaign.completed_quantity >= campaign.target_quantity) throw { code: 'CAMPAIGN_FULL', message: 'All slots for this campaign are filled.', statusCode: 400 };

  const { data: existing } = await supabaseAdmin.from('task_submissions').select('id')
    .eq('campaign_id', campaignId).eq('earner_id', earnerId).maybeSingle();
  if (existing) throw { code: 'DUPLICATE_SUBMISSION', message: 'You have already submitted this task.', statusCode: 400 };

  const { error } = await supabaseAdmin.from('task_submissions')
    .insert({ campaign_id: campaignId, earner_id: earnerId, proof_url: proofUrl, status: 'PENDING_REVIEW' });
  if (error) throw { code: 'SUBMISSION_FAILED', message: error.message, statusCode: 500 };
  return { success: true };
}

async function getAdvertiserSubmissions(advertiserId) {
  const { data: campaigns, error: campError } = await supabaseAdmin.from('campaigns').select('id, title').eq('advertiser_id', advertiserId);
  if (campError) throw campError;
  if (!campaigns || campaigns.length === 0) return [];
  const campaignIds = campaigns.map(c => c.id);
  const { data: submissions, error: subError } = await supabaseAdmin.from('task_submissions')
    .select('id, campaign_id, earner_id, proof_url, status, created_at, earner:earner_id(full_name, referral_code)')
    .in('campaign_id', campaignIds).eq('status', 'PENDING_REVIEW').order('created_at', { ascending: false });
  if (subError) throw subError;
  if (!submissions) return [];
  const campaignMap = new Map(campaigns.map(c => [c.id, c.title]));
  return submissions.map(sub => ({
    ...sub,
    campaign_title: campaignMap.get(sub.campaign_id) || 'Unknown Campaign',
    earner: sub.earner || { full_name: 'Unknown User', referral_code: 'N/A' }
  }));
}

async function reviewSubmission(advertiserId, submissionId, action) {
  if (!['APPROVED', 'REJECTED'].includes(action)) {
    throw { code: 'VALIDATION_ERROR', message: 'Invalid review action.', statusCode: 400 };
  }
  const { data, error } = await supabaseAdmin.rpc('process_task_approval', {
    p_submission_id: submissionId, p_advertiser_id: advertiserId, p_action: action
  });
  if (error) throw { code: 'REVIEW_FAILED', message: error.message, statusCode: 400 };
  return data;
}

module.exports = { isValidUrl, getTaskFeed, submitTaskProof, getAdvertiserSubmissions, reviewSubmission };
