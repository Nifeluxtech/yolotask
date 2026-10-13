// /public/js/api.js
const API_BASE = '/api';
let refreshPromise = null;

const apiClient = {
  async request(endpoint, payload = {}, _isRetry = false) {
    const token = localStorage.getItem('yolotask_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let response;
    try {
      response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    } catch (e) {
      throw new Error('Network error. Please check your connection.');
    }

    let data = null;
    try { data = await response.json(); } catch (e) { throw new Error('Invalid server response.'); }

    // ---- SILENT REFRESH: access token expired ----
    if (response.status === 401 && !_isRetry) {
      const refresh = localStorage.getItem('yolotask_refresh');
      if (refresh) {
        if (!refreshPromise) {
          refreshPromise = fetch(`${API_BASE}/auth.js`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'refresh_session', refresh_token: refresh })
          }).then(rr => rr.json()).then(rj => {
            if (!rj || !rj.success || !rj.data || !rj.data.session || !rj.data.session.access_token) {
              throw new Error('Refresh failed');
            }
            localStorage.setItem('yolotask_token', rj.data.session.access_token);
            if (rj.data.session.refresh_token) localStorage.setItem('yolotask_refresh', rj.data.session.refresh_token);
            return true;
          }).finally(() => { refreshPromise = null; });
        }
        try {
          await refreshPromise;
          return this.request(endpoint, payload, true); // retry once with fresh token
        } catch (e) { /* refresh token is no longer valid; clear below */ }
      }
      localStorage.removeItem('yolotask_token');
      localStorage.removeItem('yolotask_refresh');
      localStorage.removeItem('yolotask_user');
      const p = window.location.pathname;
      if (!p.includes('login.html') && !p.includes('register.html')) window.location.href = '/login.html';
      throw new Error('Session expired. Please log in again.');
    }

    // ---- MAINTENANCE MODE ----
    if (data && data.error && data.error.code === 'MAINTENANCE') {
      if (!window.location.pathname.includes('maintenance.html')) {
        localStorage.removeItem('yolotask_token');
        localStorage.removeItem('yolotask_refresh');
        localStorage.removeItem('yolotask_user');
        window.location.href = '/maintenance.html';
      }
      throw new Error(data.error.message);
    }

    // ---- HTTP errors ----
    if (!response.ok) {
      const errorCode = data && data.error && data.error.code;
      if (response.status === 403 && ['UNAUTHORIZED', 'FORBIDDEN'].includes(errorCode)) {
        localStorage.removeItem('yolotask_token');
        localStorage.removeItem('yolotask_refresh');
        localStorage.removeItem('yolotask_user');
        const p = window.location.pathname;
        if (!p.includes('login.html') && !p.includes('register.html')) window.location.href = '/login.html';
      }
      const error = new Error((data && data.error && data.error.message) || 'Request failed.');
      error.status = response.status;
      error.code = errorCode || 'HTTP_ERROR';
      throw error;
    }

    // ---- Logical errors ----
    if (data.success === false) {
      const error = new Error((data.error && data.error.message) || 'An error occurred.');
      error.status = response.status;
      error.code = data.error && data.error.code;
      throw error;
    }

    return data;
  }
};
