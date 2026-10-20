// /lib/relay.js — HMAC-signed client for the trusted PHP relay site
const crypto = require('crypto');

function relayEnabled() {
  return String(process.env.MGMPAY_MODE || 'direct').toLowerCase() === 'relay';
}

/** Canonical HMAC: sorted non-empty scalars, exclude relay_signature, HMAC-SHA256, uppercase hex */
function relaySign(obj, secret) {
  const pairs = Object.keys(obj).sort()
    .filter(k => k !== 'relay_signature')
    .map(k => [k, obj[k]])
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object' && String(v) !== '')
    .map(([k, v]) => `${k}=${v}`);
  return crypto.createHmac('sha256', secret).update(pairs.join('&'), 'utf8').digest('hex').toUpperCase();
}

function relayVerify(obj, secret) {
  const provided = String(obj.relay_signature || '').toUpperCase();
  if (!provided || !secret) return false;
  const ts = Number(obj.timestamp || 0);
  if (ts && Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false; // replay window
  return relaySign(obj, secret) === provided;
}

async function relayPost(path, payload) {
  const secret = process.env.RELAY_SHARED_SECRET;
  const base = (process.env.RELAY_BASE_URL || '').replace(/\/+$/, '');
  if (!secret || !base) {
    throw { code: 'RELAY_NOT_CONFIGURED', message: 'Set MGMPAY_MODE, RELAY_BASE_URL, RELAY_SHARED_SECRET.', statusCode: 500 };
  }
  const body = { ...payload, timestamp: Date.now() };
  body.relay_signature = relaySign(body, secret);

  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!resp.ok) {
    throw { code: 'RELAY_HTTP_ERROR', message: `Relay HTTP ${resp.status}: ${text.slice(0, 160)}`, statusCode: 502 };
  }
  return json || {};
}

module.exports = { relayEnabled, relaySign, relayVerify, relayPost };
