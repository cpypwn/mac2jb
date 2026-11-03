#!/usr/bin/env node
// Drive one full session end to end, and recover from a dead one.
//
//   node loop.cjs                    # status of the newest run, then do what is needed
//   node loop.cjs --dry-run          # print the plan and the state, touch nothing
//   node loop.cjs --run runs/switch2-XXXXXX
//   node loop.cjs --pull 0400c3f00006e000
//
// Stages, each gated on evidence rather than on "the command returned":
//
//   1. session   newest run folder, `rpc status` says ready
//   2. power     fingerbot: hard hold, then tap; console answers ping again
//   3. launch    controller: D-pad/confirm to the SmileBASIC tile, capture changes
//   4. bootstrap LOAD "TXT:NS2" / RUN / REMOVE / V=START, typed over USB HID
//   5. hold      host log reaches 4/4 and `rpc status` reports ready
//   6. pull      inventory, then a save backup if asked
//
// The bootstrap arity and the "REMOVE NSR" ordering are not optional: with REMOVE
// missing, BOOT() sees the stub NSR[0]="0000" and BASIC reports
// "Subscript out of range in 0:73(COPY:3)".
//
// HONEST STATUS: the power and launch stages have never been executed against a
// console whose USB host was awake. The launch stage depends on a controller
// persona the console has not yet accepted (see tools/esp32_hid/README.md), and
// the console used for this work is asleep with a fingerbot that does not reach
// its power button. Everything below the launch stage is the sequence proven by
// hand in docs/RESULTS.md.
const {spawnSync, spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const HOME = process.env.HOME || '';
const RPC = path.join(HOME, 'ns2jb-rpc');
const RUNS = path.join(RPC, 'runs');
const TOOLS = __dirname;
const HID = process.env.HID_DEVICE || 'http://192.168.50.215';
const FINGERBOT = process.env.FINGERBOT || 'http://192.168.50.235:8080';
const CONSOLE = process.env.CONSOLE_IP || '192.168.50.91';
const CAPTURE = ['-f', 'avfoundation', '-pixel_format', 'uyvy422', '-framerate', '30',
  '-video_size', '1920x1080', '-i', '0:none'];
const LOG = path.join(RPC, 'loop.log');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const option = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? argv[index + 1] : fallback;
};

function log(message) {
  const line = new Date().toISOString() + '  ' + message;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: options.timeout || 60000, ...options});
  return {status: result.status, out: (result.stdout || '') + (result.stderr || '')};
}

function httpGet(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {timeout}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', part => { body += part; });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => request.destroy(Error('timeout')));
    request.on('error', reject);
  });
}

function newestRun() {
  let names;
  try { names = fs.readdirSync(RUNS); } catch { return null; }
  let best = null;
  for (const name of names) {
    const dir = path.join(RUNS, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = {dir, mtimeMs: stat.mtimeMs};
  }
  return best && best.dir;
}

function sessionState(run) {
  if (!run) return {ready: false, detail: 'no run folder'};
  const result = sh(process.execPath, [path.join(RPC, 'rpc.cjs'), run, 'status'], {timeout: 25000});
  let reply = null;
  try { reply = JSON.parse(result.out); } catch {}
  if (reply && reply.ready === true) return {ready: true, calls: reply.calls, detail: 'ready, ' + reply.calls + ' calls'};
  return {ready: false, detail: (result.out || '').trim().split('\n')[0] || 'no answer'};
}

function hostStage(run) {
  // The host prints "1/4 ..." .. "4/4 ..."; the last one seen is the furthest
  // stage it reached, which is what separates "still working" from "stalled".
  if (!run) return {stage: 0, line: ''};
  let text = '';
  try { text = fs.readFileSync(path.join(run, 'run.log'), 'utf8'); } catch { return {stage: 0, line: ''}; }
  let stage = 0, line = '';
  for (const candidate of text.split('\n')) {
    const match = candidate.match(/^\s*([1-4])\/4\s+(.*)$/);
    if (match) { stage = Number(match[1]); line = match[0].trim(); }
  }
  return {stage, line};
}

function capture(file) {
  const result = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...CAPTURE,
    '-frames:v', '1', '-update', '1', '-y', file], {timeout: 40000});
  if (result.status !== 0 || !fs.existsSync(file)) return null;
  return fs.statSync(file).size;
}

function ping(address) {
  // macOS ping: one packet, 1s wait; status 0 means the console is powered.
  return sh('ping', ['-c', '1', '-W', '1000', address], {timeout: 8000}).status === 0;
}

