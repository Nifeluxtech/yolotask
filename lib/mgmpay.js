// /lib/mgmpay.js — MGM Pay facade. MGMPAY_MODE=relay routes via PHP relay; else direct.
const crypto = require('crypto');
const relay = require('./relay');

const BASE = (process.env.MGMPAY_BASE_URL || 'https://api.mgm-paysandbox.com').replace(/\/+$/, '');
const UA = 'YOLOTASK-Server/1.0 (+https://yolotask.nifelux.com)';

function cfg() {
  const c = {
    appId: process.env.MGMPAY_APP_ID,
    merchantNo: process.env.MGMPAY_MERCHANT_NO,
    collectionKey: process.env.MGMPAY_COLLECTION_KEY,
    payoutKey: process.env.MGMPAY_PAYOUT_KEY
  };
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => 'MGMPAY_' + k.toUpperCase());
  if (missing.length) throw { code: 'MGMPAY_NOT_CONFIGURED', message: 'Missing env: ' + missing.join(', '), statusCode: 500 };
  return c;
}

/** MGM MD5 signature: sorted non-empty scalars, exclude signature + nested, + &key=secret, uppercase */
function sign(data, secret, excludeNested = ['payer', 'payee']) {
  let exclList = [];
  if (Array.isArray(excludeNested)) exclList = excludeNested;
  else if (excludeNested && Array.isArray(excludeNested.excludeNested)) exclList = excludeNested.excludeNested;

  const pairs = [];
  for (const k of Object.keys(data).sort()) {
    if (k === 'signature' || exclList.includes(k)) continue;
    const v = data[k];
    if (v === null || v === undefined || typeof v === 'object') continue;
    const text = String(v);
    if (text === '') continue;
    pairs.push(`${k}=${text}`);
  }
  return crypto.createHash('md5').update(pairs.join('&') + '&key=' + secret, 'utf8').digest('hex').toUpperCase();
}

function verifySignature(payload, secret, excludeNested = ['payer', 'payee']) {
  const provided = String(payload.signature || '').toUpperCase();
  if (!provided) return false;
  return sign(payload, secret, excludeNested) === provided;
}

function nonce() { return String(Math.floor(10000000 + Math.random() * 90000000)); }
const fmtAmt = (n) => Number(n).toFixed(2);

async function post(path, data, secret, opts = {}) {
  const c = cfg();
  const signature = sign(data, secret, opts.excludeNested || ['payer', 'payee']);
  const body = JSON.stringify({ merchant_no: c.merchantNo, data: { ...data, signature } });
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'ApiVersion': '1.0', 'AppId': c.appId,
      'Noncestr': nonce(), 'Timestamp': String(Date.now()), 'User-Agent': UA
    },
    body
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!resp.ok) throw { code: 'MGMPAY_HTTP_ERROR', message: `MGM Pay HTTP ${resp.status}: ${text.slice(0, 160)}`, statusCode: 502 };
  return json || {};
}

// ---------- DEPOSIT ----------
async function createDeposit({ orderId, amount, notificationUrl, successUrl, methodId, flow, country, currency }) {
  if (relay.relayEnabled()) {
    return await relay.relayPost('/relay_api.php?op=deposit_create', {
      order_id: orderId,
      amount: fmtAmt(amount),
      currency: currency || 'NGN',
      country: country || 'NG',
      method_id: methodId || 'BANK_CARD',
      flow: flow || 'REDIRECT',
      success_url: successUrl || ''
    });
  }
  const c = cfg();
  const data = {
    country: country || 'NG', currency: currency || 'NGN',
    payment_method_id: String(methodId || 'BANK_CARD'),
    payment_method_flow: flow || 'REDIRECT',
    order_id: orderId, amount: fmtAmt(amount),
    notification_url: notificationUrl,
    ...(successUrl ? { success_redirect_url: successUrl } : {}),
    timestamp: Date.now()
  };
  return await post('/api/pay/payment', data, c.collectionKey, { excludeNested: ['payer'] });
}

async function queryDeposit(orderId) {
  if (relay.relayEnabled()) return await relay.relayPost('/relay_api.php?op=deposit_query', { order_id: orderId });
  const c = cfg();
  return await post('/api/pay/queryPaymentOrder', { order_id: orderId }, c.collectionKey, { excludeNested: [] });
}

// ---------- PAYOUT ----------
async function createSettlement({ orderId, amount, notificationUrl, payee, country, currency }) {
  if (relay.relayEnabled()) {
    return await relay.relayPost('/relay_api.php?op=payout_create', {
      order_id: orderId,
      amount: fmtAmt(amount),
      currency: currency || 'NGN',
      country: country || 'NG',
      payee_name: payee.name,
      payee_account: payee.account,
      payee_bank_code: payee.bank_code,
      payee_bank_name: payee.bank_name || ''
    });
  }
  const c = cfg();
  const data = {
    country: country || 'NG', currency: currency || 'NGN',
    order_id: orderId, amount: fmtAmt(amount),
    notification_url: notificationUrl, timestamp: Date.now(), payee
  };
  return await post('/api/settle/settlement', data, c.payoutKey, { excludeNested: ['payee'] });
}

async function querySettlement(orderId) {
  if (relay.relayEnabled()) return await relay.relayPost('/relay_api.php?op=payout_query', { order_id: orderId });
  const c = cfg();
  return await post('/api/settle/querySettlementOrder', { order_id: orderId }, c.payoutKey, { excludeNested: [] });
}

async function getBalance() {
  if (relay.relayEnabled()) {
    const r = await relay.relayPost('/relay_api.php?op=balance', {});
    return r.data || {};
  }
  const c = cfg();
  const merchant_no = c.merchantNo;
  const signature = sign({ merchant_no }, c.payoutKey, { excludeNested: [] });
  const resp = await fetch(BASE + '/api/merchant/balance', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'ApiVersion': '1.0', 'AppId': c.appId,
      'Noncestr': nonce(), 'Timestamp': String(Date.now()), 'User-Agent': UA
    },
    body: JSON.stringify({ merchant_no, signature })
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.data) throw { code: 'MGMPAY_BALANCE_ERROR', message: JSON.stringify(json).slice(0, 160), statusCode: 502 };
  return json.data;
}

// ---------- STATUS HELPERS ----------
const DEPOSIT_STATUS = { 1: 'CREATED', 2: 'WAITING', 3: 'PROCESSING', 4: 'FAILED', 5: 'CANCELLED', 6: 'TIMED_OUT', 100: 'SUCCESS' };
const PAYOUT_STATUS = { 1: 'CREATED', 2: 'PENDING_REVIEW', 3: 'DISBURSING', 4: 'DISBURSEMENT_FAILED', 5: 'RETURNED', 100: 'SUCCESS' };
const isFinalSuccess = (code) => Number(code) === 100;
const isTerminalFail = (code) => [4, 5].includes(Number(code));

module.exports = {
  cfg, sign, verifySignature, createDeposit, queryDeposit,
  createSettlement, querySettlement, getBalance,
  DEPOSIT_STATUS, PAYOUT_STATUS, isFinalSuccess, isTerminalFail, fmtAmt
};
