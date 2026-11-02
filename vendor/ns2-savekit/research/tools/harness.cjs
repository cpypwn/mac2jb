#!/usr/bin/env node
// One boot-to-4/4 cycle for the Switch 2 harness, driven over the network only.
//
//   node tools/harness.cjs boot                 # power cycle, launch retail SmileBASIC, stop at direct mode
//   node tools/harness.cjs session              # keyboard firmware, type the four lines, wait for 4/4
//   node tools/harness.cjs full                 # boot, then session, retrying the boot on a failed acquisition
//   node tools/harness.cjs status               # report the newest run without touching the console
//
// Every transition writes a screenshot to --caps (default /tmp/ns2caps) and a line
// to stdout, so a failure can be diagnosed from what the console actually showed.
//
// Exit codes are the documented ones:
//   0  4/4 (current-root.json exists) and the run is ready
//   3  SESSION LOST  - the console stopped answering mid-sequence (wedge)
//   4  NO LIVE HOST  - the host never came up / console never connected
//   5  console never reached direct mode
//   6  no 4/4 after the configured retries (stage 2 flake; a new boot is next)
//
// Why this exists: the manual sequence needs a pad to navigate the home menu and a
// USB keyboard to type, and the board can only present one persona per flash. So
// `boot` runs the Pro Controller firmware, and `session` OTA-flashes the keyboard
// firmware once the console is already inside SmileBASIC. Both flashes are proven
// reversible (docs/RESULTS.md), which is what makes the cycle unattended.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawn, spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PAD = process.env.PAD || 'http://192.168.50.215';
const FINGERBOT = process.env.FINGERBOT || 'http://192.168.50.235:8080';
const MAC_IP = process.env.MAC_IP || '192.168.50.235';
const RPC_DIR = process.env.RPC_DIR || path.join(process.env.HOME, 'ns2jb-rpc');
const ESPOTA = process.env.ESPOTA ||
  path.join(process.env.HOME, 'Library/Arduino15/packages/esp32/hardware/esp32/3.3.12/tools/espota.py');
const PRO_BIN = path.join(ROOT, 'tools/esp32_pro/build/esp32.esp32.esp32s2/esp32_pro.ino.bin');
const KEY_BIN = path.join(ROOT, 'tools/esp32_hid/build/esp32.esp32.esp32s2/esp32_hid.ino.bin');
const OCR = path.join(ROOT, 'tools/vision/ocr');
const COMMAND = 'V=START(39380,192,168,50,235,0,0,0,0)';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const VERBS = ['boot', 'session', 'full', 'status'];
const MODE = VERBS.includes(argv[0]) ? argv[0] : 'full';
const CAPS = arg('caps', '/tmp/ns2caps');
const RETRIES = Number(arg('retries', '2'));
const STAGE2_WAIT = Number(arg('wait', '600')) * 1000;
const AFTER = arg('after', process.env.HARNESS_AFTER || null);
fs.mkdirSync(CAPS, {recursive: true});

// A closed stdout must not kill a cycle: the work matters, the log is a convenience.
process.stdout.on('error', error => { if (error.code !== 'EPIPE') throw error; });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function log(message) { console.log(`${new Date().toLocaleTimeString()}  ${message}`); }

