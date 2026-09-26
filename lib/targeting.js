const { supabaseAdmin } = require('./supabase');

// Check if an earner is eligible for a targeted campaign
async function isEligibleForCampaign(campaign, earnerProfile) {
  // 1. Basic Campaign Status Check
  if (campaign.status !== 'LIVE' && campaign.status !== 'APPROVED') return false;
  if (campaign.remaining_budget <= 0) return false;
  if (campaign.completed_quantity >= campaign.target_quantity) return false;

  // 2. If not targeted, it's a General Task (everyone is eligible)
  if (!campaign.is_targeted) return true;

  // 3. Check Gender Targeting
  if (campaign.target_genders && campaign.target_genders.length > 0) {
    if (!earnerProfile.gender || !campaign.target_genders.includes(earnerProfile.gender)) {
      return false;
    }
  }

  // 4. Check Interest Targeting
  if (campaign.target_interest_ids && campaign.target_interest_ids.length > 0) {
    // Fetch user interests
    const { data: userInterests } = await supabaseAdmin
      .from('user_interests')
      .select('interest_id')
      .eq('user_id', earnerProfile.id);
    
    const userInterestIds = userInterests.map(i => i.interest_id);
    const hasMatchingInterest = campaign.target_interest_ids.some(id => userInterestIds.includes(id));
    
    if (!hasMatchingInterest) return false;
  }

  return true;
}

module.exports = { isEligibleForCampaign };
