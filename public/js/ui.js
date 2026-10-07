// /public/js/ui.js
// Core UI helpers + PWA bootstrap (service worker, install banner, push notifications)

const ONESIGNAL_APP_ID = '01a38103-d17e-4257-9af4-558b6500ed44'; // Your live OneSignal App ID

// ---------- CORE HELPERS ----------
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCurrency(amount) {
  const n = Number(amount || 0);
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
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

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ---------- PWA: MANIFEST + META INJECTION ----------
(function injectPwaMeta() {
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/manifest.json';
    document.head.appendChild(link);
  }
  if (!document.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#0A1628';
    document.head.appendChild(meta);
  }
  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.href = '/icons/icon.svg';
    document.head.appendChild(apple);
  }
  const mobile = document.createElement('meta');
  mobile.name = 'mobile-web-app-capable';
  mobile.content = 'yes';
  document.head.appendChild(mobile);
})();

// ---------- PWA: SERVICE WORKER ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}

// ---------- PWA: ONLINE/OFFLINE AWARENESS ----------
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
  bar.style.cssText = 'position:fixed; bottom:70px; left:50%; transform:translateX(-50%); z-index:9998; width:min(92vw,420px); background:#101E33; border:1px solid #00D4FF; border-radius:12px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5);';
  bar.innerHTML = `
    <img src="/icons/icon.svg" style="width:40px; height:40px; border-radius:8px;" alt="logo" />
    <div style="flex:1; color:#fff; font-size:13px; line-height:1.4;">
      <strong style="color:#00D4FF;">Install YOLOTASK</strong><br/>
      <span style="color:#94a3b8;">Faster access, works offline, feels native.</span>
    </div>
    <button id="installBtn" style="background:#00D4FF; color:#0A1628; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:12px; cursor:pointer;">Install</button>
    <button id="installDismiss" style="background:none; border:none; color:#64748B; font-size:16px; cursor:pointer;">✕</button>
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

// ---------- PUSH NOTIFICATIONS (OneSignal) ----------
(function initPush() {
  if (!ONESIGNAL_APP_ID) return;

  window.OneSignal = window.OneSignal || [];
  OneSignal.push(['init', {
    appId: ONESIGNAL_APP_ID,
    autoResubscribe: true,
    notifyButton: { enable: false },
    serviceWorkerParam: { scope: '/' }
  }]);

  const s = document.createElement('script');
  s.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
  s.defer = true;
  document.head.appendChild(s);

  // Tag logged-in user so the server can target pushes to them
  const tagUser = () => {
    try {
      const cached = JSON.parse(localStorage.getItem('yolotask_user') || 'null');
      if (cached && cached.id && window.OneSignal) {
        OneSignal.push(() => {
          if (OneSignal.User && OneSignal.User.addTag) OneSignal.User.addTag('user_id', cached.id);
        });
      }
    } catch (e) {}
  };
  window.addEventListener('load', () => setTimeout(tagUser, 2000));

  // Permission banner (logged in + permission undecided + not dismissed)
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
  bar.style.cssText = 'position:fixed; bottom:70px; left:50%; transform:translateX(-50%); z-index:9998; width:min(92vw,420px); background:#101E33; border:1px solid #10b981; border-radius:12px; padding:14px 16px; display:flex; align-items:center; gap:12px; box-shadow:0 8px 24px rgba(0,0,0,0.5);';
  bar.innerHTML = `
    <span style="font-size:24px;">🔔</span>
    <div style="flex:1; color:#fff; font-size:13px; line-height:1.4;">
      <strong style="color:#10b981;">Enable alerts</strong><br/>
      <span style="color:#94a3b8;">Get instant notifications for approvals & payouts.</span>
    </div>
    <button id="pushEnable" style="background:#10b981; color:#0A1628; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:12px; cursor:pointer;">Enable</button>
    <button id="pushDismiss" style="background:none; border:none; color:#64748B; font-size:16px; cursor:pointer;">✕</button>
  `;
  document.body.appendChild(bar);

  document.getElementById('pushEnable').addEventListener('click', () => {
    if (window.OneSignal) {
      OneSignal.push(() => {
        if (OneSignal.Slidedown && OneSignal.Slidedown.promptPush) OneSignal.Slidedown.promptPush();
      });
    }
    bar.remove();
  });
  document.getElementById('pushDismiss').addEventListener('click', () => {
    localStorage.setItem('yolo_push_dismissed', '1');
    bar.remove();
  });
}
