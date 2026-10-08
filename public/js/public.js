// /public/js/public.js — Public chrome + dynamics + flip-card auth (with refresh token storage)

(function injectPublicChrome() {
  const path = location.pathname;
  const isAuthPage = path.includes('login.html') || path.includes('register.html');

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('yolotask_user') || 'null'); } catch (e) {}
  const ROLE_HOME = {
    earner: '/earner/dashboard.html', advertiser: '/advertiser/dashboard.html',
    reviewer: '/reviewer/dashboard.html', admin: '/admin/dashboard.html'
  };

  if (!document.querySelector('.pub-header')) {
    const h = document.createElement('header');
    h.className = 'pub-header';
    const right = cached
      ? `<a class="btn-prim" href="${ROLE_HOME[cached.role] || '/'}">Open Dashboard</a>`
      : `<a class="btn-ghost" href="/login.html">Login</a><a class="btn-prim" href="/register.html">Get Started</a>`;
    h.innerHTML = `
      <a class="pub-brand yolo-brand" href="/">YOLOTASK</a>
      <nav class="pub-nav">
        <a href="/#features">Features</a>
        <a href="/#how">How it works</a>
        <a href="/#advertisers">Advertisers</a>
        <a href="/terms.html">Legal</a>
      </nav>
      <div class="pub-actions">${right}</div>`;
    document.body.prepend(h);
  }

  if (!isAuthPage && !document.querySelector('.pub-footer')) {
    const f = document.createElement('footer');
    f.className = 'pub-footer';
    f.innerHTML = `
      <div class="pf-inner">
        <div>
          <span class="pub-brand yolo-brand" style="font-size:18px;">YOLOTASK</span>
          <div class="pf-copy" style="margin-top:6px;">© ${new Date().getFullYear()} Nifelux Media • A promotional marketplace, not an investment platform.</div>
        </div>
        <div class="pf-links">
          <a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a>
          <a href="/refunds.html">Refunds</a><a href="mailto:support@nifelux.com">Support</a>
        </div>
      </div>`;
    document.body.appendChild(f);
  }

  const io = ('IntersectionObserver' in window)
    ? new IntersectionObserver(entries => entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      }), { threshold: 0.15 })
    : null;

  window.__observeReveals = function () {
    document.querySelectorAll('.reveal:not(.in)').forEach(el => io ? io.observe(el) : el.classList.add('in'));
  };

  window.__animateCounters = function () {
    document.querySelectorAll('[data-count]').forEach(el => {
      const target = parseFloat(el.dataset.count || '0');
      const isNaira = el.dataset.format === 'naira';
      const dur = 1500;
      const t0 = performance.now();
      (function tick(t) {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        const val = Math.round(target * eased);
        el.textContent = isNaira ? '₦' + val.toLocaleString('en-NG') : val.toLocaleString('en-NG');
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.__observeReveals);
  else window.__observeReveals();
})();

// ================= FLIP-CARD AUTH =================
window.__initFlipAuth = function (initialFace, refCode) {
  const card = document.getElementById('flipCard');
  if (!card) return;

  const ROLE_HOME = {
    earner: '/earner/dashboard.html', advertiser: '/advertiser/dashboard.html',
    reviewer: '/reviewer/dashboard.html', admin: '/admin/dashboard.html'
  };
  let role = 'earner';
  const ref = refCode || '';

  // Stores token + REFRESH token so sessions survive token expiry
  function storeSession(session) {
    localStorage.setItem('yolotask_token', session.access_token);
    if (session.refresh_token) localStorage.setItem('yolotask_refresh', session.refresh_token);
  }

  card.innerHTML = `
    <div class="flip-face front">
      <div class="face-title">Welcome back 👋</div>
      <div class="face-sub">Sign in to continue earning or growing your brand.</div>
      <label class="f-label">Email</label>
      <input type="email" id="liEmail" class="f-input" placeholder="you@example.com" autocomplete="email" />
      <label class="f-label">Password</label>
      <input type="password" id="liPass" class="f-input" placeholder="••••••••" autocomplete="current-password" />
      <button class="btn btn-primary w-full" id="liBtn" type="button">Sign In</button>
      <div style="text-align:right; margin-top:10px;">
        <a href="/forgot-password.html" style="font-size:12px; color:var(--text-secondary); text-decoration:none;">Forgot password?</a>
      </div>
      <div class="flip-switch">New to YOLOTASK? <a id="toRegister">Create an account</a></div>
    </div>

    <div class="flip-face back">
      <div class="face-title">Create your account ✨</div>
      <div class="face-sub">Join Nigeria's fastest-growing task marketplace.</div>
      <div class="role-seg">
        <button type="button" id="roleEarner" class="active">💪 I want to Earn</button>
        <button type="button" id="roleAdv">📢 I want to Advertise</button>
      </div>
      ${ref ? `<div class="ref-badge">🎟️ Invited with code: ${escapeHtml(ref)}</div>` : ''}
      <label class="f-label">Full Name</label>
      <input type="text" id="rgName" class="f-input" placeholder="Your full name" />
      <label class="f-label">Email</label>
      <input type="email" id="rgEmail" class="f-input" placeholder="you@example.com" />
      <label class="f-label">Password (min 8 characters)</label>
      <input type="password" id="rgPass" class="f-input" placeholder="••••••••" />
      <label class="f-label">Gender</label>
      <select id="rgGender" class="f-input">
        <option value="">Prefer not to say</option>
        <option value="male">Male</option>
        <option value="female">Female</option>
      </select>
      <div id="rgInterestsBlock">
        <label class="f-label">Pick at least 3 interests (matches you to premium tasks)</label>
        <div class="chip-wrap" id="rgInterests"><div style="font-size:12px; color:var(--text-secondary);">Loading interests...</div></div>
      </div>
      <button class="btn btn-primary w-full" id="rgBtn" type="button">Create Account</button>
      <div class="flip-switch">Already have an account? <a id="toLogin">Sign in</a></div>
    </div>`;

  const flip = (toBack) => card.classList.toggle('flipped', toBack);
  if (initialFace === 'register') flip(true);

  document.getElementById('toRegister').addEventListener('click', () => {
    flip(true);
    history.replaceState(null, '', '/register.html' + (ref ? '?ref=' + ref : ''));
  });
  document.getElementById('toLogin').addEventListener('click', () => {
    flip(false);
    history.replaceState(null, '', '/login.html');
  });

  const re = document.getElementById('roleEarner'), ra = document.getElementById('roleAdv');
  re.addEventListener('click', () => {
    role = 'earner'; re.classList.add('active'); ra.classList.remove('active');
    document.getElementById('rgInterestsBlock').style.display = 'block';
  });
  ra.addEventListener('click', () => {
    role = 'advertiser'; ra.classList.add('active'); re.classList.remove('active');
    document.getElementById('rgInterestsBlock').style.display = 'none';
  });

  apiClient.request('auth.js', { action: 'get_public_data' })
    .then(res => {
      const list = res.data.interests || [];
      document.getElementById('rgInterests').innerHTML = list.length
        ? list.map(i => `<label class="chip2"><input type="checkbox" name="rgInt" value="${i.id}" /> ${escapeHtml(i.name)}</label>`).join('')
        : '<div style="font-size:12px; color:var(--text-secondary);">No interests configured yet.</div>';
    })
    .catch(() => {
      document.getElementById('rgInterests').innerHTML = '<div style="font-size:12px; color:var(--text-secondary);">Could not load interests.</div>';
    });

  async function doLogin() {
    const btn = document.getElementById('liBtn');
    const email = document.getElementById('liEmail').value.trim();
    const password = document.getElementById('liPass').value;
    if (!email || !password) { showToast('Enter your email and password.', 'error'); return; }

    btn.disabled = true; btn.textContent = 'Signing in...';
    try {
      const res = await apiClient.request('auth.js', { action: 'login', email, password });
      const session = res.data && res.data.session;
      if (!session || !session.access_token) throw new Error('Login response missing session token.');
      storeSession(session);

      const s = await apiClient.request('auth.js', { action: 'get-session' });
      const p = s.data.profile;
      localStorage.setItem('yolotask_user', JSON.stringify(p));
      showToast(`Welcome back, ${p.full_name}!`, 'success');
      setTimeout(() => { window.location.href = ROLE_HOME[p.role] || '/login.html'; }, 500);
    } catch (err) {
      showToast(err.message || 'Login failed.', 'error');
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  }
  document.getElementById('liBtn').addEventListener('click', doLogin);
  document.getElementById('liPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  document.getElementById('rgBtn').addEventListener('click', async () => {
    const btn = document.getElementById('rgBtn');
    const full_name = document.getElementById('rgName').value.trim();
    const email = document.getElementById('rgEmail').value.trim();
    const password = document.getElementById('rgPass').value;
    const gender = document.getElementById('rgGender').value;
    const interests = Array.from(document.querySelectorAll('input[name="rgInt"]:checked')).map(c => c.value);

    if (!full_name || !email || !password) { showToast('Fill in name, email and password.', 'error'); return; }
    if (password.length < 8) { showToast('Password must be at least 8 characters.', 'error'); return; }
    if (role === 'earner' && interests.length < 3) { showToast('Pick at least 3 interests.', 'error'); return; }

    btn.disabled = true; btn.textContent = 'Creating account...';
    try {
      await apiClient.request('auth.js', {
        action: 'register', email, password, full_name, gender, role, interests,
        referral_code: ref || undefined
      });

      const lr = await apiClient.request('auth.js', { action: 'login', email, password });
      storeSession(lr.data.session);
      const s = await apiClient.request('auth.js', { action: 'get-session' });
      const p = s.data.profile;
      localStorage.setItem('yolotask_user', JSON.stringify(p));

      showToast('Account created! Welcome to YOLOTASK 🎉', 'success');
      setTimeout(() => { window.location.href = ROLE_HOME[p.role] || '/login.html'; }, 700);
    } catch (err) {
      showToast(err.message || 'Registration failed.', 'error');
      btn.disabled = false; btn.textContent = 'Create Account';
    }
  });
};
