(function () {
  'use strict';
  var modules = window.SwitchProbeModules = window.SwitchProbeModules || [];
  function record(id, status, details) { return { id: id, status: status, details: details || {} }; }
  function exception(error) { return error && typeof error.name === 'string' ? error.name.slice(0, 64) : 'Error'; }
  function check(id, action, milliseconds) {
    return new Promise(function (resolve) {
      var finished = false, cleanup = function () {};
      var timer = setTimeout(function () { finish('timeout', { limitMs: milliseconds || 1300 }); }, milliseconds || 1300);
      function finish(status, details) {
        if (finished) { return; }
        finished = true;
        clearTimeout(timer);
        try { cleanup(); } catch (ignored) {}
        resolve(record(id, status, details));
      }
      try {
        action(finish, function (callback) { cleanup = callback; });
      } catch (error) {
        finish(exception(error) === 'SecurityError' || exception(error) === 'NotAllowedError' ? 'blocked' : 'failed', { error: exception(error) });
      }
    });
  }
  function canvasCheck(done) {
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    var context = canvas.getContext('2d');
    if (!context) { done('unsupported', { canvas2d: false }); return; }
    context.save(); context.translate(1, 1); context.fillStyle = 'rgb(24,120,210)';
    context.beginPath(); context.rect(0, 0, 2, 2); context.fill(); context.restore();
    var pixel = context.getImageData(1, 1, 1, 1).data;
    var result = { pixelReadback: pixel[0] === 24 && pixel[1] === 120 && pixel[2] === 210 && pixel[3] === 255,
      createImageDataBytes: context.createImageData(1, 1).data.length,
      path2dConstructor: typeof window.Path2D === 'function', imageDataConstructor: typeof window.ImageData === 'function',
      drawImage: typeof context.drawImage === 'function', setTransform: typeof context.setTransform === 'function',
      ellipse: typeof context.ellipse === 'function', getTransform: typeof context.getTransform === 'function',
      offscreenCanvasConstructor: typeof window.OffscreenCanvas === 'function',
      webglConstructor: typeof window.WebGLRenderingContext !== 'undefined',
      webgl2Constructor: typeof window.WebGL2RenderingContext !== 'undefined' };
    canvas.width = canvas.height = 0;
    done(result.pixelReadback ? 'passed' : 'failed', result);
  }
  function imageCheck(id, uri, expected) {
    return check(id, function (done, onCleanup) {
      var image = new Image(), canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      onCleanup(function () { image.onload = image.onerror = null; image.src = 'data:,'; canvas.width = canvas.height = 0; });
      image.onerror = function () { done('failed', { decoded: false }); };
      image.onload = function () {
        try {
          var context = canvas.getContext('2d');
          if (!context) { done('not-tested', { decoded: true, canvas2d: false }); return; }
          context.drawImage(image, 0, 0, 2, 2);
          var pixel = context.getImageData(0, 0, 1, 1).data;
          var matches = !expected || (pixel[0] === expected[0] && pixel[1] === expected[1] && pixel[2] === expected[2] && pixel[3] === expected[3]);
          done(matches ? 'passed' : 'failed', { decoded: true, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height,
            pixelReadback: true, expectedColorMatched: expected ? matches : null });
        } catch (error) { done(exception(error) === 'SecurityError' ? 'blocked' : 'failed', { decoded: true, error: exception(error) }); }
      };
      image.src = uri;
    });
  }
  function domCheck(done) {
    if (typeof window.DOMParser !== 'function') { done('unsupported', { domParser: false }); return; }
    var parser = new DOMParser();
    var xml = parser.parseFromString('<probe><item>ok</item></probe>', 'application/xml');
    var html = parser.parseFromString('<!doctype html><html><body><p id="probe">ok</p></body></html>', 'text/html');
    var svg = parser.parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', 'image/svg+xml');
    var values = { xml: xml.documentElement.nodeName === 'probe' && xml.getElementsByTagName('item').length === 1,
      html: !!html.getElementById('probe'), svg: svg.documentElement.nodeName === 'svg' && svg.getElementsByTagName('rect').length === 1,
      xmlSerializer: typeof window.XMLSerializer === 'function', xpath: typeof document.evaluate === 'function',
      mutationObserver: typeof window.MutationObserver === 'function', resizeObserver: typeof window.ResizeObserver === 'function',
      intersectionObserver: typeof window.IntersectionObserver === 'function', shadowDom: typeof document.createElement('div').attachShadow === 'function' };
    done(values.xml && values.html && values.svg ? 'passed' : 'failed', values);
  }
  function cssCheck(done) {
    if (!window.CSS || typeof window.CSS.supports !== 'function') { done('unsupported', { cssSupports: false }); return; }
    var cases = [['display', 'flex'], ['display', 'grid'], ['transform', 'translateX(1px)'], ['color', 'var(--probe)'],
      ['touch-action', 'none'], ['position', 'sticky'], ['contain', 'layout'], ['color', 'color(display-p3 1 0 0)']];
    var results = [];
    for (var i = 0; i < cases.length; i += 1) { results.push({ property: cases[i][0], value: cases[i][1], supported: CSS.supports(cases[i][0], cases[i][1]) }); }
    done('passed', { scope: 'CSS.supports responses; layout and acceleration not inferred', values: results });
  }
  function svgAnimation(done, onCleanup) {
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    var rectangle = document.createElementNS(ns, 'rect'), animate = document.createElementNS(ns, 'animate');
    if (typeof animate.beginElement !== 'function') { done('unsupported', { beginElement: false }); return; }
    var timer = null;
    onCleanup(function () { if (timer !== null) { clearTimeout(timer); } if (svg.parentNode) { svg.parentNode.removeChild(svg); } });
    svg.setAttribute('width', '2'); svg.setAttribute('height', '2');
    svg.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    rectangle.setAttribute('x', '0'); rectangle.setAttribute('y', '0'); rectangle.setAttribute('width', '1'); rectangle.setAttribute('height', '1');
    animate.setAttribute('attributeName', 'x'); animate.setAttribute('from', '0'); animate.setAttribute('to', '1');
    animate.setAttribute('dur', '0.1s'); animate.setAttribute('repeatCount', '1'); animate.setAttribute('begin', 'indefinite'); animate.setAttribute('fill', 'freeze');
    rectangle.appendChild(animate); svg.appendChild(rectangle); document.body.appendChild(svg);
    animate.beginElement();
    timer = setTimeout(function () {
      try {
        var value = rectangle.x && rectangle.x.animVal ? rectangle.x.animVal.value : null;
        var progressed = typeof value === 'number' && value > 0 && value <= 1;
        done(progressed ? 'passed' : 'not-tested', { beginElementCallable: true, sampledX: value,
          scope: 'One 0.1-second animation; no timeline seeking', visibility: typeof document.visibilityState === 'string' ? document.visibilityState : null,
          note: progressed ? 'Normal animation progressed' : 'No progress observed in bounded sample; background throttling is possible' });
      } catch (error) { done('failed', { error: exception(error) }); }
    }, 220);
  }
  function codecs(done) {
    var audio = document.createElement('audio'), video = document.createElement('video');
    var audioTypes = ['audio/wav; codecs="1"', 'audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"', 'audio/ogg; codecs="vorbis"', 'audio/ogg; codecs="opus"'];
    var videoTypes = ['video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs="vp8"', 'video/webm; codecs="vp9"', 'application/vnd.apple.mpegurl'];
    var results = { audio: [], video: [], mediaSource: typeof window.MediaSource !== 'undefined',
      encryptedMediaAPI: typeof navigator.requestMediaKeySystemAccess === 'function',
      scope: 'canPlayType declarations only; no decoder, network stream, DRM session or playback is attempted' };
    var i;
    for (i = 0; i < audioTypes.length; i += 1) { results.audio.push({ mime: audioTypes[i], response: typeof audio.canPlayType === 'function' ? audio.canPlayType(audioTypes[i]) : null }); }
    for (i = 0; i < videoTypes.length; i += 1) { results.video.push({ mime: videoTypes[i], response: typeof video.canPlayType === 'function' ? video.canPlayType(videoTypes[i]) : null }); }
    done(typeof audio.canPlayType === 'function' || typeof video.canPlayType === 'function' ? 'supported' : 'unsupported', results);
  }
  function audioContextCheck(done, onCleanup) {
    var Constructor = window.AudioContext || window.webkitAudioContext;
    if (typeof Constructor !== 'function') { done('unsupported', { audioContext: false }); return; }
    if (!Constructor.prototype || typeof Constructor.prototype.close !== 'function') {
      done('not-tested', { constructor: true, closeSupported: false, scope: 'No instance created because explicit close is unavailable' }); return;
    }
    var audio = new Constructor(), closeAttempts = 0;
    function cleanup() { if (audio.state !== 'closed' && closeAttempts < 2) { closeAttempts += 1; try { var p = audio.close(); if (p && p.catch) { p.catch(function () {}); } } catch (ignored) {} } }
    onCleanup(cleanup);
    var details = { constructor: true, initialState: typeof audio.state === 'string' ? audio.state : null,
      sampleRate: audio.sampleRate, createBuffer: typeof audio.createBuffer === 'function', audioWorkletPresence: !!audio.audioWorklet,
      closeSupported: typeof audio.close === 'function', scope: 'Construction and close only; no audible nodes or microphone permission' };
    if (typeof audio.close !== 'function') { done('supported', details); return; }
    closeAttempts += 1;
    var closed = audio.close();
    if (closed && typeof closed.then === 'function') { closed.then(function () { details.closeCompleted = true; done('passed', details); }, function (error) { done('blocked', { error: exception(error), scope: details.scope }); }); }
    else { details.closeCompleted = true; done('passed', details); }
  }
  function offlineAudio(done, onCleanup) {
    var Constructor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (typeof Constructor !== 'function') { done('unsupported', { offlineAudioContext: false }); return; }
    var audio = new Constructor(1, 512, 44100), source = audio.createBufferSource();
    var buffer = audio.createBuffer(1, 512, 44100), samples = buffer.getChannelData(0);
    for (var i = 0; i < 512; i += 1) { samples[i] = i % 2 ? -0.125 : 0.125; }
    source.buffer = buffer; source.connect(audio.destination);
    onCleanup(function () { audio.oncomplete = null; try { source.disconnect(); } catch (ignored) {} });
    function complete(rendered) {
      var data = rendered.getChannelData(0);
      var passed = rendered.length === 512 && Math.abs(data[0] - 0.125) < 0.00001 && Math.abs(data[1] + 0.125) < 0.00001;
      done(passed ? 'passed' : 'failed', { frames: rendered.length, channels: rendered.numberOfChannels, sampleRate: rendered.sampleRate,
        sampleRoundtrip: passed, scope: '512 offline frames; no speaker output' });
    }
    audio.oncomplete = function (event) { try { complete(event.renderedBuffer); } catch (error) { done('failed', { error: exception(error) }); } };
    source.start(0);
    var rendering = audio.startRendering();
    if (rendering && typeof rendering.then === 'function') { rendering.then(function (result) { try { complete(result); } catch (error) { done('failed', { error: exception(error) }); } }, function (error) { done('blocked', { error: exception(error) }); }); }
  }
  function devices(done) {
    var media = navigator.mediaDevices;
    var result = { scope: 'Presence only; no permission requests, paired-device enumeration or sensor starts',
      secureContext: typeof window.isSecureContext === 'boolean' ? window.isSecureContext : null,
      mediaDevices: !!media, getUserMedia: !!media && typeof media.getUserMedia === 'function',
      enumerateDevices: !!media && typeof media.enumerateDevices === 'function', legacyGetUserMedia: typeof navigator.webkitGetUserMedia === 'function',
      usb: !!navigator.usb, hid: !!navigator.hid, bluetooth: !!navigator.bluetooth, serial: !!navigator.serial,
      geolocation: !!navigator.geolocation, clipboard: !!navigator.clipboard, permissions: !!navigator.permissions,
      notification: typeof window.Notification !== 'undefined', accelerometer: typeof window.Accelerometer !== 'undefined',
      gyroscope: typeof window.Gyroscope !== 'undefined', orientationEvent: typeof window.DeviceOrientationEvent !== 'undefined',
      motionEvent: typeof window.DeviceMotionEvent !== 'undefined', fullscreenRequest: typeof document.documentElement.requestFullscreen === 'function',
      pointerLock: typeof document.documentElement.requestPointerLock === 'function', filePicker: typeof window.showOpenFilePicker === 'function',
      webkitFileSystem: typeof window.webkitRequestFileSystem === 'function', webgpu: !!navigator.gpu,
      battery: typeof navigator.getBattery === 'function', vibration: typeof navigator.vibrate === 'function',
      touchEvents: 'ontouchstart' in window, pointerEvent: typeof window.PointerEvent !== 'undefined' };
    done('supported', result);
  }
  function gamepads(done) {
    var getter = navigator.getGamepads || navigator.webkitGetGamepads;
    if (typeof getter !== 'function') { done('unsupported', { gamepadAPI: false }); return; }
    var pads = getter.call(navigator), profiles = [];
    for (var i = 0; pads && i < Math.min(pads.length, 8); i += 1) {
      if (pads[i] && pads[i].connected !== false) { profiles.push({ axes: pads[i].axes ? pads[i].axes.length : null,
        buttons: pads[i].buttons ? pads[i].buttons.length : null, mapping: typeof pads[i].mapping === 'string' ? pads[i].mapping.slice(0, 32) : null }); }
    }
    done(profiles.length ? 'passed' : 'supported', { connectedObserved: profiles.length, profiles: profiles,
      scope: 'Snapshot only; device IDs and input contents omitted; gameplay and controller events not inferred' });
  }
  function videoClip(format, fixture, mime) {
    return new Promise(function (resolve) {
      var video = null, canvas = null;
      var finished = false, timeout = null, poll = null, settle = null, captured = false;
      var details = { fixture: fixture, mime: mime, declaredSupport: '', metadataLoaded: false, firstFrameReady: false,
        width: null, height: null, durationSeconds: null, readyState: 0, mediaErrorCode: null };
      var playback = { status: 'not-tested', attempted: false, promiseReturned: false, error: null,
        scope: 'Muted normal play call; policy outcome is separate from decoder readiness' };
      var pixels = { status: 'not-tested', pixel: null, referenceMatched: null, error: null,
        scope: '2x2 canvas readback from the fixed-color fixture; no hardware acceleration inference' };
      function cleanup() {
        clearTimeout(timeout); clearTimeout(settle); clearInterval(poll);
        if (video) {
          video.onloadedmetadata = video.onloadeddata = video.oncanplay = video.onplaying = video.onerror = null;
          try { video.pause(); } catch (ignored) {}
          try { video.removeAttribute('src'); video.load(); } catch (ignoredAgain) {}
          if (video.parentNode) { video.parentNode.removeChild(video); }
        }
        if (canvas) { canvas.width = canvas.height = 0; }
      }
      function finish(status, reason) {
        if (finished) { return; }
        finished = true;
        details.reason = reason;
        details.readyState = video ? video.readyState || 0 : 0;
        cleanup();
        resolve([record('video-' + format + '-decoder', status, details),
          record('video-' + format + '-canvas-readback', pixels.status, pixels),
          record('video-' + format + '-playback-policy', playback.status, playback)]);
      }
      function ready() {
        if (finished) { return; }
        if (video.readyState >= 1 && video.videoWidth > 0) {
          details.metadataLoaded = true; details.width = video.videoWidth; details.height = video.videoHeight;
          details.durationSeconds = typeof video.duration === 'number' && isFinite(video.duration) ? video.duration : null;
        }
        if (video.readyState >= 2 && video.videoWidth > 0) {
          details.firstFrameReady = true;
          if (!captured) {
            captured = true;
            try {
              var context = canvas.getContext('2d');
              if (!context) { pixels.status = 'unsupported'; }
              else {
                context.drawImage(video, 0, 0, 2, 2);
                var value = context.getImageData(0, 0, 1, 1).data;
                pixels.pixel = [value[0], value[1], value[2], value[3]];
                pixels.referenceMatched = Math.abs(value[0] - 24) <= 12 && Math.abs(value[1] - 120) <= 12 &&
                  Math.abs(value[2] - 210) <= 12 && value[3] === 255;
                pixels.status = pixels.referenceMatched ? 'passed' : 'failed';
              }
            } catch (error) { pixels.error = exception(error); pixels.status = pixels.error === 'SecurityError' ? 'blocked' : 'failed'; }
          }
          if (playback.status === 'passed' || playback.status === 'blocked' || playback.status === 'failed') {
            finish('passed', 'Metadata and current frame became available');
          } else if (settle === null) {
            settle = setTimeout(function () { finish('passed', 'Current frame available; playback outcome not observed within the short sample'); }, 150);
          }
        }
      }
      timeout = setTimeout(function () {
        finish(details.firstFrameReady ? 'passed' : (details.metadataLoaded ? 'not-tested' : 'timeout'),
          details.firstFrameReady ? 'Current frame observed within the 1500ms sample' :
            (details.metadataLoaded ? '1500ms sample ended before a current frame was observed' : '1500ms sample ended before metadata was observed'));
      }, 1500);
      try {
        video = document.createElement('video'); canvas = document.createElement('canvas');
        if (typeof video.canPlayType !== 'function' || typeof video.load !== 'function') {
          finish('unsupported', 'Video media-element methods are absent'); return;
        }
        details.declaredSupport = video.canPlayType(mime);
        canvas.width = canvas.height = 2;
        video.width = video.height = 64; video.muted = true; video.volume = 0; video.preload = 'auto'; video.playsInline = true;
        video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
        video.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
        video.onloadedmetadata = video.onloadeddata = video.oncanplay = ready;
        video.onplaying = function () { if (!finished) { playback.status = 'passed'; ready(); } };
        video.onerror = function () {
          if (finished) { return; }
          details.mediaErrorCode = video.error && typeof video.error.code === 'number' ? video.error.code : null;
          finish(details.mediaErrorCode === 4 ? 'unsupported' : 'failed', 'Media element reported an error for this valid fixture');
        };
        document.body.appendChild(video); video.src = fixture; video.load();
        if (finished) { return; }
        if (typeof video.play === 'function') {
          playback.attempted = true;
          try {
            var playing = video.play();
            if (playing && typeof playing.then === 'function') {
              playback.promiseReturned = true;
              playing.then(function () { if (!finished) { playback.status = 'passed'; ready(); } }, function (error) {
                if (finished) { return; }
                playback.error = exception(error);
                playback.status = playback.error === 'NotAllowedError' || playback.error === 'SecurityError' ? 'blocked' : 'failed';
                ready();
              });
            }
          } catch (error) {
            playback.error = exception(error);
            playback.status = playback.error === 'NotAllowedError' || playback.error === 'SecurityError' ? 'blocked' : 'failed';
          }
        }
        if (!finished) { poll = setInterval(ready, 50); ready(); }
      } catch (error) {
        details.error = exception(error);
        finish(details.error === 'SecurityError' || details.error === 'NotAllowedError' ? 'blocked' : 'failed', 'Video fixture setup did not complete');
      }
    });
  }
  modules.push({ id: 'media', title: 'Graphics, media and device APIs', run: function () {
    var svgImage = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="rgb(24,120,210)"/></svg>';
    return Promise.all([
      check('canvas2d-normal-operations', canvasCheck), check('dom-parser-small-documents', domCheck), check('css-feature-declarations', cssCheck),
      imageCheck('png-image-decode', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGOQqLj0H4QZYAwAT5gJhVR+ZY4AAAAASUVORK5CYII=', [24, 120, 210, 255]),
      imageCheck('gif-image-decode', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', null),
      imageCheck('svg-image-decode', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgImage), [24, 120, 210, 255]),
      check('svg-normal-animation', svgAnimation), check('media-codec-declarations', codecs),
      check('audio-context-lifecycle', audioContextCheck), check('offline-audio-render', offlineAudio),
      check('device-api-presence', devices), check('gamepad-snapshot', gamepads)
    ]).then(function (checks) {
      /* One decoder at a time avoids mistaking an embedded decoder-session limit for unsupported media. */
      var chain = Promise.resolve(checks);
      [['h264', '/probe-fixtures/probe-h264.mp4', 'video/mp4; codecs="avc1.42E01E"'],
        ['vp8', '/probe-fixtures/probe-vp8.webm', 'video/webm; codecs="vp8"'],
        ['vp9', '/probe-fixtures/probe-vp9.webm', 'video/webm; codecs="vp9"']].forEach(function (fixture) {
        chain = chain.then(function (current) {
          return videoClip(fixture[0], fixture[1], fixture[2]).then(function (extra) { return current.concat(extra); });
        });
      });
      return chain;
    }).then(function (checks) { return { checks: checks }; });
  } });
}());