async function http(url, timeout = 20000, method = 'GET') {
  try {
    const response = await fetch(url, {method, signal: AbortSignal.timeout(timeout)});
    return {ok: response.ok, status: response.status, body: await response.text()};
  } catch (error) {
    return {ok: false, status: 0, body: 'ERR ' + error.message};
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function capture(tag) {
  const file = path.join(CAPS, `${stamp()}-${tag}.png`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
    '-pixel_format', 'uyvy422', '-framerate', '30', '-video_size', '1920x1080',
    '-i', '0:none', '-frames:v', '1', '-update', '1', '-y', file], {timeout: 40000});
  return file;
}

// OCR rows are "x y w h<TAB>text" with Vision's origin at the bottom left.
function screen(tag) {
  const image = capture(tag);
  let rows = [];
  try {
    rows = execFileSync(OCR, [image], {encoding: 'utf8', timeout: 60000}).trim().split('\n')
      .filter(l => l.includes('\t')).map(line => {
        const [box, ...rest] = line.split('\t');
        const [x, y, w, h] = box.trim().split(/\s+/).map(Number);
        return {x, y, w, h, text: rest.join('\t').trim(), image};
      });
  } catch { /* no text at all is a valid frame */ }
  const text = rows.map(r => r.text).join(' ').toLowerCase();
  const band = (lo, hi) => rows.filter(r => r.y >= lo && r.y <= hi).map(r => r.text);
  return {image, rows, text, titleRow: band(0.70, 0.82), iconRow: band(0.09, 0.15)};
}

async function press(query, ms = 90, pause = 1600) {
  const reply = await http(`${PAD}/pro?${query}&ms=${ms}`);
  await sleep(pause);
  return reply;
}

async function padStatus() {
  const r = await http(`${PAD}/status`);
  try { return JSON.parse(r.body); } catch { return {ok: false, fw: null}; }
}

async function ota(bin, expectFw) {
  if (!fs.existsSync(bin)) throw Error(`firmware image missing: ${bin}`);
  log(`OTA ${path.basename(bin)} -> ${expectFw}`);
  const before = await padStatus();
  if (before.fw === expectFw) { log(`already ${expectFw}`); return; }
  try {
    execFileSync('python3', [ESPOTA, '-i', '192.168.50.215', '-p', '3232', '-f', bin],
      {encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    throw Error('espota failed: ' + (error.stderr || error.message).toString().slice(0, 300));
  }
  for (let i = 0; i < 40; i++) {
    await sleep(2500);
    const now = await padStatus();
    if (now.fw === expectFw) {
      log(`board reports ${now.fw}`);
      // The console drops the first HID report after a re-enumeration, so prime it
      // with an unmodified modifier (no text, no side effects) before typing.
      await http(`${PAD}/key?code=225`, 8000);
      await sleep(900);
      return;
    }
  }
  throw Error(`board never reported ${expectFw} after OTA (still ${(await padStatus()).fw})`);
}

async function waitAwake() {
  for (let i = 0; i < 40; i++) {
    const r = await http(`${PAD}/status`, 4000);
    if (r.ok) return true;
    await sleep(2000);
  }
  return false;
}

// Power off with a long hold, then a short press to boot. Measured: 16 s holds the
// button long enough for a force-off, 1 s is a boot press, 0.1 s only toggles sleep.
async function powerCycle() {
  log('fingerbot: arm up + 16 s hold (force off)');
  await http(`${FINGERBOT}/up`, 30000);
  await sleep(1000);
  const off = await http(`${FINGERBOT}/press?seconds=16`, 45000);
  log('  ' + off.body);
  await sleep(6000);
  log('fingerbot: 1 s press (boot)');
  const on = await http(`${FINGERBOT}/press?seconds=1`, 30000);
  log('  ' + on.body);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const r = await http(`${PAD}/status`, 4000);
    if (r.ok) { log('board answering again (console has USB power)'); break; }
  }
  await sleep(6000);
}

// The PaD must be adopted as a Pro Controller before any menu input registers.
async function waitPadAdopted() {
  for (let i = 0; i < 40; i++) {
    const r = await http(`${PAD}/usb`, 5000);
    try {
      const d = JSON.parse(r.body);
      if (d.handshake === true) { log(`pad adopted (pairStep ${d.pairStep})`); return true; }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  return false;
}

async function launchSmileBASIC() {
  // The console boots onto the news channel, where no tile is selected and no
  // title label exists. A leaves it for the game row. Never press A when the title
  // label is already visible: there A would launch whatever tile is selected.
  let shot = screen('menu');
  if (!shot.titleRow.length) {
    if (/featured news|a start|news/i.test(shot.text)) {
      log('leaving the news view (A)');
      await press('a=1', 100, 2500);
      shot = screen('row');
    } else {
      for (let i = 0; i < 10 && !shot.text; i++) { await sleep(3000); shot = screen('menu-wait'); }
    }
  }
  if (!shot.titleRow.length) { await press('a=1', 100, 2500); shot = screen('row2'); }
  // Walk the row, reading the label above the selected tile. The row reorders, so
  // a fixed offset is not usable; the retail tile is the one with no DEMO banner.
  const wanted = () => {
    const labels = shot.titleRow.join(' | ');
    return {labels, hit: /smilebasic/i.test(labels) && !/demo/i.test(labels)};
  };
  let found = false;
  for (const direction of ['right', 'left']) {
    for (let step = 0; step < (direction === 'right' ? 12 : 24); step++) {
      const {labels, hit} = wanted();
      log(`  label: ${labels || '(none)'}`);
      if (hit) { found = true; break; }
      await press(`${direction}=1`, 90, 1500);
      shot = screen(`${direction}-${step}`);
    }
    if (found) break;
  }
  if (!found) throw Error('never selected the retail SmileBASIC tile');
  log('launching retail SmileBASIC 4');
  await press('a=1', 120, 12000);
  // Dialogs: account picker -> tag information -> TOPMENU ("Make a Program").
  for (let step = 0; step < 8; step++) {
    const s = screen('after-launch-' + step);
    const short = s.rows.map(r => r.text).join(' ').slice(0, 110);
    log(`  screen: ${short || '(no text)'}`);
    if (/bytes free|bytes\b/i.test(s.text) && /\bok\b/i.test(s.text)) return s.image;
    await press('a=1', 120, 6000);
  }
  throw Error('never reached the direct-mode prompt');
}

function typeText(base, text) { return http(`${base}/type?text=${encodeURIComponent(text)}`, 30000); }

// The confirm dialog's default button is Yes, so Enter accepts it. A single Enter
// is not reliable right after a flash (the first report is dropped), so retry and
// stop as soon as the dialog is gone - an extra Enter on the prompt is harmless.
async function confirmDialog() {
  for (let i = 0; i < 4; i++) {
    await typeText(PAD, '\n');
    await sleep(2000);
    const s = screen('confirm');
    if (!/are you sure/i.test(s.text)) return s;
    log(`  confirm dialog still up after Enter ${i + 1}; retrying`);
  }
  throw Error('confirm dialog would not dismiss');
}

// Poll the screen until the text matches, so a wait is tied to what was actually
// drawn rather than to a guessed sleep. Patterns must survive OCR: the console
// draws "Out of memory (REMOVE)" and Vision returns it split across lines, so the
// marker tests look for the distinctive word, not the sentence.
async function waitFor(pattern, tag, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = screen(tag);
    if (new RegExp(pattern, 'i').test(last.text)) return last;
    await sleep(1500);
  }
  throw Error(`console never showed /${pattern}/ (last frame ${last && last.image})`);
}

// Type one line, then confirm the console echoed the marker we expect. Typing is
// cheap to retry but expensive to get wrong, so it is always verified on screen.
async function typeLine(text, expect) {
  const r = await typeText(PAD, text + '\n');
  log(`  typed ${JSON.stringify(text.slice(0, 40))} -> ${r.body.slice(0, 60)}`);
  if (expect) return waitFor(expect, 'typed', 20);
  await sleep(1500);
  return null;
}

function newestRun() {
  const dir = path.join(RPC_DIR, 'runs');
  const names = fs.readdirSync(dir).filter(n => n.startsWith('switch2-'));
  names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return names.length ? path.join(dir, names[0]) : null;
}

function readRun(run) {
  const out = {run, log: '', root: false, error: null, stages: []};
  try { out.log = fs.readFileSync(path.join(run, 'run.log'), 'utf8'); } catch {}
  out.root = fs.existsSync(path.join(run, 'switch2', 'ro', 'root', 'current-root.json'));
  out.stages = [...out.log.matchAll(/^\s*([1-4])\/4 .*$/gm)].map(m => m[0].trim());
  const err = out.log.split('\n').filter(l => l.startsWith('Error:'));
  if (err.length) out.error = err[err.length - 1];
  return out;
}

// Wait for the pipeline's held state, which is when savekit tools can use the run.
async function waitHeld(run, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(run, 'switch2', 'pipeline.json'), 'utf8'));
      if (record.hold && record.hold.state === 'ready') return true;
    } catch { /* the file appears once the pipeline starts */ }
    await sleep(3000);
  }
  return false;
}

