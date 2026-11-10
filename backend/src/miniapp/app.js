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
  try { tg.enableClosingConfirmation(); } catch (e) {}
}

// ── State ────────────────────────────────────────────────────────────────────
let _token        = localStorage.getItem('cf_token') || null;
let _tgInitData   = tg?.initData || '';
let _tgUser       = tg?.initDataUnsafe?.user || null;
let _profile      = null;
let _accounts     = [];
let _cashiers     = [];
let _currentNav   = 'home';

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body, isFormData = false) {
  const headers = {};
  if (!isFormData) headers['Content-Type'] = 'application/json';
  if (_token) headers['Authorization'] = `Bearer ${_token}`;

  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      body: isFormData ? body : (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    return { ok: false, status: 0, data: { error: 'Network error. Please check your connection.' } };
  }

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── Toast ────────────────────────────────────────────────────────────────────
let _toastTimeout;
function toast(msg, durationMs = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => el.classList.remove('show'), durationMs);
}

// ── Haptic feedback ──────────────────────────────────────────────────────────
function haptic(type = 'light') {
  if (!tg?.HapticFeedback) return;
  if (type === 'success' || type === 'error' || type === 'warning') {
    tg.HapticFeedback.notificationOccurred(type);
  } else if (type === 'selection') {
    tg.HapticFeedback.selectionChanged();
  } else {
    tg.HapticFeedback.impactOccurred(type);
  }
}

// ── Role helpers ─────────────────────────────────────────────────────────────
function isAdminRole() {
  if (!_profile) return false;
  return _profile.isAdmin ?? ['OWNER', 'MANAGER', 'ADMIN'].includes(_profile.role);
}

