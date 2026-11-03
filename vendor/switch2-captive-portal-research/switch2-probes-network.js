(function () {
 'use strict';
 var modules = window.SwitchProbeModules = window.SwitchProbeModules || [];
 function check(id, work, duration) {
  return new Promise(function (resolve) {
   var done = false, cleanup = function () {};
   var timer = setTimeout(function () { finish('timeout', {}); }, duration || 1700);
   function finish(state, details) { if (done) { return; } done = true; clearTimeout(timer); try { cleanup(); } catch (ignored) {} resolve({ id: id, status: state, details: details || {} }); }
   try { work(finish, function (fn) { cleanup = fn; }); }
   catch (error) { finish(error.name === 'SecurityError' ? 'blocked' : 'failed', { error: error.name }); }
  });
 }
 modules.push({ id: 'network', title: 'Networking, interfaces and input', run: function () {
  var work = [];
  work.push(check('network-api-presence', function (done) {
   done('supported', { fetch: typeof window.fetch, xhr: typeof window.XMLHttpRequest, webSocket: typeof window.WebSocket,
    eventSource: typeof window.EventSource, rtcPeerConnection: typeof window.RTCPeerConnection, sendBeacon: typeof navigator.sendBeacon });
  }));
  work.push(check('same-origin-xhr-roundtrip', function (done, cleanup) {
   if (typeof XMLHttpRequest === 'undefined') { done('unsupported'); return; }
   var request = new XMLHttpRequest(); cleanup(function () { request.abort(); });
   request.open('GET', '/probe-data', true); request.timeout = 1300;
   request.onload = function () { try { done(request.status === 200 && JSON.parse(request.responseText).value === 'switch2-probe' ? 'passed' : 'failed', { status: request.status }); } catch (error) { done('failed', { error: error.name }); } };
   request.onerror = function () { done('failed'); }; request.ontimeout = function () { done('timeout'); }; request.send();
  }));
  work.push(check('same-origin-fetch-roundtrip', function (done, cleanup) {
   if (typeof window.fetch !== 'function') { done('unsupported'); return; }
   var abort = typeof window.AbortController === 'function' ? new AbortController() : null;
   cleanup(function () { if (abort) { abort.abort(); } });
   window.fetch('/probe-data', abort ? { signal: abort.signal, cache: 'no-store' } : { cache: 'no-store' }).then(function (r) { if (!r.ok) { throw new Error('HTTP'); } return r.json(); })
    .then(function (data) { done(data.value === 'switch2-probe' ? 'passed' : 'failed'); }, function (error) { done('failed', { error: error.name }); });
  }));
  work.push(check('same-origin-websocket-echo', function (done, cleanup) {
   if (typeof window.WebSocket !== 'function') { done('unsupported'); return; }
   var socket = new WebSocket('ws://' + window.location.host + '/ws'); cleanup(function () { try { socket.close(); } catch (ignored) {} });
   socket.onopen = function () { socket.send('switch2-probe'); };
   socket.onmessage = function (event) { done(event.data === 'switch2-probe' ? 'passed' : 'failed'); };
   socket.onerror = function () { done('failed'); }; socket.onclose = function () { done('failed', { reason: 'Closed before echo' }); };
  }));
  work.push(check('web-crypto-random-buffer', function (done) {
   if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') { done('unsupported'); return; }
   var bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes); done('passed', { bytesWritten: bytes.length, randomValuesNotRecorded: true });
  }));
  work.push(check('web-crypto-sha256', function (done) {
   if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') { done('unsupported', { secureContext: window.isSecureContext === true }); return; }
   window.crypto.subtle.digest('SHA-256', new Uint8Array([112,114,111,98,101])).then(function (value) { done(value.byteLength === 32 ? 'passed' : 'failed', { digestBytes: value.byteLength }); }, function (error) { done('blocked', { error: error.name }); });
  }));
  work.push(check('advertised-device-hints', function (done) {
   done('supported', { hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    deviceMemory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null, maxTouchPoints: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : null,
    secureContext: window.isSecureContext === true, crossOriginIsolated: window.crossOriginIsolated === true, note: 'Browser hints, not verified physical specifications.' });
  }));
  work.push(check('window-interface-name-inventory', function (done) {
   var names = Object.getOwnPropertyNames(window).sort(), filter = function (name) { return !/token|secret|password|credential|cookie/i.test(name); };
   var known = {}, candidates = ['Nintendo','NintendoBrowser','nn','wkc','WKC','external','webkit'];
   for (var i = 0; i < candidates.length; i += 1) { var name = candidates[i]; try { var item = window[name]; known[name] = { type: typeof item }; if (item && (typeof item === 'object' || typeof item === 'function')) { known[name].propertyNames = Object.getOwnPropertyNames(item).filter(filter).slice(0,60); } } catch (error) { known[name] = { error: error.name }; } }
   done('supported', { totalNames: names.length, interfaceNames: names.filter(filter).slice(0,600), candidates: known, note: 'Names and types only; no bridge functions invoked or property values collected.' });
  }));
  work.push(check('input-observation-five-seconds', function (done, cleanup) {
   var counts = { pointerdown:0, touchstart:0, keydown:0 }, keys = [], pads = {}, maximumPads = 0, samples = 0;
   function pointer() { counts.pointerdown += 1; } function touch() { counts.touchstart += 1; }
   function key(event) { if (/^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Escape|Tab| )$/.test(event.key)) { counts.keydown += 1; if (keys.indexOf(event.key) < 0) { keys.push(event.key); } } }
   function sample() { samples += 1; if (typeof navigator.getGamepads !== 'function') { return; } try {
    var values = navigator.getGamepads(), connected = 0;
    for (var i = 0; values && i < Math.min(values.length,8); i += 1) { var gamepad = values[i]; if (!gamepad) { continue; } connected += 1;
     var k = String(i), info = pads[k] || { axes:Math.min(gamepad.axes.length,32), buttons:Math.min(gamepad.buttons.length,64), movementObserved:false, pressObserved:false };
     for (var a = 0; a < info.axes; a += 1) { if (Math.abs(gamepad.axes[a]) > 0.15) { info.movementObserved = true; } }
     for (var b = 0; b < info.buttons; b += 1) { if (gamepad.buttons[b].pressed) { info.pressObserved = true; } } pads[k] = info;
    } maximumPads = Math.max(maximumPads, connected);
   } catch (ignored) {} }
   window.addEventListener('pointerdown',pointer); window.addEventListener('touchstart',touch); window.addEventListener('keydown',key);
   sample(); var interval = setInterval(sample,100);
   var stop = setTimeout(function () { done('passed', { gamepadApi:typeof navigator.getGamepads, maximumConnected:maximumPads, padShapes:pads, samples:samples, eventCounts:counts, navigationKeysOnly:keys, note:'Empty input does not prove absent hardware. No device identifiers or typed text recorded.' }); },5000);
   cleanup(function () { clearTimeout(stop); clearInterval(interval); window.removeEventListener('pointerdown',pointer); window.removeEventListener('touchstart',touch); window.removeEventListener('keydown',key); });
  },5500));
  work.push(check('battery-api', function (done) {
   if (typeof navigator.getBattery !== 'function') { done('unsupported'); return; }
   navigator.getBattery().then(function (battery) { done('passed', { charging:!!battery.charging, level:typeof battery.level === 'number' && isFinite(battery.level) ? battery.level : null }); }, function (error) { done('blocked', { error:error.name }); });
  }));
  return Promise.all(work).then(function (checks) { return { checks:checks }; });
 }});
}());
