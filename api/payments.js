const axios = require('axios');
const crypto = require('crypto');
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.body || req.query;

  try {
    // WEBHOOK HANDLER
    if (req.headers['x-paystack-signature']) {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
      if (hash !== req.headers['x-paystack-signature']) return res.status(401).json({ error: 'Invalid signature' });

      const event = req.body;
      if (event.event === 'charge.success') {
        const { reference, amount } = event.data;
        const userId = event.data.metadata?.user_id; // SECURITY PATCH

        if (!userId) return res.status(400).json({ error: 'Missing metadata' });

        const verifyRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${secret}` } });
        if (verifyRes.data.data.status === 'success') {
          await supabaseAdmin.rpc('process_successful_deposit', { p_reference: reference, p_amount_kobo: amount, p_user_id: userId });
        }
      }
      return res.status(200).json({ received: true });
    }

    if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['advertiser']);

    switch (action) {
      case 'initialize': {
        const { amount } = req.body;
        if (!amount || amount < 100) return sendError(res, 'VALIDATION_ERROR', 'Minimum ₦100.', 400);

        const reference = `YOLO-${profile.id.substring(0, 8)}-${Date.now()}`;
        await supabaseAdmin.from('payment_transactions').insert({ user_id: profile.id, paystack_reference: reference, amount, status: 'PENDING' });

        const paystackRes = await axios.post('https://api.paystack.co/transaction/initialize', {
          email: profile.email, amount: amount * 100, reference,
          callback_url: `${process.env.APP_URL}/advertiser/wallet.html?status=success`,
          metadata: { user_id: profile.id } // SECURITY PATCH
        }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

        return sendSuccess(res, { authorization_url: paystackRes.data.data.authorization_url, reference });
      }
      case 'verify': {
        const { data } = await axios.get(`https://api.paystack.co/transaction/verify/${req.body.reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
        return sendSuccess(res, { payment: data.data });
      }
      default: return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    return sendError(res, 'INTERNAL_ERROR', 'Payment failed.');
  }
};
