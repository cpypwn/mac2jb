// Per-stage cost per frame (needs a STAGE_PROFILE=1 runtime).
// Usage: node --jitless bench/stages.cjs RUNTIME.js FRAMES ROM...
const fs = require('fs'), path = require('path');
const [rt, framesArg, ...roms] = process.argv.slice(2), FRAMES = Number(framesArg || 1500);
(async () => {
  for (const romPath of roms) for (const render of [1, 0]) {
    delete require.cache[require.resolve(path.resolve(rt))];
    const core = await require(path.resolve(rt))(), rom = fs.readFileSync(romPath); if (process.env.F16) core._nes_set_format16(1); if (process.env.HEAVY) core._nes_test_force_heavy(1);
    core.HEAPU8.set(rom, core._nes_rom_alloc(rom.length)); if (core._nes_load()) throw Error('load');
    for (let i = 0; i < 300; i++) { core._nes_frame(i % 120 < 5 ? 8 : 0x81, 0, 1); core._nes_audio_take(); }
    const base = core._nes_prof_ptr() >> 3, before = [...core.HEAPF64.subarray(base, base + 8)];
    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) { if (process.env.FULL) core._nes_invalidate_video(); core._nes_frame(i % 120 < 5 ? 8 : (i % 7 < 3 ? 0x81 : 0x01), 0, render); core._nes_audio_take(); }
    const total = (performance.now() - t0) / FRAMES, p = [...core.HEAPF64.subarray(base, base + 8)].map((v, i) => (v - before[i]) / FRAMES);
    const f = x => x.toFixed(3).padStart(6);
    console.log(`${path.basename(romPath).slice(0, 22).padEnd(22)} ${render ? 'drawn' : 'skip '} total ${f(total)}  cpu ${f(p[1])}  ppu+apu+other ${f(p[0] - p[1])}  convert ${f(p[2])}  audio ${f(p[3])}  runs/frame ${p[4].toFixed(1)}  palUpd ${(p[5]*100).toFixed(0)}%  fullConv ${(p[6]*100).toFixed(0)}%  paletteMs ${p[7].toFixed(3)}  outside ${f(total - p[0] - p[2] - p[3])}`);
  }
})();
