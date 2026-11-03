/* shot —— 摄像头变焦测试前端 */
(function () {
  'use strict';

  var VERSION = '1.0';
  var ZOOMS = [0.5, 1, 2, 3, 5];

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var stage = $('stage');
  var placeholder = $('placeholder');
  var badge = $('badge');
  var hud = $('hud');
  var envList = $('envList');
  var logView = $('logView');
  var logCount = $('logCount');
  var uploadState = $('uploadState');
  var deviceSelect = $('deviceSelect');
  var btnStart = $('btnStart');
  var btnStop = $('btnStop');
  var btnShot = $('btnShot');
  var btnAuto = $('btnAuto');
  var btnUploadLog = $('btnUploadLog');
  var btnDownloadLog = $('btnDownloadLog');
  var btnCopyEnv = $('btnCopyEnv');

  var state = {
    session: newId(),
    stream: null,
    track: null,
    caps: null,
    settings: null,
    devices: [],
    nativeRange: null,
    nativeApplied: false,
    digital: 1,
    currentZoom: null,
    buffer: [],
    pendingFrames: [],
    sending: false,
    uploaded: 0,
    busy: false
  };

  function newId() {
    var rnd = Math.random().toString(36).slice(2, 8);
    return 's' + Date.now().toString(36) + '-' + rnd;
  }

  function nowISO() { return new Date().toISOString(); }
  function hms(d) {
    d = d || new Date();
    function p(n, l) { return String(n).padStart(l || 2, '0'); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------------- 日志 ---------------- */
  function log(type, data) {
    var entry = { t: nowISO(), type: type };
    if (data && typeof data === 'object') {
      Object.keys(data).forEach(function (k) { entry[k] = data[k]; });
    }
    state.buffer.push(entry);
    renderLog(entry);
    return entry;
  }

  function renderLog(entry) {
    var line = document.createElement('div');
    var extra = {};
    Object.keys(entry).forEach(function (k) {
      if (k !== 't' && k !== 'type') extra[k] = entry[k];
    });
    var rest = '';
    try {
      var s = JSON.stringify(extra);
      rest = (s === '{}') ? '' : ' ' + s;
    } catch (e) { rest = ' ' + String(extra); }
    line.textContent = '[' + hms(new Date(entry.t)) + '] ' + entry.type + rest;
    logView.appendChild(line);
    while (logView.childNodes.length > 600) logView.removeChild(logView.firstChild);
    logView.scrollTop = logView.scrollHeight;
    logCount.textContent = String(state.buffer.length + state.uploaded);
  }

  function updLoadState(text, cls) {
    uploadState.textContent = text;
    uploadState.className = cls || '';
  }

  function meta() {
    return {
      session: state.session,
      version: VERSION,
      ua: navigator.userAgent,
      href: location.href,
      zoomApplied: state.nativeApplied,
      digital: state.digital,
      currentZoom: state.currentZoom
    };
  }

  function flushLogs(useBeacon) {
    if (state.sending || !state.buffer.length) return Promise.resolve();
    state.sending = true;
    var batch = state.buffer.slice(0);
    var body = JSON.stringify({ session: state.session, meta: meta(), events: batch });

    var done = function (ok) {
      state.sending = false;
      if (ok) {
        state.buffer.splice(0, batch.length);
        state.uploaded += batch.length;
        updLoadState('已上传 ' + state.uploaded + ' 条日志', 'ok');
      } else {
        updLoadState('上传失败，稍后重试（' + state.buffer.length + ' 条待传）', 'err');
      }
      logCount.textContent = String(state.buffer.length + state.uploaded);
    };

    if (useBeacon && navigator.sendBeacon) {
      var blob = new Blob([body], { type: 'application/json' });
      var ok = navigator.sendBeacon('/api/log', blob);
      done(ok);
      return Promise.resolve();
    }

    return fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: body.length < 60000
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function () {
      done(true);
    }).catch(function (err) {
      done(false);
      if (state.buffer.length && state.buffer[0] && state.buffer[0].type !== 'upload.fail') {
        // 只记录一次，避免失败日志本身引发循环
        var e = { t: nowISO(), type: 'upload.fail', error: String(err) };
        state.buffer.unshift(e);
        renderLog(e);
      }
    });
  }

  function uploadFrame(blob, label, zoom) {
    if (!blob) return Promise.resolve(false);
    return fetch('/api/frame', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Session': state.session,
        'X-Label': label,
        'X-Zoom': String(zoom)
      },
      body: blob
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      log('frame.uploaded', { label: label, zoom: zoom, bytes: blob.size });
      return flushLogs(false).then(function () { return true; });
    }).catch(function (err) {
      state.pendingFrames.push({ blob: blob, label: label, zoom: zoom });
      log('frame.upload_fail', { label: label, error: String(err) });
      return false;
    });
  }

  /* ---------------- 环境信息 ---------------- */
  function safeSupportedConstraints() {
    try {
      var c = navigator.mediaDevices.getSupportedConstraints();
      var out = {};
      Object.keys(c).forEach(function (k) { if (c[k]) out[k] = true; });
      return out;
    } catch (e) { return { error: String(e) }; }
  }

  function snapshotEnv() {
    var uaData = null;
    try {
      if (navigator.userAgentData) {
        uaData = {
          brands: navigator.userAgentData.brands,
          mobile: navigator.userAgentData.mobile,
          platform: navigator.userAgentData.platform
        };
      }
    } catch (e) { }
    var env = {
      ua: navigator.userAgent,
      uaData: uaData,
      platform: navigator.platform || '',
      vendor: navigator.vendor || '',
      appVersion: (navigator.appVersion || '').slice(0, 80),
      language: navigator.language,
      languages: navigator.languages,
      isSecureContext: window.isSecureContext,
      protocol: location.protocol,
      host: location.host,
      mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      supportedConstraints: safeSupportedConstraints(),
      screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      cookieEnabled: navigator.cookieEnabled
    };
    return env;
  }

  function renderEnv(env, caps, settings) {
    var rows = [];
    function add(k, v) {
      var dt = document.createElement('dt'); dt.textContent = k;
      var dd = document.createElement('dd'); dd.textContent = (v === null || v === undefined || v === '') ? '—' : String(v);
      rows.push(dt, dd);
    }
    envList.innerHTML = '';
    add('安全上下文', env.isSecureContext ? '是（可调用摄像头）' : '否（HTTP 无法调用摄像头）');
    add('摄像头 API', env.mediaDevices ? '存在' : '不存在');
    add('UA', env.ua);
    if (env.uaData) add('UA 品牌', JSON.stringify(env.uaData.brands));
    add('平台', env.platform + ' / ' + env.vendor);
    add('屏幕', env.screen.w + '×' + env.screen.h + ' @' + env.screen.dpr + 'x');
    add('支持 zoom 约束', env.supportedConstraints && env.supportedConstraints.zoom ? '是' : '否');
    if (caps) {
      add('zoom 能力', caps.zoom ? ('min=' + caps.zoom.min + ' max=' + caps.zoom.max + ' step=' + caps.zoom.step) : '无（浏览器未暴露）');
      if (caps.torch !== undefined) add('闪光灯', String(caps.torch));
      if (caps.focusDistance) add('对焦距离', JSON.stringify(caps.focusDistance));
      if (caps.focusMode) add('对焦模式', JSON.stringify(caps.focusMode));
    }
    if (settings) {
      add('当前分辨率', settings.width + '×' + settings.height + ' @' + (settings.frameRate ? settings.frameRate.toFixed(1) : '?') + 'fps');
      add('当前 zoom', settings.zoom !== undefined ? settings.zoom : '未上报');
      add('facingMode', settings.facingMode || '未上报');
      add('deviceId', (settings.deviceId || '').slice(0, 16) || '未上报');
    }
    rows.forEach(function (n) { envList.appendChild(n); });
  }

  function setHud(text) {
    hud.hidden = !text;
    hud.textContent = text || '';
  }

  function setBadge(text, cls) {
    badge.textContent = text;
    badge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  /* ---------------- 摄像头 ---------------- */
  function listVideoInputs() {
    return navigator.mediaDevices.enumerateDevices().then(function (list) {
      return list.filter(function (d) { return d.kind === 'videoinput'; });
    });
  }

  function fillDevices(devices) {
    state.devices = devices;
    deviceSelect.innerHTML = '';
    if (!devices.length) {
      var o = document.createElement('option');
      o.textContent = '没有可用摄像头';
      deviceSelect.appendChild(o);
      deviceSelect.disabled = true;
      return;
    }
    devices.forEach(function (d, i) {
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || ('摄像头 ' + (i + 1));
      deviceSelect.appendChild(o);
    });
    var cur = state.track && state.track.getSettings ? state.track.getSettings().deviceId : null;
    if (cur) deviceSelect.value = cur;
    deviceSelect.disabled = false;
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } });
    }
    state.stream = null;
    state.track = null;
    video.srcObject = null;
    video.classList.remove('on');
    placeholder.style.display = '';
    setBadge('已停止', '');
    setHud('');
  }

  function startCamera(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var msg = window.isSecureContext
        ? '当前浏览器不支持 getUserMedia'
        : '当前页面不是安全上下文（HTTPS），浏览器禁止调用摄像头';
      log('camera.unavailable', { reason: msg, protocol: location.protocol, secure: window.isSecureContext });
      setBadge('无法调用摄像头', 'error');
      setHud(msg);
      flushLogs(false);
      return Promise.reject(new Error(msg));
    }

    var videoConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    };
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = { ideal: 'environment' };
    }

    log('camera.request', { constraints: videoConstraints, secure: window.isSecureContext });

    return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints })
      .then(function (stream) {
        stopStreamTracksOnly();
        state.stream = stream;
        state.track = stream.getVideoTracks()[0];
        video.srcObject = stream;
        video.classList.add('on');
        placeholder.style.display = 'none';
        setBadge('已开启摄像头', '');
        return video.play().catch(function () { });
      })
      .then(function () { return afterStream(deviceId); })
      .catch(function (err) {
        var name = err && err.name || 'Error';
        var map = {
          NotAllowedError: '摄像头权限被拒绝（请在地址栏/设置里允许相机权限后重试）',
          PermissionDeniedError: '摄像头权限被拒绝',
          NotFoundError: '没有找到可用摄像头',
          DevicesNotFoundError: '没有找到可用摄像头',
          NotReadableError: '摄像头被其他应用占用（请关闭相机/微信视频等后重试）',
          TrackStartError: '摄像头启动失败（可能被占用）',
          OverconstrainedError: '设备不支持请求的约束条件：' + (err.constraint || ''),
          ConstraintNotSatisfiedError: '设备不支持请求的约束条件',
          SecurityError: '安全策略禁止调用摄像头',
          TypeError: '浏览器不支持调用摄像头（可能不是 HTTPS）'
        };
        var msg = map[name] || ('打开摄像头失败：' + name + ' ' + (err && err.message || ''));
        log('camera.error', {
          name: name, message: err && err.message, constraint: err && err.constraint,
          secure: window.isSecureContext, protocol: location.protocol
        });
        setBadge('打开失败', 'error');
        setHud(msg);
        flushLogs(false);
        throw err;
      });
  }

  function stopStreamTracksOnly() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } });
    }
  }

  function afterStream(deviceId) {
    var track = state.track;
    var caps = {}, settings = {};
    try { caps = track.getCapabilities ? (track.getCapabilities() || {}) : {}; }
    catch (e) { log('camera.getCapabilities.error', { error: String(e) }); }
    try { settings = track.getSettings ? (track.getSettings() || {}) : {}; }
    catch (e) { log('camera.getSettings.error', { error: String(e) }); }

    state.caps = caps;
    state.settings = settings;
    state.nativeRange = caps.zoom || null;
    state.nativeApplied = false;
    state.digital = 1;
    state.currentZoom = settings.zoom !== undefined ? settings.zoom : null;
    video.style.transform = '';

    log('camera.started', {
      deviceId: (settings.deviceId || '').slice(0, 24),
      facingMode: settings.facingMode,
      width: settings.width, height: settings.height, frameRate: settings.frameRate,
      zoomCapability: caps.zoom || null,
      capabilities: summarizeCaps(caps),
      supportedConstraints: safeSupportedConstraints(),
      secure: window.isSecureContext
    });

    renderEnv(snapshotEnv(), caps, settings);
    setHud([
      settings.width + '×' + settings.height,
      'zoom ' + (caps.zoom ? (caps.zoom.min + '~' + caps.zoom.max) : '不支持'),
      'device ' + (state.devices.length || '?')
    ].join(' · '));

    if (!caps.zoom) {
      setBadge('浏览器未暴露 zoom', 'digital');
      log('zoom.unsupported', { reason: 'getCapabilities() 没有 zoom 字段' });
    } else if (caps.zoom.min >= 1) {
      log('zoom.no_wide', { min: caps.zoom.min, max: caps.zoom.max, note: '最小倍率 >= 1，预计无法使用 0.5x' });
    }

    return listVideoInputs().then(function (devs) {
      fillDevices(devs);
      log('devices.list', {
        count: devs.length,
        devices: devs.map(function (d, i) { return { i: i, label: d.label, id: (d.deviceId || '').slice(0, 16) }; })
      });
      flushLogs(false);
    }).catch(function () { });
  }

  function summarizeCaps(caps) {
    var out = {};
    Object.keys(caps || {}).forEach(function (k) {
      var v = caps[k];
      if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
      else if (Array.isArray(v)) out[k] = v.slice(0, 6);
      else if (typeof v === 'object') out[k] = { min: v.min, max: v.max, step: v.step };
    });
    return out;
  }

  function readSettings() {
    try { return state.track ? (state.track.getSettings() || {}) : {}; }
    catch (e) { return {}; }
  }

  /* ---------------- 变焦 ---------------- */
  function applyZoom(z) {
    return new Promise(function (resolve) {
      if (!state.track) {
        log('zoom.no_track', { z: z });
        resolve({ requested: z, ok: false, reason: 'no_track' });
        return;
      }
      var before = readSettings();
      var caps = state.caps || {};
      var range = caps.zoom || null;
      var req = Number(z);
      var result = { requested: req, nativeApplied: false, digital: 1, confirmed: null };

      log('zoom.request', {
        z: req,
        nativeRange: range ? { min: range.min, max: range.max, step: range.step } : null,
        beforeZoom: before.zoom === undefined ? null : before.zoom
      });

      var viable = range && req >= (range.min - 1e-6) && req <= (range.max + 1e-6);

      var onDone = function (nativeZoom, errors) {
        if (nativeZoom !== null) {
          result.nativeApplied = true;
          result.confirmed = nativeZoom;
          result.digital = 1;
          state.nativeApplied = true;
          state.digital = 1;
          video.style.transform = '';
          setBadge('原生 ' + nativeZoom + 'x', 'native');
        } else {
          // 数码变焦兜底：只裁剪画面，画质会下降
          var base = (before.zoom && before.zoom > 0) ? before.zoom : 1;
          var k = req / base;
          if (k < 1) k = 1;
          result.digital = k;
          result.nativeApplied = false;
          state.nativeApplied = false;
          state.digital = k;
          video.style.transform = k > 1.001 ? 'scale(' + k.toFixed(4) + ')' : '';
          setBadge(k > 1.001 ? ('数码 ' + req + 'x（非原生）') : '不支持 ' + req + 'x', k > 1.001 ? 'digital' : 'error');
        }
        state.currentZoom = req;
        result.errors = errors;
        log('zoom.result', {
          requested: req,
          native: result.nativeApplied,
          confirmed: result.confirmed,
          digital: Number(result.digital.toFixed(3)),
          errors: errors
        });
        markZoomButton(req, result);
        flushLogs(false);
        resolve(result);
      };

      if (!viable) {
        if (range) {
          log('zoom.out_of_range', { z: req, min: range.min, max: range.max });
        } else {
          log('zoom.unavailable', { z: req, note: '该浏览器/设备未提供 zoom 能力' });
        }
        onDone(null, []);
        return;
      }

      // 先试标准写法，再试 advanced 写法（部分安卓实现只认后者）
      state.track.applyConstraints({ zoom: req }).then(function () {
        var s = readSettings();
        log('zoom.apply_ok', { constraints: { zoom: req }, after: { zoom: s.zoom } });
        if (typeof s.zoom === 'number' && Math.abs(s.zoom - req) <= Math.max(0.05, (range.step || 0.05) / 2)) {
          onDone(s.zoom, []);
        } else {
          state.track.applyConstraints({ advanced: [{ zoom: req }] }).then(function () {
            var s2 = readSettings();
            log('zoom.apply_ok', { constraints: { advanced: [{ zoom: req }] }, after: { zoom: s2.zoom } });
            if (typeof s2.zoom === 'number' && Math.abs(s2.zoom - req) <= Math.max(0.05, (range.step || 0.05) / 2)) {
              onDone(s2.zoom, []);
            } else {
              onDone(null, [{ note: '两次调用均未生效', after: s2.zoom === undefined ? null : s2.zoom }]);
            }
          }).catch(function (err) {
            log('zoom.apply_err', { constraints: { advanced: [{ zoom: req }] }, name: err && err.name, message: err && err.message });
            onDone(null, [{ name: err && err.name, message: err && err.message }]);
          });
        }
      }).catch(function (err) {
        log('zoom.apply_err', { constraints: { zoom: req }, name: err && err.name, message: err && err.message });
        state.track.applyConstraints({ advanced: [{ zoom: req }] }).then(function () {
          var s = readSettings();
          log('zoom.apply_ok', { constraints: { advanced: [{ zoom: req }] }, after: { zoom: s.zoom } });
          if (typeof s.zoom === 'number' && Math.abs(s.zoom - req) <= Math.max(0.05, (range.step || 0.05) / 2)) {
            onDone(s.zoom, []);
          } else {
            onDone(null, [{ name: err && err.name, message: err && err.message, note: 'advanced 调用成功但未生效' }]);
          }
        }).catch(function (err2) {
          log('zoom.apply_err', { constraints: { advanced: [{ zoom: req }] }, name: err2 && err2.name, message: err2 && err2.message });
          onDone(null, [
            { name: err && err.name, message: err && err.message },
            { name: err2 && err2.name, message: err2 && err2.message }
          ]);
        });
      });
    });
  }

  function markZoomButton(z, result) {
    var btn = document.querySelector('.zoom[data-zoom="' + z + '"]');
    if (!btn) return;
    Array.prototype.forEach.call(document.querySelectorAll('.zoom'), function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    btn.classList.remove('ok', 'fail', 'digital');
    if (result && result.nativeApplied) btn.classList.add('ok');
    else if (result && result.requested <= 1.001 && !result.nativeApplied && result.digital <= 1.001) btn.classList.add('ok');
    else if (result && result.digital > 1.001) btn.classList.add('digital');
    else btn.classList.add('fail');
  }

  /* ---------------- 拍照 ---------------- */
  function captureFrame() {
    if (!state.track || !video.videoWidth) return Promise.resolve(null);
    var vw = video.videoWidth, vh = video.videoHeight;
    var k = Math.max(1, state.digital || 1);
    var sw = Math.floor(vw / k), sh = Math.floor(vh / k);
    var sx = Math.floor((vw - sw) / 2), sy = Math.floor((vh - sh) / 2);
    var canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    var ctx = canvas.getContext('2d');
    try { ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh); }
    catch (e) { log('frame.error', { error: String(e) }); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.88);
    });
  }

  function shoot(label, zoom) {
    return captureFrame().then(function (blob) {
      if (!blob) return false;
      return uploadFrame(blob, label, zoom === undefined ? (state.currentZoom || 1) : zoom);
    });
  }

  /* ---------------- 交互 ---------------- */
  function setBusy(b) {
    state.busy = b;
    btnAuto.disabled = b || !state.track;
    btnShot.disabled = b || !state.track;
    btnStart.disabled = b;
  }

  function start() {
    if (state.busy) return;
    setBusy(true);
    log('session.start', snapshotEnv());
    startCamera(null).then(function () {
      btnStart.hidden = true;
      btnStop.hidden = false;
      btnAuto.disabled = false;
      btnShot.disabled = false;
      setBusy(false);
      return applyZoom(1);
    }).catch(function () {
      setBusy(false);
    });
  }

  function stop() {
    log('session.stop', { zoom: state.currentZoom });
    flushLogs(false).then(function () {
      stopStream();
      btnStart.hidden = false;
      btnStop.hidden = true;
      btnAuto.disabled = true;
      btnShot.disabled = true;
      setBadge('已停止', '');
    });
  }

  function autoRun() {
    if (state.busy || !state.track) return;
    setBusy(true);
    log('auto.start', { zooms: ZOOMS });
    var chain = Promise.resolve();
    ZOOMS.forEach(function (z) {
      chain = chain.then(function () {
        return applyZoom(z).then(function () {
          return sleep(1000);
        }).then(function () {
          return shoot('zoom-' + z, z);
        }).then(function () {
          return sleep(250);
        });
      });
    });
    chain.then(function () {
      log('auto.done', {});
      setBusy(false);
      return flushLogs(false);
    }).catch(function (e) {
      log('auto.error', { error: String(e) });
      setBusy(false);
    });
  }

  function bind() {
    btnStart.addEventListener('click', start);
    btnStop.addEventListener('click', stop);
    btnShot.addEventListener('click', function () {
      shoot('manual', state.currentZoom || 1).then(function (ok) {
        setBadge(ok ? '照片已保存' : '照片保存失败', ok ? 'native' : 'error');
      });
    });
    btnAuto.addEventListener('click', autoRun);

    Array.prototype.forEach.call(document.querySelectorAll('.zoom'), function (btn) {
      btn.addEventListener('click', function () {
        if (!state.track || state.busy) {
          setBadge('请先开始测试', 'error');
          return;
        }
        applyZoom(parseFloat(btn.dataset.zoom));
      });
    });

    deviceSelect.addEventListener('change', function () {
      var id = deviceSelect.value;
      if (!state.track || !id) return;
      log('camera.switch', { deviceId: id.slice(0, 16) });
      stopStreamTracksOnly();
      state.digital = 1;
      state.nativeApplied = false;
      video.style.transform = '';
      startCamera(id).catch(function () { });
    });

    btnUploadLog.addEventListener('click', function () {
      flushLogs(false).then(function () {
        state.pendingFrames.slice(0).forEach(function (f) {
          uploadFrame(f.blob, f.label, f.zoom).then(function (ok) {
            if (ok) state.pendingFrames.shift();
          });
        });
      });
    });

    btnDownloadLog.addEventListener('click', function () {
      var data = JSON.stringify({ session: state.session, meta: meta(), env: snapshotEnv(), events: state.buffer }, null, 2);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shot-' + state.session + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });

    btnCopyEnv.addEventListener('click', function (e) {
      e.preventDefault();
      var text = envList.innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { setBadge('已复制诊断信息', 'native'); });
      }
    });

    window.addEventListener('pagehide', function () { flushLogs(true); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushLogs(true);
    });

    setInterval(function () {
      if (state.buffer.length) flushLogs(false);
      if (state.pendingFrames.length) {
        var f = state.pendingFrames[0];
        uploadFrame(f.blob, f.label, f.zoom).then(function (ok) { if (ok) state.pendingFrames.shift(); });
      }
    }, 8000);
  }

  function init() {
    $('sessionId').textContent = state.session;
    var env = snapshotEnv();
    renderEnv(env, null, null);
    log('page.load', env);
    if (!env.mediaDevices) {
      setBadge('浏览器不支持摄像头 API', 'error');
      setHud(env.isSecureContext ? '未找到 mediaDevices' : '请使用 HTTPS 打开本页');
    }
    bind();
    flushLogs(false);
    // 自动化验证用：?auto=1 时自动开始
    if (/[?&]auto=1/.test(location.search)) {
      setTimeout(function () { start(); }, 400);
    }
  }

  init();
})();
