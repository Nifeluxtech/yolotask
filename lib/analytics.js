const { supabaseAdmin } = require('./supabase');

async function getCampaignAnalytics(advertiserId, campaignId) {
  const { data: campaign, error: campError } = await supabaseAdmin.from('campaigns').select('*, task_types:task_type_id(name)').eq('id', campaignId).eq('advertiser_id', advertiserId).single();
  if (campError || !campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.' };

  const { data: submissions } = await supabaseAdmin.from('task_submissions').select('status').eq('campaign_id', campaignId);
  const total = submissions.length;
  const approved = submissions.filter(s => s.status === 'APPROVED').length;
  const rejected = submissions.filter(s => s.status === 'REJECTED').length;
  const pending = submissions.filter(s => s.status === 'PENDING_REVIEW').length;

  const costPerWorker = campaign.is_targeted ? campaign.task_types.premium_advertiser_cost : campaign.task_types.base_advertiser_cost;
  
  return {
    campaign: { title: campaign.title, status: campaign.status, target: campaign.target_quantity, completed: campaign.completed_quantity, remaining_budget: campaign.remaining_budget },
    metrics: { total_submissions: total, approved, rejected, pending, approval_rate: total > 0 ? ((approved / total) * 100).toFixed(1) : 0, completion_rate: ((campaign.completed_quantity / campaign.target_quantity) * 100).toFixed(1), total_spent: approved * costPerWorker }
  };
}

async function getPlatformStats() {
  // Call the new SQL function directly. This completely bypasses the PostgREST Enum cache bug!
  const { data, error } = await supabaseAdmin.rpc('get_admin_dashboard_stats');
  
  if (error) {
    console.error("Error fetching admin stats:", error);
    // Return zeros if it fails so the dashboard doesn't crash
    return { 
      active_campaigns: 0, 
      pending_submissions: 0, 
      pending_withdrawals: 0, 
      platform_revenue: 0 
    };
  }

  return data;
}

module.exports = { getCampaignAnalytics, getPlatformStats };
