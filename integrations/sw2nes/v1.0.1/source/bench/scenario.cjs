// Scripted gameplay scenario for realistic (scrolling) benchmarks.
// Usage: node [--jitless] bench/scenario.cjs RUNTIME.js ROM SCRIPT.json [snapshotDir]
// SCRIPT: {"frames":N, "input":[[fromFrame, toFrame, padBits],...], "snap":[frame,...], "measureFrom":F}
// pad bits: A=1 B=2 Select=4 Start=8 Up=16 Down=32 Left=64 Right=128
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [rt, romPath, scriptPath, snapDir] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
function png(file, rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(w, 0); hdr.writeUInt32BE(h, 4); hdr[8] = 8; hdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
(async () => {
  const core = await require(path.resolve(rt))(), rom = fs.readFileSync(romPath);
  core.HEAPU8.set(rom, core._nes_rom_alloc(rom.length)); if (core._nes_load()) throw Error('load');
  const w = core._nes_width(), h = core._nes_height(), snaps = new Set(script.snap || []);
  const from = script.measureFrom || 0; let t = 0, n = 0, prev = null, changedSum = 0;
  for (let f = 0; f < script.frames; f++) {
    if (f === from && core._nes_prof_ptr) { core.HEAPF64.fill(0, core._nes_prof_ptr() >> 3, (core._nes_prof_ptr() >> 3) + 8); if (core.sw2nesOpcodes) { core.sw2nesOpcodes.fill(0); core.sw2nesCbTime.fill(0); core.sw2nesCbCount.fill(0); } }
    let pad = 0; for (const [a, b, bits] of script.input) if (f >= a && f < b) pad |= bits;
    const t0 = performance.now(); core._nes_frame(pad, 0, 1); const dt = performance.now() - t0; core._nes_audio_take();
    const img = new Uint32Array(core.HEAPU8.buffer, core._nes_video(), w * h);
    if (f >= from) { t += dt; n++; if (prev) { let c = 0; for (let i = 0; i < img.length; i += 4) if (img[i] !== prev[i]) c++; changedSum += c / (img.length / 4); } prev = img.slice(); }
    if (snapDir && snaps.has(f)) png(path.join(snapDir, `f${f}.png`), new Uint8Array(img.buffer, img.byteOffset, w * h * 4).slice(), w, h);
  }
  const out = { rom: path.basename(romPath), measuredFrames: n, drawnMs: +(t / n).toFixed(3), changedPixelShare: +(changedSum / Math.max(1, n - 1)).toFixed(2) };
  if (core._nes_prof_ptr) { const b = core._nes_prof_ptr() >> 3, p = core.HEAPF64.subarray(b, b + 8); out.stagesAllFrames = { frame: +(p[0] / n).toFixed(3), cpu: +(p[1] / n).toFixed(3), cpuCallbacksC: +(p[5] / n).toFixed(3), instructions: Math.round(p[6] / n), convert: +(p[2] / n).toFixed(3) }; }
  if (core.sw2nesOpcodes) {
    const ops = [...core.sw2nesOpcodes].map((c, o) => [o, c]).sort((a, b) => b[1] - a[1]), tot = ops.reduce((x, y) => x + y[1], 0);
    out.topOpcodes = ops.slice(0, 24).map(([o, c]) => o.toString(16).padStart(2, '0') + ':' + (100 * c / tot).toFixed(1) + '%').join(' ');
    const cb = [...core.sw2nesCbTime].map((t, a) => [a, t, core.sw2nesCbCount[a]]).filter(x => x[2]).sort((a, b) => b[1] - a[1]);
    out.topCallbacks = cb.slice(0, 14).map(([a, t, c]) => '$' + a.toString(16) + ' ' + (t / n).toFixed(3) + 'ms ' + (c / n).toFixed(1) + '/f').join(' | ');
  }
  console.log(JSON.stringify(out, null, 1));
})();
