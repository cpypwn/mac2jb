/* Fake CivSwitch loader scope for exercising app/native.js in a browser.
 * Sparse 64 KiB-page native memory, an ELF-hash SDK export table, and fake
 * nn::fs / nn::hid / nn::audio / Civ VII renderer functions. Test only. */
(function (g) {
  "use strict";
  var pages = new Map(), heaps = [];
  function page(a) { var k = a >> 16n, p = pages.get(k); if (!p) { p = new Uint8Array(65536); pages.set(k, p); } return p; }
  function heapAt(a) { for (var h of heaps) if (a >= h.base && a < h.base + BigInt(h.view.length)) return h; return null; }
  function r8(a) { var h = heapAt(a); if (h) return h.view[Number(a - h.base)]; return page(a)[Number(a & 0xffffn)]; }
  function w8(a, v) { var h = heapAt(a); if (h) { h.view[Number(a - h.base)] = v; return; } page(a)[Number(a & 0xffffn)] = v & 255; }
  function rn(a, n) { var v = 0n; for (var i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(r8(a + BigInt(i))); return v; }
  function wn(a, n, v) { v = BigInt(v); for (var i = 0; i < n; i++) { w8(a + BigInt(i), Number(v & 255n)); v >>= 8n; } }
  g.read8 = function (a) { return BigInt(r8(a)); }; g.read16 = function (a) { return rn(a, 2); };
  g.read32 = function (a) { return rn(a, 4); }; g.read64 = function (a) { return rn(a, 8); };
  g.write8 = function (a, v) { wn(a, 1, v); }; g.write16 = function (a, v) { wn(a, 2, v); };
  g.write32 = function (a, v) { wn(a, 4, v); }; g.write64 = function (a, v) { wn(a, 8, v); };
  function bytesAt(a, n) { var out = new Uint8Array(n); for (var i = 0; i < n; i++) out[i] = r8(a + BigInt(i)); return out; }
  function putBytes(a, b) { for (var i = 0; i < b.length; i++) w8(a + BigInt(i), b[i]); }
  function cstring(a) { var s = ""; for (var i = 0; i < 4096; i++) { var c = r8(a + BigInt(i)); if (!c) break; s += String.fromCharCode(c); } return s; }

  var stats = g.__mock = { live: 0, mallocs: 0, frees: 0, calls: {}, files: new Map(), dirs: new Set(["save:/"]), buttons: 0,
    audioAppended: 0, audioStarted: false, presents: 0, lastPixels: null, commits: 0, errors: [] };
  var next = 0x5000000000n, sizes = new Map();
  g.malloc = function (n) { n = BigInt(n); var p = (next + 15n) & ~15n; next = p + n + 64n; sizes.set(p, n); stats.live++; stats.mallocs++; return p; };
  g.free = function (p) { if (!sizes.has(p)) { stats.errors.push("bad free " + p.toString(16)); return; } sizes.delete(p); stats.live--; stats.frees++; };
  g.alloc_string = function (s) { var p = g.malloc(s.length + 1); g.write_string(p, s); return p; };
  g.write_string = function (p, s) { for (var i = 0; i < s.length; i++) w8(p + BigInt(i), s.charCodeAt(i)); w8(p + BigInt(s.length), 0); };

  // External typed-array backing stores live at fixed fake addresses.
  var objects = new Map(), nextObj = 0x100000n;
  g.addrof_compressed = function (view) { for (var [a, v] of objects) if (v === view) return a; var a2 = nextObj; nextObj += 0x100n; objects.set(a2, view);
    heaps.push({ base: 0x3000000000n + BigInt(heaps.length) * 0x100000000n, view: view }); return a2; };
  g.read64_compressed = function (a) { var v = objects.get(a - 0x28n); return heaps.find(function (h) { return h.view === v; }).base; };
  g.read32_compressed = function () { return 0n; };

  // SDK module with an ELF hash export table.
  var sdk = g.sdk_base = 0x7100000000n, main = g.main_base = 0x7200000000n;
  g.memcpy_addr = 0x7000000010n;
  var impl = new Map(), names = [];
  function def(name, fn) { names.push(name); impl.set(name, fn); }
  function elfHash(name) { var h = 0; for (var j = 0; j < name.length; j++) { h = ((h << 4) + name.charCodeAt(j)) >>> 0; var hi = h & 0xf0000000; if (hi) h ^= hi >>> 24; h = (h & ~hi) >>> 0; } return h; }
  var byAddress = new Map();
  function buildTable() {
    var mod = sdk + 0x200000n; g.write32(sdk + 4n, 0x200000n); g.write32(mod, 0x30444f4dn); g.write32(mod + 4n, 0x100n);
    var dyn = mod + 0x100n, hashT = sdk + 0x210000n, strT = sdk + 0x220000n, symT = sdk + 0x240000n;
    var count = names.length + 1, buckets = 37;
    g.write64(dyn, 4n); g.write64(dyn + 8n, hashT - sdk); g.write64(dyn + 16n, 5n); g.write64(dyn + 24n, strT - sdk);
    g.write64(dyn + 32n, 6n); g.write64(dyn + 40n, symT - sdk); g.write64(dyn + 48n, 0n);
    g.write32(hashT, BigInt(buckets)); g.write32(hashT + 4n, BigInt(count));
    var bucketHeads = new Array(buckets).fill(0), chain = new Array(count).fill(0), strOff = 1;
    names.forEach(function (name, i) {
      var index = i + 1, sym = symT + BigInt(index * 24), addr = 0x300000n + BigInt(i * 16);
      g.write_string(strT + BigInt(strOff), name); g.write32(sym, BigInt(strOff)); g.write64(sym + 8n, addr); strOff += name.length + 1;
      byAddress.set(sdk + addr, name);
      var b = elfHash(name) % buckets; chain[index] = bucketHeads[b]; bucketHeads[b] = index;
    });
    bucketHeads.forEach(function (h, b) { g.write32(hashT + 8n + BigInt(b * 4), BigInt(h)); });
    chain.forEach(function (c, i) { g.write32(hashT + 8n + BigInt((buckets + i) * 4), BigInt(c)); });
    g.write32(sdk + 0x168b10n, 0xd40000c1n);
    [[0x771750n, 0xa9ba7bfdn], [0x7817c0n, 0xd10103ffn], [0x4bbb90n, 0xd101c3ffn], [0x4bc160n, 0xd10183ffn], [0x771100n, 0x72003c1fn],
     [0x7716d0n, 0x90023249n], [0x4bc7a0n, 0xa9bd7bfdn], [0x4bc570n, 0xa9bc7bfdn]].forEach(function (s) { g.write32(main + s[0], s[1]); });
    g.write64(main + 0x5e7bba0n + 0x180n, 0x7300000000n);
  }

  // nn::fs
  var handles = new Map(), nextHandle = 1n;
  function exists(path) { return stats.files.has(path) || stats.dirs.has(path); }
  function parent(path) { var i = path.lastIndexOf("/"); var p = path.slice(0, i); return p === "save:" ? "save:/" : p; }
  def("_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKci", function (h, p, mode) { var path = cstring(p); if (!stats.files.has(path)) return 0x202n; var id = nextHandle++; handles.set(id, { path: path, mode: Number(mode) }); g.write64(h, id); return 0n; });
  def("_ZN2nn2fs11GetFileSizeEPlNS0_10FileHandleE", function (s, h) { g.write64(s, BigInt(stats.files.get(handles.get(h).path).length)); return 0n; });
  def("_ZN2nn2fs8ReadFileENS0_10FileHandleElPvm", function (h, off, buf, n) { var f = stats.files.get(handles.get(h).path); putBytes(buf, f.subarray(Number(off), Number(off + n))); return 0n; });
  def("_ZN2nn2fs9CloseFileENS0_10FileHandleE", function (h) { if (!handles.delete(h)) stats.errors.push("double close"); return 0n; });
  def("_ZN2nn2fs10CreateFileEPKcl", function (p, size) { var path = cstring(p); if (exists(path)) return 0x402n; if (!stats.dirs.has(parent(path))) return 0x202n; stats.files.set(path, new Uint8Array(Number(size))); return 0n; });
  def("_ZN2nn2fs11SetFileSizeENS0_10FileHandleEl", function (h, size) { var e = handles.get(h), f = stats.files.get(e.path), n = new Uint8Array(Number(size)); n.set(f.subarray(0, Math.min(f.length, n.length))); stats.files.set(e.path, n); return 0n; });
  def("_ZN2nn2fs9WriteFileENS0_10FileHandleElPKvmRKNS0_11WriteOptionE", function (h, off, buf, n) { var e = handles.get(h); if (!(e.mode & 2)) return 0x1n; stats.files.get(e.path).set(bytesAt(buf, Number(n)), Number(off)); return 0n; });
  def("_ZN2nn2fs15CreateDirectoryEPKc", function (p) { var path = cstring(p); if (exists(path)) return 0x402n; if (!stats.dirs.has(parent(path))) return 0x202n; stats.dirs.add(path); return 0n; });
  def("_ZN2nn2fs10DeleteFileEPKc", function (p) { return stats.files.delete(cstring(p)) ? 0n : 0x202n; });
  def("_ZN2nn2fs6CommitEPKc", function (p) { if (cstring(p) !== "save") return 0x1n; stats.commits++; return 0n; });
  def("_ZN2nn2fs13OpenDirectoryEPNS0_15DirectoryHandleEPKci", function (h, p) { var path = cstring(p); if (!stats.dirs.has(path)) return 0x202n;
    var list = []; for (var f of stats.files.keys()) if (parent(f) === path) list.push({ name: f.slice(path.length + 1), dir: false, size: stats.files.get(f).length });
    for (var d of stats.dirs) if (d !== path && parent(d) === path) list.push({ name: d.slice(path.length + 1), dir: true, size: 0 });
    var id = nextHandle++; handles.set(id, { list: list, at: 0 }); g.write64(h, id); return 0n; });
  def("_ZN2nn2fs13ReadDirectoryEPlPNS0_14DirectoryEntryENS0_15DirectoryHandleEl", function (countPtr, buf, h, max) {
    var e = handles.get(h), n = 0; while (n < Number(max) && e.at < e.list.length) { var it = e.list[e.at++], at = buf + BigInt(n * 0x310);
      for (var i = 0; i < 0x310; i++) w8(at + BigInt(i), 0); g.write_string(at, it.name); w8(at + 0x304n, it.dir ? 0 : 1); g.write64(at + 0x308n, BigInt(it.size)); n++; }
    g.write64(countPtr, BigInt(n)); return 0n; });
  def("_ZN2nn2fs14CloseDirectoryENS0_15DirectoryHandleE", function (h) { handles.delete(h); return 0n; });
  // nn::hid
  var P = "_ZN2nn3hid6detail";
  // Controller id 0 is always connected (full key); id 1 is a second controller when stats.player2 is set.
  def(P + "15GetNpadStyleSetEPNS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEERKj", function (style, id) { var i = g.read32(id); g.write32(style, i === 0n || (i === 1n && stats.player2) ? 1n : 0n); return 0n; });
  ["17NpadHandheldState", "16NpadFullKeyState", "16NpadJoyDualState"].forEach(function (t, i) {
    def(P + "13GetNpadStatesEPiPNS0_" + t + "EiRKj", function (count, sample, n, idp) {
      var i = g.read32(idp), connected = i === 0n || (i === 1n && stats.player2);
      g.write32(count, 1n); g.write64(sample + 8n, BigInt(i === 1n ? (stats.buttons2 || 0) : stats.buttons)); g.write32(sample + 32n, connected ? 1n : 0n); return 0n; });
  });
  // nn::audio
  var queue = [];
  def("_ZN2nn5audio27InitializeAudioOutParameterEPNS0_17AudioOutParameterE", function () { return 0n; });
  def("_ZN2nn5audio19OpenDefaultAudioOutEPNS0_8AudioOutERKNS0_17AudioOutParameterE", function (out, param) { if (g.read32(param) !== 48000n || g.read16(param + 4n) !== 2n) return 0x5n; return 0n; });
  def("_ZN2nn5audio21SetAudioOutBufferInfoEPNS0_14AudioOutBufferEPvmm", function (node, data, cap, size) { if (data & 0xfffn) stats.errors.push("audio misaligned"); if (size > cap) stats.errors.push("audio overflow"); g.write64(node, size); return 0n; });
  def("_ZN2nn5audio20AppendAudioOutBufferEPNS0_8AudioOutEPNS0_14AudioOutBufferE", function (out, node) { queue.push({ node: node, at: performance.now() }); stats.audioAppended++; return 1n; });
  def("_ZN2nn5audio13StartAudioOutEPNS0_8AudioOutE", function () { stats.audioStarted = true; return 0n; });
  // Release buffers in real time: each buffer is ~16.7 ms of audio.
  var played = 0;
  def("_ZN2nn5audio25GetReleasedAudioOutBufferEPNS0_8AudioOutE", function () { if (!stats.audioStarted || !queue.length) return 0n;
    if (performance.now() - queue[0].at < 50) return 0n; return queue.shift().node; });
  def("_ZN2nn5audio12StopAudioOutEPNS0_8AudioOutE", function () { return 0n; });
  def("_ZN2nn5audio20FlushAudioOutBuffersEPNS0_8AudioOutE", function () { queue = []; return 0n; });
  def("_ZN2nn5audio13CloseAudioOutEPNS0_8AudioOutE", function () { return 0n; });
  buildTable();

  // Civ VII renderer
  var registered = new Set(), texHandle = 0n, desc = 0n;
  var mainImpl = {
    0x4bca00: function (prov, name) { return registered.has(cstring(name)) ? 1n : 0n; },
    0x771750: function (d, name) { desc = d; if (g.read32(d) === 85n && /reject/.test(location.search)) return 5n; texHandle = 100n; return texHandle; },
    0x771100: function (h) { var m = 0x7400000000n; g.write32(m + 4n, g.read32(desc + 0x10n)); g.write16(m + 8n, g.read32(desc + 0x14n)); g.write32(m + 0x20n, g.read32(desc)); return m; },
    0x7716d0: function () { return 1n; },
    0x4bbb90: function (prov, h, name) { registered.add(cstring(name)); return 0n; },
    0x4bc7a0: function () { return 1n; },
    0x4bc570: function () { stats.presents++; var w = Number(g.read32(desc + 0x10n)), h = Number(g.read32(desc + 0x14n)); stats.lastPixels = bytesAt(g.read64(desc + 0x20n), w * h * 4); return 0n; },
    0x4bc160: function (prov, name) { registered.delete(cstring(name)); return 0n; },
    0x7817c0: function () { texHandle = 0n; return 0n; }
  };
  g.call_rop = function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    args.forEach(function (a) { if (typeof a !== "bigint") stats.errors.push("non-BigInt arg to " + fn.toString(16)); });
    if (fn === g.memcpy_addr) { putBytes(args[0], bytesAt(args[1], Number(args[2]))); return args[0]; }
    if (fn === sdk + 0x168b0cn) { var p = args[2]; g.write64(args[0], p & ~0xffffffn); g.write64(args[0] + 8n, 0x10000000n); g.write32(args[0] + 24n, 7n); return 0n; }
    var name = byAddress.get(fn);
    if (name) { stats.calls[name] = (stats.calls[name] || 0) + 1; return impl.get(name).apply(null, args); }
    var off = Number(fn - main);
    if (mainImpl[off]) { stats.calls["main+" + off.toString(16)] = (stats.calls["main+" + off.toString(16)] || 0) + 1; return mainImpl[off].apply(null, args); }
    stats.errors.push("unknown call " + fn.toString(16)); return 0n;
  };
  g.log = function () { return Promise.resolve(); };
})(window);
