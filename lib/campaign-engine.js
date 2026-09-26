const { supabaseAdmin } = require('./supabase');
const { v4: uuidv4 } = require('uuid');

async function calculateRequiredBudget(taskTypeId, quantity, isTargeted) {
  const { data: taskType, error } = await supabaseAdmin.from('task_types').select('base_advertiser_cost, premium_advertiser_cost').eq('id', taskTypeId).single();
  if (error || !taskType) throw { code: 'INVALID_TASK_TYPE', message: 'Invalid task type.' };
  if (quantity < 1 || quantity > 100000) throw { code: 'INVALID_QUANTITY', message: 'Quantity out of bounds.' };
  const costPerWorker = isTargeted ? taskType.premium_advertiser_cost : taskType.base_advertiser_cost;
  return { costPerWorker, totalBudget: costPerWorker * quantity };
}

async function createCampaign(advertiserId, payload) {
  const { title, description, task_type_id, instructions, proof_requirements, destination_link, is_targeted, target_quantity, start_date, end_date, target_genders, target_interest_ids } = payload;
  const { totalBudget } = await calculateRequiredBudget(task_type_id, target_quantity, is_targeted);

  if (is_targeted && (!target_genders || target_genders.length === 0) && (!target_interest_ids || target_interest_ids.length === 0)) {
    throw { code: 'VALIDATION_ERROR', message: 'Targeted campaigns require targeting criteria.' };
  }

  const campaignId = uuidv4();
  const { data: campaign, error } = await supabaseAdmin.from('campaigns').insert({
    id: campaignId, advertiser_id: advertiserId, task_type_id, title, description, instructions, proof_requirements, destination_link, is_targeted, target_quantity, total_budget: totalBudget, remaining_budget: totalBudget, status: 'DRAFT', start_date: start_date || null, end_date: end_date || null
  }).select().single();
  if (error) throw error;

  if (is_targeted) {
    if (target_genders?.length) await supabaseAdmin.from('campaign_targeting').insert(target_genders.map(g => ({ campaign_id: campaignId, gender: g })));
    if (target_interest_ids?.length) await supabaseAdmin.from('campaign_interests').insert(target_interest_ids.map(i => ({ campaign_id: campaignId, interest_id: i })));
  }
  return campaign;
}

async function submitForReview(advertiserId, campaignId) {
  const { data: campaign, error } = await supabaseAdmin.from('campaigns').select('*').eq('id', campaignId).eq('advertiser_id', advertiserId).single();
  if (error || !campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.' };
  if (campaign.status !== 'DRAFT') throw { code: 'INVALID_STATE', message: 'Only drafts can be submitted.' };

  const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', advertiserId).single();
  if (!wallet || wallet.available_balance < campaign.total_budget) throw { code: 'INSUFFICIENT_FUNDS', message: `Insufficient funds. Required: ₦${campaign.total_budget}` };

  await supabaseAdmin.from('campaigns').update({ status: 'SUBMITTED' }).eq('id', campaignId);
  return { message: 'Submitted for review.' };
}

async function getAdvertiserCampaigns(advertiserId, statusFilter = null) {
  let query = supabaseAdmin.from('campaigns').select('*, task_types:task_type_id(name)').eq('advertiser_id', advertiserId);
  if (statusFilter) query = query.eq('status', statusFilter);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

module.exports = { calculateRequiredBudget, createCampaign, submitForReview, getAdvertiserCampaigns };
