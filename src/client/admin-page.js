import { apiRequest } from './api.js';

const app = document.querySelector('#app');
const requestedView = document.body.dataset.view || document.body.dataset.adminView || 'overview';

function message(title, copy, actionHref='/auth/login.html', actionLabel='Log in') {
  app.innerHTML = `<main class="auth-form-wrap" style="min-height:100vh"><section class="card panel" style="width:min(520px,100%);text-align:center"><div class="brand" style="justify-content:center;margin-bottom:24px"><span class="brand-mark">Y</span> YOLOTASK</div><div class="section-kicker">Admin access</div><h1 style="font-size:2.5rem;margin-top:10px">${title}</h1><p class="muted">${copy}</p><a class="btn btn-primary" href="${actionHref}">${actionLabel} ↗</a></section></main>`;
}

async function guard() {
  const session = JSON.parse(localStorage.getItem('yolotask_session') || '{}');
  if (!session.access_token) return message('Sign in required', 'This area is reserved for authorized YOLOTASK administrators.');
  try {
    const result = await apiRequest('admin?action=dashboard');
    if (!result.dashboard) throw new Error('Admin access is not available for this account.');
    document.body.dataset.view = requestedView;
    await import('./app.js');
  } catch (error) {
    localStorage.removeItem('yolotask_session');
    message('Access restricted', 'Only users with the administrator role can visit this dashboard.', '/auth/login.html', 'Return to login');
  }
}

guard();
