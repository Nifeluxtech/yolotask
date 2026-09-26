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

      // 1. Check for HTTP errors (401, 403, 500)
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          localStorage.removeItem('yolotask_token');
          localStorage.removeItem('yolotask_user');
          // Don't redirect immediately if we are already on the login page
          if (!window.location.pathname.includes('login.html')) {
            window.location.href = '/login.html';
          }
        }
        throw new Error(data.error?.message || 'Request failed');
      }

      // 2. Check for Logical errors (Server returned 200, but success is false)
      if (data.success === false) {
        throw new Error(data.error?.message || 'An error occurred.');
      }

      return data;
    } catch (err) {
      // If it's a network error (fetch failed completely)
      if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
        throw new Error('Network error. Please check your connection.');
      }
      throw err;
    }
  }
};
