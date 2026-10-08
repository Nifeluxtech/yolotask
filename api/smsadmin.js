// /api/smsadmin.js — admin control (no service curation; catalog is live from SMSPool)
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const smspool = require('../lib/smspool');

const SMS_SETTING_RULES = {
  sms_enabled:     { type: 'boolean' },
  sms_usd_to_ngn_rate: { type: 'number', min: 100, max: 100000 },
  sms_markup:      { type: 'number', min: 1, max: 10 },
  sms_price_tier:  { type: 'number', min: 1, max: 3 }
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['admin']);

    switch (action) {
      case 'debug_smspool': {
        const report = await smspool.rawProbe();
        return sendSuccess(res, { report });
      }

      case 'get_balance': {
        const balance = await smspool.getBalance();
        return sendSuccess(res, { balance_usd: balance });
      }

      case 'get_sms_stats': {
        const [settingsRes, verRes] = await Promise.all([
          supabaseAdmin.from('platform_settings').select('key, value').in('key', Object.keys(SMS_SETTING_RULES)),
          supabaseAdmin.from('sms_verifications').select('user_id, service_name, country_name, status, charged_ngn, refunded, created_at')
            .order('created_at', { ascending: false }).limit(500)
        ]);
        const map = {};
        (settingsRes.data || []).forEach(r => { map[r.key] = r.value; });
        const enabled = map.sms_enabled === true || map.sms_enabled === 'true';

        const rows = verRes.data || [];
        const total = rows.length;
        const verified = rows.filter(r => r.status === 'VERIFIED').length;
        const revenue = rows
          .filter(r => r.status === 'VERIFIED' || (r.status === 'ACTIVE' && !r.refunded))
          .reduce((s, r) => s + Number(r.charged_ngn || 0), 0);

        const recent = rows.slice(0, 5);
        let recentEnriched = recent;
        if (recent.length > 0) {
          const userIds = [...new Set(recent.map(r => r.user_id))];
          const { data: users } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', userIds);
          const nameMap = new Map((users || []).map(u => [u.id, u.full_name]));
          recentEnriched = recent.map(r => ({ ...r, user_name: nameMap.get(r.user_id) || 'Unknown' }));
        }

        return sendSuccess(res, {
          enabled, total, verified,
          failed: rows.filter(r => r.status === 'FAILED' || r.status === 'CANCELLED').length,
          active: rows.filter(r => r.status === 'ACTIVE').length,
          revenue_ngn: revenue,
          success_rate: total ? Math.round((verified / total) * 100) : 0,
          recent: recentEnriched
        });
      }

      case 'get_settings': {
        const { data } = await supabaseAdmin.from('platform_settings').select('key, value').in('key', Object.keys(SMS_SETTING_RULES));
        const map = {};
        (data || []).forEach(r => { map[r.key] = r.value; });
        return sendSuccess(res, { settings: map });
      }

      case 'update_settings': {
        const updates = req.body.settings || {};
        const rows = [];
        for (const [key, raw] of Object.entries(updates)) {
          const rule = SMS_SETTING_RULES[key];
          if (!rule) return sendError(res, 'VALIDATION_ERROR', `Unknown setting: ${key}`, 400);
          if (rule.type === 'boolean') rows.push({ key, value: !!raw });
          else {
            const num = Number(raw);
            if (isNaN(num) || num < rule.min || num > rule.max) return sendError(res, 'VALIDATION_ERROR', `${key} must be between ${rule.min} and ${rule.max}.`, 400);
            rows.push({ key, value: num });
          }
        }
        if (rows.length === 0) return sendError(res, 'VALIDATION_ERROR', 'Nothing to update.', 400);
        const { error } = await supabaseAdmin.from('platform_settings').upsert(rows, { onConflict: 'key' });
        if (error) throw error;
        return sendSuccess(res, {}, 'SMS settings saved.');
      }

      case 'get_audit': {
        const { data, error } = await supabaseAdmin.from('sms_verifications').select('*')
          .order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        if (!data || data.length === 0) return sendSuccess(res, { verifications: [] });
        const userIds = [...new Set(data.map(v => v.user_id))];
        const { data: users } = await supabaseAdmin.from('profiles').select('id, full_name').in('id', userIds);
        const nameMap = new Map((users || []).map(u => [u.id, u.full_name]));
        return sendSuccess(res, { verifications: data.map(v => ({ ...v, user_name: nameMap.get(v.user_id) || 'Unknown' })) });
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown admin action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('SMS Admin API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