// ── Screen routing ───────────────────────────────────────────────────────────
function showScreen(name) {
  if (name !== 'verify' && document.getElementById('camera-scanner-modal')?.classList.contains('show')) {
    if (typeof window.closeCameraScanner === 'function') window.closeCameraScanner();
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`screen-${name}`);
  if (target) target.classList.add('active');

  const isAuthScreen = (name === 'register' || name === 'login' || name === 'loading');
  const nav = document.getElementById('bottom-nav');
  if (nav) nav.classList.toggle('visible', !isAuthScreen);

  // Configure bottom nav items based on role
  if (!isAuthScreen) {
    updateBottomNavVisibility();
  }

  // Telegram BackButton
  if (tg) {
    if (!isAuthScreen && name !== 'home' && name !== 'verify') {
      tg.BackButton.show();
      tg.BackButton.onClick(() => navTo(isAdminRole() ? 'home' : 'verify'));
    } else {
      tg.BackButton.hide();
    }
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateBottomNavVisibility() {
  const isAdmin = isAdminRole();
  const homeTab = document.getElementById('nav-home');
  const accountsTab = document.getElementById('nav-accounts');
  const cashiersTab = document.getElementById('nav-cashiers');

  if (homeTab) homeTab.style.display = isAdmin ? 'flex' : 'none';
  if (accountsTab) accountsTab.style.display = isAdmin ? 'flex' : 'none';
  if (cashiersTab) cashiersTab.style.display = isAdmin ? 'flex' : 'none';
}

// ── Nav tabs ─────────────────────────────────────────────────────────────────
async function navTo(tab) {
  const isAdmin = isAdminRole();

  // If cashier tries to open admin tabs, guard it
  if (!isAdmin && (tab === 'home' || tab === 'accounts' || tab === 'cashiers')) {
    haptic('warning');
    showScreen('forbidden');
    return;
  }

  _currentNav = tab;
  haptic('selection');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navBtn = document.getElementById(`nav-${tab}`);
  if (navBtn) navBtn.classList.add('active');

  showScreen(tab);

  if (tab === 'home')     loadHomeScreen();
  if (tab === 'verify')   initVerifyScreen();
  if (tab === 'accounts') loadAccounts();
  if (tab === 'cashiers') loadCashiers();
  if (tab === 'profile')  loadProfile();
}

// ── PIN widget ───────────────────────────────────────────────────────────────
function initPin(areaId, dotsId, inputId) {
  const area  = document.getElementById(areaId);
  const input = document.getElementById(inputId);
  if (!area || !input) return;

  function render() {
    const val = input.value.slice(0, 4);
    const dots = document.getElementById(dotsId);
    if (dots) {
      dots.innerHTML = [0,1,2,3].map(i =>
        `<div class="pin-dot ${i < val.length ? 'filled' : ''}"></div>`
      ).join('');
    }
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

  // Share Telegram phone number button
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

  // Pre-fill name from Telegram user if available
  if (_tgUser?.first_name) {
    const fullName = [_tgUser.first_name, _tgUser.last_name].filter(Boolean).join(' ');
    const regNameEl = document.getElementById('reg-name');
    if (regNameEl) regNameEl.value = fullName;
  }

  await bootApp();
});

// ── Boot: validate existing JWT or initData ──────────────────────────────────
async function bootApp() {
  showScreen('loading');

  if (_token) {
    const { ok, data } = await api('GET', '/auth/me');
    if (ok && data.user) {
      _profile = data.user;
      if (isAdminRole()) {
        await navTo('home');
      } else {
        await navTo('verify');
      }
      return;
    }
    // Token invalid or expired
    _token = null;
    localStorage.removeItem('cf_token');
  }

  // Telegram initData auto-login check
  if (_tgInitData) {
    const { ok, data } = await api('POST', '/miniapp/auth', { initData: _tgInitData });
    if (ok && data.token && data.user) {
      _token = data.token;
      _profile = data.user;
      localStorage.setItem('cf_token', _token);
      if (isAdminRole()) {
        await navTo('home');
      } else {
        await navTo('verify');
      }
      return;
    }
    if (ok && data.needsRegistration) {
      showScreen('register');
      return;
    }
  }

  showScreen('login');
}

// ── REGISTER (ADMIN) ─────────────────────────────────────────────────────────
async function submitRegister() {
  clearErrors(['reg-name-err', 'reg-phone-err', 'reg-pin-err', 'reg-pin2-err']);

  const fullName    = document.getElementById('reg-name').value.trim();
  const phone       = document.getElementById('reg-phone').value.trim();
  const accountType = document.getElementById('reg-type').value;
  const pin         = document.getElementById('reg-pin-input').value;
  const pin2        = document.getElementById('reg-pin2-input').value;

  let valid = true;
  if (!fullName || fullName.length < 2) {
    showErr('reg-name-err', 'Full name must be at least 2 characters');
    valid = false;
  }
  if (!phone) {
    showErr('reg-phone-err', 'Enter a valid Ethiopian phone number (e.g. 0912345678)');
    valid = false;
  }
  if (pin.length !== 4) {
    showErr('reg-pin-err', 'PIN must be exactly 4 digits');
    valid = false;
  }
  if (pin !== pin2) {
    showErr('reg-pin2-err', 'PINs do not match');
    valid = false;
  }
  if (!valid) {
    haptic('error');
    return;
  }

  setLoading('reg-submit-btn', true);

  const { ok, data } = await api('POST', '/auth/register', {
    fullName,
    phone,
    pinCode: pin,
    accountType,
    initData: _tgInitData || undefined,
  });

  setLoading('reg-submit-btn', false);

  if (!ok) {
    haptic('error');
    const msg = data.error || 'Registration failed';
    if (msg.toLowerCase().includes('phone')) showErr('reg-phone-err', msg);
    else toast('❌ ' + msg);
    return;
  }

  _token = data.token;
  _profile = data.user;
  localStorage.setItem('cf_token', _token);

  if (_tgInitData && _token) {
    await api('POST', '/miniapp/link', { initData: _tgInitData });
  }

  haptic('success');
  toast('✅ Business account created!');
  await navTo('home');
}

// ── LOGIN SWITCH & SUBMISSIONS ───────────────────────────────────────────────
function switchLoginMode(mode) {
  haptic('selection');
  const adminTab = document.getElementById('login-tab-admin');
  const cashierTab = document.getElementById('login-tab-cashier');
  const adminForm = document.getElementById('login-form-admin');
  const cashierForm = document.getElementById('login-form-cashier');

  if (mode === 'admin') {
    adminTab.classList.add('active');
    cashierTab.classList.remove('active');
    adminForm.style.display = 'block';
    cashierForm.style.display = 'none';
  } else {
    adminTab.classList.remove('active');
    cashierTab.classList.add('active');
    adminForm.style.display = 'none';
    cashierForm.style.display = 'block';
  }
}

async function submitAdminLogin() {
  clearErrors(['login-phone-err', 'login-pin-err']);

  const phone = document.getElementById('login-phone').value.trim();
  const pin   = document.getElementById('login-pin-input').value;

  let valid = true;
  if (!phone) { showErr('login-phone-err', 'Phone number is required'); valid = false; }
  if (pin.length !== 4) { showErr('login-pin-err', 'PIN must be exactly 4 digits'); valid = false; }
  if (!valid) {
    haptic('error');
    return;
  }

  setLoading('login-admin-btn', true);

  const { ok, data } = await api('POST', '/auth/login', {
    phone,
    pinCode: pin,
    initData: _tgInitData || undefined,
  });

  setLoading('login-admin-btn', false);

  if (!ok) {
    haptic('error');
    const msg = data.error || 'Invalid phone or PIN';
    showErr('login-pin-err', msg);
    toast('❌ ' + msg);
    return;
  }

  _token = data.token;
  _profile = data.user;
  localStorage.setItem('cf_token', _token);

  if (_tgInitData && _token) {
    await api('POST', '/miniapp/link', { initData: _tgInitData });
  }

  haptic('success');
  toast(`Welcome back, ${_profile.fullName.split(' ')[0]}!`);
  await navTo('home');
}

async function submitCashierLogin() {
  clearErrors(['login-cashier-pwd-err']);

  const password = document.getElementById('login-cashier-pwd').value;
  if (!password.trim()) {
    showErr('login-cashier-pwd-err', 'Password is required');
    haptic('error');
    return;
  }

  setLoading('login-cashier-btn', true);

  const { ok, data } = await api('POST', '/auth/cashier-login', {
    password,
    initData: _tgInitData || undefined,
  });

  setLoading('login-cashier-btn', false);

  if (!ok) {
    haptic('error');
    const msg = data.error || 'Wrong password, try again.';
    showErr('login-cashier-pwd-err', msg);
    toast('❌ ' + msg);
    return;
  }

  _token = data.token;
  _profile = data.cashier || data.user;
  localStorage.setItem('cf_token', _token);

  haptic('success');
  toast(`Welcome, ${_profile.fullName}!`);
  await navTo('verify');
}

// ── HOME SCREEN ──────────────────────────────────────────────────────────────
async function loadHomeScreen() {
  if (!_profile) return;
  document.getElementById('home-org-name').textContent = _profile.organizationName || "Business Dashboard";
  document.getElementById('home-greeting').textContent = `Welcome, ${_profile.fullName.split(' ')[0]} 👋`;
  document.getElementById('home-role-badge').textContent = _profile.role;

  // Refresh counts from profile
  const { ok, data } = await api('GET', '/auth/me');
  if (ok && data.user) {
    _profile = data.user;
    document.getElementById('home-stat-accounts').textContent = _profile.accountsCount ?? '0';
    document.getElementById('home-stat-cashiers').textContent = _profile.cashiersCount ?? '0';
  }
}

// ── VERIFY PAYMENT SCREEN ────────────────────────────────────────────────────
let _activeVerifyTab = 'photo';
let _refSubMode = 'manual';
let _manualProvider = 'CBE';
let _verifyRange = 'today';

const VERIFY_RANGE_LABELS = {
  today: { btn: 'Today', caption: 'Verified today' },
  week: { btn: 'Last 7 days', caption: 'Verified (7d)' },
  month: { btn: 'Last 30 days', caption: 'Verified (30d)' },
  all: { btn: 'All time', caption: 'Verified total' },
};

document.addEventListener('click', (e) => {
  const menu = document.getElementById('vp-date-menu');
  const wrap = document.querySelector('.vp-date-wrap');
  if (menu && menu.classList.contains('open') && wrap && !wrap.contains(e.target)) {
    menu.classList.remove('open');
  }
});

function toggleVerifyRangeMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('vp-date-menu');
  if (menu) menu.classList.toggle('open');
}

function selectVerifyRange(range) {
  _verifyRange = VERIFY_RANGE_LABELS[range] ? range : 'today';
  haptic('selection');

  const menu = document.getElementById('vp-date-menu');
  if (menu) menu.classList.remove('open');

  const meta = VERIFY_RANGE_LABELS[_verifyRange];
  const lbl = document.getElementById('vp-date-label');
  const cap = document.getElementById('vp-ring-caption');
  if (lbl) lbl.textContent = meta.btn;
  if (cap) cap.textContent = meta.caption;

  document.querySelectorAll('.vp-date-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === _verifyRange);
  });

  loadVerifyHistory();
}

