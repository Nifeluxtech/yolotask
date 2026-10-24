// /api/payments.js — Dual-gateway deposit engine (Paystack inline + AfrStar redirect)
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const mgmpay = require('../lib/mgmpay');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

function resolveAction(raw) {
  const a = String(raw || '').toLowerCase();
  const exact = {
    'initialize_topup': 'initialize_topup', 'initialize_payment': 'initialize_topup', 'initiate_payment': 'initialize_topup',
    'initiate_topup': 'initialize_topup', 'create_payment': 'initialize_topup', 'create_topup': 'initialize_topup',
    'start_payment': 'initialize_topup', 'paystack_initialize': 'initialize_topup', 'mgmpay_initialize': 'initialize_topup', 'afrstar_initialize': 'initialize_topup',
    'initialize': 'initialize_topup', 'initiate': 'initialize_topup', 'pay': 'initialize_topup',

    'verify_topup': 'verify_topup', 'verify_payment': 'verify_topup', 'confirm_payment': 'verify_topup',
    'confirm_topup': 'verify_topup', 'validate_payment': 'verify_topup', 'paystack_verify': 'verify_topup',
    'mgmpay_verify': 'verify_topup', 'afrstar_verify': 'verify_topup', 'check_payment': 'verify_topup', 'verify': 'verify_topup', 'confirm': 'verify_topup',

    'get_topups': 'get_topups', 'get_topup_history': 'get_topups', 'get_payment_history': 'get_topups',
    'get_topup_transactions': 'get_topups', 'get_payments': 'get_topups', 'get_deposits': 'get_topups',
    'get_deposit_history': 'get_topups', 'get_payment_list': 'get_topups', 'get_topup_list': 'get_topups',
    'get_history': 'get_topups', 'topup_history': 'get_topups', 'payment_history': 'get_topups', 'history': 'get_topups'
  };
  if (exact[a]) return exact[a];

  if (/(initialize|initiate|create|start|init)/.test(a) && /(pay|topup|top_up|deposit|fund)/.test(a)) return 'initialize_topup';
  if (/(verify|confirm|validate|check)/.test(a) && /(pay|topup|top_up|deposit|ref)/.test(a)) return 'verify_topup';
  if (/(history|list|all)/.test(a) && /(topup|top_up|deposit|payment)/.test(a)) return 'get_topups';
  if (/history/.test(a) && !/(withdraw|submission|notification)/.test(a)) return 'get_topups';

  return raw;
}

async function gatewaySettings() {
  const { data } = await supabaseAdmin.from('platform_settings').select('key, value')
    .in('key', ['deposit_gateway']);
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  const configuredGateway = String(map.deposit_gateway || 'paystack').toLowerCase();
  return {
    deposit_gateway: ['mgmpay', 'vqpay', 'afrstar'].includes(configuredGateway) ? 'afrstar' : configuredGateway,
    country: 'NG'
  };
}

async function paystackVerify(reference) {
  const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
  });
  return await resp.json();
}

