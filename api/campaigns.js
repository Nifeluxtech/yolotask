// /api/campaigns.js
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { createCampaign, submitForReview } = require('../lib/campaign-engine');
const { getCampaignAnalytics } = require('../lib/analytics');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    // --- Reference data (task types + interests for the create form) ---
    if (action === 'get_reference_data') {
      const { profile } = await getAuthenticatedUser(req);
      requireRole(profile, ['advertiser']);

      const [types, interests] = await Promise.all([
        supabaseAdmin.from('task_types').select('*').eq('is_active', true),
        supabaseAdmin.from('interests').select('*').eq('is_active', true)
      ]);

      return sendSuccess(res, {
        task_types: types.data || [],
        interests: interests.data || []
      });
    }

    // --- Authenticate + enforce Advertiser role for all other actions ---
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['advertiser']);

    switch (action) {
      case 'create': {
        const { title, task_type_id, instructions, destination_link, target_quantity } = req.body;
        if (!title || !task_type_id || !instructions || !destination_link || !target_quantity) {
          return sendError(res, 'VALIDATION_ERROR', 'Missing required fields.', 400);
        }
        const campaign = await createCampaign(profile.id, req.body);
        return sendSuccess(res, { campaign }, 'Draft created.');
      }

      case 'submit': {
        if (!req.body.campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        const result = await submitForReview(profile.id, req.body.campaignId);
        return sendSuccess(res, {}, result.message || 'Submitted for review.');
      }

      case 'get_list': {
        let query = supabaseAdmin
          .from('campaigns')
          .select('*, task_types:task_type_id(name)')
          .eq('advertiser_id', profile.id)
          .order('created_at', { ascending: false });

        if (req.body.status) query = query.eq('status', req.body.status);

        const { data, error } = await query;
        if (error) throw error;

        return sendSuccess(res, { campaigns: data || [] });
      }

      case 'get_analytics': {
        if (!req.body.campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);
        const analytics = await getCampaignAnalytics(profile.id, req.body.campaignId);
        return sendSuccess(res, { analytics });
      }

      case 'update_campaign': {
        const { campaignId, title, instructions, destination_link } = req.body;
        if (!campaignId) return sendError(res, 'VALIDATION_ERROR', 'Campaign ID required.', 400);

        // Only allow safe fields to be edited (never budget/quantity)
        const { error } = await supabaseAdmin
          .from('campaigns')
          .update({
            title: title,
            instructions: instructions,
            destination_link: destination_link,
            updated_at: new Date().toISOString()
          })
          .eq('id', campaignId)
          .eq('advertiser_id', profile.id); // Ownership check

        if (error) throw error;
        return sendSuccess(res, {}, 'Campaign updated.');
      }

      case 'change_status': {
        const { campaignId, newStatus } = req.body;
        if (!campaignId || !newStatus) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);

        // Allowed transitions only
        if (!['PAUSED', 'LIVE', 'CANCELLED'].includes(newStatus)) {
          return sendError(res, 'VALIDATION_ERROR', 'Invalid status.', 400);
        }

        const { error } = await supabaseAdmin.rpc('change_campaign_status', {
          p_campaign_id: campaignId,
          p_advertiser_id: profile.id,
          p_new_status: newStatus
        });

        if (error) throw { code: 'STATUS_ERROR', message: error.message, statusCode: 400 };
        return sendSuccess(res, {}, `Campaign ${newStatus.toLowerCase()} successfully.`);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Campaigns API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
};
