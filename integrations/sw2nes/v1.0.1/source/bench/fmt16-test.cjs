// Checks 16-bit output == RGBA output packed to B5G6R5, every drawn frame.
// Usage: node bench/fmt16-test.cjs RUNTIME.js FRAMES ROM...
const fs = require('fs'), path = require('path');
const [rt, framesArg, ...roms] = process.argv.slice(2), FRAMES = Number(framesArg || 3000), MODE = Number(process.env.MODE || 1);
async function boot(rom, f16) {
  delete require.cache[require.resolve(path.resolve(rt))];
  const core = await require(path.resolve(rt))(); core._nes_set_format16(f16);
  core.HEAPU8.set(rom, core._nes_rom_alloc(rom.length)); if (core._nes_load()) throw Error('load');
  return core;
}
(async () => {
  let fail = false;
  for (const romPath of roms) {
    const rom = fs.readFileSync(romPath), A = await boot(rom, 0), B = await boot(rom, MODE);
    if (process.env.HEAVY) { A._nes_test_force_heavy(1); B._nes_test_force_heavy(1); }
    const w = A._nes_width(), h = A._nes_height(); let seed = 99 ^ rom.length, pad = 0, bad = null;
    for (let i = 0; i < FRAMES && !bad; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; if (i % 8 === 0) pad = (seed >>> 8) & 0xFF; if (i % 97 < 3) pad = 8;
      const render = i % 2 === 0 || i % 7 === 0 ? 1 : 0;
      A._nes_frame(pad, 0, render); B._nes_frame(pad, 0, render); A._nes_audio_take(); B._nes_audio_take();
      if (!render) continue;
      const ra = new Uint32Array(A.HEAPU8.buffer, A._nes_video(), w * h), rb = new Uint16Array(B.HEAPU8.buffer, B._nes_video(), w * h);
      for (let k = 0; k < w * h; k++) {
        const v = ra[k], r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255, e = MODE === 2 ? (0x8000 | ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)) : (((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
        if (rb[k] !== e) { bad = { frame: i, pixel: k, want: e, got: rb[k] }; break; }
      }
    }
    if (bad) { fail = true; console.log('FAIL', path.basename(romPath), JSON.stringify(bad)); } else console.log('ok  ', path.basename(romPath).slice(0, 40), FRAMES, 'frames: 16-bit mode ' + MODE + ' matches RGBA');
  }
  process.exit(fail ? 1 : 0);
})();
