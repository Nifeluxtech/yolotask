// /lib/smspool.js — resilient SMSPool client with endpoint fallbacks + raw diagnostics

const BASE = process.env.SMSPOOL_BASE_URL || 'https://api.smspool.net';

const ENDPOINTS = {
  balance:  ['/v2/wallet/balance', '/v2/account/balance', '/wallet/balance', '/v2/wallet/balance/'],
  services: ['/v2/service/services', '/v2/sms/services', '/service/services', '/v2/service/list'],
  order:    ['/v2/sms/order', '/v2/sms/orders', '/sms/order'],
  status:   ['/v2/sms/status', '/v2/sms/order/status', '/sms/status'],
  cancel:   ['/v2/sms/cancel', '/v2/sms/order/cancel', '/sms/cancel']
};

function assertKey() {
  const key = process.env.SMSPOOL_API_KEY;
  if (!key) throw { code: 'SMS_NOT_CONFIGURED', message: 'SMSPOOL_API_KEY is not set in Vercel environment variables (then REDEPLOY).', statusCode: 500 };
  return key.trim();
}

async function post(path, params) {
  const key = assertKey();
  const body = new URLSearchParams({ key, ...params });
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: resp.ok, status: resp.status, json, text };
}

function isFailure(json) {
  if (!json || typeof json !== 'object') return true;
  if (json.success === 0 || json.success === false) return true;
  if (json.status === 0 || json.status === 'error' || json.status === 'failed') return true;
  if (json.error) return true;
  return false;
}

function failMsg(r) {
  const m = (r.json && (r.json.message || r.json.error || r.json.detail)) || r.text || '';
  return `HTTP ${r.status}: ${String(m).slice(0, 140)}`;
}

async function callAny(op, params = {}) {
  const paths = ENDPOINTS[op] || [];
  const errors = [];
  for (const p of paths) {
    try {
      const r = await post(p, params);
      if (r.ok && r.json && !isFailure(r.json)) return r.json;
      errors.push(`${p} → ${failMsg(r)}`);
    } catch (e) {
      errors.push(`${p} → ${e.message}`);
    }
  }
  throw {
    code: 'SMSPOOL_REQUEST_FAILED',
    message: `SMSPool "${op}" failed on all endpoints :: ${errors.join(' || ')}`,
    statusCode: 502
  };
}

async function orderNumber({ serviceId, tier }) {
  const data = await callAny('order', { service: String(serviceId), price_tier: String(tier || 2) });
  const orderId = data.order_id ?? data.orderId ?? data.order ?? data.id;
  const number = data.number ?? data.phone ?? data.phone_number ?? data.msisdn;
  if (!orderId || !number) {
    throw { code: 'SMSPOOL_ORDER_FAILED', message: 'SMSPool response missing order/number: ' + JSON.stringify(data).slice(0, 200), statusCode: 502 };
  }
  return { orderId: String(orderId), number: String(number) };
}

async function getStatus(orderId) {
  const data = await callAny('status', { order_id: orderId });
  const raw = String(data.status || data.state || '').toUpperCase();
  const smsText = String(data.sms || data.message || data.code_text || data.code || '');
  let state = 'WAITING';
  if (raw.includes('RECEIVED') || raw.includes('COMPLETED') || raw.includes('SUCCESS') || /\d{4,8}/.test(smsText)) state = 'RECEIVED';
  else if (raw.includes('CANCEL') || raw.includes('EXPIR') || raw.includes('REFUND') || raw.includes('FAIL')) state = 'CANCELLED';
  return { state, smsText };
}

async function cancelOrder(orderId) {
  try { return await callAny('cancel', { order_id: orderId }); }
  catch (e) { console.error('smspool cancel error:', e.message); return null; }
}

async function getBalance() {
  const data = await callAny('balance', {});
  const balance = Number(data.balance ?? data.wallet_balance ?? data.amount ?? data.wallet?.balance ?? NaN);
  if (isNaN(balance)) {
    throw { code: 'SMSPOOL_BALANCE_ERROR', message: 'Unparsable balance response: ' + JSON.stringify(data).slice(0, 200), statusCode: 502 };
  }
  return balance;
}

async function getServices() {
  const data = await callAny('services', {});
  const list = Array.isArray(data) ? data : (data.services || data.data || data.list || []);
  return (Array.isArray(list) ? list : [])
    .map(s => ({
      smspool_service_id: Number(s.id ?? s.service_id ?? s.service ?? s.sid),
      name: String(s.name || s.service_name || s.title || '').trim(),
      price_usd: Number(s.price ?? s.cost ?? s.price_usd ?? 0),
      in_stock: s.in_stock !== false && s.available !== false
    }))
    .filter(s => s.smspool_service_id && s.name);
}

/**
 * Diagnostics: hits EVERY candidate endpoint for balance + services and
 * returns the raw outcomes so we can see exactly what SMSPool says.
 */
async function rawProbe() {
  const report = [];
  for (const op of ['balance', 'services']) {
    for (const p of ENDPOINTS[op]) {
      try {
        const r = await post(p, {});
        report.push({
          op, path: p, http: r.status,
          result: r.ok && r.json && !isFailure(r.json) ? 'OK' : 'FAIL',
          snippet: String((r.json ? JSON.stringify(r.json) : r.text)).slice(0, 180)
        });
      } catch (e) {
        report.push({ op, path: p, http: 'EXC', result: 'FAIL', snippet: e.message });
      }
    }
  }
  return report;
}

function extractOtp(smsText) {
  const m = String(smsText || '').match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}

module.exports = { orderNumber, getStatus, cancelOrder, getBalance, getServices, extractOtp, rawProbe };
