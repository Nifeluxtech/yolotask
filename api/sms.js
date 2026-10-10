// /api/sms.js — dual-provider SMS verification (5sim = cheap, SMSPool = standard)
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const { sendNotification, pushToUser } = require('../lib/notifications');
const smspool = require('../lib/smspool');
const fivesim = require('../lib/fivesim');

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

async function quoteFor(provider, countryKey, serviceKey) {
  if (provider === 'fivesim') {
    return await fivesim.getQuote(countryKey, serviceKey); // {cost, operator} or null
  }
  const priceUsd = await smspool.getQuote(serviceKey, countryKey);
  return priceUsd ? { cost: priceUsd, operator: null } : null;
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
      case 'get_catalog': {
        const s = await getSettings();
        if (!s.enabled) return sendSuccess(res, { enabled: false, countries: [] });
        const provider = req.body.provider === 'fivesim' ? 'fivesim' : 'smspool';
        const countries = provider === 'fivesim' ? await fivesim.getCountries() : await smspool.getCountries();
        return sendSuccess(res, { enabled: true, countries });
      }

      case 'get_services': {
        const s = await getSettings();
        if (!s.enabled) return sendSuccess(res, { enabled: false, services: [] });
        const provider = req.body.provider === 'fivesim' ? 'fivesim' : 'smspool';
        const countryKey = req.body.countryKey;

        if (provider === 'fivesim') {
          if (!countryKey) return sendSuccess(res, { services: [] });
          const services = await fivesim.getServicesForCountry(countryKey);
          return sendSuccess(res, { services });
        }
        const services = await smspool.getServices();
        return sendSuccess(res, { services });
      }

      case 'get_quote': {
        const s = await getSettings();
        if (!s.enabled) return sendError(res, 'SMS_DISABLED', 'SMS verification is currently disabled.', 403);
        const provider = req.body.provider === 'fivesim' ? 'fivesim' : 'smspool';
        const { countryKey, serviceKey } = req.body;
        if (!countryKey || !serviceKey) return sendError(res, 'VALIDATION_ERROR', 'Country and service are required.', 400);

        const q = await quoteFor(provider, countryKey, serviceKey);
        if (!q || !q.cost) {
          return sendError(res, 'NO_POOLS',
            provider === 'fivesim'
              ? 'No cheap numbers in stock for this country/service right now.'
              : 'No number pools for this service + country. Try another country.', 400);
        }
        return sendSuccess(res, { price_ngn: priceNgn(q.cost, s) });
      }

      case 'get_wallet_balance': {
        const { data } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', profile.id).single();
        return sendSuccess(res, { available_balance: Number(data?.available_balance || 0) });
      }

      case 'start_verification': {
        const s = await getSettings();
        if (!s.enabled) return sendError(res, 'SMS_DISABLED', 'SMS verification is currently disabled.', 403);

        const provider = req.body.provider === 'fivesim' ? 'fivesim' : 'smspool';
        const { countryKey, countryName, serviceKey, serviceName, social_username } = req.body;
        if (!countryKey || !serviceKey) return sendError(res, 'VALIDATION_ERROR', 'Country and service are required.', 400);

        const { data: active } = await supabaseAdmin.from('sms_verifications').select('id')
          .eq('user_id', profile.id).eq('status', 'ACTIVE').maybeSingle();
        if (active) return sendError(res, 'SMS_ACTIVE_EXISTS', 'You already have a verification in progress.', 400);

        const q = await quoteFor(provider, countryKey, serviceKey);
        if (!q || !q.cost) return sendError(res, 'NO_POOLS', 'No numbers available for this combination right now.', 400);

        const charge = priceNgn(q.cost, s);

        const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', profile.id).single();
        if (!wallet || Number(wallet.available_balance) < charge) {
          return sendError(res, 'INSUFFICIENT_FUNDS', `You need ${charge.toLocaleString()} NGN for this verification. Top up first.`, 400);
        }
        const { error: debitErr } = await supabaseAdmin.from('wallets')
          .update({ available_balance: Number(wallet.available_balance) - charge, updated_at: new Date().toISOString() })
          .eq('user_id', profile.id).eq('available_balance', wallet.available_balance);
        if (debitErr) throw debitErr;

        let orderInfo;
        try {
          if (provider === 'fivesim') {
            const o = await fivesim.buy(countryKey, q.operator || 'any', serviceKey);
            orderInfo = { orderId: String(o.id), number: String(o.phone), realCost: Number(o.price ?? q.cost) };
          } else {
            const o = await smspool.orderNumber({ serviceId: serviceKey, countryId: countryKey, maxPrice: q.cost });
            orderInfo = { orderId: o.orderId, number: o.number, realCost: q.cost };
          }
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

        const rowPayload = {
          user_id: profile.id,
          provider,
          service_name: String(serviceName || '').slice(0, 80) || 'Service',
          country_name: String(countryName || '').slice(0, 60) || null,
          social_username: (social_username || '').trim().slice(0, 80) || null,
          smspool_order_id: orderInfo.orderId,
          phone_number: orderInfo.number,
          status: 'ACTIVE',
          cost_usd: orderInfo.realCost,
          charged_ngn: charge
        };
        if (provider === 'fivesim') {
          rowPayload.country_slug = String(countryKey);
          rowPayload.service_slug = String(serviceKey);
          rowPayload.operator_slug = q.operator || 'any';
        } else {
          rowPayload.smspool_service_id = Number(serviceKey);
          rowPayload.country_id = Number(countryKey);
        }

        const { data: row, error: insErr } = await supabaseAdmin.from('sms_verifications').insert(rowPayload).select().single();
        if (insErr) throw insErr;

        await supabaseAdmin.from('wallet_ledger').insert({
          user_id: profile.id, transaction_type: 'SMS_VERIFICATION', amount: charge,
          direction: 'DEBIT', status: 'COMPLETED', reference: 'SMS-' + row.id
        });

        return sendSuccess(res, {
          verification: {
            id: row.id, number: row.number, service_name: row.service_name,
            country_name: row.country_name, provider, charged_ngn: charge, status: 'ACTIVE'
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
          return sendSuccess(res, { status: row.status, otp: row.otp, number: row.phone_number, refunded: row.refunded, service_name: row.service_name, country_name: row.country_name, provider: row.provider });
        }

        const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
        let state = 'WAITING';
        let smsText = '';
        let realCost = 0;

        if (ageMin > ACTIVE_TIMEOUT_MIN) {
          state = 'CANCELLED';
        } else {
          try {
            const st = row.provider === 'fivesim'
              ? await fivesim.getStatus(row.smspool_order_id)
              : await smspool.getStatus(row.smspool_order_id);
            state = st.state;
            smsText = st.smsText;
            realCost = Number(st.cost || 0);
          } catch (e) {
            return sendSuccess(res, { status: 'ACTIVE', otp: null, number: row.phone_number, service_name: row.service_name, country_name: row.country_name, provider: row.provider });
          }
        }

        if (realCost > 0 && realCost !== Number(row.cost_usd)) {
          await supabaseAdmin.from('sms_verifications').update({ cost_usd: realCost }).eq('id', row.id);
        }

        if (state === 'RECEIVED') {
          const otp = smspool.extractOtp(smsText) || smsText.slice(0, 10);
          await supabaseAdmin.from('sms_verifications')
            .update({ status: 'VERIFIED', otp, updated_at: new Date().toISOString() }).eq('id', row.id);
          await sendNotification(profile.id, 'SMS Verified!', `Your ${row.service_name} (${row.country_name || ''}) verification succeeded. Code: ${otp}`, 'GENERAL');
          pushToUser(profile.id, 'SMS Verified!', `${row.service_name} verification complete. Code: ${otp}`);
          return sendSuccess(res, { status: 'VERIFIED', otp, number: row.phone_number, service_name: row.service_name, country_name: row.country_name, provider: row.provider });
        }

        if (state === 'CANCELLED') {
          if (row.provider === 'fivesim') await fivesim.cancel(row.smspool_order_id);
          else await smspool.cancelOrder(row.smspool_order_id);
          await refundUser(profile.id, Number(row.charged_ngn), row.id);
          await supabaseAdmin.from('sms_verifications')
            .update({ status: 'FAILED', refunded: true, updated_at: new Date().toISOString() }).eq('id', row.id);
          await sendNotification(profile.id, 'SMS Verification Failed', `No code received for ${row.service_name}. Your wallet has been refunded.`, 'WALLET');
          return sendSuccess(res, { status: 'FAILED', otp: null, number: row.phone_number, refunded: true, service_name: row.service_name, country_name: row.country_name, provider: row.provider });
        }

        return sendSuccess(res, { status: 'ACTIVE', otp: null, number: row.phone_number, service_name: row.service_name, country_name: row.country_name, provider: row.provider });
      }

      case 'cancel_verification': {
        const { verificationId } = req.body;
        const { data: row } = await supabaseAdmin.from('sms_verifications').select('*')
          .eq('id', verificationId).eq('user_id', profile.id).maybeSingle();
        if (!row) return sendError(res, 'NOT_FOUND', 'Verification not found.', 404);
        if (row.status !== 'ACTIVE') return sendError(res, 'VALIDATION_ERROR', 'Only active verifications can be cancelled.', 400);

        if (row.provider === 'fivesim') await fivesim.cancel(row.smspool_order_id);
        else await smspool.cancelOrder(row.smspool_order_id);

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
