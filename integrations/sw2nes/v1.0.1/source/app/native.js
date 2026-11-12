/* SW2NES native platform: SDK files, Npad input, owned live texture, AudioOut.
 * Adapted from the console-verified CivHomebrew and Moonlight-CivSwitch bridges
 * (Civ VII 1.0.0). Evaluated in the CivSwitch loader scope so call_rop, malloc,
 * read/write helpers, sdk_base and main_base are lexically available. */
var SW2NESNative = (function () {
  "use strict";
  var available = typeof sdk_base !== "undefined" && typeof call_rop === "function" && typeof malloc === "function";
  if (!available) return { available: false };
  try { return create(); } catch (error) { return { available: false, error: String(error && error.message || error) }; }
  function create() {

  var cache = {};
  var mod = sdk_base + read32(sdk_base + 4n);
  if (read32(mod) !== 0x30444f4dn) throw Error("Unsupported SDK module.");
  var dynamic = mod + BigInt.asIntN(32, read32(mod + 4n)), tags = {};
  for (var i = 0; i < 128; i++) {
    var tag = Number(read64(dynamic + BigInt(i * 16))); if (!tag) break;
    var v = read64(dynamic + BigInt(i * 16 + 8)); tags[tag] = v < sdk_base ? sdk_base + v : v;
  }
  var table = tags[4], strings = tags[5], symbols = tags[6];
  if (!table || !strings || !symbols) throw Error("SDK export table missing.");
  var buckets = Number(read32(table)), count = Number(read32(table + 4n));
  if (buckets < 1 || buckets > 1000000 || count < 1 || count > 1000000) throw Error("Invalid SDK export bounds.");

  function resolve(name) {
    if (cache[name]) return cache[name];
    var hash = 0;
    for (var j = 0; j < name.length; j++) {
      hash = ((hash << 4) + name.charCodeAt(j)) >>> 0;
      var high = hash & 0xf0000000; if (high) hash ^= high >>> 24; hash = (hash & ~high) >>> 0;
    }
    var index = Number(read32(table + 8n + BigInt((hash % buckets) * 4)));
    for (var k = 0; index && k < count; k++) {
      if (index >= count) throw Error("Invalid SDK symbol chain.");
      var symbol = symbols + BigInt(index * 24), p = strings + read32(symbol), s = "";
      for (var q = 0; q < 512; q++) { var ch = Number(read8(p + BigInt(q))); if (!ch) break; s += String.fromCharCode(ch); }
      if (s === name) { var offset = read64(symbol + 8n); if (offset) return cache[name] = sdk_base + offset; break; }
      index = Number(read32(table + 8n + BigInt((buckets + index) * 4)));
    }
    throw Error("Missing SDK export: " + name);
  }
  function call(name) { return call_rop.apply(null, [resolve(name)].concat(Array.prototype.slice.call(arguments, 1).map(BigInt))); }
  function code(v) { return Number(v & 0x3fffffn); }
  function checked(name) { var r = call.apply(null, arguments); if (code(r)) throw Error(name.replace(/^_ZN2nn\w*?\d+/, "") + " failed: 0x" + code(r).toString(16)); return r; }
  function alloc(n) { var p = malloc(n); if (!p) throw Error("Native allocation failed."); return p; }

  /* ---- Module heap <-> native memory (memcpy with the heap's backing store) ---- */
  var heapBuffer = null, heapAddress = 0n;
  function heapBase(heap) {
    if (heap.byteOffset !== 0 || heap.byteLength !== heap.buffer.byteLength) throw Error("Expected the complete core heap view.");
    if (heap.buffer === heapBuffer) return heapAddress;
    var object = addrof_compressed(heap), external = read64_compressed(object + 0x28n), compressedBase = read32_compressed(object + 0x30n);
    if (compressedBase !== 0n || external < 0x100000000n || external >= 0x8000000000n) throw Error("Core heap is not a validated external buffer.");
    for (var i = 0; i < 32; i++) if (Number(read8(external + BigInt(i))) !== heap[i]) throw Error("Core heap pointer verification failed.");
    heapBuffer = heap.buffer; heapAddress = external; return external;
  }
  function bounds(heap, pointer, length) {
    pointer = pointer >>> 0;
    if (!Number.isInteger(length) || length < 0 || pointer + length > heap.length) throw Error("Heap range rejected.");
    return pointer;
  }
  function toNative(heap, pointer, length, destination) {
    pointer = bounds(heap, pointer, length);
    if (length) call_rop(memcpy_addr, destination, heapBase(heap) + BigInt(pointer), BigInt(length));
  }
  function fromNative(heap, pointer, length, source) {
    pointer = bounds(heap, pointer, length);
    if (length) call_rop(memcpy_addr, heapBase(heap) + BigInt(pointer), source, BigInt(length));
  }

  /* ---- Files on the save: mount ---- */
  function pause() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function cstr(path) {
    if (typeof path !== "string" || !/^save:\//.test(path) || /[\\\x00-\x1f\x7f]/.test(path) || path.length > 0x300) throw Error("Invalid save path.");
    return alloc_string(path);
  }
  function pathOp(name, path, allowed) {
    var p = cstr(path);
    try { var r = code(call("_ZN2nn2fs" + name, p)); if (r && r !== allowed) throw Error("Save operation failed: 0x" + r.toString(16)); return r; }
    finally { free(p); }
  }
  function decodeName(raw) {
    try { return decodeURIComponent(escape(raw)); } catch (_) { return raw; }
  }
  // SDK DirectoryEntry: name[0x301], type +0x304, size +0x308, stride 0x310.
  async function list(path) {
    var p, handle, n8, buffer, opened = false, entries = [];
    try {
      p = cstr(path); handle = alloc(8); n8 = alloc(8); buffer = alloc(0x310 * 16);
      var r = code(call("_ZN2nn2fs13OpenDirectoryEPNS0_15DirectoryHandleEPKci", handle, p, 3));
      if (r === 0x202) return null; if (r) throw Error("Open directory failed: 0x" + r.toString(16));
      opened = true;
      for (;;) {
        write32(n8, 0n); write32(n8 + 4n, 0n);
        checked("_ZN2nn2fs13ReadDirectoryEPlPNS0_14DirectoryEntryENS0_15DirectoryHandleEl", n8, buffer, read64(handle), 16);
        var n = Number(read64(n8)); if (!Number.isInteger(n) || n < 0 || n > 16) throw Error("Invalid directory read.");
        if (!n || entries.length > 4096) break;
        for (var i = 0; i < n; i++) {
          var at = buffer + BigInt(i * 0x310), name = "";
          for (var c = 0; c < 0x300; c++) { var b = Number(read8(at + BigInt(c))); if (!b) break; name += String.fromCharCode(b); }
          var type = Number(read8(at + 0x304n)), size = Number(read64(at + 0x308n));
          if (name && name !== "." && name !== "..") entries.push({ name: decodeName(name), raw: name, dir: type === 0, size: type === 0 ? 0 : size });
        }
        await pause();
      }
      return entries;
    } finally {
      try { if (opened) call("_ZN2nn2fs14CloseDirectoryENS0_15DirectoryHandleE", read64(handle)); }
      finally { [buffer, n8, handle, p].forEach(function (x) { if (x) free(x); }); }
    }
  }
  // Reads a whole file into the module heap at allocate(size). Returns size, or -1 if missing.
  async function readInto(path, heap, allocate, limit) {
    var p, handle, size8, buffer, opened = false;
    try {
      p = cstr(path); handle = alloc(8); size8 = alloc(8);
      var r = code(call("_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKci", handle, p, 1));
      if (r === 0x202) return -1; if (r) throw Error("Open file failed: 0x" + r.toString(16));
      opened = true;
      checked("_ZN2nn2fs11GetFileSizeEPlNS0_10FileHandleE", size8, read64(handle));
      var length = Number(read64(size8));
      if (!Number.isSafeInteger(length) || length < 0 || length > limit) throw Error("File is too large (" + length + " bytes).");
      var target = allocate(length); if (length && !target) throw Error("Out of emulator memory.");
      var chunk = 262144; buffer = alloc(chunk);
      for (var off = 0; off < length; off += chunk) {
        var n = Math.min(chunk, length - off);
        checked("_ZN2nn2fs8ReadFileENS0_10FileHandleElPvm", read64(handle), off, buffer, n);
        fromNative(heap(), target + off, n, buffer);
        if (off + n < length) await pause();
      }
      return length;
    } finally {
      try { if (opened) call("_ZN2nn2fs9CloseFileENS0_10FileHandleE", read64(handle)); }
      finally { [buffer, size8, handle, p].forEach(function (x) { if (x) free(x); }); }
    }
  }
  // Writes heap[pointer, pointer+length) to a file, replacing it. Caller commits.
  function writeFrom(path, heap, pointer, length) {
    var p, handle, option, buffer, opened = false;
    try {
      p = cstr(path); handle = alloc(8); option = alloc(8); buffer = alloc(Math.max(16, length));
      var r = code(call("_ZN2nn2fs10CreateFileEPKcl", p, length)); if (r && r !== 0x402) throw Error("Create file failed: 0x" + r.toString(16));
      checked("_ZN2nn2fs8OpenFileEPNS0_10FileHandleEPKci", handle, p, 6); opened = true;
      checked("_ZN2nn2fs11SetFileSizeENS0_10FileHandleEl", read64(handle), length);
      toNative(heap, pointer, length, buffer); write32(option, 1n);
      checked("_ZN2nn2fs9WriteFileENS0_10FileHandleElPKvmRKNS0_11WriteOptionE", read64(handle), 0, buffer, length, option);
    } finally {
      try { if (opened) call("_ZN2nn2fs9CloseFileENS0_10FileHandleE", read64(handle)); }
      finally { [buffer, option, handle, p].forEach(function (x) { if (x) free(x); }); }
    }
  }
  var files = {
    list: list, readInto: readInto, writeFrom: writeFrom,
    mkdir: function (path) { pathOp("15CreateDirectoryEPKc", path, 0x402); },
    remove: function (path) { pathOp("10DeleteFileEPKc", path, 0x202); },
    commit: function () {
      var p = alloc_string("save");
      try { var r = code(call("_ZN2nn2fs6CommitEPKc", p)); if (r) throw Error("Save commit failed: 0x" + r.toString(16)); }
      finally { free(p); }
    }
  };

  /* ---- Controller: first connected Npad (handheld, Pro/full key, dual Joy-Con) ---- */
  function controller() {
    var prefix = "_ZN2nn3hid6detail", owned = [], selected = null, nextScan = 0, closed = false;
    var styles = resolve(prefix + "15GetNpadStyleSetEPNS_4util10BitFlagSetILi32ENS0_12NpadStyleTagEEERKj");
    var getters = [{ bit: 2, name: "17NpadHandheldState" }, { bit: 1, name: "16NpadFullKeyState" }, { bit: 4, name: "16NpadJoyDualState" }]
      .map(function (t) { return { bit: t.bit, address: resolve(prefix + "13GetNpadStatesEPiPNS0_" + t.name + "EiRKj") }; });
    function take(n) { var p = alloc(n); owned.push(p); return p; }
    var id = take(8), style = take(8), n8 = take(8), sample = take(64);
    function read(ctrl, getter) {
      write32(id, BigInt(ctrl)); write32(n8, 0n);
      if (code(call_rop(getter.address, n8, sample, 1n, id))) throw Error("Controller state failed.");
      if (read32(n8) !== 1n || !(read32(sample + 32n) & 1n)) return null;
      return Number(read64(sample + 8n) & 0xffffffffn);
    }
    // Up to two players: player 1 is the handheld console (when attached) or
    // the first controller found, player 2 the next one. While a player slot
    // is empty, one candidate id is checked per poll (spreads the native calls
    // so no single frame pays for a full scan).
    var players = [null, null], last = [0, 0], ids = [32, 0, 1, 2, 3, 4, 5, 6, 7], probeAt = 0, probeTick = 0;
    function probeOne() {
      var cid = ids[probeAt]; probeAt = (probeAt + 1) % ids.length;
      if ((players[0] && players[0].id === cid) || (players[1] && players[1].id === cid)) return;
      write32(id, BigInt(cid)); write32(style, 0n);
      if (code(call_rop(styles, style, id))) throw Error("Controller style failed.");
      var bits = Number(read32(style));
      for (var g = 0; g < getters.length; g++) if (bits & getters[g].bit) {
        if (read(cid, getters[g]) !== null) {
          var entry = { id: cid, getter: getters[g] };
          // the handheld console always takes player 1
          if (!players[0] || (cid === 32 && players[0].id !== 32)) { if (players[0]) players[1] = players[0]; players[0] = entry; }
          else if (!players[1]) players[1] = entry;
          return;
        }
      }
    }
    function pollPlayer(i) {
      var p = players[i]; if (!p) return 0;
      var v = read(p.id, p.getter); if (v === null) { players[i] = null; if (i === 0 && players[1]) { players[0] = players[1]; players[1] = null; } return 0; }
      return v;
    }
    return {
      poll: function () {
        if (closed) return 0;
        if ((!players[0] || !players[1]) && (++probeTick % 15 === 0 || !players[0])) probeOne();
        last[0] = pollPlayer(0); last[1] = pollPlayer(1);
        return last[0];
      },
      player2: function () { return last[1]; },     // read by poll(); 0 when no second controller
      players: function () { return (players[0] ? 1 : 0) + (players[1] ? 1 : 0); },
      close: function () { if (closed) return; closed = true; owned.reverse().forEach(free); owned = []; }
    };
  }

  /* ---- Owned RGBA texture shown through Civ VII's live-image provider ---- */
  var textureSequence = 0;
  // format: DXGI code; 28 = R8G8B8A8 (console-verified); 85 = B5G6R5 (accepted but
  // not displayed by Civ VII); 86 = B5G5R5A1 (experimental).
  // buffers > 1: rotate between that many native pixel buffers, so the
  // renderer never reads the buffer being written for the next frame.
  function texture(width, height, format, buffers) {
    format = format || 28; buffers = Math.max(1, Math.min(4, buffers || 1));
    var bpp = format === 85 || format === 86 ? 2 : 4;
    var allocations = [], handle = 0n, provider = 0n, published = false, closed = false;
    var byteLength = width * height * bpp, info, page, pixels, description, name;
    var imageName = "sw2nes/" + Date.now().toString(36) + "-" + (++textureSequence), url = "live:/" + imageName;
    function talloc(n) { var p = alloc(n); allocations.push(p); return p; }
    function invoke(offset, args) { return call_rop.apply(null, [main_base + offset].concat(args)); }
    function range(p, n, permissions) {
      if (call_rop(sdk_base + 0x168b0cn, info, page, p) & 0x3fffffn) throw Error("Texture memory query failed.");
      var base = read64(info), end = base + read64(info + 8n);
      if ((Number(read32(info + 24n)) & permissions) !== permissions || p < base || p + BigInt(n) > end) throw Error("Texture memory range rejected.");
    }
    function pointer(p) { range(p, 8, 1); return read64(p); }
    function close() {
      if (closed) return; closed = true;
      try {
        if (published) { invoke(0x4bc160n, [provider, name]); published = false; }
        if (handle) { invoke(0x7817c0n, [handle]); handle = 0n; }
      } finally { allocations.reverse().forEach(free); allocations = []; }
    }
    try {
      info = talloc(64); page = talloc(8);
      if (read32(sdk_base + 0x168b10n) !== 0xd40000c1n) throw Error("Unsupported memory query ABI.");
      var signatures = [[0x771750n, 0xa9ba7bfdn], [0x7817c0n, 0xd10103ffn], [0x4bbb90n, 0xd101c3ffn], [0x4bc160n, 0xd10183ffn],
        [0x771100n, 0x72003c1fn], [0x7716d0n, 0x90023249n], [0x4bc7a0n, 0xa9bd7bfdn], [0x4bc570n, 0xa9bc7bfdn], [0x4bca00n, null]];
      for (var s = 0; s < signatures.length; s++) {
        range(main_base + signatures[s][0], 8, 5);
        if (signatures[s][1] !== null && read32(main_base + signatures[s][0]) !== signatures[s][1]) throw Error("Unsupported Civ VII build for native video.");
      }
      provider = pointer(main_base + 0x5e7bba0n + 0x180n); range(provider, 64, 3);
      name = talloc(128); write_string(name, imageName);
      if (invoke(0x4bca00n, [provider, name]) & 0xffffn) throw Error("Video image name already registered.");
      var pool = []; for (var pb = 0; pb < buffers; pb++) pool.push(talloc(byteLength));
      var poolIndex = 0; pixels = pool[0]; description = talloc(0x448);
      write32(description, BigInt(format)); write32(description + 4n, 0n); write32(description + 8n, 1n);
      write32(description + 0x10n, BigInt(width)); write32(description + 0x14n, BigInt(height)); write32(description + 0x18n, 1n);
      write64(description + 0x20n, pixels);
    } catch (error) { close(); throw error; }
    function present(heap, pointerInHeap) {
      if (closed) throw Error("Texture closed.");
      var existing = !!handle;
      if (buffers > 1 && existing) { poolIndex = (poolIndex + 1) % buffers; pixels = pool[poolIndex]; write64(description + 0x20n, pixels); }
      toNative(heap, pointerInHeap, byteLength, pixels);
      if (!handle) {
        handle = invoke(0x771750n, [description, name, 1n, 0x4an, 0n]) & 0xffffn;
        if (handle < 22n) { handle = 0n; throw Error("Renderer rejected the video texture."); }
        var metadata = invoke(0x771100n, [handle]); range(metadata, 64, 1);
        if (read32(metadata + 4n) !== BigInt(width) || read16(metadata + 8n) !== BigInt(height) || read32(metadata + 0x20n) !== BigInt(format)) throw Error("Video texture metadata mismatch (format " + format + ").");
      }
      if (existing && !invoke(0x7716d0n, [handle, description, name, 0n, 0x4an, 0n])) throw Error("Video texture update failed.");
      if (!published) {
        invoke(0x4bbb90n, [provider, handle, name]); published = true;
        if (!invoke(0x4bc7a0n, [provider, handle])) throw Error("Cannot enable dynamic video texture.");
      }
      invoke(0x4bc570n, [provider, handle]);
      return url;
    }
    return { url: url, present: present, close: close, format: format, bytes: byteLength, buffers: buffers };
  }

  /* ---- AudioOut: 48 kHz stereo s16, one buffer per emulated frame ---- */
  function audio(poolSize) {
    var owned = [], out, parameter, buffers = [], opened = false, started = false, closed = false, queued = 0, dropped = 0;
    function aalloc(n) { var p = alloc(n); owned.push(p); return p; }
    var capacity = 0x4000; // 4096 stereo frames per buffer: up to ~5 NES frames per tick
    function close() {
      if (closed) return; closed = true;
      try {
        if (opened) {
          if (started) call("_ZN2nn5audio12StopAudioOutEPNS0_8AudioOutE", out);
          call("_ZN2nn5audio20FlushAudioOutBuffersEPNS0_8AudioOutE", out);
          call("_ZN2nn5audio13CloseAudioOutEPNS0_8AudioOutE", out);
        }
      } finally { owned.reverse().forEach(free); owned = []; }
    }
    try {
      out = aalloc(1024); parameter = aalloc(64);
      call("_ZN2nn5audio27InitializeAudioOutParameterEPNS0_17AudioOutParameterE", parameter);
      write32(parameter, 48000n); write16(parameter + 4n, 2n);
      var r = call("_ZN2nn5audio19OpenDefaultAudioOutEPNS0_8AudioOutERKNS0_17AudioOutParameterE", out, parameter);
      if (code(r)) throw Error("AudioOut failed: 0x" + code(r).toString(16));
      opened = true;
      for (var i = 0; i < poolSize; i++) buffers.push({ node: aalloc(64), data: (aalloc(capacity + 4096) + 4095n) & ~4095n, busy: false });
    } catch (error) { close(); throw error; }
    function reclaim() {
      if (!started) return;
      for (var i = 0; i < buffers.length; i++) {
        var released = call("_ZN2nn5audio25GetReleasedAudioOutBufferEPNS0_8AudioOutE", out); if (!released) break;
        for (var j = 0; j < buffers.length; j++) if (buffers[j].node === released) { buffers[j].busy = false; break; }
      }
    }
    function freeBuffer() { for (var i = 0; i < buffers.length; i++) if (!buffers[i].busy) return buffers[i]; return null; }
    function busyCount() { var n = 0; for (var i = 0; i < buffers.length; i++) if (buffers[i].busy) n++; return n; }
    function push(heap, pointer, frames) {
      if (closed || frames <= 0) return;
      var bytes = Math.min(frames * 4, capacity);
      // Ask the driver for released buffers only when none are known free.
      var buffer = freeBuffer(); if (!buffer) { reclaim(); buffer = freeBuffer(); }
      if (!buffer) { dropped++; return; }
      toNative(heap, pointer, bytes, buffer.data);
      call("_ZN2nn5audio21SetAudioOutBufferInfoEPNS0_14AudioOutBufferEPvmm", buffer.node, buffer.data, capacity, bytes);
      if (!call("_ZN2nn5audio20AppendAudioOutBufferEPNS0_8AudioOutEPNS0_14AudioOutBufferE", out, buffer.node)) { dropped++; return; }
      buffer.busy = true; queued++;
      // Start once two ticks are queued (~35-70 ms of cushion).
      if (!started && busyCount() >= 2) {
        var s = call("_ZN2nn5audio13StartAudioOutEPNS0_8AudioOutE", out);
        if (code(s)) throw Error("AudioOut start failed: 0x" + code(s).toString(16));
        started = true;
      }
    }
    return { push: push, close: close, pending: function () { reclaim(); return busyCount(); }, stats: function () { return { queued: queued, dropped: dropped }; } };
  }

  // Diagnostics: average cost of one trivial native call (1-byte memcpy).
  function benchCalls(n) {
    var p = alloc(16);
    try {
      var t = Date.now(), start = (typeof performance !== "undefined" && performance.now) ? performance.now() : t;
      for (var i = 0; i < n; i++) call_rop(memcpy_addr, p, p + 8n, 1n);
      var end = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      return (end - start) / n;
    } finally { free(p); }
  }

  return { available: true, files: files, controller: controller, texture: texture, audio: audio, heapBase: heapBase, benchCalls: benchCalls };
  }
})();
