// /public/js/ui.js
// Core helpers + Theme + Premium chrome (header, bell, SMS button, dock) + PWA + Push

const ONESIGNAL_APP_ID = '01a38103-d17e-4257-9af4-558b6500ed44';

// ---------- THEME ENGINE ----------
(function initTheme() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/themes.css';
  document.head.appendChild(link);
  const saved = localStorage.getItem('yolo_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

function applyTheme(theme) {
  localStorage.setItem('yolo_theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

window.toggleTheme = function () {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(current);
  showToast(current === 'dark' ? 'Dark mode on' : 'Light mode on', 'success');
};

// ---------- CORE HELPERS ----------
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatCurrency(amount) {
  const n = Number(amount || 0);
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateInput) {
  const d = new Date(dateInput);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function showToast(message, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed; bottom:110px; left:50%; transform:translateX(-50%); z-index:9999; display:flex; flex-direction:column; gap:10px; width:min(92vw,420px); pointer-events:none;';
    document.body.appendChild(container);
  }
  const colors = {
    success: { bg: '#064e3b', border: '#10b981', icon: '✓' },
    error:   { bg: '#7f1d1d', border: '#ef4444', icon: '✕' },
    warning: { bg: '#78350f', border: '#f59e0b', icon: '⚠' }
  };
  const c = colors[type] || colors.success;
  const toast = document.createElement('div');
  toast.style.cssText = `background:${c.bg}; border:1px solid ${c.border}; border-left:5px solid ${c.border}; color:#fff; padding:14px 18px; border-radius:10px; font-size:14px; display:flex; gap:10px; align-items:flex-start; box-shadow:0 8px 24px rgba(0,0,0,0.4);`;
  toast.innerHTML = `<span style="font-weight:800;">${c.icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

// ---------- PREMIUM CHROME ----------
(function injectPremiumChrome() {
  const path = window.location.pathname;
  if (path.includes('receipt.html')) return;

  if (!document.getElementById('bell-styles')) {
    const st = document.createElement('style');
    st.id = 'bell-styles';
    st.textContent = `
      .yolo-bell { position: relative; font-size: 19px; line-height: 1; text-decoration: none; margin-left: 12px; padding: 6px; border-radius: 10px; }
      .yolo-bell:active { background: var(--accent-glow); }
      .bell-badge { position: absolute; top: 0px; right: -2px; background: var(--error); color: #fff; border-radius: 10px; font-size: 9px; font-weight: 800; padding: 1px 5px; min-width: 15px; text-align: center; box-shadow: 0 0 8px rgba(239,68,68,.6); display: none; }
      .yolo-sms { margin-left: 10px; padding: 7px 14px; border-radius: 12px; border: 1px solid var(--accent); background: var(--accent-glow); color: var(--accent); font-weight: 800; font-size: 12px; text-decoration: none; white-space: nowrap; }
      .yolo-sms:active { transform: scale(.97); }
    `;
    document.head.appendChild(st);
  }

  const header = document.querySelector('header');
  if (header) {
    header.classList.add('yolo-header');
    header.querySelectorAll('div, a, span').forEach(el => {
      const txt = el.textContent.trim();
      if (txt.startsWith('YOLOTASK') && txt.length < 40 && el.children.length <= 2) el.classList.add('yolo-brand');
    });
  }

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('yolotask_user') || 'null'); } catch (e) {}
  const role = cached && cached.role;

  // Bell
  if (header && role && !header.querySelector('a[href*="notifications"]')) {
    const bell = document.createElement('a');
    bell.href = '/notifications.html';
    bell.className = 'yolo-bell';
    bell.setAttribute('aria-label', 'Notifications');
    bell.innerHTML = '🔔<span class="bell-badge" id="bellBadge"></span>';
    header.appendChild(bell);

    const token = localStorage.getItem('yolotask_token');
    if (token) {
      fetch('/api/auth.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'get_notifications' })
      }).then(r => r.json()).then(d => {
        const list = (d && d.data && d.data.notifications) || [];
        const unread = list.filter(n => !n.is_read).length;
        const badge = document.getElementById('bellBadge');
        if (badge && unread > 0) { badge.textContent = unread > 9 ? '9+' : unread; badge.style.display = 'inline-block'; }
      }).catch(() => {});
    }
  }

  // SMS button: replaces header Logout for earner/advertiser (dock logout remains)
  if (header && (role === 'earner' || role === 'advertiser') && !path.includes('/sms.html')) {
    const smsBtn = document.createElement('a');
    smsBtn.href = '/sms.html';
    smsBtn.className = 'yolo-sms';
    smsBtn.textContent = '📱 SMS';
    const headerLogout = Array.from(header.querySelectorAll('a, button'))
      .find(el => el.textContent.trim().toLowerCase() === 'logout');
    if (headerLogout) headerLogout.replaceWith(smsBtn);
    else header.appendChild(smsBtn);
  }

  // Dock
  if (!role) return;

  const I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"></path><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"></path><path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z"></path></svg>',
    refer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"></circle><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
    exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>'
  };

  const LOGOUT_ITEM = { href: '/login.html', label: 'Logout', icon: I.exit, match: [], logout: true };

  const DOCKS = {
    earner: [
      { href: '/earner/dashboard.html', label: 'Home', icon: I.home, match: ['/earner/dashboard'] },
      { href: '/earner/tasks.html', label: 'Tasks', icon: I.tasks, match: ['/earner/tasks', '/earner/task-details'] },
      { href: '/earner/wallet.html', label: 'Wallet', icon: I.wallet, match: ['/earner/wallet'] },
      { href: '/earner/referrals.html', label: 'Refer', icon: I.refer, match: ['/earner/referrals', '/earner/leaderboard'] },
      { href: '/earner/profile.html', label: 'Profile', icon: I.user, match: ['/earner/profile', '/settings'] }
    ],
    advertiser: [
      { href: '/advertiser/dashboard.html', label: 'Home', icon: I.home, match: ['/advertiser/dashboard'] },
      { href: '/advertiser/campaigns.html', label: 'Campaigns', icon: I.tasks, match: ['/advertiser/campaigns', '/advertiser/create-campaign', '/advertiser/analytics'] },
      { href: '/advertiser/submissions.html', label: 'Reviews', icon: I.review, match: ['/advertiser/submissions'] },
      { href: '/advertiser/wallet.html', label: 'Wallet', icon: I.wallet, match: ['/advertiser/wallet'] },
      { href: '/advertiser/profile.html', label: 'Profile', icon: I.user, match: ['/advertiser/profile', '/settings'] }
    ],
    reviewer: [
      { href: '/reviewer/dashboard.html', label: 'Queue', icon: I.review, match: ['/reviewer'] },
      { href: '/settings.html', label: 'Settings', icon: I.gear, match: ['/settings'] }
    ],
    admin: [
      { href: '/admin/dashboard.html', label: 'Home', icon: I.home, match: ['/admin/dashboard'] },
      { href: '/admin/campaigns.html', label: 'Reviews', icon: I.review, match: ['/admin/campaigns', '/admin/escalated'] },
      { href: '/admin/withdrawals.html', label: 'Payouts', icon: I.pay, match: ['/admin/withdrawals'] },
      { href: '/admin/users.html', label: 'Users', icon: I.users, match: ['/admin/users', '/admin/leaders'] },
      { href: '/admin/settings.html', label: 'Settings', icon: I.gear, match: ['/admin/settings', '/admin/announcements'] }
    ]
  };

  const items = [...(DOCKS[role] || []), LOGOUT_ITEM];
  if (items.length > 1) {
    const nav = document.createElement('nav');
    nav.className = 'yolo-dock';
    nav.innerHTML = items.map(it => {
      const active = !it.logout && it.match.some(m => path.startsWith(m));
      const extra = it.logout ? ' style="color:var(--error);" onclick="localStorage.clear()"' : '';
      return `<a href="${it.href}" class="${active ? 'active' : ''}"${extra}>${it.icon}<span>${it.label}</span></a>`;
    }).join('');
    document.body.appendChild(nav);
  }

  // Theme toggle
  if (!document.getElementById('themeToggleBtn')) {
    const btn = document.createElement('button');
    btn.id = 'themeToggleBtn';
    btn.className = 'theme-toggle';
    btn.textContent = (localStorage.getItem('yolo_theme') || 'dark') === 'dark' ? '🌙' : '☀️';
    btn.setAttribute('aria-label', 'Toggle theme');
    btn.onclick = window.toggleTheme;
    document.body.appendChild(btn);
  }
})();

// ---------- PWA META ----------
(function injectPwaMeta() {
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link');
    link.rel = 'manifest'; link.href = '/manifest.json';
    document.head.appendChild(link);
  }
  if (!document.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color'; meta.content = '#0A1628';
    document.head.appendChild(meta);
  }
  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon'; apple.href = '/icons/icon.svg';
    document.head.appendChild(apple);
  }
})();

if ('serviceWorker' in navigator && !ONESIGNAL_APP_ID) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed:', err));
  });
}

window.addEventListener('offline', () => showToast('You are offline. Showing cached content.', 'warning'));
window.addEventListener('online', () => showToast('Back online!', 'success'));

// ---------- INSTALL BANNER ----------
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem('yolo_install_dismissed')) showInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById('installBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'installBanner';
  bar.style.cssText = 'position:fixed; bottom:96px; left:50%; transform:translateX(-50%); z-index:9998; width:min(92vw,420px); background:var(--bg-secondary); border:1px solid var(--accent); border-radius:12px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5);';
  bar.innerHTML = `
    <img src="/icons/icon.svg" style="width:40px; height:40px; border-radius:8px;" alt="logo" />
    <div style="flex:1; font-size:13px; line-height:1.4; color:var(--text-primary);">
      <strong style="color:var(--accent);">Install YOLOTASK</strong><br/>
      <span style="color:var(--text-secondary);">Faster access, works offline, feels native.</span>
    </div>
    <button id="installBtn" style="background:var(--accent); color:#fff; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:12px; cursor:pointer;">Install</button>
    <button id="installDismiss" style="background:none; border:none; color:var(--text-muted); font-size:16px; cursor:pointer;">✕</button>
  `;
  document.body.appendChild(bar);
  document.getElementById('installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    bar.remove();
  });
  document.getElementById('installDismiss').addEventListener('click', () => {
    localStorage.setItem('yolo_install_dismissed', '1');
    bar.remove();
  });
}

// ---------- PUSH ----------
(function initPush() {
  if (!ONESIGNAL_APP_ID) return;
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  OneSignalDeferred.push(async function (OneSignal) {
    await OneSignal.init({ appId: ONESIGNAL_APP_ID });
  });
  const s = document.createElement('script');
  s.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
  s.defer = true;
  document.head.appendChild(s);

  const tagUser = () => {
    try {
      const cached = JSON.parse(localStorage.getItem('yolotask_user') || 'null');
      if (cached && cached.id) {
        OneSignalDeferred.push(async function (OneSignal) {
          if (OneSignal.User && OneSignal.User.addTag) OneSignal.User.addTag('user_id', cached.id);
        });
      }
    } catch (e) {}
  };
  window.addEventListener('load', () => setTimeout(tagUser, 2000));

  window.addEventListener('load', () => {
    setTimeout(() => {
      const loggedIn = !!localStorage.getItem('yolotask_user');
      const dismissed = localStorage.getItem('yolo_push_dismissed');
      const undecided = typeof Notification !== 'undefined' && Notification.permission === 'default';
      if (loggedIn && undecided && !dismissed) showPushBanner();
    }, 3000);
  });
})();

function showPushBanner() {
  if (document.getElementById('pushBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'pushBanner';
  bar.style.cssText = 'position:fixed; bottom:96px; left:50%; transform:translateX(-50%); z-index:9998; width:min(92vw,420px); background:var(--bg-secondary); border:1px solid var(--success); border-radius:12px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5);';
  bar.innerHTML = `
    <span style="font-size:24px;">🔔</span>
    <div style="flex:1; font-size:13px; line-height:1.4; color:var(--text-primary);">
      <strong style="color:var(--success);">Enable alerts</strong><br/>
      <span style="color:var(--text-secondary);">Get instant notifications for approvals & payouts.</span>
    </div>
    <button id="pushEnable" style="background:var(--success); color:#fff; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:12px; cursor:pointer;">Enable</button>
    <button id="pushDismiss" style="background:none; border:none; color:var(--text-muted); font-size:16px; cursor:pointer;">✕</button>
  `;
  document.body.appendChild(bar);
  document.getElementById('pushEnable').addEventListener('click', () => {
    OneSignalDeferred.push(async function (OneSignal) {
      await OneSignal.Slidedown.promptPush();
    });
    bar.remove();
  });
  document.getElementById('pushDismiss').addEventListener('click', () => {
    localStorage.setItem('yolo_push_dismissed', '1');
    bar.remove();
  });
}
