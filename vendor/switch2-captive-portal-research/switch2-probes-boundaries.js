(function (window) {
  'use strict';
  // Fixed, small browser API cases. No network, storage, native calls or custom input.
  var strings = ['', 'a', '0123456789abcde', '0123456789abcdef', 'space + percent %', '\u03a9\u65e5\u672c', '\ud83d\ude80', new Array(1025).join('x')];
  var sizes = [0, 1, 15, 16, 255, 256, 1023, 4096];
  var invalid = ['{', '[', '[1,]', '{"a":}', 'undefined', 'NaN', '01', '"unfinished'];
  var groups = [
    { id: 'json-roundtrip', run: function (i) {
      var value = { index: i, text: strings[i], values: [null, true, false, i] };
      return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value);
    } },
    { id: 'json-rejection', run: function (i) {
      try { JSON.parse(invalid[i]); } catch (error) { return error.name === 'SyntaxError'; }
      return false;
    } },
    { id: 'uri-roundtrip', run: function (i) { return decodeURIComponent(encodeURIComponent(strings[i])) === strings[i]; } },
    { id: 'typed-array-bounds', available: function () { return typeof window.Uint8Array === 'function'; }, run: function (i) {
      var a = new window.Uint8Array(sizes[i]);
      if (a.length) { a[0] = 23; a[a.length - 1] = 91; if (a[a.length - 1] !== 91) { return false; } }
      try { new window.Uint8Array(a.buffer, sizes[i] + 1, 1); } catch (error) { return error.name === 'RangeError'; }
      return false;
    } },
    { id: 'text-roundtrip', available: function () { return typeof window.TextEncoder === 'function' && typeof window.TextDecoder === 'function'; }, run: function (i) {
      return new window.TextDecoder('utf-8').decode(new window.TextEncoder().encode(strings[i])) === strings[i];
    } },
    { id: 'url-roundtrip', available: function () { return typeof window.URL === 'function'; }, run: function (i) {
      var u = new window.URL('/probe-data?case=' + encodeURIComponent(strings[i]), 'http://probe.invalid/');
      return u.hostname === 'probe.invalid' && decodeURIComponent(u.search.slice(6)) === strings[i];
    } }
  ];
  window.SwitchProbeModules.push({ id: 'boundaries', run: function (options) {
    options = options || {};
    return new Promise(function (resolve) {
      var begun = Date.now(), index = 0, checks = [], attempted = 0;
      function next() {
        if (index >= groups.length) {
          resolve({ checks: checks, budget: { maxCases: 48, casesAttempted: attempted, largestBufferBytes: 4096, deadlineMs: 2000, cooperativeDeadline: true } });
          return;
        }
        var group = groups[index++], passed = 0, failed = 0, errors = [], count = 0;
        if (group.available && !group.available()) {
          checks.push({ id: group.id, status: 'unsupported', details: { casesAttempted: 0 } });
          window.setTimeout(next, 0); return;
        }
        function one() {
          var cancelled = options.isActive && !options.isActive();
          var expired = Date.now() - begun >= 2000;
          if (cancelled || expired || count >= 8) {
            checks.push({ id: group.id, status: cancelled ? 'not-tested' : expired ? 'timeout' : failed ? 'failed' : 'passed',
              details: { casesAttempted: count, passed: passed, failed: failed, errors: errors, cancelled: !!cancelled } });
            window.setTimeout(next, 0); return;
          }
          try { if (group.run(count)) { passed++; } else { failed++; } }
          catch (error) { failed++; errors.push(String(error.name || 'Error').slice(0, 64)); }
          count++; attempted++;
          window.setTimeout(one, 0);
        }
        one();
      }
      next();
    });
  } });
}(window));