// --after runs one shell command with RUN pointing at the session, which is the
// point of the whole cycle: a 4/4 that nobody uses costs another boot.
function runAfter(run) {
  if (!AFTER) return null;
  log('after: ' + AFTER);
  const result = spawnSync('sh', ['-c', AFTER], {
    stdio: 'inherit', env: {...process.env, RUN: run}, timeout: 30 * 60 * 1000
  });
  log('after exit ' + (result.status === null ? '(killed)' : result.status));
  return result.status === null ? 7 : result.status;
}

async function startSession() {
  await ota(KEY_BIN, 'hid-kb-1');
  const s = screen('before-session');
  if (!/bytes free/i.test(s.text)) {
    log('not in direct mode; frame ' + s.image);
    return {code: 5, run: null, frame: s.image};
  }
  log('direct mode confirmed');
  const logFile = '/tmp/harness-host.log';
  const handle = fs.openSync(logFile, 'w');
  const host = spawn('node', ['run.cjs', '--rpc', MAC_IP], {cwd: RPC_DIR, stdio: ['ignore', handle, handle]});
  let run = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const text = fs.readFileSync(logFile, 'utf8');
    const m = text.match(/Run folder: (\S+)/);
    if (m) { run = m[1]; break; }
  }
  if (!run) { host.kill(); throw Error('host did not print a run folder; see ' + logFile); }
  log('host run ' + run);
  await typeLine('LOAD "TXT:NS2"');
  await waitFor('are you sure', 'confirm');                  // Yes is preselected
  await confirmDialog();
  await typeLine('RUN', 'boot\\s*ready');
  await typeLine('REMOVE NSR,&H60000000,&H3FFFFFFF', 'memory');
  await typeLine(COMMAND);
  const deadline = Date.now() + STAGE2_WAIT;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(10000);
    const state = readRun(run);
    if (state.root || /4\/4/.test(state.log)) {
      log(`4/4 REACHED (${state.stages.at(-1) || 'stage 4'})`);
      const frame = capture('4of4');
      // The pipeline holds the FS root only after its RO stages finish; tools
      // answer "Another memory request is active" until then.
      const held = await waitHeld(run);
      log(held ? 'held endpoint ready' : 'WARNING: hold never reported ready');
      const after = runAfter(run);
      return {code: after === null ? 0 : after, run, frame};
    }
    if (state.error) {
      const frame = capture('acquire-failed');
      log('acquisition failed: ' + state.error.slice(0, 140));
      log('frame ' + frame);
      return {code: 3, run, error: state.error, frame};
    }
    const stage = state.stages.at(-1) || 'waiting';
    if (stage !== last) { log('  ' + stage); last = stage; }
  }
  const frame = capture('acquire-timeout');
  log('no 4/4 within the wait; frame ' + frame);
  return {code: 6, run, frame};
}

