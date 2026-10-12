// /api/mgmpay-callback.js — MGM Pay webhooks (deposit + settlement)
const { supabaseAdmin } = require('../lib/supabase');
const mgmpay = require('../lib/mgmpay');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('FAIL');
  
  const p = req.body || {};
  const isSettlement = !!p.settlement_id;
  const isCollection = !!p.payment_id;
  
  try {
    const secret = isSettlement ? process.env.MGMPAY_PAYOUT_KEY : process.env.MGMPAY_COLLECTION_KEY;
    if (!secret) return res.status(500).send('FAIL');
    
    // Verify signature FIRST before processing anything
    const excludeNested = isSettlement ? ['payee'] : ['payer'];
    if (!mgmpay.verifySignature(p, secret, excludeNested)) {
      console.error('MGM Pay callback signature mismatch:', JSON.stringify(p).slice(0, 300));
      return res.status(400).send('FAIL');
    }
    
    if (isCollection) await handleCollection(p);
    else if (isSettlement) await handleSettlement(p);
    
    // Docs say return exact uppercase SUCCESS after successful processing
    return res.status(200).send('SUCCESS');
    
  } catch (err) {
    console.error('MGM Pay callback error:', err);
    // Still acknowledge to prevent infinite retries; reconcile via query endpoint
    return res.status(200).send('SUCCESS');
  }
};

// ---------- DEPOSIT CREDIT (idempotent claim) ----------
async function handleCollection(p) {
  const orderId = String(p.order_id || '');
  const { data: tx } = await supabaseAdmin.from('payment_transactions')
    .select('*').eq('paystack_reference', orderId).maybeSingle();
  
  if (!tx) { console.error('MGM Pay collection callback: unknown order', orderId); return; }
  if (tx.status === 'SUCCESS') return; // Already credited
  
  if (mgmpay.isFinalSuccess(p.status_code)) {
    const { data: claimed } = await supabaseAdmin.from('payment_transactions')
      .update({ 
        status: 'SUCCESS', 
        gateway: 'mgmpay',
        raw_status: String(p.status || ''),
        // Store MGM-specific IDs if needed later
      })
      .eq('id', tx.id).eq('status', 'PENDING').select();
    
    if (!claimed || claimed.length === 0) return; // Lost race
    
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
  const orderId = String(p.order_id || ''); // Format: WD-<uuid>
  const wdId = orderId.startsWith('WD-') ? orderId.slice(3) : null;
  
  if (!wdId) { console.error('MGM Pay settlement callback: unknown order', orderId); return; }
  
  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', wdId).maybeSingle();
  if (!wd) return;
  
  const patch = {
    gateway: 'mgmpay',
    vqpay_settlement_id: String(p.settlement_id || ''), // Reuse column name for now
    vqpay_status: String(p.status || ''),
    vqpay_status_code: Number(p.status_code || 0)
  };
  
  if (mgmpay.isFinalSuccess(p.status_code)) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'COMPLETED', processed_at: new Date().toISOString() })
      .eq('id', wdId).in('status', ['PENDING', 'PROCESSING']).select();
    
    if (claimed && claimed.length) {
      await supabaseAdmin.from('notifications').insert({
        user_id: wd.user_id, title: 'Withdrawal Processed',
        message: `₦${Number(wd.amount).toLocaleString()} sent to your bank via MGM Pay.`, type: 'WALLET'
      });
    }
    
  } else if (mgmpay.isTerminalFail(p.status_code)) {
    const { data: claimed } = await supabaseAdmin.from('withdrawals')
      .update({ ...patch, status: 'FAILED' })
      .eq('id', wdId).in('status', ['PENDING', 'PROCESSING']).select();
    
    if (claimed && claimed.length) {
      // Refund earner
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
        message: `The payout was rejected/returned by MGM Pay. ₦${Number(wd.amount).toLocaleString()} returned to your wallet.`, type: 'WALLET'
      });
    }
    
  } else {
    // Non-terminal states: CREATED, WAITING, DISBURSING → just record
    await supabaseAdmin.from('withdrawals').update(patch).eq('id', wdId);
  }
}
