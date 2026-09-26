const axios = require('axios');
const crypto = require('crypto');
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.body || req.query; // Webhooks might use query params depending on config

  try {
    // --- WEBHOOK HANDLER (No Auth Required, uses Signature Verification) ---
    if (action === 'webhook' || req.headers['x-paystack-signature']) {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');

      if (hash !== req.headers['x-paystack-signature']) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      const event = req.body;
      if (event.event === 'charge.success') {
        const { reference, amount, customer } = event.data;
        
        // Verify transaction details with Paystack API (Defense in depth)
        const verifyRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
          headers: { Authorization: `Bearer ${secret}` }
        });

        if (verifyRes.data.data.status === 'success') {
          // Call our atomic DB function
          const { error } = await supabaseAdmin.rpc('process_successful_deposit', {
            p_reference: reference,
            p_amount_kobo: amount,
            p_user_id: customer.customer_code // Note: You should map Paystack customer_code to your user_id in the initialize step, or store it in metadata. For MVP, we assume reference maps to user.
          });
          
          // Better approach for MVP: Store user_id in the reference or metadata during initialization.
          // Let's use the reference format: 'YOLO-USERID-TIMESTAMP'
          const refParts = reference.split('-');
          const userId = refParts[1]; 

          if (userId) {
             await supabaseAdmin.rpc('process_successful_deposit', {
              p_reference: reference,
              p_amount_kobo: amount,
              p_user_id: userId
            });
          }
        }
      }
      return res.status(200).json({ received: true });
    }

    // --- AUTHENTICATED ROUTES ---
    if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
    const { profile } = await getAuthenticatedUser(req);
    requireRole(profile, ['advertiser']);

    switch (action) {
      case 'initialize': {
        const { amount } = req.body;
        if (!amount || amount < 100) return sendError(res, 'VALIDATION_ERROR', 'Minimum deposit is ₦100.', 400);

        // Create a unique reference containing the User ID for the webhook
        const reference = `YOLO-${profile.id.substring(0, 8)}-${Date.now()}`;
        const amountInKobo = amount * 100;

        // Save pending transaction in DB
        await supabaseAdmin.from('payment_transactions').insert({
          user_id: profile.id,
          paystack_reference: reference,
          amount: amount,
          status: 'PENDING'
        });

        // Call Paystack API
        const paystackRes = await axios.post('https://api.paystack.co/transaction/initialize', {
          email: profile.email, // Ensure profile has email or fetch from auth
          amount: amountInKobo,
          reference: reference,
          callback_url: `${process.env.APP_URL}/advertiser/wallet.html?status=success`,
          metadata: { user_id: profile.id }
        }, {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });

        return sendSuccess(res, { authorization_url: paystackRes.data.data.authorization_url, reference });
      }

      case 'verify': {
        const { reference } = req.body;
        const { data } = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
        });
        return sendSuccess(res, { payment: data.data });
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown payment action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Payments API Error:', err.response?.data || err);
    return sendError(res, 'INTERNAL_ERROR', 'Payment processing failed.');
  }
};
