// /api/payments.js — Self-contained Paystack top-up engine
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

// ---------- Legacy-name resolver ----------
function resolveAction(raw) {
  const a = String(raw || '').toLowerCase();
  const exact = {
    'initialize_topup': 'initialize_topup', 'initialize_payment': 'initialize_topup', 'initiate_payment': 'initialize_topup',
    'initiate_topup': 'initialize_topup', 'create_payment': 'initialize_topup', 'create_topup': 'initialize_topup',
    'start_payment': 'initialize_topup', 'paystack_initialize': 'initialize_topup', 'init_payment': 'initialize_topup',
    'initialize': 'initialize_topup', 'initiate': 'initialize_topup', 'pay': 'initialize_topup',

    'verify_topup': 'verify_topup', 'verify_payment': 'verify_topup', 'confirm_payment': 'verify_topup',
    'confirm_topup': 'verify_topup', 'validate_payment': 'verify_topup', 'paystack_verify': 'verify_topup',
    'check_payment': 'verify_topup', 'verify': 'verify_topup', 'confirm': 'verify_topup',

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

async function paystackVerify(reference) {
  const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
  });
  return await resp.json();
}

/**
 * RACE-SAFE CREDIT: atomically claims the PENDING→SUCCESS flip.
 * Only the request that wins the claim touches wallets/ledger.
 */
async function creditTopup(tx, paystackData) {
  const { data: claimed } = await supabaseAdmin.from('payment_transactions')
    .update({ status: 'SUCCESS' })
    .eq('id', tx.id)
    .eq('status', 'PENDING')
    .select();

  if (!claimed || claimed.length === 0) {
    return { already: true, amount: Number(tx.amount) };
  }

  const naira = Number(paystackData.amount) / 100; // kobo → naira

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

    const auth = await getAuthenticatedUser(req);
    const profile = auth.profile;
    const userEmail = auth.user?.email || '';

    switch (action) {
      // ---------- INITIALIZE ----------
      case 'initialize_topup': {
        requireRole(profile, ['earner', 'advertiser']);
        if (!PAYSTACK_SECRET) throw { code: 'PAYSTACK_NOT_CONFIGURED', message: 'PAYSTACK_SECRET_KEY missing in Vercel env.', statusCode: 500 };

        const amount = Number(req.body.amount);
        if (!amount || amount < 100) return sendError(res, 'VALIDATION_ERROR', 'Minimum top-up is ₦100.', 400);
        if (amount > 10000000) return sendError(res, 'VALIDATION_ERROR', 'Amount too large.', 400);

        const reference = 'TOP-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const rolePath = profile.role === 'advertiser' ? 'advertiser' : 'earner';

        const resp = await fetch('https://api.paystack.co/transaction/initialize', {
          method: 'POST',
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: userEmail,
            amount: Math.round(amount * 100), // naira → kobo
            reference,
            callback_url: `${process.env.APP_URL || ''}/${rolePath}/wallet.html`
          })
        });
        const result = await resp.json();

        if (!result.status || !result.data) {
          throw { code: 'PAYSTACK_INIT_FAILED', message: result.message || 'Could not start payment.', statusCode: 502 };
        }

        await supabaseAdmin.from('payment_transactions').insert({
          user_id: profile.id,
          paystack_reference: reference,
          amount,
          status: 'PENDING'
        });

        return sendSuccess(res, {
          reference,
          authorization_url: result.data.authorization_url,
          access_code: result.data.access_code
        }, 'Payment initialized.');
      }

      // ---------- VERIFY ----------
      case 'verify_topup': {
        requireRole(profile, ['earner', 'advertiser', 'admin']);
        const { reference } = req.body;
        if (!reference) return sendError(res, 'VALIDATION_ERROR', 'Reference required.', 400);
        if (!PAYSTACK_SECRET) throw { code: 'PAYSTACK_NOT_CONFIGURED', message: 'PAYSTACK_SECRET_KEY missing.', statusCode: 500 };

        const { data: tx } = await supabaseAdmin.from('payment_transactions').select('*')
          .eq('paystack_reference', reference).maybeSingle();
        if (!tx) return sendError(res, 'NOT_FOUND', 'Top-up record not found.', 404);
        if (tx.user_id !== profile.id && profile.role !== 'admin') return sendError(res, 'FORBIDDEN', 'Not your transaction.', 403);

        if (tx.status === 'SUCCESS') {
          return sendSuccess(res, { already: true, amount: Number(tx.amount) }, 'Already credited.');
        }

        const result = await paystackVerify(reference);
        if (result.status && result.data && result.data.status === 'success') {
          const credited = await creditTopup(tx, result.data);
          return sendSuccess(res, credited, credited.already ? 'Already credited.' : `₦${credited.amount.toLocaleString()} added to your wallet!`);
        }

        await supabaseAdmin.from('payment_transactions').update({ status: 'FAILED' }).eq('id', tx.id).eq('status', 'PENDING');
        return sendError(res, 'PAYMENT_NOT_SUCCESSFUL', 'Payment was not completed.', 400);
      }

      // ---------- HISTORY (+ auto-rescue of paid-but-unverified topups) ----------
      case 'get_topups': {
        requireRole(profile, ['earner', 'advertiser']);

        const { data, error } = await supabaseAdmin.from('payment_transactions').select('*')
          .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(30);
        if (error) throw error;

        const topups = data || [];

        // Rescue: verify PENDING rows older than 2 minutes (max 5 per call)
        if (PAYSTACK_SECRET) {
          const stale = topups.filter(t =>
            t.status === 'PENDING' &&
            (Date.now() - new Date(t.created_at).getTime()) > 2 * 60 * 1000
          ).slice(0, 5);

          for (const tx of stale) {
            try {
              const result = await paystackVerify(tx.paystack_reference);
              if (result.status && result.data && result.data.status === 'success') {
                await creditTopup(tx, result.data);
                tx.status = 'SUCCESS';
              } else {
                await supabaseAdmin.from('payment_transactions').update({ status: 'FAILED' }).eq('id', tx.id).eq('status', 'PENDING');
                tx.status = 'FAILED';
              }
            } catch (e) {
              console.error('rescue verify error:', e.message);
            }
          }
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
