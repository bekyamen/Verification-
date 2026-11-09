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
let _activeVerifyTab = 'scan';
let _selectedProvider = 'CBE';
let _scannerStream = null;
let _scannerFacingMode = 'environment';
let _scannerCapturedBlob = null;
let _scannerPreviewUrl = null;

function selectMiniappProvider(p) {
  _selectedProvider = p;
  haptic('selection');

  const isCbe = (p === 'CBE');

  // Update vform-scan buttons
  const scanCbe = document.getElementById('vscan-prov-cbe');
  const scanTb = document.getElementById('vscan-prov-telebirr');
  if (scanCbe && scanTb) {
    scanCbe.style.background = isCbe ? 'rgba(10, 132, 255, 0.2)' : 'transparent';
    scanCbe.style.border = isCbe ? '2px solid var(--button)' : '1px solid var(--glass-border)';
    scanTb.style.background = !isCbe ? 'rgba(10, 132, 255, 0.2)' : 'transparent';
    scanTb.style.border = !isCbe ? '2px solid var(--button)' : '1px solid var(--glass-border)';
  }

  // Update vform-image buttons
  const imgCbe = document.getElementById('vimg-prov-cbe');
  const imgTb = document.getElementById('vimg-prov-telebirr');
  if (imgCbe && imgTb) {
    imgCbe.style.background = isCbe ? 'rgba(10, 132, 255, 0.2)' : 'transparent';
    imgCbe.style.border = isCbe ? '2px solid var(--button)' : '1px solid var(--glass-border)';
    imgTb.style.background = !isCbe ? 'rgba(10, 132, 255, 0.2)' : 'transparent';
    imgTb.style.border = !isCbe ? '2px solid var(--button)' : '1px solid var(--glass-border)';
  }

  // Update modal buttons
  const modCbe = document.getElementById('modal-prov-cbe');
  const modTb = document.getElementById('modal-prov-telebirr');
  if (modCbe && modTb) {
    modCbe.style.background = isCbe ? 'var(--button)' : 'transparent';
    modCbe.style.color = isCbe ? '#fff' : 'var(--hint)';
    modTb.style.background = !isCbe ? 'var(--button)' : 'transparent';
    modTb.style.color = !isCbe ? '#fff' : 'var(--hint)';
  }

  // Sync with manual dropdown
  const manualSel = document.getElementById('vmanual-provider');
  if (manualSel) manualSel.value = p;
}

function initVerifyScreen() {
  const lbl = document.getElementById('verify-cashier-label');
  if (lbl && _profile) {
    lbl.textContent = `Logged in as: ${_profile.fullName} (${_profile.role})`;
  }
  switchVerifyTab(_activeVerifyTab || 'scan', false);
}

