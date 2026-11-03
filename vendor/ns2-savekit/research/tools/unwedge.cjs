#!/usr/bin/env node
// Bring a lost console session back without touching it by hand.
//
//   node unwedge.cjs <run-directory> [--press] [--type "LOAD \"TXT:NS2\"\nRUN"]
//                                    [--shot /tmp/switch.png] [--wait 120]
//
// Steps: check the session, optionally press the Fingerbot (it can wake the console,
// it cannot power-cycle it), type the bootstrap through mac2jb's USB keyboard, then
// poll until the host reports ready. A capture is optional and only for evidence -
// ffmpeg needs macOS Camera permission for THIS process, so a failure there is
// reported and ignored rather than treated as the reason nothing worked.
const {spawnSync} = require('node:child_process');
const path = require('node:path');

const TOOLS = __dirname;
const FINGERBOT = process.env.FINGERBOT || 'http://192.168.50.235:8080';
const DEFAULT_TEXT = 'LOAD "TXT:NS2"\nRUN';

function arg(argv, name, fallback) {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function status(run) {
  const result = spawnSync(process.execPath,
    [path.join(process.env.HOME || '', 'ns2jb-rpc', 'rpc.cjs'), run, 'status'],
    {encoding: 'utf8', timeout: 20000});
  const text = (result.stdout || '') + (result.stderr || '');
  return {ready: /"ready":\s*true/.test(text), text: text.trim().split('\n').slice(0, 2).join(' ')};
}

function press() {
  const result = spawnSync('curl', ['-s', '--max-time', '8', FINGERBOT + '/press'], {encoding: 'utf8'});
  const out = result.stdout || '';
  if (/"ok":\s*true/.test(out)) return true;
  console.error('fingerbot did not confirm: ' + (out.trim() || result.stderr || 'no response'));
  return false;
}

function main() {
  const argv = process.argv.slice(2);
  const run = argv.find(value => !value.startsWith('--') && argv.indexOf(value) < 2 && !value.includes(' '));
  if (!run) {
    console.error('usage: node unwedge.cjs <run-directory> [--press] [--type "..."] [--shot png] [--wait 120]');
    process.exit(2);
  }
  const text = arg(argv, 'type', DEFAULT_TEXT).replace(/\\n/g, '\n');
  const wait = Number(arg(argv, 'wait', 120));
  const shot = arg(argv, 'shot', null);

  let state = status(run);
  console.log('session: ' + (state.ready ? 'ready' : 'not ready') + '  ' + state.text);
  if (state.ready) {
    console.log('nothing to do - the session is alive.');
    return;
  }

  if (argv.includes('--press')) {
    console.log('pressing the fingerbot (wake, not a power cycle)');
    if (!press()) console.log('continuing anyway: the console may already be awake');
  }

  console.log('typing via mac2jb: ' + JSON.stringify(text));
  const typed = spawnSync(process.execPath, [path.join(TOOLS, 'switch-type.cjs'), '--stdin'],
    {input: text, encoding: 'utf8', timeout: 120000});
  process.stdout.write(typed.stdout || '');
  process.stderr.write(typed.stderr || '');
  if (typed.status !== 0) {
    console.error('typing failed - the bootstrap was not sent.');
    process.exit(typed.status || 1);
  }

  if (shot) {
    const capture = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
      '-pixel_format', 'uyvy422', '-framerate', '30', '-video_size', '1920x1080',
      '-i', process.env.CAPTURE_INDEX || '1:none', '-frames:v', '1', '-update', '1', '-y', shot],
      {encoding: 'utf8', timeout: 30000});
    console.log(capture.status === 0
      ? 'captured ' + shot
      : 'capture skipped (Camera permission or no signal): ' + (capture.stderr || '').trim().split('\n')[0]);
  }

  const deadline = Date.now() + wait * 1000;
  for (;;) {
    state = status(run);
    if (state.ready) {
      console.log('\nsession is back. Next:');
      console.log('  node tools/kit.cjs ' + run);
      return;
    }
    if (Date.now() > deadline) {
      console.error('\nstill not ready after ' + wait + 's: ' + state.text);
      console.error('Check the console screen: a 4/4 failure needs a power cycle, not typing.');
      process.exit(1);
    }
    spawnSync('sleep', ['5']);
  }
}

main();
