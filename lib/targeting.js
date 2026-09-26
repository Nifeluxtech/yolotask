const { supabaseAdmin } = require('./supabase');

async function isEligibleForCampaign(campaign, earnerProfile) {
  if (campaign.status !== 'LIVE' && campaign.status !== 'APPROVED') return false;
  if (campaign.remaining_budget <= 0) return false;
  if (campaign.completed_quantity >= campaign.target_quantity) return false;
  if (!campaign.is_targeted) return true;

  if (campaign.target_genders && campaign.target_genders.length > 0) {
    if (!earnerProfile.gender || !campaign.target_genders.includes(earnerProfile.gender)) return false;
  }

  if (campaign.target_interest_ids && campaign.target_interest_ids.length > 0) {
    const { data: userInterests } = await supabaseAdmin
      .from('user_interests').select('interest_id').eq('user_id', earnerProfile.id);
    const userInterestIds = userInterests.map(i => i.interest_id);
    if (!campaign.target_interest_ids.some(id => userInterestIds.includes(id))) return false;
  }
  return true;
}

module.exports = { isEligibleForCampaign };
