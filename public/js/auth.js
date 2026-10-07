// /public/js/auth.js — Frontend auth guard & role router

const ROLE_HOME = {
  earner: '/earner/dashboard.html',
  advertiser: '/advertiser/dashboard.html',
  reviewer: '/reviewer/dashboard.html',
  admin: '/admin/dashboard.html'
};

async function checkAuthAndRedirect(requiredRole = null) {
  const token = localStorage.getItem('yolotask_token');
  if (!token) {
    window.location.href = '/login.html';
    return null;
  }

  try {
    const res = await apiClient.request('auth.js', { action: 'get-session' });
    const profile = res.data.profile;
    localStorage.setItem('yolotask_user', JSON.stringify(profile));

    const home = ROLE_HOME[profile.role] || '/login.html';

    if (requiredRole && profile.role !== requiredRole && profile.role !== 'admin') {
      window.location.href = home;
      return null;
    }

    return profile;
  } catch (err) {
    localStorage.clear();
    window.location.href = '/login.html';
    return null;
  }
}

function getCachedUser() {
  try { return JSON.parse(localStorage.getItem('yolotask_user') || 'null'); } catch (e) { return null; }
}

function logout() {
  localStorage.clear();
  window.location.href = '/login.html';
}
