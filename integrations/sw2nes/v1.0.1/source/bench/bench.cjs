// Usage: node --jitless bench/bench.cjs ROM.nes [frames] [renderEvery]
// Measures emulation speed of the generated wasm2js runtime.
const fs = require('fs');
const path = require('path');
const QuickNESCore = require(path.resolve(process.env.RUNTIME || path.join(__dirname, '../dist/runtime/quicknes.js')));
(async () => {
  const [romPath, framesArg, renderArg] = process.argv.slice(2);
  const lean = !!process.env.LEAN;
  const frames = Number(framesArg || 600), renderEvery = Number(renderArg || 1);
  const core = await QuickNESCore();
  const rom = fs.readFileSync(romPath);
  const p = core._nes_rom_alloc(rom.length);
  core.HEAPU8.set(rom, p);
  const err = core._nes_load();
  if (err) throw Error('Load failed: ' + core.UTF8ToString(err));
  // Press Start periodically so the game leaves its title screen.
  let samples = 0, t0 = performance.now(), times = [];
  for (let i = 0; i < frames; i++) {
    const pad = (i % 120 < 5) ? 0x08 : (i % 7 < 3 ? 0x81 : 0x01);
    const s = lean ? 0 : performance.now();
    const n = core._nes_frame(pad, 0, i % renderEvery === 0 ? 1 : 0);
    if (!lean) times.push(performance.now() - s); else times.push(0);
    if (core._nes_audio_take) core._nes_audio_take();
    if (n < 0) throw Error('Frame failed ' + n);
    samples += n;
  }
  const total = performance.now() - t0;
  times.sort((a, b) => a - b);
  const video = new Uint32Array(core.HEAPU8.buffer, core._nes_video(), core._nes_width() * core._nes_height());
  let hash = 0; for (let i = 0; i < video.length; i++) hash = (hash * 31 + video[i]) >>> 0;
  console.log(JSON.stringify({
    jitless: process.execArgv.includes('--jitless'), frames, renderEvery,
    fps: +(frames * 1000 / total).toFixed(1), msPerFrame: +(total / frames).toFixed(2),
    p50: +times[frames >> 1].toFixed(2), p95: +times[Math.floor(frames * .95)].toFixed(2),
    samplesPerFrame: +(samples / frames).toFixed(1), battery: core._nes_has_battery(),
    stateBytes: core._nes_state_save(), frameHash: hash.toString(16)
  }));
})().catch(e => { console.error(e); process.exit(1); });