/** RACE-SAFE CREDIT: atomic PENDING→SUCCESS claim; only winner touches wallets/ledger. */
async function creditTopup(tx, naira, externalId, gatewayName) {
  const patch = { status: 'SUCCESS' };
  if (externalId) patch.vqpay_payment_id = externalId; // reuse column for MGM payment_id
  if (gatewayName) patch.gateway = gatewayName;

  const { data: claimed } = await supabaseAdmin.from('payment_transactions')
    .update(patch).eq('id', tx.id).eq('status', 'PENDING').select();

  if (!claimed || claimed.length === 0) return { already: true, amount: Number(tx.amount) };

  const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', tx.user_id).single();
  if (wallet) {
    await supabaseAdmin.from('wallets')
      .update({ available_balance: Number(wallet.available_balance) + naira, updated_at: new Date().toISOString() })
      .eq('user_id', tx.user_id);
  }

  await supabaseAdmin.from('wallet_ledger').insert({
    user_id: tx.user_id, transaction_type: 'TOPUP', amount: naira,
    direction: 'CREDIT', status: 'COMPLETED', reference: 'TOPUP-' + tx.paystack_reference
  });

  return { already: false, amount: naira };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const action = resolveAction(req.body.action);
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    // Public key is safe to expose — no auth needed
    if (action === 'get_public_key') {
      return sendSuccess(res, { public_key: process.env.PAYSTACK_PUBLIC_KEY || null });
    }

    const auth = await getAuthenticatedUser(req);
    const profile = auth.profile;
    const userEmail = auth.user?.email || '';

    switch (action) {
      case 'initialize_topup': {
        requireRole(profile, ['earner', 'advertiser']);
        const amount = Number(req.body.amount);
        if (!amount || amount < 100) return sendError(res, 'VALIDATION_ERROR', 'Minimum top-up is ₦100.', 400);
        if (amount > 10000000) return sendError(res, 'VALIDATION_ERROR', 'Amount too large.', 400);

        const gw = await gatewaySettings();
        const reference = 'TOP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const rolePath = profile.role === 'advertiser' ? 'advertiser' : 'earner';
        const callbackBase = `${process.env.APP_URL || ''}`;

        // ---------- AFRSTAR REDIRECT ----------
        if (gw.deposit_gateway === 'afrstar') {
          const phone = String(req.body.phone || profile.phone || auth.user?.phone || '')
            .replace(/[\s\-()]/g, '');
          if (!/^\+?\d{10,14}$/.test(phone)) {
            return sendError(res, 'PHONE_REQUIRED', 'Enter a valid phone number before paying with AfrStar.', 400);
          }

          // Create the local record first so an immediate provider callback
          // can always find and settle the transaction.
          await supabaseAdmin.from('payment_transactions').insert({
            user_id: profile.id, paystack_reference: reference, amount,
            status: 'PENDING', gateway: 'afrstar'
          });

          const result = await mgmpay.createDeposit({
            orderId: reference,
            amount,
            name: profile.full_name,
            email: userEmail,
            phone,
            remark: 'YOLOTASK wallet top-up',
            redirectUrl: `${callbackBase}/${rolePath}/wallet.html?trxref=${reference}`
          });

          const d = result.data || result;
          const redirectUrl = d.pay_url || d.redirect_url || d.payment_url || d.url || null;

          await supabaseAdmin.from('payment_transactions').update({ redirect_url: redirectUrl })
            .eq('paystack_reference', reference).eq('status', 'PENDING');

          if (!redirectUrl) {
            throw { code: 'AFRSTAR_NO_REDIRECT', message: 'AfrStar response had no pay_url: ' + JSON.stringify(result).slice(0, 160), statusCode: 502 };
          }
          return sendSuccess(res, { gateway: 'afrstar', reference, redirect_url: redirectUrl }, 'Redirecting to checkout...');
        }

        // ---------- PAYSTACK INLINE ----------
        if (!PAYSTACK_SECRET) throw { code: 'PAYSTACK_NOT_CONFIGURED', message: 'PAYSTACK_SECRET_KEY missing.', statusCode: 500 };
        const resp = await fetch('https://api.paystack.co/transaction/initialize', {
          method: 'POST',
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: userEmail,
            amount: Math.round(amount * 100),
            reference,
            callback_url: `${callbackBase}/${rolePath}/wallet.html`
          })
        });
        const result = await resp.json();
        if (!result.status || !result.data) {
          throw { code: 'PAYSTACK_INIT_FAILED', message: result.message || 'Could not start payment.', statusCode: 502 };
        }
        await supabaseAdmin.from('payment_transactions').insert({
          user_id: profile.id, paystack_reference: reference, amount, status: 'PENDING', gateway: 'paystack'
        });
        return sendSuccess(res, {
          gateway: 'paystack', reference,
          authorization_url: result.data.authorization_url,
          access_code: result.data.access_code
        }, 'Payment initialized.');
      }

      case 'verify_topup': {
        requireRole(profile, ['earner', 'advertiser', 'admin']);
        const { reference } = req.body;
        if (!reference) return sendError(res, 'VALIDATION_ERROR', 'Reference required.', 400);

        const { data: tx } = await supabaseAdmin.from('payment_transactions').select('*')
          .eq('paystack_reference', reference).maybeSingle();
        if (!tx) return sendError(res, 'NOT_FOUND', 'Top-up record not found.', 404);
        if (tx.user_id !== profile.id && profile.role !== 'admin') return sendError(res, 'FORBIDDEN', 'Not your transaction.', 403);
        if (tx.status === 'SUCCESS') return sendSuccess(res, { already: true, amount: Number(tx.amount) }, 'Already credited.');

        if (tx.gateway === 'afrstar') {
          return sendError(res, 'PAYMENT_PENDING', 'AfrStar confirms payment by callback. Please wait a moment and refresh your wallet.', 400);
        }

        if (!PAYSTACK_SECRET) throw { code: 'PAYSTACK_NOT_CONFIGURED', message: 'PAYSTACK_SECRET_KEY missing.', statusCode: 500 };
        const result = await paystackVerify(reference);
        if (result.status && result.data && result.data.status === 'success') {
          const credited = await creditTopup(tx, Number(result.data.amount) / 100, null, 'paystack');
          return sendSuccess(res, credited, credited.already ? 'Already credited.' : `₦${credited.amount.toLocaleString()} added to your wallet!`);
        }
        await supabaseAdmin.from('payment_transactions').update({ status: 'FAILED' }).eq('id', tx.id).eq('status', 'PENDING');
        return sendError(res, 'PAYMENT_NOT_SUCCESSFUL', 'Payment was not completed.', 400);
      }

      case 'get_topups': {
        requireRole(profile, ['earner', 'advertiser']);
        const { data, error } = await supabaseAdmin.from('payment_transactions').select('*')
          .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(30);
        if (error) throw error;
        const topups = data || [];

        // Rescue stale PENDING rows (both gateways)
        const stale = topups.filter(t =>
          t.status === 'PENDING' && (Date.now() - new Date(t.created_at).getTime()) > 2 * 60 * 1000
        ).slice(0, 5);

        for (const tx of stale) {
          try {
            if (tx.gateway === 'afrstar') {
              // AfrStar v2 has callback-only confirmation; do not mark a pending
              // payment failed merely because it has not called back yet.
            } else if (PAYSTACK_SECRET) {
              const r = await paystackVerify(tx.paystack_reference);
              if (r.status && r.data && r.data.status === 'success') { await creditTopup(tx, Number(r.data.amount) / 100, null, 'paystack'); tx.status = 'SUCCESS'; }
              else {
                await supabaseAdmin.from('payment_transactions').update({ status: 'FAILED' }).eq('id', tx.id).eq('status', 'PENDING');
                tx.status = 'FAILED';
              }
            }
          } catch (e) { console.error('rescue verify error:', e.message); }
        }

        return sendSuccess(res, { topups });
      }

      default: {
        console.error('PAYMENTS UNKNOWN ACTION:', JSON.stringify(req.body));
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
      }
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Payments API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
