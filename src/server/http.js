export function json(res, status, body) { res.status(status).setHeader('Content-Type','application/json'); return res.end(JSON.stringify(body)); }
export function ok(res, data={}) { return json(res, 200, { ok:true, ...data }); }
export function fail(res, status, error, details=null) { return json(res, status, { ok:false, error, ...(details ? {details} : {}) }); }
export async function body(req) { let raw=''; for await (const chunk of req) raw += chunk; if (!raw) return {}; try { return JSON.parse(raw); } catch { throw new Error('Request body must be valid JSON.'); } }
export function method(req, expected) { return req.method === expected; }
export function bearer(req) { const value=req.headers.authorization || ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; }
export function safeError(error) { return error?.message || 'Unexpected server error.'; }
