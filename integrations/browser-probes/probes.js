(function () {
  'use strict';

  var catalog = [];
  var selected = '';
  var latest = null;
  var list = document.getElementById('probes');
  var description = document.getElementById('description');
  var status = document.getElementById('status');
  var results = document.getElementById('results');
  var runButton = document.getElementById('run');
  var copyButton = document.getElementById('copy');

  function request(method, url, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.timeout = 5000;
      if (body) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('HTTP ' + xhr.status));
          return;
        }
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (error) { reject(error); }
      };
      xhr.onerror = function () { reject(new Error('Local request failed')); };
      xhr.ontimeout = function () { reject(new Error('Local request timed out')); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function tryValue(fn) {
    try { return fn(); }
    catch (error) { return 'error: ' + String(error && error.message || error).slice(0, 160); }
  }

  function measureFonts() {
    var canvas = document.createElement('canvas');
    var context = canvas.getContext && canvas.getContext('2d');
    if (!context) return {canvas: false};
    var families = ['serif', 'sans-serif', 'monospace', 'cursive'];
    var widths = {};
    families.forEach(function (family) {
      context.font = '24px ' + family;
      widths[family] = Math.round(context.measureText('mac2jb 0123456789').width * 100) / 100;
    });
    return widths;
  }

  function probeRuntime() {
    var ticks = [];
    if (window.performance && typeof performance.now === 'function') {
      for (var i = 0; i < 8; i++) ticks.push(performance.now());
    }
    return {
      userAgent: String(navigator.userAgent || '').slice(0, 300),
      language: String(navigator.language || ''),
      languages: Array.prototype.slice.call(navigator.languages || [], 0, 8),
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      javascript: {promise: typeof Promise, typedArray: typeof Uint8Array,
        webAssembly: typeof WebAssembly, bigInt: typeof BigInt},
      timingSamplesMs: ticks
    };
  }

  function probeMedia() {
    var video = document.createElement('video');
    var audio = document.createElement('audio');
    return {
      videoElement: !!video,
      audioElement: !!audio,
      h264: tryValue(function () { return video.canPlayType('video/mp4; codecs="avc1.42E01E"'); }),
      webm: tryValue(function () { return video.canPlayType('video/webm; codecs="vp8"'); }),
      aac: tryValue(function () { return audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'); }),
      ogg: tryValue(function () { return audio.canPlayType('audio/ogg; codecs="vorbis"'); }),
      audioContext: typeof (window.AudioContext || window.webkitAudioContext),
      mediaRecorder: typeof window.MediaRecorder,
      mediaDevices: !!navigator.mediaDevices
    };
  }

  function probeNetwork() {
    var started = Date.now();
    return request('GET', './ping?stamp=' + started).then(function (value) {
      return {localRequest: value.ok === true, roundTripMs: Date.now() - started,
        online: navigator.onLine, fetch: typeof window.fetch,
        webSocket: typeof window.WebSocket,
        sendBeacon: !!(navigator.sendBeacon)};
    }).catch(function (error) {
      return {localRequest: false, error: String(error.message).slice(0, 160),
        online: navigator.onLine, fetch: typeof window.fetch,
        webSocket: typeof window.WebSocket};
    });
  }

  function probeBoundaries() {
    var length = 256 * 1024;
    var bytes = new Uint8Array(length);
    var checksum = 0;
    for (var i = 0; i < length; i += 1024) {
      bytes[i] = i / 1024 & 255;
      checksum = checksum + bytes[i] & 65535;
    }
    return {
      allocatedBytes: bytes.byteLength,
      sampledChecksum: checksum,
      textEncoder: typeof window.TextEncoder,
      structuredClone: typeof window.structuredClone,
      jsonRoundTrip: tryValue(function () {
        return JSON.parse(JSON.stringify({value: [1, 2, 3]})).value.join(',');
      })
    };
  }

  function probeFonts() {
    return {
      fontFace: typeof window.FontFace,
      fontFaceSet: !!document.fonts,
      fontStatus: document.fonts ? document.fonts.status : null,
      canvasTextWidths: tryValue(measureFonts)
    };
  }

  function probeWebkit() {
    var canvas = document.createElement('canvas');
    return {
      cssGrid: tryValue(function () { return !!window.CSS && CSS.supports('display', 'grid'); }),
      cssBackdropFilter: tryValue(function () { return !!window.CSS && CSS.supports('backdrop-filter', 'blur(1px)'); }),
      webgl: tryValue(function () { return !!canvas.getContext('webgl'); }),
      offscreenCanvas: typeof window.OffscreenCanvas,
      webGpu: !!navigator.gpu,
      serviceWorker: !!navigator.serviceWorker,
      webAssembly: typeof window.WebAssembly,
      touchPoints: navigator.maxTouchPoints || 0
    };
  }

  function probeFontEnvironment() {
    return {
      genericTextWidths: tryValue(measureFonts),
      documentFonts: !!document.fonts,
      genericChecks: tryValue(function () {
        if (!document.fonts || typeof document.fonts.check !== 'function') return null;
        var values = {};
        ['serif', 'sans-serif', 'monospace'].forEach(function (family) {
          values[family] = document.fonts.check('16px ' + family);
        });
        return values;
      })
    };
  }

  var handlers = {
    runtime: probeRuntime,
    media: probeMedia,
    network: probeNetwork,
    boundaries: probeBoundaries,
    fonts: probeFonts,
    webkit: probeWebkit,
    fontenv: probeFontEnvironment
  };

  function select(id) {
    if (!catalog.some(function (item) { return item.id === id; })) return;
    selected = id;
    latest = null;
    results.textContent = '';
    copyButton.disabled = true;
    status.textContent = 'Run the selected probe on this browser';
    Array.prototype.forEach.call(list.children, function (button) {
      button.setAttribute('aria-pressed', button.dataset.probe === id ? 'true' : 'false');
    });
    var item = catalog.filter(function (entry) { return entry.id === id; })[0];
    description.textContent = item.description;
  }

  function displayCatalog(items) {
    catalog = items;
    items.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'probe';
      button.dataset.probe = item.id;
      button.textContent = item.title;
      button.addEventListener('click', function () { select(item.id); });
      list.appendChild(button);
    });
    var requested = typeof URLSearchParams === 'function'
      ? new URLSearchParams(window.location.search).get('probe') : '';
    select(items.some(function (item) { return item.id === requested; }) ? requested : items[0].id);
  }

  runButton.addEventListener('click', function () {
    if (!handlers[selected]) return;
    var running = selected;
    runButton.disabled = true;
    copyButton.disabled = true;
    Array.prototype.forEach.call(list.children, function (button) { button.disabled = true; });
    status.textContent = 'Running ' + running + '…';
    Promise.resolve().then(handlers[running]).then(function (value) {
      latest = {probe: running, timestamp: new Date().toISOString(),
        userAgent: String(navigator.userAgent || '').slice(0, 300), result: value};
      results.textContent = JSON.stringify(latest, null, 2);
      copyButton.disabled = false;
      return request('POST', './report', latest).then(function () {
        status.textContent = 'Complete · report saved on your Mac';
      }, function (error) {
        status.textContent = 'Complete · report could not be saved: ' + error.message;
      });
    }).catch(function (error) {
      status.textContent = 'Probe failed: ' + String(error.message).slice(0, 160);
    }).then(function () {
      runButton.disabled = false;
      Array.prototype.forEach.call(list.children, function (button) { button.disabled = false; });
    });
  });

  copyButton.addEventListener('click', function () {
    if (!latest) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(JSON.stringify(latest, null, 2)).then(function () {
        status.textContent = 'Results copied';
      }, function () {
        status.textContent = 'Copy was blocked by this browser';
      });
    }
  });

  request('GET', './manifest.json').then(function (manifest) {
    if (!manifest || !Array.isArray(manifest.probes) || manifest.probes.length !== 7)
      throw new Error('Probe catalog is invalid');
    displayCatalog(manifest.probes);
  }).catch(function (error) {
    status.textContent = 'Could not load local probes: ' + String(error.message).slice(0, 160);
    runButton.disabled = true;
  });
}());
