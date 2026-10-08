// /lib/smspool.js
const BASE = process.env.SMSPOOL_BASE_URL || 'https://api.smspool.net';

function assertKey() {
  const key = process.env.SMSPOOL_API_KEY;
  if (!key) throw { code: 'SMS_NOT_CONFIGURED', message: 'SMSPOOL_API_KEY is not set in Vercel environment variables.', statusCode: 500 };
  return key;
}

async function call(path, params = {}) {
  const key = assertKey();
  const body = new URLSearchParams({ key, ...params });
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw { code: 'SMSPOOL_HTTP_ERROR', message: `SMSPool HTTP ${resp.status}: ${data?.message || resp.statusText}`, statusCode: 502 };
  }
  return data;
}

async function orderNumber({ serviceId, tier }) {
  const data = await call('/v2/sms/order', { service: String(serviceId), price_tier: String(tier || 2) });
  const orderId = data.order_id || data.orderId || data.order;
  const number = data.number || data.phone || data.phone_number;
  if (!orderId || !number) {
    throw { code: 'SMSPOOL_ORDER_FAILED', message: data.message || data.error || 'SMSPool could not assign a number right now.', statusCode: 502 };
  }
  return { orderId: String(orderId), number: String(number) };
}

async function getStatus(orderId) {
  const data = await call('/v2/sms/status', { order_id: orderId });
  const raw = String(data.status || data.state || '').toUpperCase();
  const smsText = String(data.sms || data.message || data.code_text || '');
  let state = 'WAITING';
  if (raw.includes('RECEIVED') || raw.includes('COMPLETED') || raw.includes('SUCCESS') || smsText.trim() !== '') state = 'RECEIVED';
  else if (raw.includes('CANCEL') || raw.includes('EXPIR') || raw.includes('REFUND') || raw.includes('FAIL')) state = 'CANCELLED';
  return { state, smsText };
}

async function cancelOrder(orderId) {
  try {
    return await call('/v2/sms/cancel', { order_id: orderId });
  } catch (e) {
    console.error('smspool cancel error:', e.message);
    return null;
  }
}

async function getBalance() {
  const data = await call('/v2/wallet/balance', {});
  const balance = Number(data.balance ?? data.wallet_balance ?? data.amount ?? NaN);
  if (isNaN(balance)) throw { code: 'SMSPOOL_BALANCE_ERROR', message: data.message || 'Could not read SMSPool balance.', statusCode: 502 };
  return balance;
}

async function getServices() {
  const data = await call('/v2/service/services', {});
  const list = Array.isArray(data) ? data : (data.services || data.data || []);
  return list
    .map(s => ({
      smspool_service_id: Number(s.id ?? s.service_id ?? s.service),
      name: String(s.name || s.service_name || '').trim(),
      price_usd: Number(s.price ?? s.cost ?? 0),
      in_stock: s.in_stock !== false && s.available !== false
    }))
    .filter(s => s.smspool_service_id && s.name);
}

function extractOtp(smsText) {
  const m = String(smsText || '').match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}

module.exports = { orderNumber, getStatus, cancelOrder, getBalance, getServices, extractOtp };
