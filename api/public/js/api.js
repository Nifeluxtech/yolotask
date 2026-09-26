const API_BASE = '/api';

const apiClient = {
  async request(endpoint, payload = {}) {
    const token = localStorage.getItem('yolotask_token');
    
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('yolotask_token');
        localStorage.removeItem('yolotask_user');
        window.location.href = '/login.html';
      }
      throw new Error(data.error?.message || 'Request failed');
    }

    return data;
  }
};
