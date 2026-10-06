// /api/campaigns.js
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { createCampaign, submitForReview } = require('../lib/campaign-engine');
const { getCampaignAnalytics } = require('../lib/analytics');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    if (action === 'get_reference_data') {
      const { profile } = await getAuthenticatedUser(req);
      requireRole(profile, ['advertiser']);

      const [types, interests] = await Promise.all([
        supabaseAdmin.from('task_types').select('*').eq('is_active', true),
        supabaseAdmin.from('interests').select('*').eq('is_active', true)
      ]);

      return sendSuccess(res, { task_types: types.data || [], interests: interests.data || [] });
    }

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

        const { error } = await supabaseAdmin
          .from('campaigns')
          .update({
            title: title,
            instructions: instructions,
            destination_link: destination_link,
            updated_at: new Date().toISOString()
          })
          .eq('id', campaignId)
          .eq('advertiser_id', profile.id);

        if (error) throw error;
        return sendSuccess(res, {}, 'Campaign updated.');
      }

      case 'change_status': {
        const { campaignId, newStatus } = req.body;
        if (!campaignId || !newStatus) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
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

      // ---------- ADVERTISER SETTINGS ----------
      case 'get_advertiser_settings': {
        const { data, error } = await supabaseAdmin
          .from('profiles')
          .select('business_name, business_website, business_contact_email, auto_approve_enabled, auto_approve_hours, low_balance_threshold, campaign_defaults')
          .eq('id', profile.id)
          .single();

        if (error) throw error;
        return sendSuccess(res, { settings: data });
      }

      case 'update_advertiser_settings': {
        const {
          business_name, business_website, business_contact_email,
          auto_approve_enabled, auto_approve_hours, low_balance_threshold, campaign_defaults
        } = req.body;

        // Validate approval window
        const hours = Number(auto_approve_hours);
        if (!Number.isInteger(hours) || hours < 12 || hours > 336) {
          return sendError(res, 'VALIDATION_ERROR', 'Approval window must be between 12 and 336 hours.', 400);
        }

        // Validate threshold (null = disabled)
        let threshold = null;
        if (low_balance_threshold !== null && low_balance_threshold !== undefined && String(low_balance_threshold).trim() !== '') {
          threshold = Number(low_balance_threshold);
          if (isNaN(threshold) || threshold < 0) {
            return sendError(res, 'VALIDATION_ERROR', 'Invalid balance threshold.', 400);
          }
        }

        // Validate contact email
        let cleanEmail = null;
        if (business_contact_email && String(business_contact_email).trim() !== '') {
          cleanEmail = String(business_contact_email).trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return sendError(res, 'VALIDATION_ERROR', 'Invalid contact email.', 400);
          }
        }

        // Normalize website
        let cleanSite = null;
        if (business_website && String(business_website).trim() !== '') {
          cleanSite = String(business_website).trim();
          if (!/^https?:\/\//i.test(cleanSite)) cleanSite = 'https://' + cleanSite;
          try { new URL(cleanSite); } catch (e) {
            return sendError(res, 'VALIDATION_ERROR', 'Invalid website URL.', 400);
          }
        }

        // Sanitize campaign defaults
        const defaults = campaign_defaults || {};
        const safeDefaults = {
          task_type_id: typeof defaults.task_type_id === 'string' ? defaults.task_type_id : null,
          is_targeted: !!defaults.is_targeted,
          genders: Array.isArray(defaults.genders) ? defaults.genders.filter(g => g === 'male' || g === 'female') : [],
          interest_ids: Array.isArray(defaults.interest_ids) ? defaults.interest_ids.slice(0, 20) : []
        };

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .update({
            business_name: (business_name || '').trim() || null,
            business_website: cleanSite,
            business_contact_email: cleanEmail,
            auto_approve_enabled: !!auto_approve_enabled,
            auto_approve_hours: hours,
            low_balance_threshold: threshold,
            campaign_defaults: safeDefaults,
            updated_at: new Date().toISOString()
          })
          .eq('id', profile.id)
          .select('business_name, business_website, business_contact_email, auto_approve_enabled, auto_approve_hours, low_balance_threshold, campaign_defaults')
          .single();

        if (error) throw error;
        return sendSuccess(res, { settings: data }, 'Business settings saved.');
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
