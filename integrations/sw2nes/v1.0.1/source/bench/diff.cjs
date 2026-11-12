// Differential test: reference runtime (C CPU) vs candidate (JS CPU).
// Usage: node bench/diff.cjs REF.js CAND.js FRAMES ROM...
// Feeds identical pseudo-random input; compares frame status, video, audio
// every frame and the full save state every 30 frames. Exit 1 on divergence.
const fs = require('fs');
const path = require('path');
const [refPath, candPath, framesArg, ...roms] = process.argv.slice(2);
const FRAMES = Number(framesArg || 3000);

function fnv(u8, start, end, h = 2166136261) {
  for (let i = start; i < end; i++) h = Math.imul(h ^ u8[i], 16777619);
  return h >>> 0;
}
async function boot(file, rom) {
  delete require.cache[require.resolve(path.resolve(file))];
  const core = await require(path.resolve(file))();
  const p = core._nes_rom_alloc(rom.length); core.HEAPU8.set(rom, p);
  const err = core._nes_load(); if (err) throw Error(core.UTF8ToString(err));
  return core;
}
function snapshot(core, n, render) {
  const u8 = core.HEAPU8, w = core._nes_width(), h = core._nes_height();
  const s = { n, video: render ? fnv(u8, core._nes_video(), core._nes_video() + w * h * 4) : 0 };
  const take = core._nes_audio_take(); s.audio = fnv(u8, core._nes_audio(), core._nes_audio() + take * 4); s.samples = take;
  return s;
}
function stateHash(core) {
  const len = core._nes_state_save(); const p = core._nes_state_buffer(len);
  return { len, hash: fnv(core.HEAPU8, p, p + len), bytes: core.HEAPU8.slice(p, p + len) };
}
(async () => {
  let failed = false;
  for (const romPath of roms) {
    const rom = fs.readFileSync(romPath);
    const ref = await boot(refPath, rom), cand = await boot(candPath, rom);
    if (process.env.HEAVY && cand._nes_test_force_heavy) cand._nes_test_force_heavy(1);
    let seed = 12345 ^ rom.length, pad = 0, bad = null, t0 = Date.now();
    for (let i = 0; i < FRAMES && !bad; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      if (i % 8 === 0) pad = (seed >>> 8) & 0xFF;          // change input every 8 frames
      if (i % 97 < 3) pad = 0x08;                           // periodic Start
      if (i % 503 === 250) { ref._nes_reset(0); cand._nes_reset(0); }
      const render = i % 3 === 0 ? 1 : 0;                   // mix drawn and skipped frames
      const r1 = ref._nes_frame(pad, 0, render), r2 = cand._nes_frame(pad, 0, render);
      const a = snapshot(ref, i, render), b = snapshot(cand, i, render);
      if (r1 !== r2 || a.video !== b.video || a.audio !== b.audio || a.samples !== b.samples) bad = { frame: i, why: 'frame', a, b, r1, r2 };
      else if (i % 30 === 29) {
        const sa = stateHash(ref), sb = stateHash(cand);
        if (sa.hash !== sb.hash || sa.len !== sb.len) {
          const diffs = []; for (let k = 0; k < Math.min(sa.len, sb.len) && diffs.length < 12; k++) if (sa.bytes[k] !== sb.bytes[k]) diffs.push([k, sa.bytes[k], sb.bytes[k]]);
          bad = { frame: i, why: 'state', lens: [sa.len, sb.len], diffs };
        }
      }
    }
    const name = path.basename(romPath).slice(0, 44);
    if (bad) { failed = true; console.log(`FAIL ${name}: ${JSON.stringify(bad)}`); }
    else console.log(`ok   ${name}: ${FRAMES} frames identical (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
