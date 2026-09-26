const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { createCampaign, submitForReview, getAdvertiserCampaigns } = require('../lib/campaign-engine');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['advertiser']); // STRICT ROLE CHECK

    switch (action) {
      
      case 'create': {
        const campaign = await createCampaign(profile.id, req.body);
        return sendSuccess(res, { campaign }, 'Campaign draft created.');
      }

      case 'submit': {
        const { campaignId } = req.body;
        if (!campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        
        const result = await submitForReview(profile.id, campaignId);
        return sendSuccess(res, {}, result.message);
      }

      case 'get_list': {
        const status = req.body.status || null;
        const campaigns = await getAdvertiserCampaigns(profile.id, status);
        return sendSuccess(res, { campaigns });
      }

      // Future actions (pause, resume, delete, duplicate) will be added here
      // following the exact same secure pattern.

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown campaign action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Campaigns API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
  const { getCampaignAnalytics } = require('../lib/analytics');

// ... inside switch(action)
      case 'get_analytics': {
        const { campaignId } = req.body;
        if (!campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        
        const analytics = await getCampaignAnalytics(profile.id, campaignId);
        return sendSuccess(res, { analytics });
      }
};
