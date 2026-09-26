const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { createCampaign, submitForReview, getAdvertiserCampaigns } = require('../lib/campaign-engine');
const { getCampaignAnalytics } = require('../lib/analytics');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['advertiser']);

    switch (action) {
      case 'create': {
        const campaign = await createCampaign(profile.id, req.body);
        return sendSuccess(res, { campaign }, 'Draft created.');
      }
      case 'submit': {
        if (!req.body.campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        const result = await submitForReview(profile.id, req.body.campaignId);
        return sendSuccess(res, {}, result.message);
      }
      case 'get_list': {
        const campaigns = await getAdvertiserCampaigns(profile.id, req.body.status);
        return sendSuccess(res, { campaigns });
      }
      case 'get_analytics': {
        if (!req.body.campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        const analytics = await getCampaignAnalytics(profile.id, req.body.campaignId);
        return sendSuccess(res, { analytics });
      }
      default: return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
  case 'get_reference_data': {
        const [types, interests] = await Promise.all([
          supabaseAdmin.from('task_types').select('*').eq('is_active', true),
          supabaseAdmin.from('interests').select('*').eq('is_active', true)
        ]);
        return sendSuccess(res, { task_types: types.data, interests: interests.data });
  }
};