(async () => {
  if (MODE === 'status') {
    const run = newestRun();
    if (!run) { console.log('no runs'); process.exit(4); }
    const state = readRun(run);
    console.log(JSON.stringify({run, root: state.root, stages: state.stages,
      error: state.error && state.error.slice(0, 200)}, null, 2));
    process.exit(state.root ? 0 : 3);
  }

  if (MODE === 'boot' || MODE === 'full') {
    await ota(PRO_BIN, 'pro-2');
    await powerCycle();
    if (!await waitAwake()) { log('board never came back; is the console plugged in?'); process.exit(4); }
    if (!await waitPadAdopted()) { log('pad was not adopted by the console'); process.exit(3); }
    const frame = await launchSmileBASIC();
    log('direct mode reached; frame ' + frame);
    if (MODE === 'boot') process.exit(0);
  }

  if (MODE === 'session' || MODE === 'full') {
    const result = await startSession();
    process.exit(result.code);
  }
  console.error('usage: node tools/harness.cjs boot|session|full|status [--caps DIR] [--wait SECONDS]');
  process.exit(2);
})().catch(error => {
  log('HARNESS ERROR: ' + error.message);
  try { log('frame ' + capture('harness-error')); } catch {}
  process.exit(error.message.includes('never reached') || error.message.includes('not ready') ? 5 : 3);
});
