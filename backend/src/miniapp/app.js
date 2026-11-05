/* ── CheckFlow ET Mini App — app.js ─────────────────────────────────────────
 * Vanilla JS, no build step required.
 * All API calls go through /api/* (same origin).
 */

'use strict';

// ── Telegram WebApp SDK ─────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp ?? null;
if (tg) {
  tg.ready();
  tg.expand();
  tg.enableClosingConfirmation();
}

// ── State ────────────────────────────────────────────────────────────────────
let _token        = localStorage.getItem('cf_token') || null;
let _tgInitData   = tg?.initData || '';
let _tgUser       = tg?.initDataUnsafe?.user || null;
let _profile      = null;
let _accounts     = [];
let _currentNav   = 'accounts';

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch('/api' + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── Toast ────────────────────────────────────────────────────────────────────
let _toastTimeout;
function toast(msg, durationMs = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => el.classList.remove('show'), durationMs);
}

// ── Screen routing ───────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');

  const isApp = (name === 'accounts' || name === 'profile');
  const nav = document.getElementById('bottom-nav');
  nav.classList.toggle('visible', isApp);

  // Back button
  if (tg) {
    if (!isApp && name !== 'loading') {
      tg.BackButton.show();
      tg.BackButton.onClick(() => showScreen('login'));
    } else {
      tg.BackButton.hide();
    }
  }
}

// ── Nav tabs ─────────────────────────────────────────────────────────────────
function navTo(tab) {
  _currentNav = tab;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`nav-${tab}`).classList.add('active');
  showScreen(tab);

  if (tab === 'accounts') loadAccounts();
  if (tab === 'profile')  loadProfile();
}

// ── PIN widget ───────────────────────────────────────────────────────────────
function initPin(areaId, dotsId, inputId) {
  const area  = document.getElementById(areaId);
  const input = document.getElementById(inputId);

  function render() {
    const val = input.value.slice(0, 4);
    const dots = document.getElementById(dotsId);
    dots.innerHTML = [0,1,2,3].map(i =>
      `<div class="pin-dot ${i < val.length ? 'filled' : ''}"></div>`
    ).join('');
  }

  area.addEventListener('click', () => { input.focus(); area.classList.add('focused'); });
  input.addEventListener('focus', () => area.classList.add('focused'));
  input.addEventListener('blur',  () => area.classList.remove('focused'));
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 4);
    render();
  });

  render();
}

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  initPin('reg-pin-area',   'reg-pin-dots',   'reg-pin-input');
  initPin('reg-pin2-area',  'reg-pin2-dots',  'reg-pin2-input');
  initPin('login-pin-area', 'login-pin-dots', 'login-pin-input');

  // Share Telegram phone number
  const shareBtn = document.getElementById('share-phone-btn');
  if (tg && shareBtn) {
    shareBtn.addEventListener('click', () => {
      tg.requestContact((valid, contact) => {
        if (valid && contact?.contact?.phone_number) {
          document.getElementById('reg-phone').value = contact.contact.phone_number;
        } else {
          toast('Could not retrieve phone number');
        }
      });
    });
  } else if (shareBtn) {
    shareBtn.style.display = 'none';
  }

  // Pre-fill name from Telegram user
  if (_tgUser?.first_name) {
    const fullName = [_tgUser.first_name, _tgUser.last_name].filter(Boolean).join(' ');
    document.getElementById('reg-name').value = fullName;
  }

  await bootApp();
});

