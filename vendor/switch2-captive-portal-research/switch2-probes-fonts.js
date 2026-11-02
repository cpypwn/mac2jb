(function (window) {
  'use strict';
  var DEADLINE = 2000;
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
    var sample = null;
    var face = null;
    var cleanedUp = false;
    var source = 'local("Arial")';
    function collect(p) { return p.then(function (result) { checks.push(result); }); }
    return collect(check('font-api', function (done) {
      var available = typeof window.FontFace === 'function' && !!document.fonts;
      done(available ? 'passed' : 'unsupported', {
        fontFace: typeof window.FontFace,
        fontSet: !!document.fonts,
        fontSetLoad: !!(document.fonts && document.fonts.load),
        fontSetCheck: !!(document.fonts && document.fonts.check)
      });
    })).then(function () {
      return collect(check('font-load', function (done) {
        if (typeof window.FontFace !== 'function' || !document.fonts) { done('unsupported'); return; }
        face = new window.FontFace('OSNXFontDiagnostic', source);
        var initial = String(face.status);
        face.load().then(function (loaded) {
          if (cleanedUp) { return; }
          document.fonts.add(loaded);
          done('passed', { initialStatus: initial, finalStatus: String(loaded.status), source: 'local-system-font' });
        }, function (error) {
          done('unsupported', { initialStatus: initial, reason: String(error.name || 'LoadError') });
        });
      }));
    }).then(function () {
      return collect(check('font-render', function (done) {
        if (!face || face.status !== 'loaded') { done('unsupported'); return; }
        sample = document.createElement('span');
        sample.textContent = 'OSNX FONT 012345';
        sample.style.cssText = 'position:absolute;left:-10000px;top:0;font:32px OSNXFontDiagnostic,sans-serif';
        document.body.appendChild(sample);
        var width = sample.getBoundingClientRect().width;
        var checked = typeof document.fonts.check === 'function' ? document.fonts.check('32px OSNXFontDiagnostic') : null;
        done(width > 0 ? 'passed' : 'failed', { widthPx: Math.round(width * 100) / 100, fontCheck: checked });
      }));
    }).then(function () {
      return collect(check('font-loading-events', function (done) {
        if (!document.fonts) { done('unsupported'); return; }
        done('passed', {
          status: String(document.fonts.status || 'unknown'),
          loadingEventSupported: 'onloading' in document.fonts,
          doneEventSupported: 'onloadingdone' in document.fonts,
          errorEventSupported: 'onloadingerror' in document.fonts
        });
      }));
    }).then(function () {
      return { checks: checks, budget: { perCheckMs: DEADLINE, externalFontRequests: false, craftedFonts: false } };
    }).then(function (output) {
      cleanedUp = true;
      if (sample && sample.parentNode) { sample.parentNode.removeChild(sample); }
      if (face && document.fonts && typeof document.fonts.delete === 'function') { document.fonts.delete(face); }
      return output;
    });
  }
  window.SwitchProbeModules.push({ id: 'fonts', run: run });
}(window));
