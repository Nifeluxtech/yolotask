// /lib/smspool.js — SMSPool client (docs-verified paths + robust price parsing)

const BASE = process.env.SMSPOOL_BASE_URL || 'https://api.smspool.net';

const ENDPOINTS = {
  balance:  ['/request/balance'],
  services: ['/service/retrieve_all', '/pricing/retrieve_all', '/request/services'],
  pools:    ['/pool/retrieve_valid', '/pool/retrieve_all'],
  order:    ['/sms/order', '/request/order'],
  status:   ['/sms/status', '/request/status'],
  cancel:   ['/sms/cancel', '/request/cancel']
};

function assertKey() {
  const key = process.env.SMSPOOL_API_KEY;
  if (!key) throw { code: 'SMS_NOT_CONFIGURED', message: 'SMSPOOL_API_KEY is not set in Vercel environment variables (then REDEPLOY).', statusCode: 500 };
  return key.trim();
}

async function post(path, params) {
  const key = assertKey();
  const body = new URLSearchParams({ key, web: '1', ...params });
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + key
    },
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
  if (json.status === 'error' || json.status === 'failed') return true;
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
  throw { code: 'SMSPOOL_REQUEST_FAILED', message: `SMSPool "${op}" failed :: ${errors.join(' || ')}`, statusCode: 502 };
}

// ---------- PRICE PARSING (every shape SMSPool might use) ----------
function parsePrice(s) {
  const candidates = [
    s.price, s.Price, s.PRICE, s.price_usd, s.usd_price, s.cost, s.min_price,
    s.from_price, s.start_price, s.average_price, s.rate, s.unit_price
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (!isNaN(n) && n > 0) return n;
  }
  if (Array.isArray(s.prices)) {
    const nums = s.prices.map(p => Number(p && (p.price ?? p.value ?? p))).filter(n => !isNaN(n) && n > 0);
    if (nums.length) return Math.min(...nums);
  }
  if (Array.isArray(s.pools)) {
    const nums = s.pools.map(p => Number(p && (p.price ?? p.cost ?? p))).filter(n => !isNaN(n) && n > 0);
    if (nums.length) return Math.min(...nums);
  }
  return 0;
}

// ---------- OPERATIONS ----------
async function getBalance() {
  const data = await callAny('balance', {});
  const balance = Number(data.balance ?? data.wallet_balance ?? data.amount ?? NaN);
  if (isNaN(balance)) throw { code: 'SMSPOOL_BALANCE_ERROR', message: 'Unparsable balance: ' + JSON.stringify(data).slice(0, 200), statusCode: 502 };
  return balance;
}

async function getServices() {
  const data = await callAny('services', {});
  const list = Array.isArray(data) ? data : (data.services || data.data || data.list || []);
  return (Array.isArray(list) ? list : [])
    .map(s => ({
      smspool_service_id: Number(s.ID ?? s.id ?? s.service_id ?? s.service),
      name: String(s.name || s.service_name || '').trim(),
      price_usd: parsePrice(s),
      in_stock: s.in_stock !== false && s.in_stock !== 0 && s.available !== false
    }))
    .filter(s => s.smspool_service_id && s.name);
}

/**
 * Live price for one service: pool pricing first (real current price), then catalog.
 */
async function getServicePrice(serviceId) {
  try {
    const data = await callAny('pools', { service: String(serviceId) });
    const list = Array.isArray(data) ? data : (data.pools || data.data || []);
    const nums = (Array.isArray(list) ? list : [])
      .map(p => Number(p && (p.price ?? p.cost ?? p)))
      .filter(n => !isNaN(n) && n > 0);
    if (nums.length) return Math.min(...nums);
  } catch (e) { /* fall through */ }

  try {
    const services = await getServices();
    const hit = services.find(x => x.smspool_service_id === Number(serviceId));
    if (hit && hit.price_usd > 0) return hit.price_usd;
  } catch (e) { /* fall through */ }

  return 0;
}

async function orderNumber({ serviceId, tier }) {
  const params = { service: String(serviceId) };
  if (tier) params.price_tier = String(tier);
  const data = await callAny('order', params);
  const orderId = data.sms_id ?? data.order_id ?? data.orderId ?? data.order ?? data.id;
  const number = data.phone_number ?? data.number ?? data.phone ?? data.msisdn;
  if (!orderId || !number) {
    throw { code: 'SMSPOOL_ORDER_FAILED', message: 'SMSPool order response missing id/number: ' + JSON.stringify(data).slice(0, 200), statusCode: 502 };
  }
  return { orderId: String(orderId), number: String(number) };
}

async function getStatus(orderId) {
  const data = await callAny('status', { sms_id: orderId, order_id: orderId });
  const smsText = String(data.sms ?? data.message ?? data.code_text ?? data.sms_code ?? '');
  const raw = String(data.status ?? data.state ?? '').toUpperCase();
  if (smsText.trim() !== '' || raw.includes('RECEIVED') || raw.includes('SUCCESS')) return { state: 'RECEIVED', smsText };
  if (raw.includes('CANCEL') || raw.includes('REFUND') || raw.includes('EXPIR') || raw.includes('FAIL')) return { state: 'CANCELLED', smsText: '' };
  return { state: 'WAITING', smsText: '' };
}

async function cancelOrder(orderId) {
  try { return await callAny('cancel', { sms_id: orderId, order_id: orderId }); }
  catch (e) { console.error('smspool cancel error:', e.message); return null; }
}

async function rawProbe() {
  const report = [];
  for (const op of ['balance', 'services', 'pools', 'order', 'status', 'cancel']) {
    for (const p of ENDPOINTS[op]) {
      const params = op === 'order' ? { service: '1' } : op === 'status' || op === 'cancel' ? { sms_id: '0', order_id: '0' } : op === 'pools' ? { service: '1' } : {};
      try {
        const r = await post(p, params);
        report.push({
          op, path: p, http: r.status,
          result: r.ok && r.json && !isFailure(r.json) ? 'OK' : (r.status === 404 ? 'FAIL' : 'PATH-EXISTS'),
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

module.exports = { orderNumber, getStatus, cancelOrder, getBalance, getServices, getServicePrice, extractOtp, rawProbe, parsePrice };
