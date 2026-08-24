const config = window.YOLOTASK_CONFIG || {};

export class ApiError extends Error {
  constructor(message, status = 400, details = null) { super(message); this.status = status; this.details = details; }
}

export async function apiRequest(path, options = {}) {
  const response = await fetch(`/api/${path.replace(/^\//, '')}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new ApiError(payload.error || 'The request could not be completed.', response.status, payload.details);
  return payload;
}

export function isConfigured() { return Boolean(config.supabaseUrl && config.supabaseAnonKey); }
export function publicConfig() { return config; }
