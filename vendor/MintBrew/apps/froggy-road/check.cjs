#!/usr/bin/env node
// Validate the package, exercise the real compute shader, and render the real
// fragment shader offscreen.  Desktop checks do not replace a console run.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const B = 2;
const MINUS = 2048;
const LEFT = 4096;
const UP = 8192;
const RIGHT = 16384;
const A = 1;

function findLauncher() {
  if (process.env.HB_LAUNCHER) return path.resolve(process.env.HB_LAUNCHER);
  const candidates = [
    path.resolve(__dirname, '../..'), // inside the launcher's apps/ folder
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, 'homebrew-launcher/game-compute-check.c'))) return candidate;
  }
  throw new Error('Cannot find HBLauncher. Set HB_LAUNCHER=/path/to/HBLauncher.');
}

function ensureBinary(root, name) {
  const binary = path.join(root, 'homebrew-launcher', name);
  const source = binary + '.c';
  const stale = !fsSync.existsSync(binary) ||
    fsSync.statSync(binary).mtimeMs < fsSync.statSync(source).mtimeMs;
  if (!stale) return binary;

  const args = ['-O2', source, '-o', binary];
  if (process.env.HB_VULKAN_INCLUDE) args.push('-I' + process.env.HB_VULKAN_INCLUDE);
  if (process.env.HB_VULKAN_LIB) args.push('-L' + process.env.HB_VULKAN_LIB);
  args.push(process.env.HB_VULKAN_LINK || '-lvulkan');
  try {
    execFileSync(process.env.CC || 'cc', args, { stdio: 'inherit' });
  } catch {
    throw new Error(
      `Could not build ${name}. Set HB_VULKAN_INCLUDE and HB_VULKAN_LIB ` +
      '(or install libvulkan-dev and Mesa drivers).'
    );
  }
  return binary;
}

function frame({ buttons = 0, connected = 1, stickX = 0, stickY = 0 } = {}) {
  const input = Buffer.alloc(64);
  input.writeUInt32LE(buttons >>> 0, 8);
  input.writeInt32LE(stickX, 16);
  input.writeInt32LE(stickY, 20);
  input.writeUInt32LE(connected >>> 0, 32);
  return input;
}

async function baseState() {
  return Buffer.from(await fs.readFile(path.join(__dirname, 'assets/state.bin')));
}

function configure(state, values) {
  const put = (offset, value) => state.writeUInt32LE(value >>> 0, offset);
  const putSigned = (offset, value) => state.writeInt32LE(value, offset);
  const g = (name, offset) => {
    if (values[name] !== undefined) put(offset, values[name]);
  };
  g('mode', 784);
  g('lives', 788);
  g('timer', 792);
  g('pads', 796);
  if (values.col !== undefined) putSigned(800, values.col);
  if (values.row !== undefined) putSigned(804, values.row);
  if (values.death !== undefined) putSigned(808, values.death);
  if (values.lastDir !== undefined) putSigned(812, values.lastDir);
  if (values.transition !== undefined) state.writeFloatLE(values.transition, 960);
  g('score', 992);
  g('tick', 996);
  g('best', 1004);
  return state;
}

const mode = (out) => out.readUInt32LE(784);
const lives = (out) => out.readUInt32LE(788);
const timer = (out) => out.readUInt32LE(792);
const pads = (out) => out.readUInt32LE(796);
const col = (out) => out.readInt32LE(800);
const row = (out) => out.readInt32LE(804);
const death = (out) => out.readInt32LE(808);
const lastDir = (out) => out.readInt32LE(812);
const score = (out) => out.readUInt32LE(992);
const tick = (out) => out.readUInt32LE(996);
const best = (out) => out.readUInt32LE(1004);
const exitFlag = (out) => out.readUInt32LE(1016);
const sound = (out) => out.readUInt32LE(980);

async function runCompute(binary, directory, label, state, inputs) {
  const statePath = path.join(directory, label + '-state.bin');
  const inputPath = path.join(directory, label + '-input.bin');
  const outputPath = path.join(directory, label + '-output.bin');
  await fs.writeFile(statePath, state);
  await fs.writeFile(inputPath, Buffer.concat(inputs));
  execFileSync(binary, [
    statePath,
    outputPath,
    path.join(__dirname, 'app.comp.spv'),
    inputPath,
    String(inputs.length),
  ], { stdio: 'pipe' });
  return fs.readFile(outputPath);
}