async function hid(pathAndQuery) {
  const reply = await httpGet(HID.replace(/\/$/, '') + pathAndQuery, 30000);
  try { return JSON.parse(reply); } catch { return {ok: false, error: reply.slice(0, 80)}; }
}

const BOOTSTRAP = [
  {text: 'LOAD "TXT:NS2"\n', wait: 3000, then: {key: 40}, note: 'load the bootstrap, accept the confirm'},
  {text: 'RUN\n', wait: 5000, note: 'start the RPC listener'},
  {text: 'REMOVE NSR,&H60000000,&H3FFFFFFF\n', wait: 5000, note: 'must print "Out of memory (REMOVE)"'},
  {text: 'V=START(39380,192,168,50,235,0,0,0,0)\n', wait: 5000, note: 'nine arguments'},
];

async function bootstrap() {
  for (const step of BOOTSTRAP) {
    log('bootstrap: ' + step.note);
    if (dryRun) continue;
    const reply = await hid('/type?text=' + encodeURIComponent(step.text));
    if (!reply.ok) throw Error('typing failed: ' + JSON.stringify(reply));
    await new Promise(resolve => setTimeout(resolve, step.wait));
    if (step.then) {
      const key = await hid('/key?code=' + step.then.key);
      if (!key.ok) throw Error('key press failed');
      await new Promise(resolve => setTimeout(resolve, step.wait));
    }
  }
}

async function powerCycle() {
  log('power: hard hold 10s, then a tap');
  if (dryRun) return;
  const hold = await httpGet(FINGERBOT + '/hold?seconds=10', 40000).catch(() => '{"ok":false}');
  log('power: hold -> ' + hold.slice(0, 120));
  await new Promise(resolve => setTimeout(resolve, 9000));
  const tap = await httpGet(FINGERBOT + '/tap', 30000).catch(() => '{"ok":false}');
  log('power: tap -> ' + tap.slice(0, 120));
  for (let i = 0; i < 30; i++) {
    if (ping(CONSOLE)) { log('power: console answers ping'); return true; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return false;
}

async function launchSmileBASIC() {
  // The home menu keeps the cursor on the last played title. One confirm launches
  // it; the A button is whatever /pad?a=1 maps to on the accepted persona.
  log('launch: confirm on the home menu');
  if (dryRun) return true;
  const before = capture('/tmp/loop-before.png');
  await hid('/pad?a=1&ms=200');
  await new Promise(resolve => setTimeout(resolve, 20000));
  const after = capture('/tmp/loop-after.png');
  log('launch: frame before=' + before + ' after=' + after);
  return before !== null && after !== null && after !== before;
}

async function waitForReady(run, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const state = sessionState(run);
    if (state.ready) return true;
    const {stage, line} = hostStage(run);
    if (Date.now() > deadline) {
      log('hold: gave up at stage ' + stage + ' (' + line + ')');
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function main() {
  const run = option('run', newestRun());
  const state = sessionState(run);
  const {stage, line} = hostStage(run);
  log('run: ' + (run || 'none') + '  session: ' + (state.ready ? 'ready' : 'down') +
      '  host stage: ' + (stage ? stage + '/4' : 'none'));

  if (state.ready) {
    log('nothing to recover.');
    if (option('pull')) {
      log('pull: inventory first');
      if (!dryRun) console.log(sh(process.execPath, [path.join(TOOLS, 'inventory.cjs'), run]).out);
      log('pull: ' + option('pull') + ' (backup path must be chosen by the operator)');
    }
    return;
  }

  if (!run) {
    log('no run folder: start the host first with `node run.cjs --rpc <mac-ip>`');
    if (!dryRun) process.exit(2);
  }

  if (stage >= 3) {
    // The FS root was already held in this run; a dead session here is the
    // probabilistic host drop, and a power cycle is the documented cure.
    log('session died after stage ' + stage + ': power cycle and re-bootstrap');
  }

  if (!(await powerCycle()) && !dryRun) {
    log('power: the console never answered ping - stop rather than loop');
    process.exit(3);
  }
  if (!(await launchSmileBASIC()) && !dryRun) {
    log('launch: no frame change - the controller persona is not accepted; stop');
    process.exit(4);
  }
  await bootstrap();
  if (dryRun) return;

  if (!(await waitForReady(run, option('wait', 600)))) {
    log('hold: session did not reach 4/4; restart the console before another launch');
    process.exit(5);
  }
  log('hold: 4/4, session ready');
  console.log(sh(process.execPath, [path.join(TOOLS, 'inventory.cjs'), run]).out);
}

main().catch(error => { log('failed: ' + error.message); process.exit(1); });