function switchVerifyTab(tab, autoLaunchCamera = false) {
  _activeVerifyTab = tab;
  haptic('selection');
  ['scan', 'image', 'manual'].forEach(t => {
    const btn = document.getElementById(`vtab-${t}`);
    const form = document.getElementById(`vform-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (form) form.style.display = (t === tab) ? 'block' : 'none';
  });
  if (tab === 'scan' && autoLaunchCamera) {
    openCameraScanner();
  }
}

// Client-side image compression
async function compressImageClient(fileOrBlob, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (w > maxDim || h > maxDim) {
        if (w >= h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(fileOrBlob);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        resolve(blob || fileOrBlob);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(fileOrBlob);
    };
    img.src = url;
  });
}

// Live Camera Scanner Lifecycle
async function openCameraScanner() {
  haptic('selection');
  const modal = document.getElementById('camera-scanner-modal');
  if (!modal) return;
  modal.classList.add('show');
  setScannerStep('camera');
  await startScannerCamera(_scannerFacingMode);
}

function closeCameraScanner() {
  haptic('light');
  stopScannerCamera();
  if (_scannerPreviewUrl) {
    URL.revokeObjectURL(_scannerPreviewUrl);
    _scannerPreviewUrl = null;
  }
  _scannerCapturedBlob = null;
  const modal = document.getElementById('camera-scanner-modal');
  if (modal) modal.classList.remove('show');
}

function stopScannerCamera() {
  if (_scannerStream) {
    _scannerStream.getTracks().forEach(t => {
      try { t.stop(); } catch(e) {}
    });
    _scannerStream = null;
  }
  const video = document.getElementById('scanner-video');
  if (video) video.srcObject = null;
}

async function startScannerCamera(mode) {
  stopScannerCamera();
  const errorBox = document.getElementById('scanner-error-box');
  const frame = document.getElementById('scanner-frame');
  const controls = document.getElementById('scanner-camera-controls');
  const video = document.getElementById('scanner-video');
  const switchBtn = document.getElementById('scanner-switch-btn');

  if (errorBox) errorBox.style.display = 'none';
  if (frame) frame.style.display = 'flex';
  if (controls) controls.style.display = 'flex';
  if (switchBtn) switchBtn.style.display = 'block';

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showScannerError('Camera streaming is not supported on this browser/client. Use the native camera button below.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: mode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    _scannerStream = stream;
    if (video) {
      video.srcObject = stream;
      try { await video.play(); } catch(e) {}
    }
  } catch (err) {
    console.warn('Camera error:', err);
    showScannerError('Camera permission blocked or unavailable. Please use the native camera option below.');
  }
}

function showScannerError(msg) {
  const errorBox = document.getElementById('scanner-error-box');
  const errorMsg = document.getElementById('scanner-error-msg');
  const frame = document.getElementById('scanner-frame');
  const controls = document.getElementById('scanner-camera-controls');
  const switchBtn = document.getElementById('scanner-switch-btn');

  if (errorBox) errorBox.style.display = 'block';
  if (errorMsg) errorMsg.textContent = msg;
  if (frame) frame.style.display = 'none';
  if (controls) controls.style.display = 'none';
  if (switchBtn) switchBtn.style.display = 'none';
}

async function switchScannerCamera() {
  haptic('selection');
  _scannerFacingMode = (_scannerFacingMode === 'environment') ? 'user' : 'environment';
  await startScannerCamera(_scannerFacingMode);
}

function setScannerStep(step) {
  const camView = document.getElementById('scanner-view-camera');
  const prevView = document.getElementById('scanner-view-preview');
  const vrfView = document.getElementById('scanner-view-verifying');
  const title = document.getElementById('scanner-header-title');

  if (camView) camView.style.display = (step === 'camera') ? 'flex' : 'none';
  if (prevView) prevView.style.display = (step === 'preview') ? 'flex' : 'none';
  if (vrfView) vrfView.style.display = (step === 'verifying') ? 'flex' : 'none';

  if (title) {
    if (step === 'camera') title.textContent = 'Scan Receipt';
    else if (step === 'preview') title.textContent = 'Preview Receipt';
    else if (step === 'verifying') title.textContent = 'Verifying...';
  }
}

async function captureScannerPhoto() {
  const video = document.getElementById('scanner-video');
  if (!video || !video.videoWidth) {
    toast('Camera is not ready yet');
    return;
  }
  haptic('medium');

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  stopScannerCamera();

  canvas.toBlob(async (rawBlob) => {
    if (!rawBlob) {
      toast('Failed to capture frame');
      startScannerCamera(_scannerFacingMode);
      return;
    }
    const compressed = await compressImageClient(rawBlob, 1280, 0.82);
    _scannerCapturedBlob = compressed;

    if (_scannerPreviewUrl) URL.revokeObjectURL(_scannerPreviewUrl);
    _scannerPreviewUrl = URL.createObjectURL(compressed);

    const img = document.getElementById('scanner-preview-img');
    if (img) img.src = _scannerPreviewUrl;

    setScannerStep('preview');
  }, 'image/jpeg', 0.92);
}

function retakeScannerPhoto() {
  haptic('light');
  if (_scannerPreviewUrl) {
    URL.revokeObjectURL(_scannerPreviewUrl);
    _scannerPreviewUrl = null;
  }
  _scannerCapturedBlob = null;
  setScannerStep('camera');
  startScannerCamera(_scannerFacingMode);
}

async function handleScannerNativeFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  haptic('selection');
  stopScannerCamera();

  toast('Optimizing photo...');
  const compressed = await compressImageClient(file, 1280, 0.82);
  _scannerCapturedBlob = compressed;

  if (_scannerPreviewUrl) URL.revokeObjectURL(_scannerPreviewUrl);
  _scannerPreviewUrl = URL.createObjectURL(compressed);

  const img = document.getElementById('scanner-preview-img');
  if (img) img.src = _scannerPreviewUrl;

  setScannerStep('preview');
}

async function verifyScannerPhoto() {
  if (!_scannerCapturedBlob) {
    toast('No photo captured');
    return;
  }

  haptic('medium');
  setScannerStep('verifying');

  const fd = new FormData();
  fd.append('receipt', _scannerCapturedBlob, 'receipt.jpg');
  fd.append('provider', _selectedProvider);

  const { ok, data } = await api('POST', '/verify/image', fd, true);

  closeCameraScanner();

  if (!ok) {
    toast('❌ ' + (data?.error || 'Verification failed'));
    renderVerifyResult({ status: 'FAILED', message: data?.error || 'Could not verify receipt' });
    return;
  }

  renderVerifyResult(data);
}

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
  card.scrollIntoView({ behavior: 'smooth' });
}

async function submitVerifyManual() {
  const provider = document.getElementById('vmanual-provider').value;
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

async function submitVerifyImage() {
  const fileInput = document.getElementById('vimage-file');
  const file = fileInput.files?.[0];
  if (!file) {
    toast('Please select an image file to upload');
    haptic('error');
    return;
  }

  setLoading('vimage-btn', true);
  toast('Optimizing image...');
  const compressed = await compressImageClient(file, 1280, 0.82);

  const fd = new FormData();
  fd.append('receipt', compressed, 'receipt.jpg');
  fd.append('provider', _selectedProvider);

  const { ok, data } = await api('POST', '/verify/image', fd, true);
  setLoading('vimage-btn', false);

  if (!ok) {
    toast('❌ ' + (data?.error || 'Image verification failed'));
    renderVerifyResult({ status: 'FAILED', message: data?.error || 'Image verification failed' });
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
