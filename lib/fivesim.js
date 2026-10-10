// /lib/fivesim.js — 5sim client (cheap numbers provider)

const BASE = process.env.FIVESIM_BASE_URL || 'https://5sim.net/v1';

function assertKey() {
  const k = process.env.FIVESIM_API_KEY;
  if (!k) throw { code: 'FIVESIM_NOT_CONFIGURED', message: 'FIVESIM_API_KEY is not set in Vercel environment variables (then REDEPLOY).', statusCode: 500 };
  return k;
}

async function get(path) {
  const resp = await fetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + assertKey(), Accept: 'application/json' }
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!resp.ok) {
    throw { code: 'FIVESIM_HTTP_ERROR', message: `5sim HTTP ${resp.status}: ${(json && (json.message || json.error)) || text.slice(0, 120)}`, statusCode: 502 };
  }
  return json;
}

function prettify(slug) {
  return String(slug).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------- PUBLIC PRICE/STOCK MAP (cached 5 min) ----------
let pubCache = { at: 0, data: null };

async function getPublic() {
  const now = Date.now();
  if (pubCache.data && now - pubCache.at < 5 * 60 * 1000) return pubCache.data;

  const raw = await get('/guest/public');
  const root = raw && raw.countries ? raw.countries : raw;

  const countries = [];
  const byCountry = {};

  for (const [cSlug, ops] of Object.entries(root || {})) {
    if (!ops || typeof ops !== 'object') continue;
    const map = new Map();
    for (const [opSlug, svcs] of Object.entries(ops)) {
      if (!svcs || typeof svcs !== 'object') continue;
      for (const [sSlug, info] of Object.entries(svcs)) {
        const cost = Number(info && info.cost);
        const count = Number((info && info.count) || 0);
        if (!isFinite(cost) || cost <= 0) continue;
        const prev = map.get(sSlug);
        if (!prev) map.set(sSlug, { cost, operator: opSlug, count });
        else {
          prev.count += count;
          if (cost < prev.cost) { prev.cost = cost; prev.operator = opSlug; }
        }
      }
    }
    if (map.size) {
      countries.push({ slug: cSlug, name: prettify(cSlug) });
      byCountry[cSlug] = [...map.entries()]
        .map(([sSlug, v]) => ({ slug: sSlug, name: prettify(sSlug), cost: v.cost, operator: v.operator, count: v.count }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  countries.sort((a, b) => a.name.localeCompare(b.name));
  pubCache = { at: now, data: { countries, byCountry } };
  return pubCache.data;
}

// ---------- OPERATIONS ----------
async function getBalance() {
  const p = await get('/user/profile');
  return Number(p.balance ?? 0);
}

async function getCountries() {
  const d = await getPublic();
  return d.countries;
}

async function getServicesForCountry(countrySlug) {
  const d = await getPublic();
  return d.byCountry[countrySlug] || [];
}

async function getQuote(countrySlug, serviceSlug) {
  const sv = await getServicesForCountry(countrySlug);
  const hit = sv.find(x => x.slug === serviceSlug);
  return hit ? { cost: hit.cost, operator: hit.operator } : null;
}

async function buy(countrySlug, operator, serviceSlug) {
  const o = await get(`/user/buy/activation/${encodeURIComponent(countrySlug)}/${encodeURIComponent(operator || 'any')}/${encodeURIComponent(serviceSlug)}`);
  if (!o || !o.id || !o.phone) {
    throw { code: 'FIVESIM_BUY_FAILED', message: '5sim buy response missing id/phone: ' + JSON.stringify(o).slice(0, 160), statusCode: 502 };
  }
  return o;
}

async function getOrder(id) {
  return get('/user/order/' + encodeURIComponent(id));
}

async function getStatus(id) {
  const o = await getOrder(id);
  const st = String(o.status || '').toUpperCase();
  const smsList = Array.isArray(o.sms) ? o.sms : [];
  const last = smsList[smsList.length - 1];
  const code = last ? (String(last.code || '').trim() || String(last.text || '').trim()) : '';
  const cost = Number(o.price || 0) || 0;

  if (st === 'RECEIVED' || code) return { state: 'RECEIVED', smsText: code, cost };
  if (['CANCELED', 'CANCELLED', 'TIMEOUT', 'BANNED', 'FINISHED'].includes(st)) return { state: 'CANCELLED', smsText: '', cost };
  return { state: 'WAITING', smsText: '', cost };
}

async function cancel(id) {
  try { return await get('/user/cancel/' + encodeURIComponent(id)); }
  catch (e) { console.error('fivesim cancel error:', e.message); return null; }
}

module.exports = { getBalance, getCountries, getServicesForCountry, getQuote, buy, getOrder, getStatus, cancel, prettify };
