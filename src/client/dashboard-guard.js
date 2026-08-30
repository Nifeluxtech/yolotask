import { apiRequest } from './api.js';

const app = document.querySelector('#app');
const requiredRole = document.body.dataset.role || null;
const requestedView = document.body.dataset.view || 'overview';

function message(title, copy, actionHref = '/auth/login.html', actionLabel = 'Log in') {
  app.innerHTML = `<main class="auth-form-wrap" style="min-height:100vh"><section class="card panel" style="width:min(520px,100%);text-align:center"><div class="brand" style="justify-content:center;margin-bottom:24px"><span class="brand-mark">Y</span> YOLOTASK</div><div class="section-kicker">Restricted area</div><h1 style="font-size:2.5rem;margin-top:10px">${title}</h1><p class="muted">${copy}</p><a class="btn btn-primary" href="${actionHref}">${actionLabel} ↗</a></section></main>`;
}

async function guard() {
  const session = JSON.parse(localStorage.getItem('yolotask_session') || '{}');
  if (!session.access_token) return message('Sign in required', 'Log in to reach your workspace.');
  try {
    const result = await apiRequest('auth?action=session');
    if (requiredRole && result.user?.role !== requiredRole) {
      return message('Wrong workspace', `This area is for ${requiredRole}s. Head to your own dashboard instead.`, result.dashboard_path || '/auth/login.html', 'Go to my dashboard');
    }
    document.body.dataset.view = requestedView;
    await import('./app.js');
  } catch (error) {
    localStorage.removeItem('yolotask_session');
    message('Session expired', 'Please sign in again to continue.', '/auth/login.html', 'Return to login');
  }
}

guard();