// ── Boot: validate initData / existing JWT ────────────────────────────────────
async function bootApp() {
  showScreen('loading');

  // If we have a stored JWT, verify it's still valid
  if (_token) {
    const { ok } = await api('GET', '/miniapp/me');
    if (ok) {
      await navTo('accounts');
      return;
    }
    // Token expired — clear and re-auth via Telegram
    _token = null;
    localStorage.removeItem('cf_token');
  }

  // Try Telegram initData auto-login
  if (_tgInitData) {
    const { ok, data } = await api('POST', '/miniapp/auth', { initData: _tgInitData });
    if (ok && data.token) {
      _token = data.token;
      localStorage.setItem('cf_token', _token);
      await navTo('accounts');
      return;
    }
    if (ok && data.needsRegistration) {
      // Pre-fill phone from tgUser if Telegram share already gave it
      showScreen('register');
      return;
    }
  }

  // Fallback to manual login
  showScreen('login');
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
async function submitRegister() {
  clearErrors(['reg-name-err', 'reg-phone-err', 'reg-pin-err', 'reg-pin2-err']);

  const fullName = document.getElementById('reg-name').value.trim();
  const phone    = document.getElementById('reg-phone').value.trim();
  const pin      = document.getElementById('reg-pin-input').value;
  const pin2     = document.getElementById('reg-pin2-input').value;

  let valid = true;
  if (!fullName) { showErr('reg-name-err', 'Full name is required'); valid = false; }
  if (!phone)    { showErr('reg-phone-err', 'Phone number is required'); valid = false; }
  if (pin.length !== 4) { showErr('reg-pin-err', 'PIN must be exactly 4 digits'); valid = false; }
  if (pin !== pin2)     { showErr('reg-pin2-err', 'PINs do not match'); valid = false; }
  if (!valid) return;

  setLoading('reg-submit-btn', true);

  const { ok, data } = await api('POST', '/auth/register', {
    fullName, phone, pinCode: pin, accountType: 'BUSINESS',
  });

  setLoading('reg-submit-btn', false);

  if (!ok) {
    const msg = data.error || 'Registration failed';
    if (msg.toLowerCase().includes('phone')) showErr('reg-phone-err', msg);
    else toast('❌ ' + msg);
    return;
  }

  _token = data.token;
  localStorage.setItem('cf_token', _token);

  // Link Telegram ID server-side if we have initData
  if (_tgInitData && _token) {
    await api('POST', '/miniapp/link', { initData: _tgInitData });
  }

  toast('✅ Account created!');
  await navTo('accounts');
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
async function submitLogin() {
  clearErrors(['login-phone-err', 'login-pin-err']);

  const phone = document.getElementById('login-phone').value.trim();
  const pin   = document.getElementById('login-pin-input').value;

  let valid = true;
  if (!phone) { showErr('login-phone-err', 'Phone number is required'); valid = false; }
  if (pin.length !== 4) { showErr('login-pin-err', 'PIN must be exactly 4 digits'); valid = false; }
  if (!valid) return;

  setLoading('login-submit-btn', true);

  const { ok, data, status } = await api('POST', '/auth/login', { phone, pinCode: pin });

  setLoading('login-submit-btn', false);

  if (!ok) {
    const msg = data.error || 'Login failed';
    if (status === 429) toast('⏳ ' + msg, 4000);
    else showErr('login-pin-err', msg);
    return;
  }

  _token = data.token;
  localStorage.setItem('cf_token', _token);

  // Link Telegram ID server-side
  if (_tgInitData && _token) {
    await api('POST', '/miniapp/link', { initData: _tgInitData });
  }

  toast('✅ Logged in!');
  await navTo('accounts');
}

// ── ACCOUNTS ─────────────────────────────────────────────────────────────────
async function loadAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = `<div style="text-align:center;padding:30px 0"><div class="spinner" style="margin:auto"></div></div>`;

  const { ok, data } = await api('GET', '/settings/accounts');
  if (!ok) { toast('Failed to load accounts'); return; }

  _accounts = data.accounts || [];
  renderAccounts();
}

function renderAccounts() {
  const container = document.getElementById('accounts-list');

  if (_accounts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🏦</div>
        <div class="empty-title">No accounts yet</div>
        <div class="empty-desc">Add your first receiving account below so payments can be verified against it.</div>
      </div>`;
    return;
  }

  // Group by bank
  const groups = {};
  for (const a of _accounts) {
    if (!groups[a.bankName]) groups[a.bankName] = [];
    groups[a.bankName].push(a);
  }

  const bankIcon = b => b === 'TELEBIRR' ? '📱' : '🏦';
  const bankLabel = b => b === 'TELEBIRR' ? 'Telebirr' : b === 'CBE' ? 'CBE' : b === 'BOA' ? 'BOA' : b === 'AWASH' ? 'Awash' : b;

  let html = '';
  for (const [bank, list] of Object.entries(groups)) {
    html += `<div class="section-label">${bankIcon(bank)} ${bankLabel(bank)}</div>`;
    html += `<div class="card">`;
    for (const a of list) {
      html += `
        <div class="card-row no-tap">
          <div class="row-icon ${a.isActive ? 'green' : 'orange'}">${a.isActive ? '✅' : '⏸'}</div>
          <div class="row-body">
            <strong>${escHtml(a.accountHolderName)}</strong>
            <span>${escHtml(a.accountNumber)}</span>
          </div>
          <span class="row-badge ${a.isActive ? 'active' : 'inactive'}">${a.isActive ? 'Active' : 'Inactive'}</span>
          <div class="row-actions">
            <button class="icon-btn" title="Toggle" onclick="toggleAccount('${a.id}', ${a.isActive})">
              ${a.isActive ? '⏸' : '▶'}
            </button>
            <button class="icon-btn" title="Edit holder name" onclick="openEdit('${a.id}', '${escHtml(a.accountHolderName)}')">✏️</button>
            <button class="icon-btn danger" title="Delete" onclick="openConfirmDelete('${a.id}', '${escHtml(a.accountNumber)}')">🗑</button>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
}

async function submitAddAccount() {
  clearErrors(['add-number-err', 'add-holder-err']);

  const bankName  = document.getElementById('add-bank').value;
  const accountNumber = document.getElementById('add-number').value.trim();
  const accountHolderName = document.getElementById('add-holder').value.trim();

  let valid = true;
  if (!accountNumber) { showErr('add-number-err', 'Account number is required'); valid = false; }
  if (!accountHolderName) { showErr('add-holder-err', 'Holder name is required'); valid = false; }
  if (!valid) return;

  const { ok, data } = await api('POST', '/settings/accounts', { bankName, accountNumber, accountHolderName });
  if (!ok) {
    const msg = data.error || 'Failed to add account';
    if (msg.toLowerCase().includes('number')) showErr('add-number-err', msg);
    else toast('❌ ' + msg);
    return;
  }

  document.getElementById('add-number').value = '';
  document.getElementById('add-holder').value = '';
  toast('✅ Account added!');
  if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  await loadAccounts();
}

async function toggleAccount(id, isCurrentlyActive) {
  const { ok, data } = await api('PATCH', `/settings/accounts/${id}/toggle`, { isActive: !isCurrentlyActive });
  if (!ok) { toast('❌ ' + (data.error || 'Failed to update')); return; }
  toast(isCurrentlyActive ? 'Account deactivated' : 'Account activated');
  await loadAccounts();
}

// ── Delete confirm sheet ──────────────────────────────────────────────────────
let _deleteTargetId = null;

function openConfirmDelete(id, accountNumber) {
  _deleteTargetId = id;
  document.getElementById('confirm-desc').textContent = `Delete account "${accountNumber}"? This cannot be undone.`;
  document.getElementById('confirm-overlay').classList.add('show');
  document.getElementById('confirm-ok-btn').onclick = doDelete;
}

function closeConfirm(event) {
  if (!event || event.target === document.getElementById('confirm-overlay')) {
    document.getElementById('confirm-overlay').classList.remove('show');
    _deleteTargetId = null;
  }
}

async function doDelete() {
  if (!_deleteTargetId) return;
  closeConfirm();
  const { ok, data } = await api('DELETE', `/settings/accounts/${_deleteTargetId}`);
  if (!ok) { toast('❌ ' + (data.error || 'Delete failed')); return; }
  if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  toast('Account deleted');
  await loadAccounts();
}

// ── Edit holder name sheet ────────────────────────────────────────────────────
let _editTargetId = null;

function openEdit(id, currentName) {
  _editTargetId = id;
  document.getElementById('edit-holder-input').value = currentName;
  document.getElementById('edit-overlay').classList.add('show');
  setTimeout(() => document.getElementById('edit-holder-input').focus(), 120);
  document.getElementById('edit-ok-btn').onclick = doEdit;
}

function closeEdit(event) {
  if (!event || event.target === document.getElementById('edit-overlay')) {
    document.getElementById('edit-overlay').classList.remove('show');
    _editTargetId = null;
  }
}

async function doEdit() {
  const name = document.getElementById('edit-holder-input').value.trim();
  if (!name) { toast('Name cannot be empty'); return; }
  closeEdit();
  const { ok, data } = await api('PATCH', `/settings/accounts/${_editTargetId}`, { accountHolderName: name });
  if (!ok) { toast('❌ ' + (data.error || 'Update failed')); return; }
  toast('✅ Name updated');
  await loadAccounts();
}

// ── PROFILE ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  const { ok, data } = await api('GET', '/miniapp/me');
  if (!ok) { toast('Failed to load profile'); return; }

  _profile = data.user;
  document.getElementById('profile-name').textContent = _profile.fullName;
  document.getElementById('profile-sub').textContent  = _profile.organizationName || _profile.role;
  document.getElementById('pf-phone').textContent     = _profile.phone;
  document.getElementById('pf-org').textContent       = _profile.organizationName || '—';
  document.getElementById('pf-role').textContent      = capitalize(_profile.role);
  document.getElementById('pf-accounts').textContent  = _profile.accountCount + ' account' + (_profile.accountCount !== 1 ? 's' : '');
  document.getElementById('pf-tg').textContent        = _profile.telegramLinked ? '🔗 Linked' : 'Not linked';
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
function logout() {
  _token = null;
  localStorage.removeItem('cf_token');
  if (tg) tg.close();
  else showScreen('login');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}

function clearErrors(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.classList.remove('visible'); }
  });
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) { btn._orig = btn.textContent; btn.textContent = '⏳ Please wait…'; }
  else         { btn.textContent = btn._orig || btn.textContent; }
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function capitalize(s) {
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}
