// /api/vqpay-callback.js — VQPay collection & settlement callbacks (no auth; signature-verified)
const { supabaseAdmin } = require('../lib/supabase');
const vqpay = require('../lib/vqpay');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('FAIL');

  const p = req.body || {};
  const isSettlement = !!p.settlement_id;
  const isCollection = !!p.payment_id;

  try {
    const secret = isSettlement ? process.env.VQPAY_PAYOUT_KEY : process.env.VQPAY_COLLECTION_KEY;
    if (!secret) return res.status(500).send('FAIL');

    // 1) Verify signature BEFORE touching anything
    if (!vqpay.verifySignature(p, secret)) {
      console.error('VQPay callback signature mismatch:', JSON.stringify(p).slice(0, 300));
      return res.status(400).send('FAIL');
    }

    if (isCollection) {
      await handleCollection(p);
    } else if (isSettlement) {
      await handleSettlement(p);
    }

    // Docs: return uppercase SUCCESS; platform retries 5x otherwise
    return res.status(200).send('SUCCESS');
  } catch (err) {
    console.error('VQPay callback error:', err);
    return res.status(200).send('SUCCESS'); // acknowledge to stop retries; state reconciled via inquiry
  }
};

// ---------- DEPOSIT CREDIT (idempotent claim) ----------
async function handleCollection(p) {
  const orderId = String(p.order_id || '');
  const { data: tx } = await supabaseAdmin.from('payment_transactions')
    .select('*').eq('paystack_reference', orderId).maybeSingle();
  if (!tx) { console.error('VQPay collection callback: unknown order', orderId); return; }
  if (tx.status === 'SUCCESS') return; // already credited

  if (vqpay.isFinalSuccess(p.status_code) || String(p.status).toUpperCase() === 'SUCCESS') {
    const { data: claimed } = await supabaseAdmin.from('payment_transactions')
      .update({ status: 'SUCCESS', vqpay_payment_id: String(p.payment_id || ''), raw_status: String(p.status || '') })
      .eq('id', tx.id).eq('status', 'PENDING').select();
    if (!claimed || claimed.length === 0) return;

    const naira = Number(p.amount);
    const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', tx.user_id).single();
    if (wallet) {
      await supabaseAdmin.from('wallets')
        .update({ available_balance: Number(wallet.available_balance) + naira, updated_at: new Date().toISOString() })
        .eq('user_id', tx.user_id);
    }
    await supabaseAdmin.from('wallet_ledger').insert({
      user_id: tx.user_id, transaction_type: 'TOPUP', amount: naira,
      direction: 'CREDIT', status: 'COMPLETED', reference: 'TOPUP-' + orderId
    });
  }
}

// ---------- SETTLEMENT RESULT ----------
async function handleSettlement(p) {
  const orderId = String(p.order_id || ''); // format: WD-<uuid>
  const wdId = orderId.startsWith('WD-') ? orderId.slice(3) : null;
  if (!wdId) { console.error('VQPay settlement callback: unknown order', orderId); return; }

  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', wdId).maybeSingle();
  if (!wd) return;

  const patch = {
    vqpay_settlement_id: String(p.settlement_id || wd.vqpay_settlement_id || ''),
    vqpay_status: String(p.status || ''),
    vqpay_status_code: Number(p.status_code || 0)
  };

  if (vqpay.isFinalSuccess(p.status_code)) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'COMPLETED', processed_at: new Date().toISOString() })
      .eq('id', wdId).in('status', ['PENDING', 'PROCESSING']).select();
    if (claimed && claimed.length) {
      await supabaseAdmin.from('notifications').insert({
        user_id: wd.user_id, title: 'Withdrawal Processed',
        message: `₦${Number(wd.amount).toLocaleString()} sent to your bank via VQPay.`, type: 'WALLET'
      });
    }
  } else if (vqpay.isFinalFail(p.status_code)) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'FAILED' })
      .eq('id', wdId).in('status', ['PENDING', 'PROCESSING']).select();
    if (claimed && claimed.length) {
      // Refund the earner
      const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', wd.user_id).single();
      if (wallet) {
        await supabaseAdmin.from('wallets')
          .update({ available_balance: Number(wallet.available_balance) + Number(wd.amount), updated_at: new Date().toISOString() })
          .eq('user_id', wd.user_id);
      }
      await supabaseAdmin.from('wallet_ledger').insert({
        user_id: wd.user_id, transaction_type: 'WITHDRAWAL_REFUND', amount: Number(wd.amount),
        direction: 'CREDIT', status: 'COMPLETED', reference: 'WDREF-' + wdId
      });
      await supabaseAdmin.from('notifications').insert({
        user_id: wd.user_id, title: 'Withdrawal Failed',
        message: `The payout was rejected by the bank route. ₦${Number(wd.amount).toLocaleString()} returned to your wallet.`, type: 'WALLET'
      });
    }
  } else {
    // APPLY / PENDING / PROCESSING → just record
    await supabaseAdmin.from('withdrawals').update(patch).eq('id', wdId);
  }
                                                                                                }
