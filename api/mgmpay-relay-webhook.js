// /api/mgmpay-relay-webhook.js — HMAC-verified results from PHP relay (deposit + payout)
const { supabaseAdmin } = require('../lib/supabase');
const relay = require('../lib/relay');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('FAIL');
  const p = req.body || {};

  try {
    if (!relay.relayVerify(p, process.env.RELAY_SHARED_SECRET)) {
      console.error('Relay webhook signature mismatch:', JSON.stringify(p).slice(0, 300));
      return res.status(400).send('FAIL');
    }

    if (p.event === 'deposit') await handleDeposit(p);
    else if (p.event === 'payout') await handlePayout(p);

    return res.status(200).send('SUCCESS');
  } catch (err) {
    console.error('Relay webhook error:', err);
    return res.status(200).send('SUCCESS'); // acknowledge; relay retries are no-ops (idempotent)
  }
};

async function handleDeposit(p) {
  const orderId = String(p.order_id || '');
  const { data: tx } = await supabaseAdmin.from('payment_transactions')
    .select('*').eq('paystack_reference', orderId).maybeSingle();
  if (!tx) { console.error('relay webhook: unknown deposit order', orderId); return; }

  // Amount guard per MGM guide: compare amount before touching ledger
  if (Math.abs(Number(p.amount) - Number(tx.amount)) > 0.009) {
    console.error('relay webhook: amount mismatch', orderId, p.amount, tx.amount);
    return;
  }
  if (tx.status === 'SUCCESS') return;

  const code = Number(p.status_code || 0);
  if (code === 100) {
    const { data: claimed } = await supabaseAdmin.from('payment_transactions')
      .update({ status: 'SUCCESS', gateway: 'mgmpay', vqpay_payment_id: String(p.payment_id || ''), raw_status: String(p.status || '') })
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
  } else if ([4, 5, 6].includes(code)) {
    await supabaseAdmin.from('payment_transactions')
      .update({ status: 'FAILED', raw_status: String(p.status || '') })
      .eq('id', tx.id).eq('status', 'PENDING');
  }
}

async function handlePayout(p) {
  const orderId = String(p.order_id || '');
  const wdId = orderId.startsWith('WD-') ? orderId.slice(3) : null;
  if (!wdId) { console.error('relay webhook: unknown payout order', orderId); return; }

  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', wdId).maybeSingle();
  if (!wd) return;
  if (Math.abs(Number(p.amount) - Number(wd.amount)) > 0.009) {
    console.error('relay webhook: payout amount mismatch', orderId);
    return;
  }

  const code = Number(p.status_code || 0);
  const patch = {
    gateway: 'mgmpay',
    vqpay_settlement_id: String(p.settlement_id || wd.vqpay_settlement_id || ''),
    vqpay_status: String(p.status || ''),
    vqpay_status_code: code
  };

  if (code === 100) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'COMPLETED', processed_at: new Date().toISOString() })
      .eq('id', wdId).in('status', ['PENDING', 'PROCESSING']).select();
    if (claimed && claimed.length) {
      await supabaseAdmin.from('notifications').insert({
        user_id: wd.user_id, title: 'Withdrawal Processed',
        message: `₦${Number(wd.amount).toLocaleString()} sent to your bank via MGM Pay.`, type: 'WALLET'
      });
    }
  } else if ([4, 5].includes(code)) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'FAILED' })
      .eq('id', wdId).in('status', ['PENDING', 'PROCESSING']).select();
    if (claimed && claimed.length) {
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
        message: `The payout was rejected/returned. ₦${Number(wd.amount).toLocaleString()} returned to your wallet.`, type: 'WALLET'
      });
    }
  } else {
    await supabaseAdmin.from('withdrawals').update(patch).eq('id', wdId);
  }
      }
