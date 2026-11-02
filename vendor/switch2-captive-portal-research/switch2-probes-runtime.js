(function (window) {
  'use strict';
  var serial = 0;
  var LIMIT = 1400;
  function unique() {
    serial += 1;
    return 'switchprobe-runtime-' + new Date().getTime().toString(36) + '-' +
      Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2) + '-' + serial;
  }
  function errorDetails(error) {
    return { error: error && error.name ? String(error.name).slice(0, 64) : 'Error' };
  }
  function errorStatus(error) {
    return error && /^(SecurityError|NotAllowedError|QuotaExceededError|EvalError)$/.test(error.name) ? 'blocked' : 'failed';
  }
  function bounded(id, operation) {
    return new Promise(function (resolve) {
      var finished = false;
      var cleanups = [];
      var timer;
      function finish(status, details) {
        if (finished) { return; }
        finished = true;
        window.clearTimeout(timer);
        for (var i = cleanups.length - 1; i >= 0; i -= 1) {
          try { cleanups[i](); } catch (ignored) { /* Continue remaining cleanup. */ }
        }
        resolve({ id: id, status: status, details: details || {} });
      }
      var scope = {
        active: function () { return !finished; },
        finish: finish,
        cleanup: function (callback) {
          if (finished) { try { callback(); } catch (ignored) {} } else { cleanups.push(callback); }
        },
        guard: function (callback) {
          return function () {
            if (finished) { return; }
            try { callback.apply(null, arguments); } catch (error) { finish(errorStatus(error), errorDetails(error)); }
          };
        }
      };
      timer = window.setTimeout(function () {
        finish('timeout', { limitMs: LIMIT, cleanupRequested: true });
      }, LIMIT);
      try {
        var result = operation(scope);
        if (result) { finish(result.status, result.details); }
      } catch (error) { finish(errorStatus(error), errorDetails(error)); }
    });
  }
  function storageCase(name) {
    return bounded(name, function (scope) {
      var storage = window[name];
      if (!storage) { return { status: 'unsupported' }; }
      var key = unique();
      var value = new Array(2049).join('s');
      scope.cleanup(function () { storage.removeItem(key); });
      storage.setItem(key, value);
      var matches = storage.getItem(key) === value;
      storage.removeItem(key);
      return { status: matches ? 'passed' : 'failed', details: { bytes: 2048, ownKeyOnly: true, removed: true } };
    });
  }
  function idbCase() {
    return bounded('indexeddb-owned-roundtrip', function (scope) {
      var factory = window.indexedDB || window.webkitIndexedDB;
      if (!factory) { return { status: 'unsupported' }; }
      var name = unique();
      var database = null;
      var transaction = null;
      var deleting = false;
      var deleted = false;
      var payload = new Array(2049).join('i');
      function remove(done) {
        if (database) { try { database.close(); } catch (ignored) {} database = null; }
        if (deleted) { if (done && scope.active()) { done(); } return; }
        if (deleting) { return; }
        deleting = true;
        try {
          var deletion = factory.deleteDatabase(name);
          deletion.onsuccess = function () { deleting = false; deleted = true; if (done && scope.active()) { done(); } };
          deletion.onerror = function () {
            deleting = false;
            if (scope.active()) { scope.finish('failed', { stage: 'delete', ownDatabaseOnly: true }); }
          };
          deletion.onblocked = function () {
            if (scope.active()) { scope.finish('blocked', { stage: 'delete', ownDatabaseOnly: true }); }
          };
        } catch (error) {
          deleting = false;
          if (scope.active()) { scope.finish(errorStatus(error), errorDetails(error)); }
        }
      }
      scope.cleanup(function () {
        if (transaction) { try { transaction.abort(); } catch (ignored) {} transaction = null; }
        remove();
      });
      var opening = factory.open(name, 1);
      opening.onupgradeneeded = function (event) {
        try {
          if (!scope.active()) {
            event.target.transaction.abort();
            event.target.result.close();
            remove();
            return;
          }
          event.target.result.createObjectStore('probe');
        } catch (error) {
          if (scope.active()) { scope.finish(errorStatus(error), errorDetails(error)); }
        }
      };
      opening.onerror = function () {
        if (scope.active()) { scope.finish(errorStatus(opening.error), errorDetails(opening.error)); }
        else { remove(); }
      };
      opening.onblocked = function () { scope.finish('blocked', { stage: 'open', ownDatabaseOnly: true }); };
      opening.onsuccess = function () {
        database = opening.result;
        deleted = false;
        if (!scope.active()) { remove(); return; }
        try {
          database.onversionchange = function () { remove(); };
          transaction = database.transaction('probe', 'readwrite');
          var store = transaction.objectStore('probe');
          var written = store.put(payload, 'owned-key');
          var matched = false;
          written.onsuccess = scope.guard(function () {
            var read = store.get('owned-key');
            read.onsuccess = scope.guard(function () { matched = read.result === payload; });
          });
          transaction.onabort = function () {
            if (scope.active()) { scope.finish('failed', { stage: 'transaction', ownDatabaseOnly: true }); }
          };
          transaction.onerror = function () {
            if (scope.active()) { scope.finish('failed', { stage: 'transaction', ownDatabaseOnly: true }); }
          };
          transaction.oncomplete = scope.guard(function () {
            transaction = null;
            remove(function () {
              scope.finish(matched ? 'passed' : 'failed', { bytes: 2048, ownDatabaseOnly: true, deleted: true });
            });
          });
        } catch (error) { scope.finish(errorStatus(error), errorDetails(error)); }
      };
    });
  }
  function cacheCase() {
    return bounded('cache-storage-owned-roundtrip', function (scope) {
      var storage = window.caches;
      if (!storage || typeof window.Response !== 'function') { return { status: 'unsupported' }; }
      var name = unique();
      var key = '/probe-data?owned-runtime-cache=' + encodeURIComponent(name);
      var payload = new Array(2049).join('c');
      var deleted = false;
      function remove() {
        if (deleted) { return; }
        try { storage.delete(name).then(function () {}, function () {}); } catch (ignored) {}
      }
      scope.cleanup(remove);
      storage.open(name).then(function (cache) {
        deleted = false;
        if (!scope.active()) { remove(); return; }
        return cache.put(key, new window.Response(payload, { headers: { 'Content-Type': 'text/plain' } })).then(function () {
          if (!scope.active()) { remove(); return; }
          return cache.match(key);
        }).then(function (response) {
          if (!scope.active()) { remove(); return; }
          if (!response) { throw new Error('Own cache entry missing'); }
          return response.text();
        }).then(function (value) {
          if (!scope.active()) { remove(); return; }
          return storage.delete(name).then(function (wasDeleted) {
            var removed = wasDeleted === true;
            deleted = removed;
            scope.finish(value === payload && removed ? 'passed' : 'failed',
              { bytes: 2048, ownCacheOnly: true, deleted: removed, networkRequests: 0 });
          });
        });
      }).then(function () {}, function (error) {
        if (scope.active()) { scope.finish(errorStatus(error), errorDetails(error)); } else { remove(); }
      });
    });
  }
  function filesystemSurfaceCase() {
    return bounded('browser-filesystem-entrypoint-surface', function (scope) {
      function inspect(object, name) {
        try {
          for (var depth = 0; object && depth < 16; depth += 1) {
            var descriptor = Object.getOwnPropertyDescriptor(object, name);
            if (descriptor) {
              if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                return { kind: 'data', type: typeof descriptor.value, value: descriptor.value, depth: depth };
              }
              return { kind: 'accessor-not-read', getterPresent: typeof descriptor.get === 'function', depth: depth };
            }
            object = Object.getPrototypeOf(object);
          }
          return { kind: 'absent', type: 'undefined' };
        } catch (error) { return { kind: 'blocked', error: errorDetails(error).error }; }
      }
      function summary(record) {
        var output = { kind: record.kind, getterInvoked: false };
        if (record.type) { output.type = record.type; }
        if (typeof record.depth === 'number') { output.prototypeDepth = record.depth; }
        if (record.getterPresent) { output.getterPresent = true; }
        if (record.error) { output.error = record.error; }
        return output;
      }
      function prototypeOfConstructor(name) {
        var constructor = inspect(window, name);
        return constructor.kind === 'data' ? inspect(constructor.value, 'prototype').value : null;
      }
      var details = { inventoryOnly: true, descriptors: {}, bridgeCandidates: {},
        opfs: { status: 'not-tested', scope: 'browser-origin storage only', filesCreated: 0, directoryContentsRead: false },
        nativeFilesystemService: 'not-established', nativeIpc: 'not-established',
        note: 'Browser file/storage APIs and candidate names do not establish Horizon FS, native service handles, or arbitrary memory access. No bridge functions, accessors or permission pickers are invoked.' };
      var navigatorRecord = inspect(window, 'navigator');
      details.descriptors.navigator = summary(navigatorRecord);
      var navigatorObject = navigatorRecord.kind === 'data' ? navigatorRecord.value : prototypeOfConstructor('Navigator');
      var storage = inspect(navigatorObject, 'storage');
      details.descriptors['navigator.storage'] = summary(storage);
      details.descriptors['navigator.storage'].inspectedOwner = navigatorRecord.kind === 'data' ? 'navigator' : 'Navigator.prototype';
      var directory = storage.kind === 'data' ? inspect(storage.value, 'getDirectory') : { kind: 'parent-not-read' };
      details.descriptors['navigator.storage.getDirectory'] = summary(directory);
      details.descriptors['StorageManager.prototype.getDirectory'] = summary(inspect(prototypeOfConstructor('StorageManager'), 'getDirectory'));
      var globals = ['requestFileSystem', 'webkitRequestFileSystem', 'resolveLocalFileSystemURL',
        'webkitResolveLocalFileSystemURL', 'showDirectoryPicker', 'showOpenFilePicker'];
      for (var i = 0; i < globals.length; i += 1) { details.descriptors[globals[i]] = summary(inspect(window, globals[i])); }
      var candidates = ['Nintendo', 'NintendoBrowser', 'nn', 'wkc', 'WKC', 'external', 'webkit'];
      try {
        var names = Object.getOwnPropertyNames(window);
        details.totalOwnGlobalNames = names.length;
        details.globalNamesExamined = Math.min(names.length, 4096);
        details.nameScanTruncated = names.length > 4096;
        for (i = 0; i < Math.min(names.length, 4096); i += 1) {
          var name = names[i];
          if (!/token|secret|password|credential|cookie/i.test(name) &&
              /nintendo|^horizon|bridge|ipc|service|wkc|^external$|^webkit$|^nx$|^nn$|^svc$|^sm$|filesystem|directorypicker|openfilepicker/i.test(name) &&
              candidates.indexOf(name) < 0 && candidates.length < 64) { candidates.push(name); }
        }
      } catch (error) { details.nameScanError = errorDetails(error).error; }
      for (i = 0; i < candidates.length; i += 1) { details.bridgeCandidates[candidates[i]] = summary(inspect(window, candidates[i])); }
      if (storage.kind !== 'data' || directory.kind !== 'data' || directory.type !== 'function') {
        var unread = navigatorRecord.kind === 'accessor-not-read' || navigatorRecord.kind === 'blocked' || storage.kind === 'accessor-not-read';
        details.opfs.status = unread ? 'not-tested' : 'unsupported';
        details.opfs.reason = unread ? 'Navigator or storage accessor not invoked; instance API availability unverified' : 'Direct data-descriptor getDirectory unavailable';
        return { status: 'passed', details: details };
      }
      var deadline = window.setTimeout(function () {
        details.opfs.status = 'timeout';
        details.opfs.limitMs = 1000;
        scope.finish('timeout', details);
      }, 1000);
      scope.cleanup(function () { window.clearTimeout(deadline); });
      try {
        Promise.resolve(directory.value.call(storage.value)).then(scope.guard(function () {
          details.opfs.status = 'passed';
          details.opfs.rootHandleResolved = true;
          scope.finish('passed', details);
        }), scope.guard(function (error) {
          details.opfs.status = errorStatus(error);
          details.opfs.error = errorDetails(error).error;
          scope.finish('passed', details);
        }));
      } catch (error) {
        details.opfs.status = errorStatus(error);
        details.opfs.error = errorDetails(error).error;
        scope.finish('passed', details);
      }
    });
  }
  window.SwitchProbeModules = window.SwitchProbeModules || [];
  window.SwitchProbeModules.push({
    id: 'runtime',
    title: 'JavaScript, workers and storage',
    run: function (context) {
      var checks = [];
      checks.push(bounded('runtime-api-presence', function () {
        var names = ['WeakRef', 'FinalizationRegistry', 'Proxy', 'BigInt', 'SharedArrayBuffer', 'Atomics', 'Intl', 'WebAssembly'];
        var available = {};
        for (var i = 0; i < names.length; i += 1) { available[names[i]] = typeof window[names[i]]; }
        return { status: 'passed', details: { presence: available, sharedMemoryUsed: false, atomicsWaitUsed: false } };
      }));
      checks.push(bounded('typed-array-dataview-roundtrip', function () {
        if (!window.ArrayBuffer || !window.DataView || !window.Uint8Array) { return { status: 'unsupported' }; }
        var buffer = new window.ArrayBuffer(4096);
        var bytes = new window.Uint8Array(buffer);
        var view = new window.DataView(buffer);
        for (var i = 32; i < 1056; i += 1) { bytes[i] = i % 251; }
        view.setUint32(0, 0x12345678, false);
        view.setFloat64(8, 1234.5, true);
        var correct = view.getUint32(0, false) === 0x12345678 && view.getFloat64(8, true) === 1234.5;
        for (i = 32; i < 1056; i += 1) { correct = correct && bytes[i] === i % 251; }
        return { status: correct ? 'passed' : 'failed', details: { allocatedBytes: 4096, patternBytes: 1024 } };
      }));
      checks.push(bounded('normal-function-constructor', function () {
        if (typeof window.Function !== 'function') { return { status: 'unsupported' }; }
        var calculate = new window.Function('return 6 * 7;');
        return { status: typeof calculate === 'function' ? 'passed' : 'failed',
          details: { ordinarySourceParsedOnly: true, functionBodyExecuted: false, jitInference: false } };
      }));
      checks.push(bounded('intl-explicit-locale', function () {
        if (!window.Intl || !window.Intl.NumberFormat || !window.Intl.DateTimeFormat) { return { status: 'unsupported' }; }
        var number = new window.Intl.NumberFormat('en-US', { useGrouping: false }).format(1234.5);
        var year = new window.Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' }).format(new Date(0));
        return { status: number === '1234.5' && year === '1970' ? 'passed' : 'failed',
          details: { explicitLocale: 'en-US', explicitTimeZone: 'UTC', number: number, year: year } };
      }));
      checks.push(bounded('promise-microtask-order', function (scope) {
        var order = ['sync'];
        Promise.resolve().then(scope.guard(function () { order.push('microtask'); }));
        var task = window.setTimeout(scope.guard(function () {
          order.push('timer');
          scope.finish(order.join(',') === 'sync,microtask,timer' ? 'passed' : 'failed', { order: order });
        }), 0);
        scope.cleanup(function () { window.clearTimeout(task); });
      }));
      checks.push(bounded('performance-clock', function () {
        if (!window.performance || typeof window.performance.now !== 'function') { return { status: 'unsupported' }; }
        var first = window.performance.now();
        var second = window.performance.now();
        return { status: isFinite(first) && isFinite(second) && second >= first ? 'passed' : 'failed',
          details: { deltaMs: isFinite(second - first) ? second - first : null, samples: 2, cpuBenchmark: false } };
      }));
      checks.push(bounded('two-animation-frames', function (scope) {
        var request = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
        var cancel = window.cancelAnimationFrame || window.webkitCancelAnimationFrame;
        if (typeof request !== 'function') { return { status: 'unsupported' }; }
        if (typeof cancel !== 'function') { return { status: 'not-tested', details: { reason: 'Frame cancellation API unavailable' } }; }
        var token = null;
        scope.cleanup(function () { if (token !== null && typeof cancel === 'function') { cancel.call(window, token); } });
        token = request.call(window, scope.guard(function (first) {
          token = request.call(window, scope.guard(function (second) {
            token = null;
            scope.finish(typeof first === 'number' && typeof second === 'number' && second >= first ? 'passed' : 'failed',
              { deltaMs: typeof second === 'number' && typeof first === 'number' ? second - first : null,
                frames: 2, displayRateInference: false });
          }));
        }));
      }));
      checks.push(bounded('blob-worker-echo', function (scope) {
        var urls = window.URL || window.webkitURL;
        if (!window.Worker || !window.Blob || !urls || !urls.createObjectURL) { return { status: 'unsupported' }; }
        var worker = null;
        var address = urls.createObjectURL(new window.Blob(['onmessage=function(e){postMessage(e.data);};'], { type: 'application/javascript' }));
        scope.cleanup(function () { urls.revokeObjectURL(address); });
        scope.cleanup(function () {
          if (worker) { worker.onmessage = null; worker.onerror = null; try { worker.terminate(); } finally { worker = null; } }
        });
        worker = new window.Worker(address);
        var payload = new Array(1025).join('w');
        worker.onmessage = scope.guard(function (event) {
          scope.finish(event.data === payload ? 'passed' : 'failed', { bytes: 1024, workerTerminated: true, blobRevoked: true });
        });
        worker.onerror = scope.guard(function (event) {
          if (event.preventDefault) { event.preventDefault(); }
          scope.finish('blocked', { stage: 'worker execution', cleanupRequested: true });
        });
        worker.postMessage(payload);
      }));
      checks.push(bounded('message-channel-echo', function (scope) {
        if (typeof window.MessageChannel !== 'function') { return { status: 'unsupported' }; }
        var channel = new window.MessageChannel();
        scope.cleanup(function () { channel.port2.close(); });
        scope.cleanup(function () { channel.port1.onmessage = null; channel.port1.close(); });
        var payload = new Array(1025).join('m');
        channel.port1.onmessage = scope.guard(function (event) {
          scope.finish(event.data === payload ? 'passed' : 'failed', { bytes: 1024, portsClosed: true });
        });
        if (channel.port1.start) { channel.port1.start(); }
        channel.port2.postMessage(payload);
      }));
      checks.push(storageCase('localStorage'));
      checks.push(storageCase('sessionStorage'));
      checks.push(idbCase());
      checks.push(cacheCase());
      checks.push(filesystemSurfaceCase());
      return Promise.all(checks).then(function (results) { return { checks: results }; });
    }
  });
}(window));