function initVerifyScreen() {
  const lbl = document.getElementById('verify-cashier-label');
  if (lbl && _profile) {
    lbl.textContent = _profile.fullName ? _profile.fullName.split(' ')[0] : 'Verify';
  }
  switchVerifyTab(_activeVerifyTab || 'photo');
  switchRefSubMode(_refSubMode || 'manual');
  loadVerifyHistory();
}

function switchVerifyTab(tab) {
  _activeVerifyTab = tab === 'ref' ? 'ref' : 'photo';
  haptic('selection');
  const btnPhoto = document.getElementById('vtab-photo');
  const btnRef = document.getElementById('vtab-ref');
  const formPhoto = document.getElementById('vform-photo');
  const formRef = document.getElementById('vform-ref');

  if (btnPhoto) btnPhoto.classList.toggle('active', _activeVerifyTab === 'photo');
  if (btnRef) btnRef.classList.toggle('active', _activeVerifyTab === 'ref');
  if (formPhoto) formPhoto.style.display = _activeVerifyTab === 'photo' ? 'flex' : 'none';
  if (formRef) formRef.style.display = _activeVerifyTab === 'ref' ? 'block' : 'none';
}

function switchRefSubMode(mode) {
  _refSubMode = mode === 'sms' ? 'sms' : 'manual';
  haptic('selection');
  const btnManual = document.getElementById('vref-sub-manual');
  const btnSms = document.getElementById('vref-sub-sms');
  const panManual = document.getElementById('vref-panel-manual');
  const panSms = document.getElementById('vref-panel-sms');

  if (btnManual) btnManual.classList.toggle('active', _refSubMode === 'manual');
  if (btnSms) btnSms.classList.toggle('active', _refSubMode === 'sms');
  if (panManual) panManual.style.display = _refSubMode === 'manual' ? 'block' : 'none';
  if (panSms) panSms.style.display = _refSubMode === 'sms' ? 'block' : 'none';
}

function selectManualProvider(p) {
  _manualProvider = p === 'TELEBIRR' ? 'TELEBIRR' : 'CBE';
  haptic('selection');
  const btnCbe = document.getElementById('vref-prov-cbe');
  const btnTb = document.getElementById('vref-prov-telebirr');
  const hidden = document.getElementById('vmanual-provider');
  if (btnCbe) btnCbe.classList.toggle('active', _manualProvider === 'CBE');
  if (btnTb) btnTb.classList.toggle('active', _manualProvider === 'TELEBIRR');
  if (hidden) hidden.value = _manualProvider;
}

