// /public/js/api.js
const API_BASE = '/api';

const apiClient = {
  async request(endpoint, payload = {}) {
    const token = localStorage.getItem('yolotask_token');

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      // MAINTENANCE MODE: send everyone to the maintenance page
      if (data.error && data.error.code === 'MAINTENANCE') {
        if (!window.location.pathname.includes('maintenance.html')) {
          localStorage.removeItem('yolotask_token');
          localStorage.removeItem('yolotask_user');
          window.location.href = '/maintenance.html';
        }
        throw new Error(data.error.message);
      }

      // HTTP-level errors (401, 403, 500...)
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          if (!window.location.pathname.includes('login.html')) {
            localStorage.removeItem('yolotask_token');
            localStorage.removeItem('yolotask_user');
            window.location.href = '/login.html';
          }
        }
        throw new Error((data.error && data.error.message) || 'Request failed');
      }

      // Logical errors (200 OK but success:false)
      if (data.success === false) {
        throw new Error((data.error && data.error.message) || 'An error occurred.');
      }

      return data;
    } catch (err) {
      if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
        throw new Error('Network error. Please check your connection.');
      }
      throw err;
    }
  }
};
