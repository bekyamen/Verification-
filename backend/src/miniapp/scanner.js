/* ── CheckFlow ET — Fullscreen Live Receipt Scanner ───────────────────────────
 * Works on Android Chrome/Telegram WebView and iOS Safari/Telegram WKWebView.
 * Vanilla ES6+, zero external packages.
 */

'use strict';

(function () {
  // ── Persisted preferences (layout & switches only — NEVER photos) ──────────
  const STORAGE_SHAPE_KEY = 'cf_scanner_frame_shape';
  const STORAGE_AUTO_KEY  = 'cf_scanner_auto_capture';

  let _frameShape = localStorage.getItem(STORAGE_SHAPE_KEY) === 'screenshot' ? 'screenshot' : 'tall';
  let _autoCaptureEnabled = localStorage.getItem(STORAGE_AUTO_KEY) === '1';

  // ── Scanner Runtime State ──────────────────────────────────────────────────
  let _stream = null;
  let _videoTrack = null;
  let _facingMode = 'environment'; // Always start with back camera
  let _cameraAttemptId = 0;
  let _cameraReady = false;
  let _supportsTorch = false;
  let _flashEnabled = false;
  let _flashBeforePreview = false;
  let _supportsZoom = false;
  let _zoomMin = 1;
  let _zoomMax = 1;
  let _zoomStep = 0.1;
  let _currentZoom = 1;
  let _trackCaps = {};

  let _capturedBlob = null;
  let _previewUrl = null;
  let _isCapturing = false;
  let _isVerifying = false;
  let _currentStep = 'camera'; // 'camera' | 'preview' | 'verifying'
  let _pickingNativeFile = false;
  let _processingNativeFile = false;

  // Analysis & Auto-capture state
  let _qualityTimer = null;
  let _analysisCanvas = null;
  let _analysisCtx = null;
  let _prevLuma = null;
  let _autoSharpSince = 0;
  let _autoCooldownUntil = 0;
  let _lastQualityState = 'idle';
  let _warnStreak = 0;

  // Pinch-to-zoom & tap-to-focus gesture state
  let _pinchStartDist = 0;
  let _pinchStartZoom = 1;
  let _touchMoved = false;
  let _touchStartX = 0;
  let _touchStartY = 0;
  let _lastTouchTapAt = 0;
  let _focusRestoreTimer = null;
  let _zoomRafPending = false;
  let _pendingZoomValue = 1;
  let _resumeTimer = null;

  // BackButton management
  let _tgBackHandler = null;

  // ── Helpers referencing Mini App globals safely ────────────────────────────
  function getToken() {
    try {
      if (typeof _token !== 'undefined' && _token) return _token;
    } catch (_) {}
    return localStorage.getItem('cf_token') || '';
  }

  function getSelectedProvider() {
    try {
      if (typeof _selectedProvider !== 'undefined' && _selectedProvider) return _selectedProvider;
    } catch (_) {}
    return 'CBE';
  }

  function safeHaptic(type) {
    try {
      if (typeof haptic === 'function') {
        haptic(type);
        return;
      }
      if (type === 'light' && navigator.vibrate) navigator.vibrate(15);
    } catch (_) {}
  }

  function safeToast(msg) {
    try {
      if (typeof toast === 'function') toast(msg);
    } catch (_) {}
  }

  function el(id) {
    return document.getElementById(id);
  }

  function isModalOpen() {
    const modal = el('camera-scanner-modal');
    return Boolean(modal && modal.classList.contains('show'));
  }

  // ── Frame Crop Math (shared by capture + live quality analyzer) ────────────
  function computeFrameCrop(video, bleedRatio = 0.02) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const frame = el('scanner-frame');
    const vRect = video.getBoundingClientRect();
    const fRect = frame ? frame.getBoundingClientRect() : null;

    if (!fRect || fRect.width <= 0 || fRect.height <= 0 || vRect.width <= 0 || vRect.height <= 0) {
      return { sx: 0, sy: 0, sw: vw, sh: vh };
    }

    // Account for CSS object-fit: cover scaling and centering
    const scale = Math.max(vRect.width / vw, vRect.height / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const offsetX = (vRect.width - renderedW) / 2;
    const offsetY = (vRect.height - renderedH) / 2;

    const fx = fRect.left - vRect.left;
    const fy = fRect.top - vRect.top;

    let sx = (fx - offsetX) / scale;
    let sy = (fy - offsetY) / scale;
    let sw = fRect.width / scale;
    let sh = fRect.height / scale;

    if (video.classList.contains('mirrored')) {
      sx = vw - (sx + sw);
    }

    if (bleedRatio > 0) {
      const padX = sw * bleedRatio;
      const padY = sh * bleedRatio;
      sx -= padX;
      sy -= padY;
      sw += padX * 2;
      sh += padY * 2;
    }

    sx = Math.max(0, Math.min(vw - 1, sx));
    sy = Math.max(0, Math.min(vh - 1, sy));
    sw = Math.max(1, Math.min(vw - sx, sw));
    sh = Math.max(1, Math.min(vh - sy, sh));

    return { sx: Math.round(sx), sy: Math.round(sy), sw: Math.round(sw), sh: Math.round(sh) };
  }

  // ── Canvas → JPEG Blob with iOS/Android safe fallback ─────────────────────
  function canvasToJpegBlob(canvas, quality) {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob === 'function') {
        try {
          canvas.toBlob((blob) => {
            if (blob) return resolve(blob);
            resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', quality)));
          }, 'image/jpeg', quality);
          return;
        } catch (_) {}
      }
      resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', quality)));
    });
  }

  function dataUrlToBlob(dataUrl) {
    try {
      const parts = dataUrl.split(',');
      const byteStr = atob(parts[1] || '');
      const ab = new ArrayBuffer(byteStr.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
      return new Blob([ab], { type: 'image/jpeg' });
    } catch (_) {
      return null;
    }
  }

  // Normalize & compress any image File/Blob (native camera or gallery upload)
  async function compressImageFile(fileOrBlob, maxWidth = 1400, quality = 0.85) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(fileOrBlob);
      const img = new Image();
      img.onload = async () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) return resolve(fileOrBlob);

        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        // Keep extremely tall receipts bounded too (~1960px height) for fast upload
        if (h > 1960) {
          w = Math.round((w * 1960) / h);
          h = 1960;
        }

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(fileOrBlob);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const blob = await canvasToJpegBlob(canvas, quality);
        canvas.width = 0;
        canvas.height = 0;
        resolve(blob || fileOrBlob);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(fileOrBlob);
      };
      img.src = url;
    });
  }

  // Expose shared compression helper to app.js (Upload Image tab)
  window.compressImageClient = function (fileOrBlob, maxDim = 1400, quality = 0.85) {
    return compressImageFile(fileOrBlob, maxDim, quality);
  };

  // ── Clear captured photo memory immediately ────────────────────────────────
  function clearCapturedPhoto() {
    if (_previewUrl) {
      try { URL.revokeObjectURL(_previewUrl); } catch (_) {}
      _previewUrl = null;
    }
    _capturedBlob = null;

    const previewImg = el('scanner-preview-img');
    if (previewImg) {
      previewImg.removeAttribute('src');
    }

    const nativeCam = el('scanner-native-camera-input');
    const galleryIn = el('scanner-gallery-input');
    if (nativeCam) nativeCam.value = '';
    if (galleryIn) galleryIn.value = '';
  }

  // ── UI State Controls ──────────────────────────────────────────────────────
  function applyFrameShapeUI() {
    const frame = el('scanner-frame');
    const previewBox = el('scanner-preview-frame-box');
    const btnTall = el('scanner-shape-tall');
    const btnShot = el('scanner-shape-screenshot');

    if (frame) {
      frame.classList.toggle('frame-tall', _frameShape === 'tall');
      frame.classList.toggle('frame-screenshot', _frameShape === 'screenshot');
    }
    if (previewBox) {
      previewBox.classList.toggle('frame-tall', _frameShape === 'tall');
      previewBox.classList.toggle('frame-screenshot', _frameShape === 'screenshot');
    }
    if (btnTall) btnTall.classList.toggle('active', _frameShape === 'tall');
    if (btnShot) btnShot.classList.toggle('active', _frameShape === 'screenshot');
  }

  window.setScannerFrameShape = function (shape) {
    _frameShape = shape === 'screenshot' ? 'screenshot' : 'tall';
    localStorage.setItem(STORAGE_SHAPE_KEY, _frameShape);
    safeHaptic('selection');
    applyFrameShapeUI();
    // Reset analysis stability baseline when crop region changes
    _prevLuma = null;
    _autoSharpSince = 0;
    updateAutoRing(0);
  };

  function applyAutoCaptureUI() {
    const btn = el('scanner-auto-btn');
    if (btn) {
      btn.classList.toggle('active', _autoCaptureEnabled);
      btn.setAttribute('aria-pressed', _autoCaptureEnabled ? 'true' : 'false');
      btn.textContent = _autoCaptureEnabled ? '✨ Auto: ON' : '✨ Auto: OFF';
    }
    const ring = el('scanner-auto-ring');
    if (ring) ring.style.display = _autoCaptureEnabled ? 'block' : 'none';
    if (!_autoCaptureEnabled) updateAutoRing(0);
  }

  window.toggleScannerAutoCapture = function () {
    _autoCaptureEnabled = !_autoCaptureEnabled;
    localStorage.setItem(STORAGE_AUTO_KEY, _autoCaptureEnabled ? '1' : '0');
    _autoSharpSince = 0;
    safeHaptic('selection');
    applyAutoCaptureUI();
  };

  function updateAutoRing(progress) {
    const circle = el('scanner-auto-ring-circle');
    if (!circle) return;
    const clamped = Math.max(0, Math.min(1, progress));
    circle.style.strokeDashoffset = String(264 * (1 - clamped));
  }

  function setStartingState(starting) {
    const badge = el('scanner-starting-badge');
    const captureBtn = el('scanner-capture-btn');
    const qualityPill = el('scanner-quality-pill');

    if (badge) badge.style.display = starting ? 'flex' : 'none';
    if (captureBtn) {
      captureBtn.disabled = starting;
      captureBtn.setAttribute('aria-disabled', starting ? 'true' : 'false');
    }
    if (qualityPill) {
      qualityPill.style.visibility = starting ? 'hidden' : 'visible';
    }
  }

  function setQualityFeedback(state, text) {
    const frame = el('scanner-frame');
    const pill = el('scanner-quality-pill');
    const captureBtn = el('scanner-capture-btn');

    if (frame) {
      frame.classList.toggle('is-sharp', state === 'sharp');
      frame.classList.toggle('is-warn', state === 'dark' || state === 'moving');
    }
    if (captureBtn) {
      captureBtn.classList.toggle('is-sharp', state === 'sharp');
    }
    if (pill) {
      pill.classList.remove('state-sharp', 'state-warn');
      if (state === 'sharp') pill.classList.add('state-sharp');
      else if (state === 'dark' || state === 'moving') pill.classList.add('state-warn');
      pill.textContent = text;
    }
  }

  function setScannerStep(step) {
    _currentStep = step;
    const camView = el('scanner-view-camera');
    const prevView = el('scanner-view-preview');
    const vrfView = el('scanner-view-verifying');

    if (camView) camView.style.display = step === 'camera' ? 'flex' : 'none';
    if (prevView) prevView.style.display = step === 'preview' ? 'flex' : 'none';
    if (vrfView) vrfView.style.display = step === 'verifying' ? 'flex' : 'none';
  }

  function setVerifyingStage(stage) {
    const s1 = el('sc-step-reading');
    const s2 = el('sc-step-bank');
    if (!s1 || !s2) return;

    const s1Dot = s1.querySelector('.sc-step-dot');
    const s2Dot = s2.querySelector('.sc-step-dot');

    if (stage === 'reading') {
      s1.className = 'sc-step active';
      s2.className = 'sc-step';
      if (s1Dot) s1Dot.textContent = '';
      if (s2Dot) s2Dot.textContent = '2';
    } else if (stage === 'checking_bank') {
      s1.className = 'sc-step done';
      s2.className = 'sc-step active';
      if (s1Dot) s1Dot.textContent = '✓';
      if (s2Dot) s2Dot.textContent = '';
    } else if (stage === 'done') {
      s1.className = 'sc-step done';
      s2.className = 'sc-step done';
      if (s1Dot) s1Dot.textContent = '✓';
      if (s2Dot) s2Dot.textContent = '✓';
    }
  }

  // ── Friendly Camera Error / Fallback Handler ───────────────────────────────
  function showCameraFallback(reasonType, triggerImmediatePicker = false) {
    _cameraReady = false;
    stopQualityLoop();
    setStartingState(false);

    const errBox = el('scanner-error-box');
    const errIcon = el('scanner-error-icon');
    const errTitle = el('scanner-error-title');
    const errMsg = el('scanner-error-msg');
    const frame = el('scanner-frame');
    const hint = el('scanner-hint-top');
    const bottomHud = el('scanner-bottom-hud');
    const flashBtn = el('scanner-flash-btn');
    const retryBtn = el('scanner-retry-btn');

    if (frame) frame.style.display = 'none';
    if (hint) hint.style.display = 'none';
    if (bottomHud) bottomHud.style.display = 'none';
    if (flashBtn) flashBtn.style.display = 'none';
    if (errBox) errBox.classList.add('show');

    if (reasonType === 'denied') {
      if (errIcon) errIcon.textContent = '🔒';
      if (errTitle) errTitle.textContent = 'Camera Permission Blocked';
      if (errMsg) {
        errMsg.textContent =
          'To scan receipts live, allow Camera access for Telegram in your phone Settings (or site permissions) and tap Try Again — or pick a photo right now.';
      }
      if (retryBtn) retryBtn.style.display = 'inline-flex';
    } else {
      if (errIcon) errIcon.textContent = '📷';
      if (errTitle) errTitle.textContent = 'Use Phone Camera or Photo';
      if (errMsg) {
        errMsg.textContent =
          'Live camera preview is not available in this Telegram window. Tap below to take a photo with your camera app or select a receipt screenshot.';
      }
      if (retryBtn) retryBtn.style.display = reasonType === 'unsupported' ? 'none' : 'inline-flex';
    }

    if (triggerImmediatePicker) {
      // Called synchronously on unsupported environments so user goes straight to native camera/picker
      const input = el('scanner-gallery-input');
      if (input) {
        _pickingNativeFile = true;
        try { input.click(); } catch (_) { _pickingNativeFile = false; }
      }
    }
  }

  function hideCameraFallback() {
    const errBox = el('scanner-error-box');
    const frame = el('scanner-frame');
    const hint = el('scanner-hint-top');
    const bottomHud = el('scanner-bottom-hud');

    if (errBox) errBox.classList.remove('show');
    if (frame) frame.style.display = 'flex';
    if (hint) hint.style.display = 'block';
    if (bottomHud) bottomHud.style.display = 'flex';
  }

  // ── Live Camera Hardware Lifecycle ─────────────────────────────────────────
  function stopScannerCamera() {
    _cameraAttemptId++;
    _cameraReady = false;
    stopQualityLoop();
    clearTimeout(_focusRestoreTimer);

    if (_stream) {
      _stream.getTracks().forEach((track) => {
        try {
          if (_flashEnabled && typeof track.applyConstraints === 'function') {
            track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
          }
        } catch (_) {}
        try { track.stop(); } catch (_) {}
      });
      _stream = null;
    }
    _videoTrack = null;
    _trackCaps = {};
    _supportsTorch = false;
    _flashEnabled = false;
    _supportsZoom = false;
    _currentZoom = 1;

    const flashBtn = el('scanner-flash-btn');
    if (flashBtn) {
      flashBtn.style.display = 'none';
      flashBtn.classList.remove('is-on');
    }

    const zoomWrap = el('scanner-zoom-wrap');
    const stage = el('scanner-stage');
    if (zoomWrap) zoomWrap.classList.remove('show');
    if (stage) stage.classList.remove('has-zoom');

    const video = el('scanner-video');
    if (video) {
      try { video.pause(); } catch (_) {}
      video.srcObject = null;
      video.classList.remove('mirrored');
    }
  }

  async function waitForVideoReady(video, attemptId) {
    if (video.videoWidth > 0 && video.readyState >= 2) return true;

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', check);
        video.removeEventListener('canplay', check);
        video.removeEventListener('playing', check);
        resolve(ok);
      };
      const check = () => {
        if (attemptId !== _cameraAttemptId) return done(false);
        if (video.videoWidth > 0 && video.readyState >= 2) done(true);
      };
      video.addEventListener('loadedmetadata', check);
      video.addEventListener('canplay', check);
      video.addEventListener('playing', check);
      const poll = setInterval(check, 60);
      const timeout = setTimeout(() => done(video.videoWidth > 0), 4000);
    });
  }

  async function acquireCameraStream(mode) {
    const constraintsList = [
      { video: { facingMode: { ideal: mode }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: { ideal: mode } }, audio: false },
    ];
    if (mode === 'environment') {
      constraintsList.push({ video: true, audio: false });
    }

    let lastErr = null;
    for (const constraints of constraintsList) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        lastErr = err;
        // Stop immediately on permission denial — don't prompt user multiple times
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')) {
          throw err;
        }
      }
    }
    throw lastErr || new Error('Camera unavailable');
  }

  async function startScannerCamera(mode) {
    stopScannerCamera();
    const attemptId = ++_cameraAttemptId;

    hideCameraFallback();
    setStartingState(true);
    setQualityFeedback('idle', 'Starting camera...');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraFallback('unsupported', false);
      return;
    }

    // Small settle wait after previous track.stop() — prevents NotReadableError on iOS camera switches
    await new Promise((r) => setTimeout(r, 50));
    if (attemptId !== _cameraAttemptId || !isModalOpen()) return;

    try {
      const stream = await acquireCameraStream(mode);
      if (attemptId !== _cameraAttemptId || !isModalOpen() || _currentStep !== 'camera') {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        return;
      }

      _stream = stream;
      _videoTrack = stream.getVideoTracks()[0] || null;

      const video = el('scanner-video');
      if (!video) return;

      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.autoplay = true;
      video.classList.toggle('mirrored', mode === 'user');
      video.srcObject = stream;

      try {
        await video.play();
      } catch (_) {}

      const ready = await waitForVideoReady(video, attemptId);
      if (!ready || attemptId !== _cameraAttemptId || !isModalOpen()) return;

      // Read hardware capabilities safely (iPhone Safari lacks several optional caps)
      _trackCaps = (_videoTrack && typeof _videoTrack.getCapabilities === 'function')
        ? (_videoTrack.getCapabilities() || {})
        : {};

      // Enable continuous autofocus if device supports it
      if (Array.isArray(_trackCaps.focusMode) && _trackCaps.focusMode.includes('continuous')) {
        _videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }

      // Flash / Torch button (shown ONLY when phone supports it)
      _supportsTorch = Boolean(_trackCaps.torch);
      _flashEnabled = false;
      const flashBtn = el('scanner-flash-btn');
      if (flashBtn) {
        flashBtn.style.display = _supportsTorch ? 'inline-flex' : 'none';
        flashBtn.classList.remove('is-on');
      }

      // Hardware Zoom slider (shown ONLY when phone supports zoom)
      _supportsZoom = Boolean(
        _trackCaps.zoom &&
        typeof _trackCaps.zoom.min === 'number' &&
        typeof _trackCaps.zoom.max === 'number' &&
        _trackCaps.zoom.max > _trackCaps.zoom.min
      );

      const zoomWrap = el('scanner-zoom-wrap');
      const zoomSlider = el('scanner-zoom-slider');
      const zoomVal = el('scanner-zoom-val');
      const stage = el('scanner-stage');

      if (_supportsZoom && zoomWrap && zoomSlider) {
        _zoomMin = _trackCaps.zoom.min;
        _zoomMax = Math.min(_trackCaps.zoom.max, 4); // Keep zoom practical (up to 4x)
        _zoomStep = _trackCaps.zoom.step || 0.1;
        const trackSettings = typeof _videoTrack.getSettings === 'function' ? _videoTrack.getSettings() : {};
        _currentZoom = typeof trackSettings.zoom === 'number' ? trackSettings.zoom : _zoomMin;

        zoomSlider.min = String(_zoomMin);
        zoomSlider.max = String(_zoomMax);
        zoomSlider.step = String(_zoomStep);
        zoomSlider.value = String(_currentZoom);
        if (zoomVal) zoomVal.textContent = `${Number(_currentZoom).toFixed(1)}x`;

        zoomWrap.classList.add('show');
        if (stage) stage.classList.add('has-zoom');
      } else {
        if (zoomWrap) zoomWrap.classList.remove('show');
        if (stage) stage.classList.remove('has-zoom');
      }

      _cameraReady = true;
      _prevLuma = null;
      _autoSharpSince = 0;
      _autoCooldownUntil = Date.now() + 900;
      updateAutoRing(0);

      setStartingState(false);
      setQualityFeedback('idle', 'Hold steady inside frame');
      startQualityLoop();
    } catch (err) {
      if (attemptId !== _cameraAttemptId) return;
      stopScannerCamera();
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showCameraFallback('denied', false);
      } else {
        showCameraFallback('unavailable', false);
      }
    }
  }

  // ── Torch / Flash Control ──────────────────────────────────────────────────
  async function setTorch(enabled) {
    if (!_videoTrack || !_supportsTorch || typeof _videoTrack.applyConstraints !== 'function') return;
    try {
      await _videoTrack.applyConstraints({ advanced: [{ torch: enabled }] });
      _flashEnabled = enabled;
      const flashBtn = el('scanner-flash-btn');
      if (flashBtn) {
        flashBtn.classList.toggle('is-on', enabled);
        flashBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      }
    } catch (_) {
      _flashEnabled = false;
    }
  }

  window.toggleScannerFlash = async function () {
    if (!_supportsTorch) return;
    safeHaptic('selection');
    await setTorch(!_flashEnabled);
  };

  // ── Zoom Control (Slider + Pinch) ──────────────────────────────────────────
  function applyZoom(targetZoom) {
    if (!_supportsZoom || !_videoTrack || typeof _videoTrack.applyConstraints !== 'function') return;
    const clamped = Math.max(_zoomMin, Math.min(_zoomMax, Number(targetZoom) || _zoomMin));
    _currentZoom = clamped;

    const slider = el('scanner-zoom-slider');
    const val = el('scanner-zoom-val');
    if (slider) slider.value = String(clamped);
    if (val) val.textContent = `${clamped.toFixed(1)}x`;

    _pendingZoomValue = clamped;
    if (_zoomRafPending) return;
    _zoomRafPending = true;

    requestAnimationFrame(() => {
      _zoomRafPending = false;
      if (!_videoTrack || !_supportsZoom) return;
      _videoTrack.applyConstraints({ advanced: [{ zoom: _pendingZoomValue }] }).catch(() => {});
    });
  }

  window.onScannerZoomInput = function (val) {
    applyZoom(parseFloat(val));
  };

  // ── Tap-to-Focus + Pinch Listeners ─────────────────────────────────────────
  function handleStageTapFocus(clientX, clientY) {
    if (!_cameraReady || _currentStep !== 'camera') return;
    const camView = el('scanner-view-camera');
    const video = el('scanner-video');
    const ring = el('scanner-focus-ring');
    if (!camView || !video) return;

    const camRect = camView.getBoundingClientRect();
    const rx = clientX - camRect.left;
    const ry = clientY - camRect.top;

    if (ring) {
      ring.style.left = `${rx}px`;
      ring.style.top = `${ry}px`;
      ring.classList.remove('active');
      void ring.offsetWidth; // trigger CSS reflow to replay pulse
      ring.classList.add('active');
    }
    safeHaptic('selection');

    if (!_videoTrack || typeof _videoTrack.applyConstraints !== 'function') return;

    // Convert screen tap to normalized [0..1] coordinates inside video frame
    const vRect = video.getBoundingClientRect();
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.max(vRect.width / vw, vRect.height / vh);
    const renderedW = vw * scale;
    const renderedH = vh * scale;
    const offsetX = (vRect.width - renderedW) / 2;
    const offsetY = (vRect.height - renderedH) / 2;

    let nx = (clientX - vRect.left - offsetX) / renderedW;
    const ny = (clientY - vRect.top - offsetY) / renderedH;
    if (_facingMode === 'user') nx = 1 - nx;

    const px = Math.max(0.02, Math.min(0.98, nx));
    const py = Math.max(0.02, Math.min(0.98, ny));

    const focusConstraint = {};
    let hasConstraint = false;

    if (Array.isArray(_trackCaps.focusMode)) {
      if (_trackCaps.focusMode.includes('single-shot')) {
        focusConstraint.focusMode = 'single-shot';
        hasConstraint = true;
      } else if (_trackCaps.focusMode.includes('continuous')) {
        focusConstraint.focusMode = 'continuous';
        hasConstraint = true;
      }
    }
    if ('pointsOfInterest' in _trackCaps || Array.isArray(_trackCaps.pointsOfInterest)) {
      focusConstraint.pointsOfInterest = [{ x: px, y: py }];
      hasConstraint = true;
    }

    if (hasConstraint) {
      _videoTrack.applyConstraints({ advanced: [focusConstraint] }).catch(() => {});
      clearTimeout(_focusRestoreTimer);
      if (focusConstraint.focusMode === 'single-shot' && _trackCaps.focusMode?.includes('continuous')) {
        _focusRestoreTimer = setTimeout(() => {
          if (_videoTrack && _cameraReady) {
            _videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
          }
        }, 1400);
      }
    }
  }

  function initCameraGestures() {
    const stage = el('scanner-stage');
    if (!stage || stage._gesturesBound) return;
    stage._gesturesBound = true;

    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && _supportsZoom) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        _pinchStartDist = Math.hypot(dx, dy);
        _pinchStartZoom = _currentZoom;
      } else if (e.touches.length === 1) {
        _touchMoved = false;
        _touchStartX = e.touches[0].clientX;
        _touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && _supportsZoom && _pinchStartDist > 0) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const factor = dist / _pinchStartDist;
        applyZoom(_pinchStartZoom * factor);
      } else if (e.touches.length === 1) {
        if (Math.hypot(e.touches[0].clientX - _touchStartX, e.touches[0].clientY - _touchStartY) > 12) {
          _touchMoved = true;
        }
      }
    }, { passive: true });

    stage.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) _pinchStartDist = 0;
      if (!_touchMoved && e.changedTouches.length === 1 && e.touches.length === 0) {
        if (e.target && e.target.closest && e.target.closest('button, input, #scanner-error-box')) return;
        _lastTouchTapAt = Date.now();
        const t = e.changedTouches[0];
        handleStageTapFocus(t.clientX, t.clientY);
      }
    }, { passive: true });

    // Desktop / non-touch click-to-focus support (skip synthetic click after touch)
    stage.addEventListener('click', (e) => {
      if (Date.now() - _lastTouchTapAt < 650) return;
      if (e.target && e.target.closest && e.target.closest('button, input, #scanner-error-box')) return;
      handleStageTapFocus(e.clientX, e.clientY);
    });
  }

  // ── Live Blur / Motion / Darkness Analyzer ─────────────────────────────────
  function startQualityLoop() {
    stopQualityLoop();
    _qualityTimer = setInterval(analyzeLiveFrame, 170);
  }

  function stopQualityLoop() {
    if (_qualityTimer) {
      clearInterval(_qualityTimer);
      _qualityTimer = null;
    }
    _autoSharpSince = 0;
    updateAutoRing(0);
  }

  function analyzeLiveFrame() {
    if (!_cameraReady || _currentStep !== 'camera' || document.hidden || _isCapturing) return;

    const video = el('scanner-video');
    if (!video || !video.videoWidth || video.readyState < 2) return;

    const crop = computeFrameCrop(video, 0);
    if (!crop) return;

    const W = 144;
    const H = 192;
    if (!_analysisCanvas) {
      _analysisCanvas = document.createElement('canvas');
      _analysisCanvas.width = W;
      _analysisCanvas.height = H;
      _analysisCtx = _analysisCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!_analysisCtx) return;

    try {
      _analysisCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
    } catch (_) {
      return;
    }

    const pixels = _analysisCtx.getImageData(0, 0, W, H).data;
    const totalPx = W * H;
    const currLuma = new Uint8Array(totalPx);

    let lumaSum = 0;
    let diffSum = 0;
    let lumaCount = 0;

    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      // Fast integer luminance approximation
      const y = (pixels[i] * 77 + pixels[i + 1] * 150 + pixels[i + 2] * 29) >> 8;
      currLuma[p] = y;
      if ((p & 1) === 0) {
        lumaSum += y;
        if (_prevLuma) diffSum += Math.abs(y - _prevLuma[p]);
        lumaCount++;
      }
    }

    const meanLuma = lumaCount > 0 ? lumaSum / lumaCount : 128;
    const motion = (_prevLuma && lumaCount > 0) ? (diffSum / lumaCount) : 0;
    _prevLuma = currLuma;

    // Edge gradient sharpness over interior receipt zone (avoids corner borders)
    const xStart = Math.floor(W * 0.12);
    const xEnd = Math.floor(W * 0.88);
    const yStart = Math.floor(H * 0.12);
    const yEnd = Math.floor(H * 0.88);

    let gradSum = 0;
    let edgeHits = 0;
    let interiorCount = 0;
    let minLuma = 255;
    let maxLuma = 0;

    for (let y = yStart; y < yEnd; y += 2) {
      const rowOffset = y * W;
      for (let x = xStart; x < xEnd; x += 2) {
        const idx = rowOffset + x;
        const c = currLuma[idx];
        if (c < minLuma) minLuma = c;
        if (c > maxLuma) maxLuma = c;

        const gx = Math.abs(currLuma[idx + 1] - currLuma[idx - 1]);
        const gy = Math.abs(currLuma[idx + W] - currLuma[idx - W]);
        const g = gx + gy;
        gradSum += g;
        if (g > 24) edgeHits++;
        interiorCount++;
      }
    }

    const meanGrad = interiorCount > 0 ? gradSum / interiorCount : 0;
    const edgeRatio = interiorCount > 0 ? edgeHits / interiorCount : 0;
    const contrast = maxLuma - minLuma;

    const isDark = meanLuma < 46;
    const isMoving = motion > 10.5;
    const isSharp = !isDark && !isMoving && contrast >= 42 && (edgeRatio >= 0.032 || meanGrad >= 9.0);

    let state = 'blurry';
    if (isDark) state = 'dark';
    else if (isMoving) state = 'moving';
    else if (isSharp) state = 'sharp';

    // Gentle debouncing on warning labels so banner doesn't flicker rapidly
    if (state === 'sharp') {
      _warnStreak = 0;
      _lastQualityState = 'sharp';
    } else if (state === _lastQualityState) {
      _warnStreak++;
    } else {
      _warnStreak = 1;
      if (_lastQualityState !== 'sharp') {
        _lastQualityState = state;
      } else if (_warnStreak >= 1) {
        _lastQualityState = state;
      }
    }

    if (state === 'dark') {
      _autoSharpSince = 0;
      updateAutoRing(0);
      setQualityFeedback('dark', '💡 Too dark — turn on flash or find more light');
    } else if (state === 'moving') {
      _autoSharpSince = 0;
      updateAutoRing(0);
      setQualityFeedback('moving', '✋ Hold steady');
    } else if (state === 'sharp') {
      const now = Date.now();
      if (_autoCaptureEnabled && now >= _autoCooldownUntil) {
        if (!_autoSharpSince) _autoSharpSince = now;
        const elapsed = now - _autoSharpSince;
        const progress = Math.min(1, elapsed / 1000);
        updateAutoRing(progress);
        setQualityFeedback('sharp', '✨ Sharp — auto-capturing...');
        if (elapsed >= 1000) {
          _autoSharpSince = 0;
          updateAutoRing(0);
          window.captureScannerPhoto(true);
        }
      } else {
        updateAutoRing(0);
        setQualityFeedback('sharp', '✅ Looks sharp — tap to capture');
      }
    } else {
      _autoSharpSince = 0;
      updateAutoRing(0);
      setQualityFeedback('blurry', '✋ Hold steady inside frame');
    }
  }

  // ── Public Lifecycle Functions (bound to UI buttons & app.js) ──────────────
  window.openCameraScanner = async function () {
    if (_isVerifying) return;
    safeHaptic('selection');

    try { window.Telegram?.WebApp?.expand?.(); } catch (_) {}

    const modal = el('camera-scanner-modal');
    if (!modal) return;
    modal.classList.add('show');

    initCameraGestures();
    applyFrameShapeUI();
    applyAutoCaptureUI();
    setScannerStep('camera');
    _facingMode = 'environment';

    // Hook Telegram BackButton so pressing back exits camera safely
    const tgApp = window.Telegram?.WebApp;
    if (tgApp?.BackButton) {
      if (_tgBackHandler) {
        try { tgApp.BackButton.offClick(_tgBackHandler); } catch (_) {}
      }
      _tgBackHandler = () => window.closeCameraScanner();
      try {
        tgApp.BackButton.show();
        tgApp.BackButton.onClick(_tgBackHandler);
      } catch (_) {}
    }

    // Immediate synchronous fallback if live getUserMedia doesn't exist
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraFallback('unsupported', true);
      return;
    }

    await startScannerCamera(_facingMode);
  };

  window.closeCameraScanner = function () {
    clearTimeout(_resumeTimer);
    safeHaptic('light');
    stopScannerCamera();
    clearCapturedPhoto();
    _isCapturing = false;
    _isVerifying = false;
    _pickingNativeFile = false;

    const modal = el('camera-scanner-modal');
    if (modal) modal.classList.remove('show');

    // Restore Telegram BackButton safely
    const tgApp = window.Telegram?.WebApp;
    if (tgApp?.BackButton && _tgBackHandler) {
      try { tgApp.BackButton.offClick(_tgBackHandler); } catch (_) {}
      _tgBackHandler = null;
      const onVerifyOrHome = (typeof _currentNav !== 'undefined' && (_currentNav === 'home' || _currentNav === 'verify'));
      if (onVerifyOrHome) {
        try { tgApp.BackButton.hide(); } catch (_) {}
      }
    }
  };

  window.switchScannerCamera = async function () {
    if (_isCapturing || _isVerifying) return;
    safeHaptic('selection');
    _facingMode = _facingMode === 'environment' ? 'user' : 'environment';
    await startScannerCamera(_facingMode);
  };

  window.retryScannerCamera = async function () {
    safeHaptic('selection');
    await startScannerCamera(_facingMode);
  };

  window.openNativeCameraPicker = function () {
    const input = el('scanner-native-camera-input');
    if (!input) return;
    _pickingNativeFile = true;
    input.click();
  };

  window.openGalleryPicker = function () {
    const input = el('scanner-gallery-input');
    if (!input) return;
    _pickingNativeFile = true;
    input.click();
  };

  // ── Instant Capture (Crop to frame, max 1400px wide, JPEG 0.85) ────────────
  window.captureScannerPhoto = async function (fromAuto = false) {
    if (!_cameraReady || _isCapturing || _isVerifying) return;
    const video = el('scanner-video');
    if (!video || !video.videoWidth) {
      if (!fromAuto) safeToast('Camera is still starting…');
      return;
    }

    _isCapturing = true;
    stopQualityLoop();

    // Instant haptic & visual shutter feedback
    safeHaptic(fromAuto ? 'success' : 'light');
    try { navigator.vibrate?.(18); } catch (_) {}

    const flashEl = el('scanner-shutter-flash');
    if (flashEl) {
      flashEl.classList.remove('flash');
      void flashEl.offsetWidth;
      flashEl.classList.add('flash');
    }

    // Turn off torch while checking preview (save battery & avoid blinding user)
    _flashBeforePreview = _flashEnabled;
    if (_flashEnabled) {
      setTorch(false);
    }

    try {
      const crop = computeFrameCrop(video, 0.02) || {
        sx: 0,
        sy: 0,
        sw: video.videoWidth,
        sh: video.videoHeight,
      };

      let targetW = crop.sw;
      let targetH = crop.sh;
      if (targetW > 1400) {
        targetH = Math.round((targetH * 1400) / targetW);
        targetW = 1400;
      }
      if (targetH > 1960) {
        targetW = Math.round((targetW * 1960) / targetH);
        targetH = 1960;
      }

      const capCanvas = document.createElement('canvas');
      capCanvas.width = Math.max(1, targetW);
      capCanvas.height = Math.max(1, targetH);
      const ctx = capCanvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, capCanvas.width, capCanvas.height);

      const blob = await canvasToJpegBlob(capCanvas, 0.85);
      capCanvas.width = 0;
      capCanvas.height = 0;

      if (!blob) {
        safeToast('Could not capture photo, please try again.');
        startQualityLoop();
        return;
      }

      if (_previewUrl) URL.revokeObjectURL(_previewUrl);
      _capturedBlob = blob;
      _previewUrl = URL.createObjectURL(blob);

      const previewImg = el('scanner-preview-img');
      if (previewImg) previewImg.src = _previewUrl;

      // Notice: keep _stream open in background so Retake returns instantly!
      setScannerStep('preview');
    } catch (_) {
      safeToast('Could not capture frame, please try again.');
      startQualityLoop();
    } finally {
      _isCapturing = false;
    }
  };

  // ── Instant Retake (zero camera restart lag if stream is still live) ───────
  window.retakeScannerPhoto = function () {
    if (_isVerifying) return;
    safeHaptic('light');
    clearCapturedPhoto();
    _autoCooldownUntil = Date.now() + 1100;
    _autoSharpSince = 0;
    _prevLuma = null;
    updateAutoRing(0);

    setScannerStep('camera');

    const streamAlive = Boolean(_stream && _videoTrack && _videoTrack.readyState === 'live');
    if (streamAlive) {
      setStartingState(false);
      setQualityFeedback('idle', 'Hold steady inside frame');
      if (_flashBeforePreview && _supportsTorch) {
        setTorch(true);
      }
      startQualityLoop();
    } else {
      startScannerCamera(_facingMode);
    }
  };

  // ── Native Camera / Gallery File Fallback Handler ──────────────────────────
  window.handleScannerNativeFile = async function (event) {
    _pickingNativeFile = false;
    const file = event.target?.files?.[0];
    if (!file) return;

    _processingNativeFile = true;
    clearTimeout(_resumeTimer);
    safeHaptic('selection');
    stopScannerCamera();
    safeToast('Preparing photo…');

    try {
      const compressed = await compressImageFile(file, 1400, 0.85);
      if (_previewUrl) URL.revokeObjectURL(_previewUrl);
      _capturedBlob = compressed;
      _previewUrl = URL.createObjectURL(compressed);

      const previewImg = el('scanner-preview-img');
      if (previewImg) previewImg.src = _previewUrl;

      setScannerStep('preview');
    } finally {
      _processingNativeFile = false;
    }
  };

  // ── Verify Captured Photo (Step-by-Step + Anti-Double-Tap + Immediate Cleanup)
  window.verifyScannerPhoto = async function () {
    if (_isVerifying) return;
    if (!_capturedBlob) {
      safeToast('Please take or select a photo first');
      return;
    }

    _isVerifying = true;
    safeHaptic('medium');

    const verifyBtn = el('scanner-verify-btn');
    const retakeBtn = el('scanner-retake-btn');
    if (verifyBtn) verifyBtn.disabled = true;
    if (retakeBtn) retakeBtn.disabled = true;

    // Turn off camera hardware the instant user taps Verify
    stopScannerCamera();

    setScannerStep('verifying');
    setVerifyingStage('reading');

    const fd = new FormData();
    fd.append('receipt', _capturedBlob, 'receipt.jpg');
    fd.append('provider', getSelectedProvider());

    // Clear photo from UI & memory immediately after packaging into FormData
    clearCapturedPhoto();

    // Gentle UI progression fallback in case a proxy buffers small stream chunks
    let stageReachedBank = false;
    const fallbackStageTimer = setTimeout(() => {
      if (!stageReachedBank && _isVerifying) {
        setVerifyingStage('checking_bank');
      }
    }, 1800);

    let finalStatus = 0;
    let finalData = null;

    try {
      const headers = { Accept: 'application/x-ndjson' };
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/verify/image?stream=1', {
        method: 'POST',
        headers,
        body: fd,
      });

      const contentType = (res.headers.get('content-type') || '').toLowerCase();

      if (contentType.includes('application/x-ndjson') && res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const evt = JSON.parse(trimmed);
              if (evt.stage === 'checking_bank') {
                stageReachedBank = true;
                setVerifyingStage('checking_bank');
              } else if (evt.done) {
                finalStatus = evt.httpStatus || 200;
                finalData = evt.result;
              }
            } catch (_) {}
          }
        }
        if (buffer.trim()) {
          try {
            const evt = JSON.parse(buffer.trim());
            if (evt.done) {
              finalStatus = evt.httpStatus || 200;
              finalData = evt.result;
            }
          } catch (_) {}
        }
      } else {
        finalStatus = res.status;
        finalData = await res.json().catch(() => null);
      }

      clearTimeout(fallbackStageTimer);

      if (!finalData) {
        throw new Error('Empty response');
      }

      setVerifyingStage('done');
      await new Promise((r) => setTimeout(r, 180));

      window.closeCameraScanner();

      if (!finalData.status && (finalStatus >= 400 || finalData.error)) {
        const friendlyErr = finalData?.error || 'Could not verify receipt right now. Please try again.';
        safeToast('❌ ' + friendlyErr);
        if (typeof renderVerifyResult === 'function') {
          renderVerifyResult({ status: 'FAILED', message: friendlyErr });
        }
        return;
      }

      if (typeof renderVerifyResult === 'function') {
        renderVerifyResult(finalData);
      }
    } catch (_) {
      clearTimeout(fallbackStageTimer);
      window.closeCameraScanner();
      const friendlyMsg = 'Could not reach the verification server. Please check your internet connection and try again.';
      safeToast('❌ ' + friendlyMsg);
      if (typeof renderVerifyResult === 'function') {
        renderVerifyResult({ status: 'FAILED', message: friendlyMsg });
      }
    } finally {
      _isVerifying = false;
      clearCapturedPhoto();
      if (verifyBtn) verifyBtn.disabled = false;
      if (retakeBtn) retakeBtn.disabled = false;
    }
  };

  // ── Background & Unload Safety Hooks ───────────────────────────────────────
  function handleAppBackground() {
    clearTimeout(_resumeTimer);
    if (!isModalOpen()) return;
    if (_stream) {
      stopScannerCamera();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      handleAppBackground();
      return;
    }

    // Small delay allows OS file picker onchange to fire first before checking camera resume
    clearTimeout(_resumeTimer);
    _resumeTimer = setTimeout(() => {
      _pickingNativeFile = false;
      const errVisible = Boolean(el('scanner-error-box')?.classList.contains('show'));
      if (isModalOpen() && _currentStep === 'camera' && !_isVerifying && !_processingNativeFile && !_stream && !errVisible) {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          startScannerCamera(_facingMode);
        }
      }
    }, 320);
  });

  window.addEventListener('pagehide', () => {
    stopScannerCamera();
    clearCapturedPhoto();
  });

  try {
    window.Telegram?.WebApp?.onEvent?.('deactivated', handleAppBackground);
  } catch (_) {}
})();
