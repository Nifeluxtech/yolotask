// /api/sms.js — user-facing SMS verification (margin-protected)
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { sendNotification, pushToUser } = require('../lib/notifications');
const smspool = require('../lib/smspool');

const ACTIVE_TIMEOUT_MIN = 20;

async function getSettings() {
  const { data } = await supabaseAdmin.from('platform_settings').select('key, value')
    .in('key', ['sms_enabled', 'sms_usd_to_ngn_rate', 'sms_markup', 'sms_price_tier']);
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return {
    enabled: map.sms_enabled === true || map.sms_enabled === 'true',
    rate: Number(map.sms_usd_to_ngn_rate ?? 1600),
    markup: Number(map.sms_markup ?? 1.5),
    tier: Number(map.sms_price_tier ?? 2)
  };
}

function priceNgn(priceUsd, s) {
  return Math.round(priceUsd * s.markup * s.rate * 100) / 100;
}

async function refundUser(userId, amount, verificationId) {
  const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', userId).single();
  if (!wallet) return;
  await supabaseAdmin.from('wallets')
    .update({ available_balance: Number(wallet.available_balance) + amount, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  await supabaseAdmin.from('wallet_ledger').insert({
    user_id: userId, transaction_type: 'SMS_VERIFICATION_REFUND', amount,
    direction: 'CREDIT', status: 'COMPLETED', reference: 'SMSREF-' + verificationId
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['earner', 'advertiser']);

    switch (action) {
      case 'get_countries': {
        const s = await getSettings();
        if (!s.enabled) return sendSuccess(res, { enabled: false, countries: [] });
        const countries = await smspool.getCountries();
        return sendSuccess(res, { enabled: true, countries });
      }

      case 'get_services': {
        const s = await getSettings();
        if (!s.enabled) return sendSuccess(res, { enabled: false, services: [] });
        const services = await smspool.getServices();
        return sendSuccess(res, { enabled: true, services });
      }

      case 'get_quote': {
        const s = await getSettings();
        if (!s.enabled) return sendError(res, 'SMS_DISABLED', 'SMS verification is currently disabled.', 403);
        const { serviceId, countryId } = req.body;
        if (!serviceId || !countryId) return sendError(res, 'VALIDATION_ERROR', 'Service and country are required.', 400);

        const priceUsd = await smspool.getQuote(serviceId, countryId);
        if (!priceUsd) {
          return sendError(res, 'NO_POOLS', 'No number pools for this service + country right now. Try another country.', 400);
        }
        return sendSuccess(res, { price_ngn: priceNgn(priceUsd, s) });
      }

      case 'get_wallet_balance': {
        const { data } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', profile.id).single();
        return sendSuccess(res, { available_balance: Number(data?.available_balance || 0) });
      }

      case 'start_verification': {
        const s = await getSettings();
        if (!s.enabled) return sendError(res, 'SMS_DISABLED', 'SMS verification is currently disabled.', 403);

        const { serviceId, serviceName, countryId, countryName, social_username } = req.body;
        if (!serviceId || !countryId) return sendError(res, 'VALIDATION_ERROR', 'Service and country are required.', 400);

        const { data: active } = await supabaseAdmin.from('sms_verifications').select('id')
          .eq('user_id', profile.id).eq('status', 'ACTIVE').maybeSingle();
        if (active) return sendError(res, 'SMS_ACTIVE_EXISTS', 'You already have a verification in progress.', 400);

        const live = await smspool.getServices();
        const hit = live.find(x => x.smspool_service_id === Number(serviceId));
        if (!hit) return sendError(res, 'NOT_FOUND', 'Service not available on SMSPool.', 404);
        const canonicalName = hit.name || String(serviceName || 'Service');

        const priceUsd = await smspool.getQuote(hit.smspool_service_id, countryId);
        if (!priceUsd) return sendError(res, 'NO_POOLS', 'No pools for this service + country. Try another country.', 400);

        const charge = priceNgn(priceUsd, s);

        const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', profile.id).single();
        if (!wallet || Number(wallet.available_balance) < charge) {
          return sendError(res, 'INSUFFICIENT_FUNDS', `You need ${charge.toLocaleString()} NGN for this verification. Top up first.`, 400);
        }
        const { error: debitErr } = await supabaseAdmin.from('wallets')
          .update({ available_balance: Number(wallet.available_balance) - charge, updated_at: new Date().toISOString() })
          .eq('user_id', profile.id).eq('available_balance', wallet.available_balance);
        if (debitErr) throw debitErr;

        let order;
        try {
          // maxPrice guard: SMSPool may only assign pools at/below our quoted cost
          order = await smspool.orderNumber({ serviceId: hit.smspool_service_id, countryId, maxPrice: priceUsd });
        } catch (orderErr) {
          await refundUser(profile.id, charge, 'FAILED-ORDER');
          await supabaseAdmin.from('wallet_ledger').insert({
            user_id: profile.id, transaction_type: 'SMS_VERIFICATION', amount: charge,
            direction: 'DEBIT', status: 'COMPLETED', reference: 'SMS-FAILED-ORDER'
          });
          await supabaseAdmin.from('wallet_ledger').insert({
            user_id: profile.id, transaction_type: 'SMS_VERIFICATION_REFUND', amount: charge,
            direction: 'CREDIT', status: 'COMPLETED', reference: 'SMSREF-FAILED-ORDER'
          });
          throw orderErr;
        }

        const { data: row, error: insErr } = await supabaseAdmin.from('sms_verifications')
          .insert({
            user_id: profile.id,
            smspool_service_id: hit.smspool_service_id,
            service_name: canonicalName,
            country_id: Number(countryId),
            country_name: String(countryName || '').slice(0, 60) || null,
            social_username: (social_username || '').trim().slice(0, 80) || null,
            smspool_order_id: order.orderId,
            phone_number: order.number,
            status: 'ACTIVE',
            cost_usd: priceUsd,
            charged_ngn: charge
          })
          .select().single();
        if (insErr) throw insErr;

        await supabaseAdmin.from('wallet_ledger').insert({
          user_id: profile.id, transaction_type: 'SMS_VERIFICATION', amount: charge,
          direction: 'DEBIT', status: 'COMPLETED', reference: 'SMS-' + row.id
        });

        return sendSuccess(res, {
          verification: {
            id: row.id, number: row.number, service_name: row.service_name,
            country_name: row.country_name, charged_ngn: charge, status: 'ACTIVE'
          }
        }, `Number assigned. ${charge.toLocaleString()} NGN charged.`);
      }

      case 'poll_status': {
        const { verificationId } = req.body;
        if (!verificationId) return sendError(res, 'VALIDATION_ERROR', 'Verification ID required.', 400);

        const { data: row } = await supabaseAdmin.from('sms_verifications').select('*')
          .eq('id', verificationId).eq('user_id', profile.id).maybeSingle();
        if (!row) return sendError(res, 'NOT_FOUND', 'Verification not found.', 404);

        if (row.status !== 'ACTIVE') {
          return sendSuccess(res, { status: row.status, otp: row.otp, number: row.phone_number, refunded: row.refunded, service_name: row.service_name, country_name: row.country_name });
        }

        const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
        let state = 'WAITING';
        let smsText = '';
        let realCost = 0;

        if (ageMin > ACTIVE_TIMEOUT_MIN) {
          state = 'CANCELLED';
        } else {
          try {
            const st = await smspool.getStatus(row.smspool_order_id);
            state = st.state;
            smsText = st.smsText;
            realCost = Number(st.cost || 0);
          } catch (e) {
            return sendSuccess(res, { status: 'ACTIVE', otp: null, number: row.phone_number, service_name: row.service_name, country_name: row.country_name });
          }
        }

        // Record SMSPool's REAL charge for margin reporting (never shown to users)
        if (realCost > 0 && realCost !== Number(row.cost_usd)) {
          await supabaseAdmin.from('sms_verifications').update({ cost_usd: realCost }).eq('id', row.id);
        }

        if (state === 'RECEIVED') {
          const otp = smspool.extractOtp(smsText) || smsText.slice(0, 10);
          await supabaseAdmin.from('sms_verifications')
            .update({ status: 'VERIFIED', otp, updated_at: new Date().toISOString() }).eq('id', row.id);
          await sendNotification(profile.id, 'SMS Verified!', `Your ${row.service_name} (${row.country_name || ''}) verification succeeded. Code: ${otp}`, 'GENERAL');
          pushToUser(profile.id, 'SMS Verified!', `${row.service_name} verification complete. Code: ${otp}`);
          return sendSuccess(res, { status: 'VERIFIED', otp, number: row.phone_number, service_name: row.service_name, country_name: row.country_name });
        }

        if (state === 'CANCELLED') {
          await smspool.cancelOrder(row.smspool_order_id);
          await refundUser(profile.id, Number(row.charged_ngn), row.id);
          await supabaseAdmin.from('sms_verifications')
            .update({ status: 'FAILED', refunded: true, updated_at: new Date().toISOString() }).eq('id', row.id);
          await sendNotification(profile.id, 'SMS Verification Failed', `No code received for ${row.service_name}. Your wallet has been refunded.`, 'WALLET');
          return sendSuccess(res, { status: 'FAILED', otp: null, number: row.phone_number, refunded: true, service_name: row.service_name, country_name: row.country_name });
        }

        return sendSuccess(res, { status: 'ACTIVE', otp: null, number: row.phone_number, service_name: row.service_name, country_name: row.country_name });
      }

      case 'cancel_verification': {
        const { verificationId } = req.body;
        const { data: row } = await supabaseAdmin.from('sms_verifications').select('*')
          .eq('id', verificationId).eq('user_id', profile.id).maybeSingle();
        if (!row) return sendError(res, 'NOT_FOUND', 'Verification not found.', 404);
        if (row.status !== 'ACTIVE') return sendError(res, 'VALIDATION_ERROR', 'Only active verifications can be cancelled.', 400);

        await smspool.cancelOrder(row.smspool_order_id);
        await refundUser(profile.id, Number(row.charged_ngn), row.id);
        await supabaseAdmin.from('sms_verifications')
          .update({ status: 'CANCELLED', refunded: true, updated_at: new Date().toISOString() }).eq('id', row.id);

        return sendSuccess(res, {}, 'Cancelled and refunded.');
      }

      case 'get_history': {
        const { data, error } = await supabaseAdmin.from('sms_verifications').select('*')
          .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(50);
        if (error) throw error;
        return sendSuccess(res, { verifications: data || [] });
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('SMS API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
