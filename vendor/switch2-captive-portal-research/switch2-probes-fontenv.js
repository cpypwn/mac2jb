(function (window) {
  'use strict';
  var DEADLINE = 1500;
  var FAMILIES = [
    'Helvetica', 'Arial', 'Times', 'Courier New',
    'MS Mincho', 'MS PGothic', 'AppleGothic', 'Gothic', 'systemfont'
  ];

  function check(id, fn) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = window.setTimeout(function () { done('timeout', { deadlineMs: DEADLINE }); }, DEADLINE);
      function done(status, details) {
        if (finished) { return; }
        finished = true;
        window.clearTimeout(timer);
        resolve({ id: id, status: status, details: details || {} });
      }
      try { fn(done); } catch (error) { done('failed', { error: String(error.name || error).slice(0, 80) }); }
    });
  }

  function run() {
    var checks = [];
    var added = [];
    function collect(p) { return p.then(function (result) { checks.push(result); }); }
    function cleanup() {
      for (var i = 0; i < added.length; i += 1) {
        try {
          if (document.fonts && typeof document.fonts.delete === 'function') { document.fonts.delete(added[i]); }
        } catch (ignored) {}
      }
      added.length = 0;
    }

    return collect(check('fontenv-api', function (done) {
      done(typeof window.FontFace === 'function' && !!document.fonts ? 'passed' : 'unsupported', {
        fontFace: typeof window.FontFace,
        fontSet: !!document.fonts,
        fontSetLoad: !!(document.fonts && document.fonts.load),
        fontSetCheck: !!(document.fonts && document.fonts.check),
        fontSetSize: document.fonts && typeof document.fonts.size === 'number' ? document.fonts.size : null,
        thenOverridden: !!(window.FontFace && window.FontFace.prototype && Object.getOwnPropertyDescriptor(window.FontFace.prototype, 'then'))
      });
    })).then(function () {
      return collect(check('fontenv-computed-family', function (done) {
        if (!document.body) { done('unsupported'); return; }
        var style = window.getComputedStyle ? window.getComputedStyle(document.body) : null;
        done('passed', {
          bodyFontFamily: style ? String(style.fontFamily || '').slice(0, 200) : null,
          bodyFontSize: style ? String(style.fontSize || '').slice(0, 40) : null
        });
      }));
    }).then(function () {
      var chain = Promise.resolve();
      FAMILIES.forEach(function (family) {
        chain = chain.then(function () {
          return collect(check('fontenv-local-' + family.toLowerCase().replace(/[^a-z0-9]+/g, '-'), function (done) {
            if (typeof window.FontFace !== 'function' || !document.fonts) { done('unsupported'); return; }
            var face = new window.FontFace('OSNXFontEnv' + family, 'local("' + family + '")');
            var initial = String(face.status);
            var statusAfterCall = null;
            var loadPromise = face.load();
            statusAfterCall = String(face.status);
            added.push(face);
            loadPromise.then(function (loaded) {
              document.fonts.add(loaded);
              done('passed', {
                family: family,
                initialStatus: initial,
                statusAfterCall: statusAfterCall,
                finalStatus: String(loaded.status),
                loadedSynchronously: statusAfterCall === 'loaded'
              });
            }, function (error) {
              done('unsupported', {
                family: family,
                initialStatus: initial,
                statusAfterCall: statusAfterCall,
                reason: String((error && error.name) || 'LoadError')
              });
            });
          }));
        });
      });
      return chain;
    }).then(function () {
      return collect(check('fontenv-summary', function (done) {
        var local = checks.filter(function (c) { return c.id.indexOf('fontenv-local-') === 0; });
        var loaded = local.filter(function (c) { return c.status === 'passed'; });
        var sync = local.filter(function (c) { return c.status === 'passed' && c.details.loadedSynchronously; });
        done('passed', {
          familiesTried: FAMILIES.length,
          familiesLoaded: loaded.map(function (c) { return c.details.family; }),
          familiesLoadedSynchronously: sync.map(function (c) { return c.details.family; }),
          note: 'Availability inventory only. No then-override, no style invalidation, no crafted fonts, no external font requests.'
        });
      }));
    }).then(function (output) {
      cleanup();
      return {
        checks: checks,
        budget: {
          perCheckMs: DEADLINE,
          externalFontRequests: false,
          craftedFonts: false,
          thenOverride: false,
          styleInvalidation: false
        }
      };
    });
  }

  window.SwitchProbeModules.push({ id: 'fontenv', run: run });
}(window));
