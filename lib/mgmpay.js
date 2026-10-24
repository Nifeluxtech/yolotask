// /lib/mgmpay.js
// Legacy filename retained for route compatibility; implementation is AfrStar API v2.
const crypto = require('crypto');

const BASE = (process.env.AFRSTAR_BASE_URL || 'https://ngn.afrstar.com').replace(/\/+$/, '');
const fmtAmt = value => Number(value).toFixed(2);

function cfg() {
  const c = {
    baseUrl: BASE,
    merchantSn: process.env.AFRSTAR_MERCHANT_SN,
    merchantAk: process.env.AFRSTAR_MERCHANT_AK,
    merchantSk: process.env.AFRSTAR_MERCHANT_SK
  };
  const missing = Object.entries(c)
    .filter(([key, value]) => key !== 'baseUrl' && !value)
    .map(([key]) => 'AFRSTAR_' + ({ merchantSn: 'MERCHANT_SN', merchantAk: 'MERCHANT_AK', merchantSk: 'MERCHANT_SK' }[key]));
  if (missing.length) {
    throw { code: 'AFRSTAR_NOT_CONFIGURED', message: 'Missing env: ' + missing.join(', '), statusCode: 500 };
  }
  return c;
}

function md5(value) {
  return crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
}

// AfrStar v2 signs the documented values in the exact order, with no separators.
function signValues(values, secret) {
  return md5(values.map(value => String(value ?? '')).join('') + secret);
}

function signCollection(orderSn, amount, secret) {
  const c = cfg();
  return signValues([c.merchantAk, orderSn, fmtAmt(amount)], secret || c.merchantSk);
}

function signPayout(orderSn, account, upiHandle, amount, secret) {
  const c = cfg();
  return signValues([c.merchantAk, orderSn, account, upiHandle, fmtAmt(amount)], secret || c.merchantSk);
}

function verifyCollection(payload, originalAmount) {
  const c = cfg();
  if (String(payload.merchant_sn || '') !== String(c.merchantSn)) return false;
  const expected = signValues([c.merchantAk, payload.platform_osn, payload.status, fmtAmt(originalAmount)], c.merchantSk);
  const provided = String(payload.sign || '').toLowerCase();
  return provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function verifyPayout(payload, originalAmount) {
  const c = cfg();
  if (String(payload.merchant_sn || '') !== String(c.merchantSn)) return false;
  const expected = signValues([c.merchantAk, payload.platform_osn, payload.status, fmtAmt(originalAmount)], c.merchantSk);
  const provided = String(payload.sign || '').toLowerCase();
  return provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

async function post(path, body) {
  const c = cfg();
  const response = await fetch(c.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) {}
  if (!response.ok) {
    throw { code: 'AFRSTAR_HTTP_ERROR', message: `AfrStar HTTP ${response.status}: ${text.slice(0, 240)}`, statusCode: 502 };
  }
  if (json.code !== undefined && Number(json.code) !== 0) {
    throw { code: 'AFRSTAR_API_ERROR', message: json.message || `AfrStar error ${json.code}`, statusCode: 502 };
  }
  return json;
}

async function createDeposit({ orderId, amount, name, email, phone, remark, redirectUrl }) {
  const c = cfg();
  const amountText = fmtAmt(amount);
  return post('/gateway/payin/', {
    merchant_sn: c.merchantSn,
    order_sn: orderId,
    amount: amountText,
    name: String(name || 'YOLOTASK Customer'),
    email: String(email || ''),
    phone: String(phone || ''),
    remark: String(remark || 'YOLOTASK wallet top-up'),
    redirect_url: String(redirectUrl || ''),
    sign: signValues([c.merchantAk, orderId, amountText], c.merchantSk)
  });
}

async function createSettlement({ orderId, amount, payee, remark }) {
  const c = cfg();
  const amountText = fmtAmt(amount);
  const account = String(payee?.account || '');
  const upiHandle = '';
  return post('/gateway/payout/', {
    merchant_sn: c.merchantSn,
    order_sn: orderId,
    amount: amountText,
    type: 'bank',
    name: String(payee?.name || ''),
    account,
    ifsc: String(payee?.bank_code || ''),
    upi_handle: upiHandle,
    remark: String(remark || 'YOLOTASK withdrawal'),
    sign: signValues([c.merchantAk, orderId, account, upiHandle, amountText], c.merchantSk)
  });
}

async function getBalance() {
  const c = cfg();
  const response = await post('/gateway/balance/', {
    merchant_sn: c.merchantSn,
    sign: signValues([c.merchantAk], c.merchantSk)
  });
  return response.data || response;
}

// AfrStar v2 documents callbacks as the source of truth and does not document
// a collection/payout query endpoint. Keep these exports for old callers.
async function queryDeposit() {
  throw { code: 'AFRSTAR_CALLBACK_ONLY', message: 'AfrStar confirms deposits by callback. Please wait for confirmation.', statusCode: 400 };
}
async function querySettlement() {
  throw { code: 'AFRSTAR_CALLBACK_ONLY', message: 'AfrStar confirms payouts by callback. Please wait for confirmation.', statusCode: 400 };
}

const isFinalSuccess = status => Number(status) === 1;
const isTerminalFail = status => Number(status) === 9;

module.exports = {
  cfg, md5, signValues, signCollection, signPayout,
  verifyCollection, verifyPayout,
  createDeposit, queryDeposit, createSettlement, querySettlement, getBalance,
  isFinalSuccess, isTerminalFail, fmtAmt
};
