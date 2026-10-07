// /public/js/ui.js
// Core helpers + Theme engine + Premium footer + PWA + Push

const ONESIGNAL_APP_ID = '01a38103-d17e-4257-9af4-558b6500ed44';

// ---------- THEME ENGINE (runs immediately) ----------
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
    container.style.cssText = 'position:fixed; bottom:90px; left:50%; transform:translateX(-50%); z-index:9999; display:flex; flex-direction:column; gap:10px; width:min(92vw,420px); pointer-events:none;';
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

// ---------- PREMIUM FOOTER + THEME TOGGLE INJECTION ----------
(function injectSiteChrome() {
  const path = window.location.pathname;
  const isAdmin = path.startsWith('/admin');
  const isReceipt = path.includes('receipt.html');

  // Theme toggle (everywhere except admin)
  if (!isAdmin && !document.getElementById('themeToggleBtn')) {
    const btn = document.createElement('button');
    btn.id = 'themeToggleBtn';
    btn.className = 'theme-toggle';
    btn.textContent = (localStorage.getItem('yolo_theme') || 'dark') === 'dark' ? '🌙' : '☀️';
    btn.setAttribute('aria-label', 'Toggle theme');
    btn.onclick = window.toggleTheme;
    document.body.appendChild(btn);
  }

  // Premium footer (skip admin + receipt)
  if (isAdmin || isReceipt) return;

  const footerHtml = `
    <div class="pf-grid">
      <div>
        <div class="pf-brand">YOLOTASK</div>
        <p class="pf-tag">Nigeria's trusted digital task marketplace. Complete tasks, earn rewards, and grow your brand — all in one place.</p>
        <div class="pf-badges">
          <span class="pf-badge">🔒 Secured by Paystack</span>
          <span class="pf-badge">⚡ Instant Push Alerts</span>
        </div>
      </div>
      <div class="pf-col">
        <h4>Product</h4>
        <a href="/earner/tasks.html">Browse Tasks</a>
        <a href="/earner/my-submissions.html">My Submissions</a>
        <a href="/earner/leaderboard.html">Leaderboard</a>
        <a href="/earner/wallet.html">Wallet</a>
        <a href="/earner/referrals.html">Refer & Earn</a>
      </div>
      <div class="pf-col">
        <h4>Company</h4>
        <a href="/login.html">Advertiser Login</a>
        <a href="/register.html">Create Account</a>
        <a href="mailto:support@nifelux.com">Support</a>
      </div>
      <div class="pf-col">
        <h4>Legal</h4>
        <a href="/terms.html">Terms of Service</a>
        <a href="/privacy.html">Privacy Policy</a>
        <a href="/refunds.html">Refund & Dispute Policy</a>
      </div>
    </div>
    <div class="pf-bottom">
      <span>© ${new Date().getFullYear()} Nifelux Media. YOLOTASK™ is a promotional marketplace, not an investment platform.</span>
      <span>Made with pride in Lagos, Nigeria 🇳🇬</span>
    </div>
  `;

  const existing = document.querySelector('footer');
  if (existing) {
    existing.className = 'premium-footer';
    existing.innerHTML = footerHtml;
  } else {
    const f = document.createElement('footer');
    f.className = 'premium-footer';
    f.innerHTML = footerHtml;
    document.body.appendChild(f);
  }
})();

// ---------- PWA: MANIFEST + META ----------
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

// ---------- PWA: SERVICE WORKER (only when push disabled) ----------
if ('serviceWorker' in navigator && !ONESIGNAL_APP_ID) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed:', err));
  });
}

window.addEventListener('offline', () => showToast('You are offline. Showing cached content.', 'warning'));
window.addEventListener('online', () => showToast('Back online!', 'success'));

// ---------- PWA: INSTALL BANNER ----------
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
  bar.style.cssText = 'position:fixed; bottom:70px; left:50%; transform:translateX(-50%); z-index:9998; width:min(92vw,420px); background:var(--bg-secondary); border:1px solid var(--accent); border-radius:12px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5);';
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

// ---------- PUSH (OneSignal v16) ----------
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
  bar.style.cssText = 'position:fixed; bottom:70px; left:50%; transform:translateX(-50%); z-index:9998; width:min(92vw,420px); background:var(--bg-secondary); border:1px solid var(--success); border-radius:12px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5);';
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
