// /api/sms.js
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
      case 'get_services': {
        const s = await getSettings();
        if (!s.enabled) return sendSuccess(res, { enabled: false, services: [] });
        const { data, error } = await supabaseAdmin.from('sms_services').select('*')
          .eq('is_active', true).order('name');
        if (error) throw error;
        return sendSuccess(res, {
          enabled: true,
          services: (data || []).map(sv => ({
            id: sv.id, name: sv.name, icon: sv.icon,
            price_usd: Number(sv.price_usd),
            price_ngn: priceNgn(Number(sv.price_usd), s)
          }))
        });
      }

      case 'get_wallet_balance': {
        const { data } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', profile.id).single();
        return sendSuccess(res, { available_balance: Number(data?.available_balance || 0) });
      }

      case 'start_verification': {
        const s = await getSettings();
        if (!s.enabled) return sendError(res, 'SMS_DISABLED', 'SMS verification is currently disabled.', 403);

        const { serviceId, social_username } = req.body;
        if (!serviceId) return sendError(res, 'VALIDATION_ERROR', 'Service required.', 400);

        // One active order per user
        const { data: active } = await supabaseAdmin.from('sms_verifications').select('id')
          .eq('user_id', profile.id).eq('status', 'ACTIVE').maybeSingle();
        if (active) return sendError(res, 'SMS_ACTIVE_EXISTS', 'You already have a verification in progress.', 400);

        const { data: service } = await supabaseAdmin.from('sms_services').select('*')
          .eq('id', serviceId).eq('is_active', true).maybeSingle();
        if (!service) return sendError(res, 'NOT_FOUND', 'Service not available.', 404);

        const charge = priceNgn(Number(service.price_usd), s);
        if (charge <= 0) return sendError(res, 'VALIDATION_ERROR', 'Service price not configured.', 400);

        // Debit wallet
        const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', profile.id).single();
        if (!wallet || Number(wallet.available_balance) < charge) {
          return sendError(res, 'INSUFFICIENT_FUNDS', `You need ${charge.toLocaleString()} NGN for this verification. Top up first.`, 400);
        }
        const { error: debitErr } = await supabaseAdmin.from('wallets')
          .update({ available_balance: Number(wallet.available_balance) - charge, updated_at: new Date().toISOString() })
          .eq('user_id', profile.id).eq('available_balance', wallet.available_balance);
        if (debitErr) throw debitErr;

        // Buy number from SMSPool
        let order;
        try {
          order = await smspool.orderNumber({ serviceId: service.smspool_service_id, tier: s.tier });
        } catch (orderErr) {
          await refundUser(profile.id, charge, 'FAILED-ORDER');
          await supabaseAdmin.from('wallet_ledger').insert({
            user_id: profile.id, transaction_type: 'SMS_VERIFICATION', amount: charge,
            direction: 'DEBIT', status: 'COMPLETED', reference: 'SMS-FAILED-ORDER'
          }).then(() => supabaseAdmin.from('wallet_ledger').insert({
            user_id: profile.id, transaction_type: 'SMS_VERIFICATION_REFUND', amount: charge,
            direction: 'CREDIT', status: 'COMPLETED', reference: 'SMSREF-FAILED-ORDER'
          }));
          throw orderErr;
        }

        const { data: row, error: insErr } = await supabaseAdmin.from('sms_verifications')
          .insert({
            user_id: profile.id,
            service_id: service.id,
            service_name: service.name,
            social_username: (social_username || '').trim().slice(0, 80) || null,
            smspool_order_id: order.orderId,
            phone_number: order.number,
            status: 'ACTIVE',
            cost_usd: Number(service.price_usd),
            charged_ngn: charge
          })
          .select().single();
        if (insErr) throw insErr;

        await supabaseAdmin.from('wallet_ledger').insert({
          user_id: profile.id, transaction_type: 'SMS_VERIFICATION', amount: charge,
          direction: 'DEBIT', status: 'COMPLETED', reference: 'SMS-' + row.id
        });

        return sendSuccess(res, {
          verification: { id: row.id, number: row.number, service_name: row.service_name, charged_ngn: charge, status: 'ACTIVE' }
        }, `Number assigned. ${charge.toLocaleString()} NGN charged.`);
      }

      case 'poll_status': {
        const { verificationId } = req.body;
        if (!verificationId) return sendError(res, 'VALIDATION_ERROR', 'Verification ID required.', 400);

        const { data: row } = await supabaseAdmin.from('sms_verifications').select('*')
          .eq('id', verificationId).eq('user_id', profile.id).maybeSingle();
        if (!row) return sendError(res, 'NOT_FOUND', 'Verification not found.', 404);

        if (row.status !== 'ACTIVE') {
          return sendSuccess(res, { status: row.status, otp: row.otp, number: row.phone_number, refunded: row.refunded });
        }

        // Local expiry guard
        const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
        let state = 'WAITING';
        let smsText = '';

        if (ageMin > ACTIVE_TIMEOUT_MIN) {
          state = 'CANCELLED';
        } else {
          try {
            const st = await smspool.getStatus(row.smspool_order_id);
            state = st.state;
            smsText = st.smsText;
          } catch (e) {
            return sendSuccess(res, { status: 'ACTIVE', otp: null, number: row.phone_number }); // transient, keep waiting
          }
        }

        if (state === 'RECEIVED') {
          const otp = smspool.extractOtp(smsText) || smsText.slice(0, 10);
          await supabaseAdmin.from('sms_verifications')
            .update({ status: 'VERIFIED', otp, updated_at: new Date().toISOString() }).eq('id', row.id);
          await sendNotification(profile.id, 'SMS Verified!', `Your ${row.service_name} number verification succeeded. Code: ${otp}`, 'GENERAL');
          pushToUser(profile.id, 'SMS Verified!', `${row.service_name} verification complete. Code: ${otp}`);
          return sendSuccess(res, { status: 'VERIFIED', otp, number: row.phone_number });
        }

        if (state === 'CANCELLED') {
          await smspool.cancelOrder(row.smspool_order_id);
          await refundUser(profile.id, Number(row.charged_ngn), row.id);
          await supabaseAdmin.from('sms_verifications')
            .update({ status: 'FAILED', refunded: true, updated_at: new Date().toISOString() }).eq('id', row.id);
          await sendNotification(profile.id, 'SMS Verification Failed', `No code received for ${row.service_name}. Your wallet has been refunded.`, 'WALLET');
          return sendSuccess(res, { status: 'FAILED', otp: null, number: row.phone_number, refunded: true });
        }

        return sendSuccess(res, { status: 'ACTIVE', otp: null, number: row.phone_number });
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
