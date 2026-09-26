const { supabaseAdmin } = require('./supabase');
const { v4: uuidv4 } = require('uuid');

// Calculate the exact budget required based on Task Type and Targeting
async function calculateRequiredBudget(taskTypeId, quantity, isTargeted) {
  const { data: taskType, error } = await supabaseAdmin
    .from('task_types')
    .select('base_advertiser_cost, premium_advertiser_cost')
    .eq('id', taskTypeId)
    .single();

  if (error || !taskType) throw { code: 'INVALID_TASK_TYPE', message: 'Invalid task type selected.' };
  if (quantity < 1 || quantity > 100000) throw { code: 'INVALID_QUANTITY', message: 'Quantity must be between 1 and 100,000.' };

  // If targeted, use premium (x2) rate, otherwise use base rate
  const costPerWorker = isTargeted ? taskType.premium_advertiser_cost : taskType.base_advertiser_cost;
  
  return {
    costPerWorker,
    totalBudget: costPerWorker * quantity
  };
}

// Create a new campaign (Saves as DRAFT)
async function createCampaign(advertiserId, payload) {
  const { title, description, task_type_id, instructions, proof_requirements, destination_link, is_targeted, target_quantity, start_date, end_date, target_genders, target_interest_ids } = payload;

  // 1. Calculate Budget Server-Side
  const { costPerWorker, totalBudget } = await calculateRequiredBudget(task_type_id, target_quantity, is_targeted);

  // 2. Validate Targeting
  if (is_targeted && (!target_genders || target_genders.length === 0) && (!target_interest_ids || target_interest_ids.length === 0)) {
    throw { code: 'VALIDATION_ERROR', message: 'Targeted campaigns must specify at least one gender or interest.' };
  }

  // 3. Insert Campaign
  const campaignId = uuidv4();
  const { data: campaign, error } = await supabaseAdmin
    .from('campaigns')
    .insert({
      id: campaignId,
      advertiser_id: advertiserId,
      task_type_id,
      title,
      description,
      instructions,
      proof_requirements,
      destination_link,
      is_targeted,
      target_quantity,
      total_budget: totalBudget,
      remaining_budget: totalBudget, // Initially same as total
      status: 'DRAFT',
      start_date: start_date || null,
      end_date: end_date || null
    })
    .select()
    .single();

  if (error) throw error;

  // 4. Insert Targeting Data (if applicable)
  if (is_targeted) {
    if (target_genders && target_genders.length > 0) {
      const genderRows = target_genders.map(g => ({ campaign_id: campaignId, gender: g }));
      await supabaseAdmin.from('campaign_targeting').insert(genderRows);
    }
    if (target_interest_ids && target_interest_ids.length > 0) {
      const interestRows = target_interest_ids.map(i => ({ campaign_id: campaignId, interest_id: i }));
      await supabaseAdmin.from('campaign_interests').insert(interestRows);
    }
  }

  return campaign;
}

// Submit Campaign for Admin Review
async function submitForReview(advertiserId, campaignId) {
  // 1. Fetch Campaign
  const { data: campaign, error } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('advertiser_id', advertiserId)
    .single();

  if (error || !campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.' };
  if (campaign.status !== 'DRAFT') throw { code: 'INVALID_STATE', message: 'Only draft campaigns can be submitted.' };

  // 2. Check Advertiser Wallet Balance
  const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', advertiserId).single();
  if (!wallet || wallet.available_balance < campaign.total_budget) {
    throw { code: 'INSUFFICIENT_FUNDS', message: `Insufficient wallet balance. Required: ₦${campaign.total_budget}` };
  }

  // 3. Update Status
  const { error: updateError } = await supabaseAdmin
    .from('campaigns')
    .update({ status: 'SUBMITTED' })
    .eq('id', campaignId);

  if (updateError) throw updateError;
  return { message: 'Campaign submitted for admin review.' };
}

// Get Campaigns for Advertiser
async function getAdvertiserCampaigns(advertiserId, statusFilter = null) {
  let query = supabaseAdmin.from('campaigns').select('*, task_types:task_type_id(name)').eq('advertiser_id', advertiserId);
  if (statusFilter) query = query.eq('status', statusFilter);
  
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

module.exports = { calculateRequiredBudget, createCampaign, submitForReview, getAdvertiserCampaigns };
