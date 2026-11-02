(function (window) {
  'use strict';
  var checks = [];
  function add(id, status, details) { checks.push({ id: id, status: status, details: details || {} }); }
  function safe(id, fn) {
    try { var x = fn(); add(id, x ? 'passed' : 'unsupported', { available: !!x }); }
    catch (e) { add(id, 'blocked', { error: String(e.name || e).slice(0, 64) }); }
  }
  function run() {
    checks = [];
    safe('webkit-js-promise', function () { return typeof Promise === 'function'; });
    safe('webkit-js-bigint', function () { return typeof window.BigInt === 'function'; });
    safe('webkit-js-wasm', function () { return !!window.WebAssembly; });
    safe('webkit-js-textcodec', function () { return !!window.TextEncoder && !!window.TextDecoder; });
    safe('webkit-page-visibility', function () { return typeof document.visibilityState === 'string'; });
    safe('webkit-page-performance', function () { return !!window.performance && typeof performance.now === 'function'; });
    safe('webkit-page-viewport', function () { return !!window.innerWidth && !!window.innerHeight; });
    safe('webkit-render-canvas2d', function () { var c = document.createElement('canvas'); c.width = 8; c.height = 8; return !!c.getContext('2d'); });
    safe('webkit-render-svg', function () { return !!document.createElementNS('http://www.w3.org/2000/svg', 'svg').createSVGRect; });
    safe('webkit-render-cssfilter', function () { return !!(window.CSS && window.CSS.supports && window.CSS.supports('filter', 'blur(1px)')); });
    safe('webkit-render-webgl-declaration', function () { return !!window.WebGLRenderingContext; });
    safe('webkit-render-webgl2-declaration', function () { return !!window.WebGL2RenderingContext; });
    safe('webkit-network-fetch', function () { return typeof window.fetch === 'function'; });
    safe('webkit-network-xhr', function () { return typeof window.XMLHttpRequest === 'function'; });
    safe('webkit-network-websocket', function () { return typeof window.WebSocket === 'function'; });
    safe('webkit-worker', function () { return typeof window.Worker === 'function'; });
    safe('webkit-storage-indexeddb', function () { return !!window.indexedDB; });
    add('webkit-context', 'passed', {
      userAgent: String(navigator.userAgent || '').slice(0, 512),
      platform: String(navigator.platform || '').slice(0, 64),
      protocol: String(window.location.protocol),
      secureContext: !!window.isSecureContext,
      visibility: String(document.visibilityState || 'unknown'),
      dimensions: [window.innerWidth || 0, window.innerHeight || 0],
      pixelRatio: window.devicePixelRatio || 1
    });
    return Promise.resolve({ checks: checks, budget: { noNativeCalls: true, noHeapStress: true, noStorageWrites: true, noExternalRequests: true } });
  }
  window.SwitchProbeModules.push({ id: 'webkit', run: run });
}(window));
