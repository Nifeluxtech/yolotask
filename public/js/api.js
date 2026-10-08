// /public/js/api.js
const API_BASE = '/api';

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
        try {
          const rr = await fetch(`${API_BASE}/auth.js`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'refresh_session', refresh_token: refresh })
          });
          const rj = await rr.json();
          if (rj && rj.success && rj.data && rj.data.session) {
            localStorage.setItem('yolotask_token', rj.data.session.access_token);
            localStorage.setItem('yolotask_refresh', rj.data.session.refresh_token);
            return this.request(endpoint, payload, true); // retry once with fresh token
          }
        } catch (e) { /* fall through to logout */ }
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
      if (response.status === 403) {
        localStorage.removeItem('yolotask_token');
        localStorage.removeItem('yolotask_refresh');
        localStorage.removeItem('yolotask_user');
        const p = window.location.pathname;
        if (!p.includes('login.html') && !p.includes('register.html')) window.location.href = '/login.html';
      }
      throw new Error((data && data.error && data.error.message) || 'Request failed.');
    }

    // ---- Logical errors ----
    if (data.success === false) {
      throw new Error((data.error && data.error.message) || 'An error occurred.');
    }

    return data;
  }
};
