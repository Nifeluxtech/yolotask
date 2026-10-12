// /lib/vqpay.js — VortaQpay client (docs-verified signing & headers)
const crypto = require('crypto');

const BASE = (process.env.VQPAY_BASE_URL || 'https://api.vqpay-sandbox.com').replace(/\/+$/, '');

function cfg() {
  const c = {
    appId: process.env.VQPAY_APP_ID,
    merchantNo: process.env.VQPAY_MERCHANT_NO,
    collectionKey: process.env.VQPAY_COLLECTION_KEY,
    payoutKey: process.env.VQPAY_PAYOUT_KEY
  };
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => 'VQPAY_' + k.toUpperCase());
  if (missing.length) {
    throw { code: 'VQPAY_NOT_CONFIGURED', message: 'Missing env: ' + missing.join(', '), statusCode: 500 };
  }
  return c;
}

/** MD5 uppercase signature: sorted non-empty scalars, k=v&..., + &key=secret. payee/nested excluded. */
function sign(data, secret) {
  const pairs = [];
  const keys = Object.keys(data).sort(); // ASCII ascending
  for (const k of keys) {
    if (k === 'signature' || k === 'payee') continue;
    const v = data[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    const text = String(v);
    if (text === '') continue;
    pairs.push(`${k}=${text}`);
  }
  const source = pairs.join('&') + '&key=' + secret;
  return crypto.createHash('md5').update(source, 'utf8').digest('hex').toUpperCase();
}

function verifySignature(payload, secret) {
  const provided = String(payload.signature || '').toUpperCase();
  if (!provided) return false;
  return sign(payload, secret) === provided;
}

function nonce() {
  return String(Math.floor(10000000 + Math.random() * 90000000)); // 8 digits
}

async function post(path, data, secret) {
  const c = cfg();
  const timestamp = Date.now(); // 13-digit UTC ms
  data.signature = sign(data, secret);

  const body = JSON.stringify({ merchant_no: c.merchantNo, data });
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ApiVersion': '1.0',
      'AppId': c.appId,
      'Noncestr': nonce(),
      'Timestamp': String(timestamp)
    },
    body
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!resp.ok) {
    throw { code: 'VQPAY_HTTP_ERROR', message: `VQPay HTTP ${resp.status}: ${text.slice(0, 160)}`, statusCode: 502 };
  }
  return json || {};
}

const fmtAmt = (n) => Number(n).toFixed(2);

// ---------- COLLECTION (deposits) ----------
async function createDeposit({ orderId, amount, notificationUrl, successUrl, methodId, flow, country, currency }) {
  const c = cfg();
  const data = {
    country: country || 'NG',
    currency: currency || 'NGN',
    payment_method_id: String(methodId),
    payment_method_flow: flow || 'REDIRECT',
    order_id: orderId,
    amount: fmtAmt(amount),
    notification_url: notificationUrl,
    success_redirect_url: successUrl,
    timestamp: Date.now()
  };
  return await post('/api/pay/payment', data, c.collectionKey);
}

async function queryDeposit(orderId) {
  const c = cfg();
  return await post('/api/pay/queryPaymentOrder', { order_id: orderId, timestamp: Date.now() }, c.collectionKey);
}

// ---------- PAYOUT (settlements) ----------
async function createSettlement({ orderId, amount, notificationUrl, payee, country, currency }) {
  const c = cfg();
  const data = {
    country: country || 'NG',
    currency: currency || 'NGN',
    order_id: orderId,
    amount: fmtAmt(amount),
    notification_url: notificationUrl,
    timestamp: Date.now(),
    payee // excluded from signature inside sign()
  };
  return await post('/api/settle/settlement', data, c.payoutKey);
}

async function querySettlement(orderId) {
  const c = cfg();
  return await post('/api/settle/querySettlementOrder', { order_id: orderId, timestamp: Date.now() }, c.payoutKey);
}

async function getBalance() {
  const c = cfg();
  const merchant_no = c.merchantNo;
  const signature = sign({ merchant_no }, c.payoutKey);
  const resp = await fetch(BASE + '/api/merchant/balance', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ApiVersion': '1.0',
      'AppId': c.appId,
      'Noncestr': nonce(),
      'Timestamp': String(Date.now())
    },
    body: JSON.stringify({ merchant_no, signature })
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.data) {
    throw { code: 'VQPAY_BALANCE_ERROR', message: JSON.stringify(json).slice(0, 160), statusCode: 502 };
  }
  return json.data;
}

// ---------- STATUS HELPERS ----------
const PAYOUT_STATUS = { 1: 'APPLY', 2: 'PENDING', 3: 'PROCESSING', 4: 'FAIL', 5: 'BACK', 100: 'SUCCESS' };
function isFinalSuccess(code) { return Number(code) === 100; }
function isFinalFail(code) { return [4, 5].includes(Number(code)); }

module.exports = {
  sign, verifySignature, createDeposit, queryDeposit,
  createSettlement, querySettlement, getBalance,
  PAYOUT_STATUS, isFinalSuccess, isFinalFail, fmtAmt
};
