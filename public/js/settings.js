// /public/js/settings.js
// Renders the unified Settings UI (Profile + Security tabs) into #settingsRoot
(function () {
  // Inject scoped styles once
  if (!document.getElementById('settings-styles')) {
    const style = document.createElement('style');
    style.id = 'settings-styles';
    style.textContent = `
      .settings-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
      .settings-tabs .tab-btn { background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-secondary); padding: 10px 20px; border-radius: 20px; cursor: pointer; font-weight: 600; }
      .settings-tabs .tab-btn.active { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
      .settings-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 25px; margin-bottom: 20px; }
      .avatar-row { display: flex; align-items: center; gap: 20px; margin-bottom: 25px; flex-wrap: wrap; }
      .avatar-circle { width: 80px; height: 80px; border-radius: 50%; background: var(--accent-glow); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 800; overflow: hidden; border: 2px solid var(--accent); }
      .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
      .field-label { display: block; margin-bottom: 8px; font-size: 14px; color: var(--text-secondary); }
      .settings-input { width: 100%; padding: 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); margin-bottom: 15px; }
      .verified-badge { background: var(--success-bg); color: var(--success); padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }
      .unverified-badge { background: var(--warning-bg); color: var(--warning); padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }
      .danger-zone { border: 1px solid var(--error); border-radius: var(--radius-md); padding: 20px; }
    `;
    document.head.appendChild(style);
  }

  async function init() {
    const profile = await checkAuthAndRedirect();
    if (!profile) return;

    const root = document.getElementById('settingsRoot');
    if (!root) return;

    root.innerHTML = `
      <h1 style="margin-bottom:20px;">Settings</h1>
      <div class="settings-tabs">
        <button class="tab-btn active" data-tab="profile">Profile</button>
        <button class="tab-btn" data-tab="security">Security</button>
      </div>
      <div id="tab-profile"></div>
      <div id="tab-security" style="display:none;"></div>
    `;

    root.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-profile').style.display = btn.dataset.tab === 'profile' ? 'block' : 'none';
        document.getElementById('tab-security').style.display = btn.dataset.tab === 'security' ? 'block' : 'none';
      });
    });

    renderProfileTab(profile);
    renderSecurityTab();
  }

  function initialsOf(name) {
    return (name || 'U').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function renderProfileTab(profile) {
    const box = document.getElementById('tab-profile');
    const avatarHtml = profile.avatar_url
      ? `<img src="${profile.avatar_url}" alt="avatar" />`
      : initialsOf(profile.full_name);

    box.innerHTML = `
      <div class="settings-card">
        <div class="avatar-row">
          <div class="avatar-circle" id="avatarCircle">${avatarHtml}</div>
          <div>
            <div style="font-weight:700; font-size:18px; margin-bottom:4px;">${profile.full_name}</div>
            <div style="color:var(--text-secondary); font-size:14px; margin-bottom:10px;">
              ${profile.email || ''} 
              ${profile.email_verified ? '<span class="verified-badge">VERIFIED</span>' : '<span class="unverified-badge">UNVERIFIED</span>'}
            </div>
            <label class="btn btn-outline" style="padding:8px 16px; font-size:13px; cursor:pointer;">
              Change Photo
              <input type="file" id="avatarInput" accept="image/*" style="display:none;" />
            </label>
          </div>
        </div>

        <label class="field-label">Display Name</label>
        <input type="text" id="setName" class="settings-input" value="${(profile.full_name || '').replace(/"/g, '&quot;')}" />

        <label class="field-label">Phone Number</label>
        <input type="tel" id="setPhone" class="settings-input" placeholder="e.g. 08012345678" value="${profile.phone || ''}" />

        <label class="field-label">Role</label>
        <input type="text" class="settings-input" value="${profile.role}" disabled style="opacity:0.6; text-transform:capitalize;" />

        <button class="btn btn-primary w-full" id="saveProfileBtn">Save Changes</button>
      </div>
    `;

    // Avatar upload
    document.getElementById('avatarInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) { showToast('Image must be under 500KB.', 'error'); return; }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          showToast('Uploading avatar...', 'success');
          const res = await apiClient.request('auth.js', { action: 'upload_avatar', dataUrl: reader.result });
          document.getElementById('avatarCircle').innerHTML = `<img src="${res.data.avatar_url}" alt="avatar" />`;
          cacheProfile({ avatar_url: res.data.avatar_url });
          showToast('Avatar updated!', 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
      reader.readAsDataURL(file);
    });

    // Save profile
    document.getElementById('saveProfileBtn').addEventListener('click', async () => {
      const btn = document.getElementById('saveProfileBtn');
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        const res = await apiClient.request('auth.js', {
          action: 'update_profile',
          full_name: document.getElementById('setName').value,
          phone: document.getElementById('setPhone').value
        });
        cacheProfile(res.data.profile);
        showToast('Profile saved!', 'success');
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Save Changes';
      }
    });
  }

  function renderSecurityTab() {
    const box = document.getElementById('tab-security');
    box.innerHTML = `
      <div class="settings-card">
        <h3 style="margin-bottom:15px;">Change Password</h3>
        <label class="field-label">Current Password</label>
        <input type="password" id="curPass" class="settings-input" />
        <label class="field-label">New Password (min 8 chars)</label>
        <input type="password" id="newPass" class="settings-input" />
        <label class="field-label">Confirm New Password</label>
        <input type="password" id="confPass" class="settings-input" />
        <button class="btn btn-primary w-full" id="changePassBtn">Update Password</button>
        <p style="font-size:12px; color:var(--text-secondary); margin-top:10px;">You will be signed out of all devices after changing your password.</p>
      </div>

      <div class="settings-card danger-zone">
        <h3 style="margin-bottom:10px; color:var(--error);">Danger Zone</h3>
        <p style="font-size:14px; color:var(--text-secondary); margin-bottom:15px;">Sign out of every device logged into this account, including this one.</p>
        <button class="btn btn-danger" id="signOutAllBtn">Sign Out All Devices</button>
      </div>
    `;

    document.getElementById('changePassBtn').addEventListener('click', async () => {
      const newPass = document.getElementById('newPass').value;
      const confPass = document.getElementById('confPass').value;
      if (newPass !== confPass) { showToast('New passwords do not match.', 'error'); return; }

      const btn = document.getElementById('changePassBtn');
      btn.disabled = true; btn.textContent = 'Updating...';
      try {
        await apiClient.request('auth.js', {
          action: 'change_password',
          currentPassword: document.getElementById('curPass').value,
          newPassword: newPass
        });
        showToast('Password changed. Please log in again.', 'success');
        setTimeout(() => { localStorage.clear(); window.location.href = '/login.html'; }, 1500);
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Update Password';
      }
    });

    document.getElementById('signOutAllBtn').addEventListener('click', async () => {
      if (!confirm('Sign out of ALL devices?')) return;
      try {
        await apiClient.request('auth.js', { action: 'sign_out_all' });
      } catch (err) { /* session already gone */ }
      localStorage.clear();
      window.location.href = '/login.html';
    });
  }

  // Merge updates into the cached profile in localStorage
  function cacheProfile(updates) {
    try {
      const cached = JSON.parse(localStorage.getItem('yolotask_user') || '{}');
      localStorage.setItem('yolotask_user', JSON.stringify({ ...cached, ...updates }));
    } catch (e) { /* ignore */ }
  }

  init();
})();