async function renderState(binary, directory, previews, label, state) {
  const statePath = path.join(directory, label + '-render-state.bin');
  const rawPath = path.join(directory, label + '.rgba');
  await fs.writeFile(statePath, state);
  execFileSync(binary, [
    statePath,
    path.join(__dirname, 'assets/font.bin'),
    __dirname,
    rawPath,
  ], { env: { ...process.env, HB_SHADER_PREFIX: 'app' }, stdio: 'pipe' });

  const raw = await fs.readFile(rawPath);
  assert.equal(raw.length, 1920 * 1080 * 4, label + ' render size');
  let lit = 0;
  let total = 0;
  for (let i = 0; i < raw.length; i += 4) {
    const value = raw[i] + raw[i + 1] + raw[i + 2];
    total += value;
    if (value > 24) lit++;
  }
  assert.ok(lit > 1920 * 1080 * 0.5, label + ' render is not mostly lit');
  assert.ok(total / (1920 * 1080) > 10, label + ' render is too dark');

  const pngPath = path.join(previews, label + '.png');
  execFileSync('python3', [
    '-c',
    'from PIL import Image; import sys; Image.frombytes("RGBA",(1920,1080),open(sys.argv[1],"rb").read()).save(sys.argv[2])',
    rawPath,
    pngPath,
  ], { stdio: 'pipe' });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function main() {
  const launcher = findLauncher();
  const compute = ensureBinary(launcher, 'game-compute-check');
  const render = ensureBinary(launcher, 'game-render');
  const catalog = require(path.join(launcher, 'homebrew-launcher/app-catalog.cjs'));

  const app = await catalog.readApp(__dirname);
  assert.equal(app.id, 'froggy-road');
  assert.equal(app.name, 'Froggy Road');
  assert.equal(Object.keys(app.effects).length, 6);

  const library = await catalog.scan(path.dirname(__dirname));
  assert.ok(library.apps.some((item) => item.id === 'froggy-road'), 'catalog must discover the package');

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'froggy-road-check-'));
  const previews = path.join(__dirname, 'previews');
  await fs.mkdir(previews, { recursive: true });

  let state = await baseState();
  let out = await runCompute(compute, directory, 'idle', state,
    Array.from({ length: 5 }, () => frame()));
  assert.equal(mode(out), 0, 'idle mode');
  assert.equal(lives(out), 3, 'idle lives');
  assert.equal(timer(out), 2695, 'idle timer');
  assert.equal(tick(out), 5, 'idle tick');
  assert.equal(exitFlag(out), 0, 'idle must not exit');

  out = await runCompute(compute, directory, 'b', await baseState(), [frame({ buttons: B })]);
  assert.equal(exitFlag(out), 1, 'B exits');
  out = await runCompute(compute, directory, 'b-stays', await baseState(),
    [frame({ buttons: B }), frame({ buttons: B }), frame({ buttons: B })]);
  assert.equal(exitFlag(out), 1, 'exit request stays set until the host handles it');
  out = await runCompute(compute, directory, 'minus', await baseState(), [frame({ buttons: MINUS })]);
  assert.equal(exitFlag(out), 1, 'Minus exits');

  state = await baseState();
  state.writeUInt32LE(B, 84); // previous buttons already contain B
  out = await runCompute(compute, directory, 'held-b', state,
    [frame({ buttons: B }), frame({ buttons: B })]);
  assert.equal(exitFlag(out), 0, 'held B is not a new press');

  out = await runCompute(compute, directory, 'disconnected', await baseState(),
    [frame({ buttons: B, connected: 0 })]);
  assert.equal(exitFlag(out), 0, 'disconnected controller cannot exit');

  out = await runCompute(compute, directory, 'up', await baseState(), [frame({ buttons: UP })]);
  assert.equal(col(out), 6, 'up keeps column');
  assert.equal(row(out), 1, 'up moves one row');
  assert.equal(score(out), 10, 'forward step scores');
  assert.equal(sound(out), 1, 'hop sound');
  assert.equal(exitFlag(out), 0, 'movement must not exit');

  out = await runCompute(compute, directory, 'stick', await baseState(), [
    frame({ stickX: 32767 }),
    frame({ stickX: 32767 }),
    frame(),
    frame({ stickX: 32767 }),
  ]);
  assert.equal(col(out), 8, 'stick moves one cell per flick');
  assert.equal(row(out), 0, 'stick right stays on start row');

  state = configure(await baseState(), {
    mode: 0, lives: 3, timer: 2700, pads: 0,
    col: 3, row: 11, death: 0, lastDir: -1,
    score: 0, tick: 0, best: 0, transition: 0,
  });
  out = await runCompute(compute, directory, 'goal', state, [frame({ buttons: UP })]);
  assert.equal(pads(out), 2, 'goal pad index 1 is filled');
  assert.equal(mode(out), 0, 'one goal does not win');
  assert.equal(col(out), 6, 'goal respawns at centre');
  assert.equal(row(out), 0, 'goal respawns at start');
  assert.equal(timer(out), 2700, 'goal resets timer');
  assert.equal(score(out), 549, 'goal score includes time bonus');
  assert.equal(sound(out), 3, 'goal sound');

  state = configure(await baseState(), {
    mode: 0, lives: 3, timer: 2700, pads: 15,
    col: 12, row: 11, death: 0, lastDir: -1,
    score: 0, tick: 30, best: 0, transition: 0,
  });
  out = await runCompute(compute, directory, 'win', state, [frame({ buttons: UP })]);
  assert.equal(mode(out), 1, 'fifth pad wins');
  assert.equal(pads(out), 31, 'all pads filled');
  assert.equal(score(out), 1549, 'win score includes bonus');
  assert.equal(best(out), 1549, 'win updates best');
  assert.equal(sound(out), 4, 'win sound');
  assert.equal(tick(out), 31, 'tick advances');

  state = configure(await baseState(), {
    mode: 0, lives: 3, timer: 2700, pads: 0,
    col: 4, row: 1, death: 0, lastDir: -1,
    score: 0, tick: 0, best: 0, transition: 0,
  });
  out = await runCompute(compute, directory, 'collision', state, [frame()]);
  assert.equal(mode(out), 3, 'a car starts the squash state');
  assert.equal(lives(out), 2, 'a car costs one life');
  assert.equal(death(out), 40, 'squash timer starts');
  assert.equal(sound(out), 2, 'squash sound');

  state = configure(await baseState(), {
    mode: 0, lives: 1, timer: 1, pads: 0,
    col: 6, row: 0, death: 0, lastDir: -1,
    score: 0, tick: 0, best: 0, transition: 0,
  });
  out = await runCompute(compute, directory, 'gameover', state,
    Array.from({ length: 41 }, () => frame()));
  assert.equal(mode(out), 2, 'timeout with one life ends the game');
  assert.equal(lives(out), 0, 'game over has zero lives');
  assert.equal(timer(out), 0, 'game over timer');
  assert.equal(sound(out), 5, 'game-over sound');
  assert.equal(exitFlag(out), 0, 'game over must not exit');
  assert.equal(tick(out), 41, 'game-over tick');

  state = configure(await baseState(), {
    mode: 2, lives: 0, timer: 0, pads: 7,
    col: 12, row: 11, death: 0, lastDir: -1,
    score: 840, tick: 100, best: 900, transition: 0,
  });
  out = await runCompute(compute, directory, 'restart', state, [frame({ buttons: A })]);
  assert.equal(mode(out), 0, 'A restarts');
  assert.equal(lives(out), 3, 'restart restores lives');
  assert.equal(timer(out), 2700, 'restart resets timer');
  assert.equal(pads(out), 0, 'restart clears pads');
  assert.equal(col(out), 6, 'restart frog column');
  assert.equal(row(out), 0, 'restart frog row');
  assert.equal(score(out), 0, 'restart clears score');
  assert.equal(best(out), 900, 'restart keeps best');
  assert.equal(sound(out), 1, 'restart sound');

  const play = configure(await baseState(), {
    mode: 0, lives: 2, timer: 2100, pads: 2,
    col: 6, row: 3, death: 0, lastDir: -1,
    score: 430, tick: 123, best: 900, transition: 0,
  });
  const winning = configure(await baseState(), {
    mode: 1, lives: 3, timer: 0, pads: 31,
    col: 12, row: 11, death: 0, lastDir: -1,
    score: 1549, tick: 400, best: 1549, transition: 0,
  });
  const gameover = configure(await baseState(), {
    mode: 2, lives: 0, timer: 0, pads: 7,
    col: 5, row: 2, death: 0, lastDir: -1,
    score: 840, tick: 500, best: 900, transition: 0,
  });
  const dying = configure(await baseState(), {
    mode: 3, lives: 2, timer: 2500, pads: 5,
    col: 4, row: 4, death: 20, lastDir: -1,
    score: 260, tick: 600, best: 900, transition: 0,
  });

  const playHash = await renderState(render, directory, previews, 'play', play);
  const winHash = await renderState(render, directory, previews, 'win', winning);
  await renderState(render, directory, previews, 'gameover', gameover);
  await renderState(render, directory, previews, 'dying', dying);
  assert.notEqual(playHash, winHash, 'win overlay differs from play view');

  console.log('Passed: package validation, catalog discovery, input/hop/stick tests,');
  console.log('collision/goal/win/timeout/restart tests, and four real 1920x1080');
  console.log('fragment renders.');
  console.log('Previews: ' + previews);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
