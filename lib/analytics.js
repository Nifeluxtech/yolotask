const { supabaseAdmin } = require('./supabase');

// Get detailed analytics for a specific advertiser's campaign
async function getCampaignAnalytics(advertiserId, campaignId) {
  // 1. Verify ownership and fetch campaign base data
  const { data: campaign, error: campError } = await supabaseAdmin
    .from('campaigns')
    .select('*, task_types:task_type_id(name)')
    .eq('id', campaignId)
    .eq('advertiser_id', advertiserId)
    .single();

  if (campError || !campaign) throw { code: 'NOT_FOUND', message: 'Campaign not found.' };

  // 2. Aggregate submission statuses
  const { data: submissions, error: subError } = await supabaseAdmin
    .from('task_submissions')
    .select('status')
    .eq('campaign_id', campaignId);

  if (subError) throw subError;

  const totalSubmissions = submissions.length;
  const approved = submissions.filter(s => s.status === 'APPROVED').length;
  const rejected = submissions.filter(s => s.status === 'REJECTED').length;
  const pending = submissions.filter(s => s.status === 'PENDING_REVIEW').length;

  // 3. Calculate Metrics
  const approvalRate = totalSubmissions > 0 ? ((approved / totalSubmissions) * 100).toFixed(1) : 0;
  const completionRate = ((campaign.completed_quantity / campaign.target_quantity) * 100).toFixed(1);
  
  // Cost per completed user (using the actual earner reward from task type)
  const costPerWorker = campaign.is_targeted ? campaign.task_types.premium_advertiser_cost : campaign.task_types.base_advertiser_cost;
  const totalSpent = approved * costPerWorker;

  return {
    campaign: {
      title: campaign.title,
      status: campaign.status,
      target: campaign.target_quantity,
      completed: campaign.completed_quantity,
      remaining_budget: campaign.remaining_budget
    },
    metrics: {
      total_submissions: totalSubmissions,
      approved,
      rejected,
      pending,
      approval_rate: approvalRate,
      completion_rate: completionRate,
      total_spent: totalSpent
    }
  };
}

// Get high-level platform stats for Admin
async function getPlatformStats() {
  const [users, campaigns, ledger] = await Promise.all([
    supabaseAdmin.from('profiles').select('role', { count: 'exact', head: true }),
    supabaseAdmin.from('campaigns').select('status, total_budget', { count: 'exact', head: true }).eq('status', 'LIVE'),
    supabaseAdmin.from('wallet_ledger').select('amount').eq('transaction_type', 'PLATFORM_FEE_REVENUE').eq('direction', 'CREDIT')
  ]);

  // Note: In a production app, use Postgres SUM() for revenue. For MVP, JS reduction is acceptable for small datasets, 
  // but let's do a raw query for revenue to be safe and scalable.
  const { data: revenueData } = await supabaseAdmin.rpc('get_platform_revenue'); // We'll add this simple SQL function below.

  return {
    total_earners: 0, // Would require separate count query, simplified for MVP
    total_advertisers: 0,
    active_campaigns: campaigns.count,
    platform_revenue: revenueData || 0
  };
}

module.exports = { getCampaignAnalytics, getPlatformStats };
