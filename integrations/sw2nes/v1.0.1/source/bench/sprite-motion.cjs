// Regression test for sub-4-pixel sprite placement (wasm2js unaligned stores).
// SMB1: walk right, stop, and check that the drawn Goomba tracks its RAM
// position every frame (constant offset), instead of 4-pixel jumps.
// Usage: node bench/sprite-motion.cjs RUNTIME.js smb.nes
const fs = require('fs'), path = require('path');
const [rt, rom] = process.argv.slice(2);
(async () => {
  const core = await require(path.resolve(rt))(), r = fs.readFileSync(rom);
  core.HEAPU8.set(r, core._nes_rom_alloc(r.length)); if (core._nes_load()) throw Error('load');
  const W = core._nes_width(), H = core._nes_height(); let colour = null; const offsets = [];
  for (let f = 0; f < 520; f++) {
    const pad = (f >= 60 && f < 66) ? 8 : (f >= 250 && f < 335) ? 128 : 0;
    core._nes_frame(pad, 0, 1); core._nes_audio_take();
    if (f < 380) continue;
    const ram = core.HEAPU8.subarray(core._nes_ram(), core._nes_ram() + 0x800), scr = ram[0x71A] * 256 + ram[0x71C];
    if (!ram[0x0F]) continue;
    const gx = ram[0x6E] * 256 + ram[0x87] - scr, img = new Uint8Array(core.HEAPU8.buffer, core._nes_video(), W * H * 4);
    if (gx < 150 || gx > 230) continue;
    if (!colour) { colour = [153, 79, 0]; }
    let lead = -1;
    for (let x = 140; x < 256 && lead < 0; x++) for (let y = 176; y < 200; y++) { const i = (y * W + x) * 4; if (img[i] === colour[0] && img[i + 1] === colour[1] && img[i + 2] === colour[2]) { lead = x; break; } }
    if (lead >= 0) offsets.push(lead - gx);
  }
  const distinct = [...new Set(offsets)];
  const ok = offsets.length > 40 && distinct.length <= 2;
  console.log(`${ok ? 'ok  ' : 'FAIL'} sprite motion: ${offsets.length} frames, drawn-minus-RAM offsets seen: ${distinct.join(',')}`);
  process.exit(ok ? 0 : 1);
})();
