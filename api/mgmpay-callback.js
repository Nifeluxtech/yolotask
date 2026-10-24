// /api/mgmpay-callback.js
// Legacy route filename retained for provider callback compatibility; handles AfrStar v2 callbacks.
const { supabaseAdmin } = require('../lib/supabase');
const afrstar = require('../lib/mgmpay');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('FAIL');

  const payload = req.body || {};
  try {
    const orderId = String(payload.order_sn || '');
    if (!orderId) return res.status(400).send('FAIL');

    const { data: topup } = await supabaseAdmin.from('payment_transactions')
      .select('*').eq('paystack_reference', orderId).maybeSingle();
    if (topup) {
      await handleCollection(payload, topup);
      return res.status(200).send('SUCCESS');
    }

    const withdrawalId = orderId.startsWith('WD-') ? orderId.slice(3) : '';
    const { data: withdrawal } = withdrawalId
      ? await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawalId).maybeSingle()
      : { data: null };
    if (withdrawal) {
      await handlePayout(payload, withdrawal);
      return res.status(200).send('SUCCESS');
    }

    console.error('AfrStar callback: unknown order', orderId);
    return res.status(404).send('FAIL');
  } catch (error) {
    console.error('AfrStar callback error:', error);
    // Do not acknowledge failed processing. AfrStar can retry the callback.
    return res.status(500).send('FAIL');
  }
};

async function handleCollection(payload, tx) {
  if (!afrstar.verifyCollection(payload, tx.amount)) {
    throw new Error('AfrStar collection signature or merchant mismatch');
  }

  const status = Number(payload.status);
  if (status !== 1) {
    await supabaseAdmin.from('payment_transactions')
      .update({ raw_status: String(payload.message || status) })
      .eq('id', tx.id).eq('status', 'PENDING');
    return;
  }

  const paid = Number(payload.amount_paid || payload.amount || 0);
  if (!Number.isFinite(paid) || paid !== Number(tx.amount)) {
    throw new Error(`AfrStar collection amount mismatch for ${tx.paystack_reference}`);
  }

  const { data: claimed } = await supabaseAdmin.from('payment_transactions')
    .update({
      status: 'SUCCESS',
      gateway: 'afrstar',
      raw_status: String(payload.message || 'Paid Success'),
      vqpay_payment_id: String(payload.platform_osn || payload.utr || payload.session_id || '')
    })
    .eq('id', tx.id).eq('status', 'PENDING').select();

  if (!claimed || claimed.length === 0) return;

  const { data: wallet } = await supabaseAdmin.from('wallets')
    .select('available_balance').eq('user_id', tx.user_id).single();
  if (!wallet) throw new Error('Wallet not found for AfrStar collection');

  await supabaseAdmin.from('wallets')
    .update({ available_balance: Number(wallet.available_balance) + paid, updated_at: new Date().toISOString() })
    .eq('user_id', tx.user_id);

  await supabaseAdmin.from('wallet_ledger').insert({
    user_id: tx.user_id,
    transaction_type: 'TOPUP',
    amount: paid,
    direction: 'CREDIT',
    status: 'COMPLETED',
    reference: 'TOPUP-' + tx.paystack_reference
  });
}

async function handlePayout(payload, wd) {
  if (!afrstar.verifyPayout(payload, wd.amount)) {
    throw new Error('AfrStar payout signature or merchant mismatch');
  }

  const status = Number(payload.status);
  const patch = {
    gateway: 'afrstar',
    vqpay_settlement_id: String(payload.platform_osn || payload.utr || ''),
    vqpay_status: String(payload.message || status),
    vqpay_status_code: status
  };

  if (status === 1) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'COMPLETED', processed_at: new Date().toISOString() })
      .eq('id', wd.id).in('status', ['PENDING', 'PROCESSING']).select();

    if (claimed && claimed.length) {
      await supabaseAdmin.from('notifications').insert({
        user_id: wd.user_id,
        title: 'Withdrawal Processed',
        message: `₦${Number(wd.amount).toLocaleString()} sent to your bank via AfrStar.`,
        type: 'WALLET'
      });
    }
    return;
  }

  if (status === 9) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'FAILED' })
      .eq('id', wd.id).in('status', ['PENDING', 'PROCESSING']).select();

    if (claimed && claimed.length) {
      const { data: wallet } = await supabaseAdmin.from('wallets')
        .select('available_balance').eq('user_id', wd.user_id).single();
      if (!wallet) throw new Error('Wallet not found for AfrStar payout refund');

      await supabaseAdmin.from('wallets')
        .update({ available_balance: Number(wallet.available_balance) + Number(wd.amount), updated_at: new Date().toISOString() })
        .eq('user_id', wd.user_id);

      await supabaseAdmin.from('wallet_ledger').insert({
        user_id: wd.user_id,
        transaction_type: 'WITHDRAWAL_REFUND',
        amount: Number(wd.amount),
        direction: 'CREDIT',
        status: 'COMPLETED',
        reference: 'WDREF-' + wd.id
      });

      await supabaseAdmin.from('notifications').insert({
        user_id: wd.user_id,
        title: 'Withdrawal Failed',
        message: `The payout was rejected by AfrStar. ₦${Number(wd.amount).toLocaleString()} returned to your wallet.`,
        type: 'WALLET'
      });
    }
    return;
  }

  await supabaseAdmin.from('withdrawals').update(patch).eq('id', wd.id);
}
