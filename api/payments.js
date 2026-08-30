import { createHmac, timingSafeEqual } from 'node:crypto';
import { adminClient, requireUser } from '../src/server/supabase.js';
import { ok, fail, body } from '../src/server/http.js';
import { positiveInt } from '../src/server/validation.js';
import { enforceRateLimit } from '../src/server/rate-limit.js';

async function rawBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

function verifyPaystackSignature(rawText, signatureHeader) {
  if (!process.env.PAYSTACK_WEBHOOK_SECRET) {
    throw Object.assign(new Error('Webhook is not configured.'), { status: 500 });
  }
  const expected = createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(rawText).digest('hex');
  const signature = typeof signatureHeader === 'string' ? signatureHeader : '';
  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw Object.assign(new Error('Invalid webhook signature.'), { status: 401 });
  }
}

async function settleIfMatching(reference, amountKobo, paystackId) {
  const { data: intent } = await adminClient
    .from('payment_intents')
    .select('*')
    .eq('reference', reference)
    .maybeSingle();
  if (!intent || intent.status === 'verified') return { status: intent ? 'already_verified' : 'unknown_reference' };
  if (Number(amountKobo) !== Number(intent.amount_kobo)) {
    throw new Error('Webhook amount does not match the payment intent.');
  }
  const result = await adminClient.rpc('settle_verified_payment', {
    p_reference: reference,
    p_paystack_id: String(paystackId)
  });
  if (result.error) throw result.error;
  return result.data;
}

export default async function handler(req, res) {
  try {
    const action = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('action');

    // Paystack calls this directly with no user session — authenticity comes
    // from the HMAC signature, not a bearer token, so this branch must run
    // before anything that expects requireUser/JSON-parsed body.
    if (action === 'webhook' && req.method === 'POST') {
      const raw = await rawBody(req);
      verifyPaystackSignature(raw, req.headers['x-paystack-signature']);
      const event = JSON.parse(raw);
      if (event.event === 'charge.success' && event.data?.reference) {
        await settleIfMatching(event.data.reference, event.data.amount, event.data.id);
      }
      // Always 200 a validly-signed webhook so Paystack doesn't retry events we've
      // already handled or intentionally ignored (e.g. unrelated event types).
      return ok(res, { received: true });
    }

    if (action === 'initialize' && req.method === 'POST') {
      const { profile } = await requireUser(req, ['earner', 'advertiser']);
      await enforceRateLimit(req, 'payments:initialize', profile.id);
      const input = await body(req);
      const amount = profile.role === 'earner' ? 1000 : positiveInt(input.amount, 'Amount');
      const reference = `YOTO-${profile.id.slice(0, 8)}-${Date.now()}`;
      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: profile.email,
          amount: amount * 100,
          reference,
          callback_url: `${process.env.APP_URL}/app?payment=verify&reference=${reference}`,
          metadata: {
            profile_id: profile.id,
            purpose: profile.role === 'earner' ? 'activation' : 'wallet_funding',
            amount_naira: amount
          }
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.status) {
        throw new Error(payload?.message || 'Payment initialization failed.');
      }
      await adminClient.from('payment_intents').insert({
        profile_id: profile.id,
        reference,
        purpose: profile.role === 'earner' ? 'activation' : 'wallet_funding',
        amount_kobo: amount * 100,
        status: 'initialized'
      });
      return ok(res, { authorization_url: payload.data.authorization_url, reference });
    }

    if (action === 'verify' && req.method === 'POST') {
      const { profile } = await requireUser(req, ['earner', 'advertiser']);
      await enforceRateLimit(req, 'payments:verify', profile.id);
      const input = await body(req);
      if (typeof input.reference !== 'string') throw new Error('Payment reference is required.');
      const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(input.reference)}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });
      const payload = await response.json();
      if (!response.ok || payload.data?.status !== 'success') {
        throw new Error(payload?.message || 'Payment could not be verified.');
      }
      const { data: intent } = await adminClient
        .from('payment_intents')
        .select('*')
        .eq('reference', input.reference)
        .eq('profile_id', profile.id)
        .single();
      if (!intent || intent.status === 'verified') return ok(res, { verified: true });
      if (Number(payload.data.amount) !== Number(intent.amount_kobo)) {
        throw new Error('Verified amount does not match the payment intent.');
      }
      const result = await adminClient.rpc('settle_verified_payment', {
        p_reference: input.reference,
        p_paystack_id: String(payload.data.id)
      });
      if (result.error) throw result.error;
      return ok(res, { verified: true, result: result.data });
    }

    return fail(res, 405, 'Payment action not supported.');
  } catch (error) {
    return fail(res, error.status || 400, error.message || 'Payment request failed.');
  }
}
