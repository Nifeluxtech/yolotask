// /lib/smspool.js — SMSPool client with margin protection (max_price) + real-cost capture

const BASE = process.env.SMSPOOL_BASE_URL || 'https://api.smspool.net';

const ENDPOINTS = {
  balance:   ['/request/balance'],
  services:  ['/service/retrieve_all'],
  countries: ['/country/retrieve_all'],
  suggested: ['/request/suggested_countries'],
  pools:     ['/pool/retrieve_valid'],
  order:     ['/sms/order'],
  active:    ['/request/active'],
  check:     ['/sms/check'],
  cancel:    ['/sms/cancel']
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

function parsePrice(s) {
  const candidates = [s.price, s.Price, s.price_usd, s.usd_price, s.cost, s.min_price, s.from_price, s.average_price];
  for (const c of candidates) {
    const n = Number(c);
    if (!isNaN(n) && n > 0) return n;
  }
  return 0;
}

// ---------- CATALOG ----------
async function getBalance() {
  const data = await callAny('balance', {});
  const balance = Number(data.balance ?? data.wallet_balance ?? data.amount ?? NaN);
  if (isNaN(balance)) throw { code: 'SMSPOOL_BALANCE_ERROR', message: 'Unparsable balance: ' + JSON.stringify(data).slice(0, 200), statusCode: 502 };
  return balance;
}

async function getServices() {
  const data = await callAny('services', {});
  const list = Array.isArray(data) ? data : (data.services || data.data || []);
  return (Array.isArray(list) ? list : [])
    .map(s => ({
      smspool_service_id: Number(s.ID ?? s.id ?? s.service_id ?? s.service),
      name: String(s.name || s.service_name || '').trim(),
      price_usd: parsePrice(s),
      in_stock: s.in_stock !== false && s.in_stock !== 0 && s.available !== false
    }))
    .filter(s => s.smspool_service_id && s.name);
}

async function getCountries() {
  const data = await callAny('countries', {});
  const list = Array.isArray(data) ? data : (data.countries || data.data || []);
  const out = [];
  if (Array.isArray(list)) {
    for (const c of list) {
      if (c && typeof c === 'object') {
        const id = Number(c.ID ?? c.id ?? c.country_id ?? c.country);
        const name = String(c.name || c.country_name || '').trim();
        if (id && name) out.push({ id, name, short: String(c.short_name || c.code || '') });
      }
    }
  } else if (list && typeof list === 'object') {
    for (const [k, v] of Object.entries(list)) {
      const id = Number(k);
      const name = typeof v === 'string' ? v : String((v && (v.name || v.country_name)) || '');
      if (id && name) out.push({ id, name, short: '' });
    }
  }
  return out;
}

// ---------- POOLS & QUOTES ----------
async function getPools(serviceId, countryId) {
  const params = { service: String(serviceId) };
  if (countryId) params.country = String(countryId);
  const data = await callAny('pools', params);
  const list = Array.isArray(data) ? data : (data.pools || data.data || []);
  return (Array.isArray(list) ? list : [])
    .map(p => ({ pool: p.pool ?? p.id, name: String(p.name || ''), price: Number(p.price ?? p.cost ?? 0) }))
    .filter(p => p.price > 0);
}

/** Cheapest valid pool price for service+country. 0 = no pools. */
async function getQuote(serviceId, countryId) {
  try {
    const pools = await getPools(serviceId, countryId);
    if (pools.length) return Math.min(...pools.map(p => p.price));
  } catch (e) { /* no pools */ }
  return 0;
}

async function getSuggestedCountries(serviceId) {
  try {
    const data = await callAny('suggested', { service: String(serviceId) });
    const list = Array.isArray(data) ? data : (data.countries || data.data || []);
    const ids = [];
    if (Array.isArray(list)) {
      for (const c of list) {
        const n = Number(c && typeof c === 'object' ? (c.ID ?? c.id ?? c.country ?? c.country_id) : c);
        if (!isNaN(n) && n > 0) ids.push(n);
      }
    } else if (list && typeof list === 'object') {
      for (const k of Object.keys(list)) {
        const n = Number(k);
        if (!isNaN(n) && n > 0) ids.push(n);
      }
    }
    return ids;
  } catch (e) {
    return [];
  }
}

async function getServicePrice(serviceId) {
  const suggested = await getSuggestedCountries(serviceId);
  for (const c of suggested.slice(0, 3)) {
    const p = await getQuote(serviceId, c);
    if (p > 0) return p;
  }
  try {
    const countries = await getCountries();
    for (const c of countries.slice(0, 5)) {
      const p = await getQuote(serviceId, c.id);
      if (p > 0) return p;
    }
  } catch (e) { /* ignore */ }
  return 0;
}

// ---------- ORDER (with max_price margin guard) ----------
/**
 * maxPrice = the price we quoted the user's cost from.
 * SMSPool will only assign pools at/below it → our margin can never invert.
 */
async function orderNumber({ serviceId, countryId, maxPrice }) {
  const params = { service: String(serviceId) };
  if (countryId) params.country = String(countryId);
  if (maxPrice && maxPrice > 0) params.max_price = String(maxPrice);

  const data = await callAny('order', params);

  const orderId = data.order_code ?? data.orderid ?? data.order_id ?? data.orderId ?? data.order ?? data.id;
  const number = data.phonenumber ?? data.phone_number ?? data.number ?? data.phone;

  if (!orderId || !number) {
    throw { code: 'SMSPOOL_ORDER_FAILED', message: 'SMSPool order response missing order_code/phonenumber: ' + JSON.stringify(data).slice(0, 200), statusCode: 502 };
  }
  return { orderId: String(orderId), number: String(number) };
}

// ---------- STATUS / OTP + REAL COST ----------
async function getStatus(orderId) {
  try {
    const data = await callAny('active', {});
    const list = Array.isArray(data) ? data : (data.orders || data.data || []);
    const row = (Array.isArray(list) ? list : [])
      .find(o => String(o.order_code ?? o.orderid ?? o.order_id ?? '') === String(orderId));

    if (row) {
      const full = String(row.full_code ?? '').trim();
      const code = String(row.code ?? '').trim();
      const otp = full || (code && code !== '0' ? code : '');
      const st = String(row.status ?? '').toLowerCase();
      const cost = Number(row.cost ?? 0) || 0;   // REAL amount SMSPool charged us

      if (otp) return { state: 'RECEIVED', smsText: otp, cost };
      if (st.includes('cancel') || st.includes('refund') || st.includes('expir') || st.includes('fail')) return { state: 'CANCELLED', smsText: '', cost };
      return { state: 'WAITING', smsText: '', cost };
    }
  } catch (e) { /* fall through */ }

  try {
    const chk = await callAny('check', { orderid: String(orderId) });
    const code2 = String(chk.full_code ?? chk.code ?? chk.sms ?? '').trim();
    if (code2 && code2 !== '0') return { state: 'RECEIVED', smsText: code2, cost: 0 };
    if (Number(chk.status) === 1) return { state: 'WAITING', smsText: '', cost: 0 };
    return { state: 'CANCELLED', smsText: '', cost: 0 };
  } catch (e) {
    return { state: 'CANCELLED', smsText: '', cost: 0 };
  }
}

async function cancelOrder(orderId) {
  try {
    return await callAny('cancel', { orderid: String(orderId), sms_id: String(orderId) });
  } catch (e) {
    console.error('smspool cancel error:', e.message);
    return null;
  }
}

// ---------- DIAGNOSTICS ----------
async function rawProbe() {
  const report = [];
  const probes = [
    ['balance', {}],
    ['services', {}],
    ['countries', {}],
    ['suggested', { service: '1' }],
    ['pools', { service: '1', country: '2' }],
    ['order', { service: '1' }],
    ['active', {}],
    ['check', { orderid: '0' }],
    ['cancel', { orderid: '0' }]
  ];
  for (const [op, params] of probes) {
    for (const p of ENDPOINTS[op]) {
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

module.exports = {
  orderNumber, getStatus, cancelOrder, getBalance, getServices, getCountries,
  getPools, getQuote, getServicePrice, extractOtp, rawProbe, parsePrice
};
