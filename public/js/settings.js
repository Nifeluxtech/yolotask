// /public/js/settings.js
(function () {
  if (!document.getElementById('settings-styles')) {
    const style = document.createElement('style');
    style.id = 'settings-styles';
    style.textContent = `
      .settings-tabs { display: flex; gap: 8px; margin-bottom: 20px; overflow-x: auto; padding-bottom: 5px; }
      .settings-tabs .tab-btn { background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-secondary); padding: 10px 18px; border-radius: 20px; cursor: pointer; font-weight: 600; white-space: nowrap; }
      .settings-tabs .tab-btn.active { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
      .settings-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 25px; margin-bottom: 20px; }
      .avatar-row { display: flex; align-items: center; gap: 20px; margin-bottom: 25px; flex-wrap: wrap; }
      .avatar-circle { width: 80px; height: 80px; border-radius: 50%; background: var(--accent-glow); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 800; overflow: hidden; border: 2px solid var(--accent); flex-shrink: 0; }
      .avatar-circle img { width: 100%; height: 100%; object-fit: cover; }
      .field-label { display: block; margin-bottom: 8px; font-size: 14px; color: var(--text-secondary); }
      .settings-input, .settings-select { width: 100%; padding: 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); margin-bottom: 15px; }
      .verified-badge { background: var(--success-bg); color: var(--success); padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }
      .unverified-badge { background: var(--warning-bg); color: var(--warning); padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }
      .danger-zone { border: 1px solid var(--error); }
      .bank-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 15px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap; }
      .bank-default { background: var(--success-bg); color: var(--success); padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; }
      .chip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 15px; }
      .chip { display: flex; align-items: center; gap: 8px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 13px; cursor: pointer; }
      .chip input { width: auto; }
    `;
    document.head.appendChild(style);
  }

  let currentProfile = null;

  async function init() {
    const profile = await checkAuthAndRedirect();
    if (!profile) return;
    currentProfile = profile;

    const root = document.getElementById('settingsRoot');
    if (!root) return;

    const tabs = [{ id: 'profile', label: 'Profile' }];
    if (profile.role === 'earner') {
      tabs.push({ id: 'payouts', label: 'Payouts' });
      tabs.push({ id: 'tasks', label: 'Task Prefs' });
    }
    tabs.push({ id: 'security', label: 'Security' });

    root.innerHTML = `
      <h1 style="margin-bottom:20px;">Settings</h1>
      <div class="settings-tabs">
        ${tabs.map((t, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>
      ${tabs.map((t, i) => `<div id="tab-${t.id}" style="${i === 0 ? '' : 'display:none;'}"></div>`).join('')}
    `;

    root.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tabs.forEach(t => {
          document.getElementById(`tab-${t.id}`).style.display = t.id === btn.dataset.tab ? 'block' : 'none';
        });
        if (btn.dataset.tab === 'payouts') loadPayoutsTab();
        if (btn.dataset.tab === 'tasks') loadTasksTab();
      });
    });

    renderProfileTab(profile);
    renderSecurityTab();
  }

  function initialsOf(name) {
    return (name || 'U').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function cacheProfile(updates) {
    try {
      const cached = JSON.parse(localStorage.getItem('yolotask_user') || '{}');
      localStorage.setItem('yolotask_user', JSON.stringify({ ...cached, ...updates }));
    } catch (e) {}
  }

  // ---------- PROFILE TAB ----------
  function renderProfileTab(profile) {
    const box = document.getElementById('tab-profile');
    const avatarHtml = profile.avatar_url ? `<img src="${profile.avatar_url}" alt="avatar" />` : initialsOf(profile.full_name);

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
        <button class="btn btn-primary w-full" id="saveProfileBtn">Save Changes</button>
      </div>
    `;

    document.getElementById('avatarInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) { showToast('Image must be under 500KB.', 'error'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await apiClient.request('auth.js', { action: 'upload_avatar', dataUrl: reader.result });
          document.getElementById('avatarCircle').innerHTML = `<img src="${res.data.avatar_url}" alt="avatar" />`;
          cacheProfile({ avatar_url: res.data.avatar_url });
          showToast('Avatar updated!', 'success');
        } catch (err) { showToast(err.message, 'error'); }
      };
      reader.readAsDataURL(file);
    });

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

  // ---------- PAYOUTS TAB (EARNER) ----------
  async function loadPayoutsTab() {
    const box = document.getElementById('tab-payouts');
    box.innerHTML = '<div class="settings-card">Loading payout accounts...</div>';

    try {
      const [accRes, bankRes] = await Promise.all([
        apiClient.request('wallet.js', { action: 'get_bank_accounts' }),
        apiClient.request('wallet.js', { action: 'get_banks' })
      ]);

      const accounts = accRes.data.accounts;
      const banks = bankRes.data.banks;

      box.innerHTML = `
        <div class="settings-card">
          <h3 style="margin-bottom:15px;">Saved Bank Accounts</h3>
          <div id="bankList"></div>
        </div>
        <div class="settings-card">
          <h3 style="margin-bottom:15px;">Add New Account</h3>
          <label class="field-label">Bank</label>
          <select id="bankSelect" class="settings-select">
            <option value="">Select bank...</option>
            ${banks.map(b => `<option value="${b.code}">${b.name}</option>`).join('')}
          </select>
          <label class="field-label">Account Number (10 digits)</label>
          <input type="text" id="acctNumber" class="settings-input" maxlength="10" inputmode="numeric" placeholder="0123456789" />
          <div id="resolvedName" style="margin:-5px 0 15px; font-size:14px; color:var(--success); font-weight:600;"></div>
          <button class="btn btn-outline w-full" id="resolveBtn" style="margin-bottom:10px;">Verify Account</button>
          <button class="btn btn-primary w-full" id="saveBankBtn" disabled>Save Account</button>
        </div>
      `;

      renderBankList(accounts);

      let resolvedAccountName = '';

      document.getElementById('resolveBtn').addEventListener('click', async () => {
        const btn = document.getElementById('resolveBtn');
        btn.disabled = true; btn.textContent = 'Verifying...';
        try {
          const res = await apiClient.request('wallet.js', {
            action: 'resolve_account',
            account_number: document.getElementById('acctNumber').value,
            bank_code: document.getElementById('bankSelect').value
          });
          resolvedAccountName = res.data.account_name;
          document.getElementById('resolvedName').textContent = '✓ Account Name: ' + resolvedAccountName;
          document.getElementById('saveBankBtn').disabled = false;
        } catch (err) {
          document.getElementById('resolvedName').textContent = '';
          document.getElementById('saveBankBtn').disabled = true;
          showToast(err.message, 'error');
        }
        btn.disabled = false; btn.textContent = 'Verify Account';
      });

      document.getElementById('saveBankBtn').addEventListener('click', async () => {
        const btn = document.getElementById('saveBankBtn');
        btn.disabled = true; btn.textContent = 'Saving...';
        try {
          const bankCode = document.getElementById('bankSelect').value;
          await apiClient.request('wallet.js', {
            action: 'save_bank_account',
            bank_code: bankCode,
            bank_name: document.getElementById('bankSelect').selectedOptions[0].textContent,
            account_number: document.getElementById('acctNumber').value,
            account_name: resolvedAccountName,
            is_default: accounts.length === 0
          });
          showToast('Bank account saved!', 'success');
          loadPayoutsTab();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false; btn.textContent = 'Save Account';
        }
      });
    } catch (err) {
      box.innerHTML = `<div class="settings-card" style="color:var(--error);">Failed to load: ${err.message}</div>`;
    }
  }

  function renderBankList(accounts) {
    const list = document.getElementById('bankList');
    if (!accounts || accounts.length === 0) {
      list.innerHTML = '<p style="color:var(--text-secondary); font-size:14px;">No saved accounts yet. Add one below — withdrawals require a verified account.</p>';
      return;
    }
    list.innerHTML = accounts.map(a => `
      <div class="bank-row">
        <div>
          <div style="font-weight:600;">${a.bank_name} ${a.is_default ? '<span class="bank-default">DEFAULT</span>' : ''}</div>
          <div style="font-size:13px; color:var(--text-secondary);">****${a.account_number.slice(-4)} • ${a.account_name}</div>
        </div>
        <div style="display:flex; gap:8px;">
          ${!a.is_default ? `<button class="btn btn-outline" style="padding:6px 10px; font-size:11px;" onclick="setDefaultBank('${a.id}')">Make Default</button>` : ''}
          <button class="btn btn-danger" style="padding:6px 10px; font-size:11px;" onclick="deleteBank('${a.id}')">Remove</button>
        </div>
      </div>
    `).join('');
  }

  window.setDefaultBank = async function (id) {
    try {
      await apiClient.request('wallet.js', { action: 'set_default_bank', accountId: id });
      showToast('Default account updated.', 'success');
      loadPayoutsTab();
    } catch (err) { showToast(err.message, 'error'); }
  };

  window.deleteBank = async function (id) {
    if (!confirm('Remove this bank account?')) return;
    try {
      await apiClient.request('wallet.js', { action: 'delete_bank_account', accountId: id });
      showToast('Account removed.', 'success');
      loadPayoutsTab();
    } catch (err) { showToast(err.message, 'error'); }
  };

  // ---------- TASK PREFS TAB (EARNER) ----------
  async function loadTasksTab() {
    const box = document.getElementById('tab-tasks');
    box.innerHTML = '<div class="settings-card">Loading preferences...</div>';

    try {
      const res = await apiClient.request('auth.js', { action: 'get_settings_data' });
      const { interests, task_types, my_interest_ids, my_hidden_task_ids } = res.data;

      box.innerHTML = `
        <div class="settings-card">
          <h3 style="margin-bottom:5px;">My Interests</h3>
          <p style="font-size:13px; color:var(--text-secondary); margin-bottom:15px;">Controls which premium (targeted) campaigns you see. Minimum 3.</p>
          <div class="chip-grid">
            ${interests.map(i => `
              <label class="chip"><input type="checkbox" name="prefInterest" value="${i.id}" ${my_interest_ids.includes(i.id) ? 'checked' : ''} /> ${i.name}</label>
            `).join('')}
          </div>
          <button class="btn btn-primary w-full" id="saveInterestsBtn">Save Interests</button>
        </div>
        <div class="settings-card">
          <h3 style="margin-bottom:5px;">Hide Task Types</h3>
          <p style="font-size:13px; color:var(--text-secondary); margin-bottom:15px;">Checked types will never appear in your task feed.</p>
          <div class="chip-grid">
            ${task_types.map(t => `
              <label class="chip"><input type="checkbox" name="prefHide" value="${t.id}" ${my_hidden_task_ids.includes(t.id) ? 'checked' : ''} /> Hide: ${t.name}</label>
            `).join('')}
          </div>
          <button class="btn btn-primary w-full" id="savePrefsBtn">Save Task Preferences</button>
        </div>
      `;

      document.getElementById('saveInterestsBtn').addEventListener('click', async () => {
        const ids = Array.from(document.querySelectorAll('input[name="prefInterest"]:checked')).map(c => c.value);
        try {
          await apiClient.request('auth.js', { action: 'update_interests', interest_ids: ids });
          showToast('Interests updated!', 'success');
        } catch (err) { showToast(err.message, 'error'); }
      });

      document.getElementById('savePrefsBtn').addEventListener('click', async () => {
        const ids = Array.from(document.querySelectorAll('input[name="prefHide"]:checked')).map(c => c.value);
        try {
          await apiClient.request('auth.js', { action: 'update_task_prefs', hidden_task_type_ids: ids });
          showToast('Task preferences saved!', 'success');
        } catch (err) { showToast(err.message, 'error'); }
      });
    } catch (err) {
      box.innerHTML = `<div class="settings-card" style="color:var(--error);">Failed to load: ${err.message}</div>`;
    }
  }

  // ---------- SECURITY TAB ----------
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
      </div>
      <div class="settings-card danger-zone">
        <h3 style="margin-bottom:10px; color:var(--error);">Danger Zone</h3>
        <p style="font-size:14px; color:var(--text-secondary); margin-bottom:15px;">Sign out of every device logged into this account.</p>
        <button class="btn btn-danger" id="signOutAllBtn">Sign Out All Devices</button>
      </div>
    `;

    document.getElementById('changePassBtn').addEventListener('click', async () => {
      const newPass = document.getElementById('newPass').value;
      if (newPass !== document.getElementById('confPass').value) { showToast('New passwords do not match.', 'error'); return; }
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
      try { await apiClient.request('auth.js', { action: 'sign_out_all' }); } catch (e) {}
      localStorage.clear();
      window.location.href = '/login.html';
    });
  }

  init();
})();