function formatEtbAmount(num) {
  const n = Number(num || 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatRecentDate(isoStr) {
  if (!isoStr) return { dateText: '—', agoText: '' };
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return { dateText: '—', agoText: '' };
  const dateText = d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const diffMin = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  let agoText = 'Just now';
  if (diffMin >= 1440) {
    const days = Math.floor(diffMin / 1440);
    const hrs = Math.floor((diffMin % 1440) / 60);
    agoText = `${days}d ${hrs}h ago`;
  } else if (diffMin >= 60) {
    const hrs = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    agoText = `${hrs}h ${mins}m ago`;
  } else if (diffMin >= 1) {
    agoText = `${diffMin}m ago`;
  }
  return { dateText, agoText };
}

function renderVerifyRing(summary) {
  const totalAmount = Number(summary?.totalAmount || 0);
  const totalCount = Number(summary?.totalCount || 0);
  const byProvider = summary?.byProvider || {};

  const amtEl = document.getElementById('vp-ring-amount');
  const cntEl = document.getElementById('vp-ring-count');
  const svg = document.getElementById('vp-ring-svg');

  if (amtEl) amtEl.textContent = `ETB ${formatEtbAmount(totalAmount)}`;
  if (cntEl) cntEl.textContent = `${totalCount} ${totalCount === 1 ? 'payment' : 'payments'}`;
  if (!svg) return;

  const r = 88;
  const C = 2 * Math.PI * r;
  const arcSpan = C * (344 / 360);

  if (totalAmount <= 0 || totalCount <= 0) {
    svg.innerHTML = `<circle cx="110" cy="110" r="${r}" fill="none" stroke="#6c7179" stroke-width="17" stroke-linecap="round" stroke-dasharray="${arcSpan.toFixed(2)} ${C.toFixed(2)}" transform="rotate(-82 110 110)"></circle>`;
    return;
  }

  const colors = { TELEBIRR: '#00a6fb', CBE: '#f59e0b', BOA: '#a855f7' };
  const entries = Object.entries(byProvider).filter(([, v]) => Number(v?.amount || 0) > 0);

  let html = `<circle cx="110" cy="110" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="17" stroke-linecap="round" stroke-dasharray="${arcSpan.toFixed(2)} ${C.toFixed(2)}" transform="rotate(-82 110 110)"></circle>`;
  let offset = 0;

  for (const [prov, info] of entries) {
    const share = Number(info.amount) / totalAmount;
    const segLen = Math.max(8, arcSpan * share);
    const col = colors[prov] || '#30d158';
    html += `<circle cx="110" cy="110" r="${r}" fill="none" stroke="${col}" stroke-width="17" stroke-linecap="round" stroke-dasharray="${segLen.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-82 110 110)"></circle>`;
    offset += segLen;
  }
  svg.innerHTML = html;
}

function getProviderSvg(provider) {
  if (provider === 'TELEBIRR') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M12 3v8M8 7h8M12 11c3.5 0 6 2.5 6 5.5S15.5 21 12 21s-6-2.5-6-5.5" stroke="#0ea5e9" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;
  }
  if (provider === 'CBE') {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <polygon points="12,3 14.7,9 21,9.5 16,13.8 17.5,20 12,16.8 6.5,20 8,13.8 3,9.5 9.3,9" fill="#f59e0b"/>
    </svg>`;
  }
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2">
    <path d="M3 10h18M5 10v8M10 10v8M14 10v8M19 10v8M2 20h20M12 3l10 5H2l10-5z"/>
  </svg>`;
}

function renderRecentTransactions(items) {
  const list = document.getElementById('vp-recent-list');
  if (!list) return;

  if (!Array.isArray(items) || items.length === 0) {
    list.innerHTML = `<div class="vp-tx-card" style="justify-content:center;color:#8c96a6;font-size:13px;">No recent verifications yet. Scan or upload a receipt above.</div>`;
    return;
  }

  list.innerHTML = items.map((tx) => {
    const prov = String(tx.provider || 'CBE').toUpperCase();
    const status = String(tx.status || 'VERIFIED');
    let badgeClass = 'verified';
    let badgeText = 'Verified';
    let dotColor = '#22c55e';

    if (status === 'FLAGGED_DUPLICATE') {
      badgeClass = 'duplicate';
      badgeText = 'Duplicate';
      dotColor = '#ef4444';
    } else if (status === 'AMOUNT_MISMATCH') {
      badgeClass = 'mismatch';
      badgeText = 'Mismatch';
      dotColor = '#f59e0b';
    } else if (status !== 'VERIFIED') {
      badgeClass = 'failed';
      badgeText = 'Failed';
      dotColor = '#ef4444';
    }

    const sub = tx.payerName || (tx.receivingAccount ? `To ${tx.receivingAccount}` : 'Receipt check');
    const { dateText, agoText } = formatRecentDate(tx.verifiedAt || tx.createdAt);

    return `<div class="vp-tx-card">
      <div class="vp-tx-icon">
        ${getProviderSvg(prov)}
        <span class="vp-tx-dot" style="background:${dotColor};"></span>
      </div>
      <div class="vp-tx-main">
        <div class="vp-tx-prov">${escHtml(prov)}</div>
        <div class="vp-tx-sub">${escHtml(sub)}</div>
        <span class="vp-tx-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="vp-tx-right">
        <div class="vp-tx-amt">ETB ${formatEtbAmount(tx.amount)}</div>
        <div class="vp-tx-ref">${escHtml(tx.txnReference || '—')}</div>
        <div class="vp-tx-date">${escHtml(dateText)}</div>
        ${agoText ? `<div class="vp-tx-ago">${escHtml(agoText)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function loadVerifyHistory() {
  const { ok, data } = await api('GET', `/verify/history?range=${encodeURIComponent(_verifyRange)}&limit=15`);
  if (!ok || !data) {
    renderRecentTransactions([]);
    return;
  }
  renderVerifyRing(data.summary);
  renderRecentTransactions(data.recent || []);
}

function dismissVerifyResult() {
  const card = document.getElementById('vresult-card');
  if (card) card.style.display = 'none';
}

// Live camera scanner implementation lives in scanner.js (window.openCameraScanner, etc.)

function renderVerifyResult(result) {
  const card = document.getElementById('vresult-card');
  const icon = document.getElementById('vresult-icon');
  const title = document.getElementById('vresult-title');
  const desc = document.getElementById('vresult-desc');
  const details = document.getElementById('vresult-details');
  const hint = document.getElementById('vresult-hint');
  if (!card) return;

  card.style.display = 'block';

  let borderCol = '#30d158';
  let bgCol = 'rgba(48, 209, 88, 0.1)';
  let iconText = '✅';
  let titleText = 'Payment Verified!';
  let descText = 'Legitimate payment received in your designated account.';

  const isWrongReceiver = /wrong receiver|receiver account mismatch|receiver mismatch|not to your registered/i.test(result.message || '');
  const isUnreadable = (result.status === 'FAILED' || result.status === 'INVALID_RECEIPT' || result.status === 'UNKNOWN') && !isWrongReceiver;

  if (hint) {
    hint.style.display = isUnreadable ? 'block' : 'none';
  }

  if (result.status === 'FLAGGED_DUPLICATE') {
    borderCol = '#ff453a';
    bgCol = 'rgba(255, 69, 58, 0.15)';
    iconText = '🚨';
    titleText = 'Duplicate Receipt!';
    descText = 'Warning: This receipt was already verified! Do NOT release goods.';
    haptic('error');
  } else if (result.status === 'AMOUNT_MISMATCH') {
    borderCol = '#ff9f0a';
    bgCol = 'rgba(255, 159, 10, 0.15)';
    iconText = '⚠️';
    titleText = 'Amount Mismatch';
    descText = result.message || 'Amount differs from bank confirmation.';
    haptic('warning');
  } else if (result.status === 'FAILED' || result.status === 'INVALID_RECEIPT') {
    if (isWrongReceiver) {
      borderCol = '#ff9f0a';
      bgCol = 'rgba(255, 159, 10, 0.15)';
      iconText = '⚠️';
      titleText = 'Wrong Receiver — Not Accepted';
      descText = result.message || 'Payment was sent to another person\'s account, not to your business. Do NOT release goods.';
      haptic('warning');
    } else {
      borderCol = '#ff453a';
      bgCol = 'rgba(255, 69, 58, 0.1)';
      iconText = '❌';
      titleText = 'Verification Failed';
      descText = result.message || 'Payment could not be verified.';
      haptic('error');
    }
  } else {
    haptic('success');
  }

  card.style.borderColor = borderCol;
  card.style.background = bgCol;
  icon.textContent = iconText;
  title.textContent = titleText;
  title.style.color = borderCol;
  desc.textContent = descText;

  let html = '';
  if (result.amount !== undefined && result.amount !== null) {
    const formattedAmount = !isNaN(Number(result.amount)) ? Number(result.amount).toFixed(2) : String(result.amount);
    html += `<div style="display:flex;justify-content:space-between">
      <span style="color:var(--hint)">Amount:</span>
      <strong style="color:${borderCol};font-size:16px">${formattedAmount} ETB</strong>
    </div>`;
  }
  if (result.txnReference) {
    html += `<div style="display:flex;justify-content:space-between">
      <span style="color:var(--hint)">Reference:</span>
      <code>${escHtml(result.txnReference)}</code>
    </div>`;
  }
  if (result.payerName) {
    html += `<div style="display:flex;justify-content:space-between">
      <span style="color:var(--hint)">Payer:</span>
      <span>${escHtml(result.payerName)}</span>
    </div>`;
  }
  if (result.payerPhone) {
    html += `<div style="display:flex;justify-content:space-between">
      <span style="color:var(--hint)">Payer Phone:</span>
      <span>${escHtml(result.payerPhone)}</span>
    </div>`;
  }
  if (result.receivingAccount) {
    html += `<div style="display:flex;justify-content:space-between">
      <span style="color:var(--hint)">Paid To:</span>
      <span>${escHtml(result.receivingAccount)}</span>
    </div>`;
  }
  if (result.provider) {
    html += `<div style="display:flex;justify-content:space-between">
      <span style="color:var(--hint)">Provider:</span>
      <span>${escHtml(result.provider)}</span>
    </div>`;
  }

  details.innerHTML = html;
  loadVerifyHistory();
}

function triggerQuickUpload() {
  const input = document.getElementById('vimage-file');
  if (input) input.click();
}

async function handleQuickUploadFile(event) {
  const fileInput = event?.target || document.getElementById('vimage-file');
  const file = fileInput?.files?.[0];
  if (!file) return;

  const uploadBtn = document.getElementById('vimage-btn');
  const uploadIcon = document.getElementById('vimage-icon');
  if (uploadBtn) uploadBtn.disabled = true;
  if (uploadIcon) uploadIcon.style.opacity = '0.45';

  toast('Optimizing & verifying receipt…');
  const isPdf = file.type === 'application/pdf';
  const payloadBlob = isPdf
    ? file
    : (typeof compressImageClient === 'function' ? await compressImageClient(file, 1400, 0.85) : file);

  const fd = new FormData();
  fd.append('receipt', payloadBlob, isPdf ? (file.name || 'receipt.pdf') : 'receipt.jpg');

  const { ok, data } = await api('POST', '/verify/image', fd, true);
  if (uploadBtn) uploadBtn.disabled = false;
  if (uploadIcon) uploadIcon.style.opacity = '1';
  if (fileInput) fileInput.value = '';

  if (!ok) {
    toast('❌ ' + (data?.error || 'Image verification failed'));
    renderVerifyResult({ status: 'FAILED', message: data?.error || 'Image verification failed' });
    return;
  }

  renderVerifyResult(data);
}

async function submitVerifyManual() {
  const provider = document.getElementById('vmanual-provider')?.value || 'CBE';
  const txnReference = document.getElementById('vmanual-ref').value.trim();
  const amountStr = document.getElementById('vmanual-amount').value.trim();
  const amount = parseFloat(amountStr);

  if (!txnReference) {
    toast('Please enter a transaction reference');
    haptic('error');
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    toast('Please enter a valid amount');
    haptic('error');
    return;
  }

  setLoading('vmanual-btn', true);
  const { ok, data } = await api('POST', '/verify/manual', { provider, txnReference, amount });
  setLoading('vmanual-btn', false);

  if (!ok) {
    toast('❌ ' + (data.error || 'Verification failed'));
    renderVerifyResult({ status: 'FAILED', message: data.error });
    return;
  }

  renderVerifyResult(data);
}

async function submitVerifySms() {
  const rawText = document.getElementById('vsms-text')?.value.trim() || '';
  const amtStr = document.getElementById('vsms-amount')?.value.trim() || '';
  const expectedAmount = amtStr ? parseFloat(amtStr) : undefined;

  if (!rawText || rawText.length < 5) {
    toast('Please paste the SMS confirmation or receipt link');
    haptic('error');
    return;
  }

  setLoading('vsms-btn', true);
  const isPureUrl = /^https:\/\/\S+$/i.test(rawText);
  const payload = isPureUrl
    ? { receiptUrl: rawText, ...(expectedAmount && expectedAmount > 0 ? { expectedAmount } : {}) }
    : { rawText, ...(expectedAmount && expectedAmount > 0 ? { expectedAmount } : {}) };

  const { ok, data } = await api('POST', isPureUrl ? '/verify/url' : '/verify/text', payload);
  setLoading('vsms-btn', false);

  if (!ok) {
    toast('❌ ' + (data.error || 'Verification failed'));
    renderVerifyResult({ status: 'FAILED', message: data.error || data.message || 'Verification failed' });
    return;
  }

  renderVerifyResult(data);
}

// ── RECEIVING ACCOUNTS (ADMIN) ────────────────────────────────────────────────
async function loadAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = `<div style="text-align:center;padding:30px 0"><div class="spinner" style="margin:auto"></div></div>`;

  const { ok, data } = await api('GET', '/settings/accounts');
  if (!ok) {
    toast('Failed to load receiving accounts');
    container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--destructive)">Could not load accounts.</div>`;
    return;
  }

  _accounts = data.accounts || [];
  renderAccounts();
}

function renderAccounts() {
  const container = document.getElementById('accounts-list');

  if (_accounts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:50px 20px;">
        <div style="font-size:48px;margin-bottom:12px;">🏦</div>
        <strong style="font-size:18px;display:block;">No accounts yet</strong>
        <p style="font-size:14px;color:var(--hint);margin:6px 0 20px;">
          Add your first CBE account or Telebirr number so verified customer payments deposit directly to your business.
        </p>
        <button class="btn" onclick="openAddAccountModal()" style="max-width:220px;margin:auto;">+ Add Account</button>
      </div>`;
    return;
  }

  // Group by bank (CBE and Telebirr prioritized)
  const grouped = { CBE: [], TELEBIRR: [] };
  for (const acc of _accounts) {
    const b = acc.bankName || 'CBE';
    if (!grouped[b]) grouped[b] = [];
    grouped[b].push(acc);
  }

  let html = '';
  for (const [bank, list] of Object.entries(grouped)) {
    if (list.length === 0) continue;
    const isCbe = bank === 'CBE';
    const icon = isCbe ? '🏦' : '📱';
    const label = isCbe ? 'Commercial Bank of Ethiopia (CBE)' : 'Telebirr';

    html += `<div class="section-label">${icon} ${label} (${list.length})</div>`;
    html += `<div class="card">`;
    for (const a of list) {
      html += `
        <div class="card-row no-tap">
          <div class="row-icon ${a.isActive ? 'green' : 'orange'}">${isCbe ? '🏦' : '📱'}</div>
          <div class="row-body">
            <strong>${escHtml(a.accountHolderName)}</strong>
            <span>${escHtml(a.accountNumber)}</span>
          </div>
          <span class="badge ${a.isActive ? 'active' : 'inactive'}">${a.isActive ? 'Active' : 'Disabled'}</span>
          <div class="row-actions">
            <button class="icon-btn" title="Toggle Active" onclick="toggleAccount('${a.id}', ${a.isActive})">
              ${a.isActive ? '⏸' : '▶'}
            </button>
            <button class="icon-btn" title="Edit Holder Name" onclick="openEditHolderModal('${a.id}', '${escHtml(a.accountHolderName)}')">✏️</button>
            <button class="icon-btn danger" title="Delete" onclick="openConfirmDeleteAccount('${a.id}', '${escHtml(a.accountNumber)}')">🗑</button>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
}

function openAddAccountModal() {
  clearErrors(['modal-add-accnum-err', 'modal-add-holder-err']);
  document.getElementById('modal-add-accnum').value = '';
  document.getElementById('modal-add-holder').value = '';
  openModal('modal-add-account');
}

async function submitAddAccountModal() {
  clearErrors(['modal-add-accnum-err', 'modal-add-holder-err']);
  const bankName = document.getElementById('modal-add-bank').value;
  const accountNumber = document.getElementById('modal-add-accnum').value.trim();
  const accountHolderName = document.getElementById('modal-add-holder').value.trim();

  let valid = true;
  if (!accountNumber) {
    showErr('modal-add-accnum-err', 'Account number or phone is required');
    valid = false;
  }
  if (!accountHolderName) {
    showErr('modal-add-holder-err', 'Account holder name is required');
    valid = false;
  }
  if (!valid) {
    haptic('error');
    return;
  }

  setLoading('modal-add-acc-btn', true);
  const { ok, data } = await api('POST', '/settings/accounts', {
    bankName,
    accountNumber,
    accountHolderName,
  });
  setLoading('modal-add-acc-btn', false);

  if (!ok) {
    haptic('error');
    const msg = data.error || 'Failed to add receiving account';
    if (msg.toLowerCase().includes('number')) showErr('modal-add-accnum-err', msg);
    else toast('❌ ' + msg);
    return;
  }

  closeModal('modal-add-account');
  haptic('success');
  toast('✅ Receiving account added!');
  await loadAccounts();
}

let _editingAccountId = null;
function openEditHolderModal(id, currentName) {
  _editingAccountId = id;
  clearErrors(['modal-edit-holder-err']);
  document.getElementById('modal-edit-holder-input').value = currentName;
  openModal('modal-edit-holder');
}

async function submitEditHolderModal() {
  const name = document.getElementById('modal-edit-holder-input').value.trim();
  if (!name || name.length < 2) {
    showErr('modal-edit-holder-err', 'Name must be at least 2 characters');
    haptic('error');
    return;
  }

  setLoading('modal-edit-holder-btn', true);
  const { ok, data } = await api('PATCH', `/settings/accounts/${_editingAccountId}`, {
    accountHolderName: name,
  });
  setLoading('modal-edit-holder-btn', false);

  if (!ok) {
    haptic('error');
    toast('❌ ' + (data.error || 'Update failed'));
    return;
  }

  closeModal('modal-edit-holder');
  haptic('success');
  toast('✅ Account holder updated!');
  await loadAccounts();
}

async function toggleAccount(id, isCurrentlyActive) {
  const { ok, data } = await api('PATCH', `/settings/accounts/${id}/toggle`, {
    isActive: !isCurrentlyActive,
  });
  if (!ok) {
    haptic('error');
    toast('❌ ' + (data.error || 'Failed to update'));
    return;
  }
  haptic('light');
  toast(!isCurrentlyActive ? 'Account enabled ✓' : 'Account disabled');
  await loadAccounts();
}

function openConfirmDeleteAccount(id, num) {
  document.getElementById('modal-confirm-title').textContent = 'Delete Receiving Account?';
  document.getElementById('modal-confirm-desc').textContent = `Are you sure you want to remove account "${num}"? Customers will no longer be able to verify payments made to this account.`;
  document.getElementById('modal-confirm-ok-btn').onclick = async () => {
    closeModal('modal-confirm-delete');
    const { ok, data } = await api('DELETE', `/settings/accounts/${id}`);
    if (!ok) {
      haptic('error');
      toast('❌ ' + (data.error || 'Delete failed'));
      return;
    }
    haptic('success');
    toast('Account deleted ✓');
    await loadAccounts();
  };
  openModal('modal-confirm-delete');
}

// ── CASHIERS MANAGEMENT (ADMIN) ──────────────────────────────────────────────
async function loadCashiers() {
  const container = document.getElementById('cashiers-list');
  container.innerHTML = `<div style="text-align:center;padding:30px 0"><div class="spinner" style="margin:auto"></div></div>`;

  const { ok, data } = await api('GET', '/cashiers');
  if (!ok) {
    toast('Failed to load cashiers');
    container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--destructive)">Could not load cashiers.</div>`;
    return;
  }

  _cashiers = data.cashiers || [];
  renderCashiers();
}

function renderCashiers() {
  const container = document.getElementById('cashiers-list');

  if (_cashiers.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:50px 20px;">
        <div style="font-size:48px;margin-bottom:12px;">👥</div>
        <strong style="font-size:18px;display:block;">No cashiers yet</strong>
        <p style="font-size:14px;color:var(--hint);margin:6px 0 20px;">
          Create staff cashier logins with a simple password so they can verify payments at the counter.
        </p>
        <button class="btn" onclick="openAddCashierModal()" style="max-width:220px;margin:auto;background:#30d158;color:#000;">+ Create Cashier</button>
      </div>`;
    return;
  }

  let html = `<div class="section-label">Active Cashiers (${_cashiers.length})</div>`;
  html += `<div class="card">`;
  for (const c of _cashiers) {
    html += `
      <div class="card-row no-tap">
        <div class="row-icon ${c.isActive ? 'green' : 'orange'}">👤</div>
        <div class="row-body">
          <strong>${escHtml(c.fullName)}</strong>
          <span>Branch: ${escHtml(c.branchName || 'Main Branch')}</span>
        </div>
        <span class="badge ${c.isActive ? 'active' : 'inactive'}">${c.isActive ? 'Active' : 'Disabled'}</span>
        <div class="row-actions">
          <button class="icon-btn" title="Toggle Status" onclick="toggleCashier('${c.id}', ${c.isActive})">
            ${c.isActive ? '⏸' : '▶'}
          </button>
          <button class="icon-btn" title="Edit / Reset Password" onclick="openEditCashierModal('${c.id}', '${escHtml(c.fullName)}')">✏️</button>
          <button class="icon-btn danger" title="Delete Cashier" onclick="openConfirmDeleteCashier('${c.id}', '${escHtml(c.fullName)}')">🗑</button>
        </div>
      </div>`;
  }
  html += `</div>`;

  container.innerHTML = html;
}

function openAddCashierModal() {
  clearErrors(['modal-add-cashier-name-err', 'modal-add-cashier-pwd-err']);
  document.getElementById('modal-add-cashier-name').value = '';
  document.getElementById('modal-add-cashier-pwd').value = '';
  openModal('modal-add-cashier');
}

async function submitAddCashierModal() {
  clearErrors(['modal-add-cashier-name-err', 'modal-add-cashier-pwd-err']);
  const fullName = document.getElementById('modal-add-cashier-name').value.trim();
  const password = document.getElementById('modal-add-cashier-pwd').value;

  let valid = true;
  if (!fullName || fullName.length < 2) {
    showErr('modal-add-cashier-name-err', 'Full name must be at least 2 characters');
    valid = false;
  }
  if (!password || password.length < 4) {
    showErr('modal-add-cashier-pwd-err', 'Password must be at least 4 characters');
    valid = false;
  }
  if (!valid) {
    haptic('error');
    return;
  }

  setLoading('modal-add-cashier-btn', true);
  const { ok, status, data } = await api('POST', '/cashiers', { fullName, password });
  setLoading('modal-add-cashier-btn', false);

  if (!ok) {
    haptic('error');
    const msg = data.error || 'Failed to create cashier';
    if (status === 409 || msg.toLowerCase().includes('already in use')) {
      showErr('modal-add-cashier-pwd-err', 'That password is already in use by another cashier in this branch. Please choose a different one.');
    } else {
      toast('❌ ' + msg);
    }
    return;
  }

  closeModal('modal-add-cashier');
  haptic('success');
  toast('✅ Cashier created successfully!');
  await loadCashiers();
}

let _editingCashierId = null;
function openEditCashierModal(id, fullName) {
  _editingCashierId = id;
  clearErrors(['modal-edit-cashier-name-err', 'modal-edit-cashier-pwd-err']);
  document.getElementById('modal-edit-cashier-name').value = fullName;
  document.getElementById('modal-edit-cashier-pwd').value = '';
  openModal('modal-edit-cashier');
}

async function submitEditCashierModal() {
  clearErrors(['modal-edit-cashier-name-err', 'modal-edit-cashier-pwd-err']);
  const fullName = document.getElementById('modal-edit-cashier-name').value.trim();
  const password = document.getElementById('modal-edit-cashier-pwd').value;

  if (!fullName || fullName.length < 2) {
    showErr('modal-edit-cashier-name-err', 'Full name must be at least 2 characters');
    haptic('error');
    return;
  }

  const payload = { fullName };
  if (password.trim()) payload.password = password;

  setLoading('modal-edit-cashier-btn', true);
  const { ok, status, data } = await api('PATCH', `/cashiers/${_editingCashierId}`, payload);
  setLoading('modal-edit-cashier-btn', false);

  if (!ok) {
    haptic('error');
    const msg = data.error || 'Failed to update cashier';
    if (status === 409 || msg.toLowerCase().includes('already in use')) {
      showErr('modal-edit-cashier-pwd-err', 'That password is already in use by another cashier in this branch. Please choose a different one.');
    } else {
      toast('❌ ' + msg);
    }
    return;
  }

  closeModal('modal-edit-cashier');
  haptic('success');
  toast('✅ Cashier updated!');
  await loadCashiers();
}

async function toggleCashier(id, isCurrentlyActive) {
  const { ok, data } = await api('PATCH', `/cashiers/${id}/status`, {
    isActive: !isCurrentlyActive,
  });
  if (!ok) {
    haptic('error');
    toast('❌ ' + (data.error || 'Failed to update cashier status'));
    return;
  }
  haptic('light');
  toast(!isCurrentlyActive ? 'Cashier enabled ✓' : 'Cashier disabled');
  await loadCashiers();
}

function openConfirmDeleteCashier(id, name) {
  document.getElementById('modal-confirm-title').textContent = 'Delete Cashier Account?';
  document.getElementById('modal-confirm-desc').textContent = `Are you sure you want to remove cashier "${name}"? They will no longer be able to log in or verify payments.`;
  document.getElementById('modal-confirm-ok-btn').onclick = async () => {
    closeModal('modal-confirm-delete');
    const { ok, data } = await api('DELETE', `/cashiers/${id}`);
    if (!ok) {
      haptic('error');
      toast('❌ ' + (data.error || 'Failed to delete cashier'));
      return;
    }
    haptic('success');
    toast('Cashier removed ✓');
    await loadCashiers();
  };
  openModal('modal-confirm-delete');
}

// ── PROFILE SCREEN ───────────────────────────────────────────────────────────
async function loadProfile() {
  const { ok, data } = await api('GET', '/auth/me');
  if (ok && data.user) _profile = data.user;
  if (!_profile) return;

  const isAdmin = isAdminRole();
  const avatarEl = document.getElementById('pf-avatar');
  if (avatarEl) {
    avatarEl.textContent = _profile.fullName?.[0]?.toUpperCase() ?? '?';
    avatarEl.style.background = isAdmin
      ? 'linear-gradient(135deg, #0a84ff, #5e5ce6)'
      : 'linear-gradient(135deg, #30d158, #0a84ff)';
  }

  document.getElementById('profile-name').textContent = _profile.fullName;
  const roleBadge = document.getElementById('profile-role-badge');
  if (roleBadge) {
    roleBadge.textContent = isAdmin ? 'Business Admin' : 'Staff Cashier';
    roleBadge.style.color = isAdmin ? '#0a84ff' : '#30d158';
  }

  document.getElementById('pf-role-subtitle').textContent = _profile.organizationName || 'Account Details';

  // Toggle rows based on role
  const rowPhone = document.getElementById('pf-row-phone');
  const rowType = document.getElementById('pf-row-type');
  const rowAccs = document.getElementById('pf-row-accounts');
  const rowCash = document.getElementById('pf-row-cashiers');

  if (rowPhone) rowPhone.style.display = _profile.phone ? 'flex' : 'none';
  if (rowType)  rowType.style.display  = _profile.accountType ? 'flex' : 'none';
  if (rowAccs)  rowAccs.style.display  = isAdmin ? 'flex' : 'none';
  if (rowCash)  rowCash.style.display  = isAdmin ? 'flex' : 'none';

  document.getElementById('pf-phone').textContent    = _profile.phone || '—';
  document.getElementById('pf-org').textContent      = _profile.organizationName || '—';
  document.getElementById('pf-branch').textContent   = _profile.branchName || 'Main Branch';
  document.getElementById('pf-type').textContent     = _profile.accountType || '—';
  document.getElementById('pf-accounts').textContent = `${_profile.accountsCount ?? 0} configured`;
  document.getElementById('pf-cashiers').textContent = `${_profile.cashiersCount ?? 0} active`;
  document.getElementById('pf-tg').textContent       = _profile.telegramLinked ? '🔗 Linked' : 'Not linked';
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────
async function logout() {
  haptic('medium');
  try { await api('POST', '/auth/logout'); } catch (e) {}
  _token = null;
  _profile = null;
  localStorage.removeItem('cf_token');
  toast('Signed out successfully');
  showScreen('login');
}

// ── MODAL HELPERS ─────────────────────────────────────────────────────────────
function openModal(id) {
  haptic('light');
  const m = document.getElementById(id);
  if (m) m.classList.add('show');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('show');
}

function closeModalOnBg(e, id) {
  if (e.target && e.target.id === id) {
    closeModal(id);
  }
}

// ── UTILITY HELPERS ───────────────────────────────────────────────────────────
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
  if (loading) {
    btn._orig = btn.textContent;
    btn.textContent = '⏳ Please wait…';
  } else {
    btn.textContent = btn._orig || btn.textContent;
  }
}

function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
