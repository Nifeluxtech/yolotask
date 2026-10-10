// /lib/fivesim.js — 5sim client
// Prices structure (verified live): { country: { service: { operator: { cost, count } } } }

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

// ---------- PUBLIC PRICE TREE (cached 5 min) ----------
let pubCache = { at: 0, data: null };

async function getPublic() {
  const now = Date.now();
  if (pubCache.data && now - pubCache.at < 5 * 60 * 1000) return pubCache.data;

  const raw = await get('/guest/prices');
  const root = raw && raw.countries ? raw.countries : raw;

  const countries = [];
  const tree = {}; // country -> service -> operator -> {cost, count}

  for (const [cSlug, services] of Object.entries(root || {})) {
    if (!services || typeof services !== 'object') continue;
    const svcMap = {};
    let anyService = false;

    for (const [sSlug, operators] of Object.entries(services)) {
      if (!operators || typeof operators !== 'object') continue;

      // Leaf shape guard: service -> {cost, count} directly (operator = any)
      if (typeof operators.cost !== 'undefined' || typeof operators.count !== 'undefined') {
        const cost = Number(operators.cost || 0);
        if (cost > 0) {
          svcMap[sSlug] = { any: { cost, count: Number(operators.count || 0) } };
          anyService = true;
        }
        continue;
      }

      const opMap = {};
      for (const [opSlug, info] of Object.entries(operators)) {
        if (!info || typeof info !== 'object') continue;
        const cost = Number(info.cost);
        const count = Number(info.count || 0);
        if (isFinite(cost) && cost > 0) opMap[opSlug] = { cost, count };
      }
      if (Object.keys(opMap).length) {
        svcMap[sSlug] = opMap;
        anyService = true;
      }
    }

    if (anyService) {
      countries.push({ slug: cSlug, name: prettify(cSlug) });
      tree[cSlug] = svcMap;
    }
  }

  countries.sort((a, b) => a.name.localeCompare(b.name));
  pubCache = { at: now, data: { countries, tree } };
  return pubCache.data;
}

/** Pick pricing for a service: preferred operator first, cheapest as fallback. */
function pickOperator(opMap, preferred) {
  if (preferred && opMap[preferred] && opMap[preferred].cost > 0) {
    return { cost: opMap[preferred].cost, count: opMap[preferred].count, operator: preferred };
  }
  let best = null;
  for (const [op, v] of Object.entries(opMap)) {
    if (!v || v.cost <= 0) continue;
    if (!best || v.cost < best.cost) best = { cost: v.cost, count: v.count, operator: op };
  }
  return best;
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

/** Real services for a country, priced on the configured operator (in-stock only). */
async function getServicesForCountry(countrySlug, preferredOperator) {
  const d = await getPublic();
  const svcMap = d.tree[countrySlug] || {};
  const out = [];
  for (const [sSlug, opMap] of Object.entries(svcMap)) {
    const pick = pickOperator(opMap, preferredOperator);
    if (pick && pick.count > 0) {
      out.push({ slug: sSlug, name: prettify(sSlug), cost: pick.cost, count: pick.count, operator: pick.operator });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function getQuote(countrySlug, serviceSlug, preferredOperator) {
  const d = await getPublic();
  const opMap = (d.tree[countrySlug] || {})[serviceSlug];
  if (!opMap) return null;
  const pick = pickOperator(opMap, preferredOperator);
  return pick ? { cost: pick.cost, operator: pick.operator } : null;
}

async function buy(countrySlug, operator, serviceSlug) {
  const o = await get(`/user/buy/activation/${encodeURIComponent(countrySlug)}/${encodeURIComponent(operator || 'any')}/${encodeURIComponent(serviceSlug)}`);
  if (!o || !o.id || !o.phone) {
    throw { code: 'FIVESIM_BUY_FAILED', message: '5sim buy response missing id/phone: ' + JSON.stringify(o).slice(0, 160), statusCode: 502 };
  }
  return o;
}

async function getOrder(id) {
  return get('/user/check/' + encodeURIComponent(id));
}

async function getStatus(id) {
  const o = await getOrder(id);
  const st = String(o.status || '').toUpperCase();
  const smsList = Array.isArray(o.sms) ? o.sms : [];
  const last = smsList[smsList.length - 1];
  const code = last ? (String(last.code || '').trim() || String(last.text || '').trim()) : '';
  const cost = Number(o.price || 0) || 0;

  if (st === 'RECEIVED' || st === 'FINISHED' || code) return { state: 'RECEIVED', smsText: code, cost };
  if (['CANCELED', 'CANCELLED', 'TIMEOUT', 'BANNED'].includes(st)) return { state: 'CANCELLED', smsText: '', cost };
  return { state: 'WAITING', smsText: '', cost };
}

async function cancel(id) {
  try {
    return await get('/user/cancel/' + encodeURIComponent(id));
  } catch (e) {
    console.error('fivesim cancel error:', e.message);
    return null;
  }
}

module.exports = { getBalance, getCountries, getServicesForCountry, getQuote, buy, getOrder, getStatus, cancel, prettify };
