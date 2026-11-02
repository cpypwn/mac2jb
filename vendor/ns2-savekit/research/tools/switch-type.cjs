#!/usr/bin/env node
// Type text into the console through mac2jb's USB keyboard helper.
//
//   node switch-type.cjs "LOAD \"TXT:NS2\"" --delay 10 [--controller auto]
//   echo '{"text":"..."}' | node switch-type.cjs --stdin
//
// mac2jb's helper is GUI-driven but its worker is a plain node script with a JSON
// line protocol: `gui-keyboard.cjs live <controller> <timeout-seconds>` reads
// {"text":..., "delayMs":...} on stdin and reports events as JSON lines. This wraps
// that so the savekit can type without the GUI. The USB gadget driver must already
// be installed and the cable must have the Switch powering the Mac.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAC2JB = process.env.MAC2JB || path.join(process.env.HOME || '', 'mac2jb');
const HELPER = path.join(MAC2JB, 'scripts', 'gui-keyboard.cjs');

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const result = require('node:child_process').spawnSync(process.execPath,
      [HELPER, '--self-test'], {encoding: 'utf8'});
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  }
  if (!fs.existsSync(HELPER)) {
    console.error('mac2jb helper not found at ' + HELPER);
    console.error('Clone it (git clone https://github.com/cpypwn/mac2jb) or set MAC2JB=/path/to/mac2jb');
    process.exit(2);
  }
  let controller = 'auto';
  let delay = 10;
  let timeout = 4;
  let text = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--delay') delay = Number(argv[++i]);
    else if (argv[i] === '--controller') controller = argv[++i];
    else if (argv[i] === '--timeout') timeout = Number(argv[++i]);
    else if (argv[i] === '--stdin') text = '';
    else rest.push(argv[i]);
  }
  if (text !== null) {
    text = fs.readFileSync(0, 'utf8');
  } else {
    text = rest.join(' ');
  }
  if (!text) {
    console.error('usage: node switch-type.cjs "<text>" [--delay ms] [--controller auto]');
    console.error('   or: node switch-type.cjs --stdin < file');
    process.exit(2);
  }

  const child = spawn(process.execPath, [HELPER, 'live', controller, String(timeout)],
    {stdio: ['pipe', 'pipe', 'inherit']});
  let done = false;
  let buffer = '';
  const finish = (code, message) => {
    if (done) return;
    done = true;
    if (message) console.error(message);
    process.exit(code);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', part => {
    buffer += part;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.message) console.error('mac2jb: ' + event.message);
      if (event.type === 'ready') {
        child.stdin.write(JSON.stringify({text, delayMs: delay}) + '\n');
      } else if (event.type === 'text-done' || event.type === 'text-complete') {
        finish(0);
      } else if (event.type === 'failed') {
        finish(1, 'typing failed - check the USB cable, the power direction and the driver');
      }
    }
  });
  child.on('exit', code => finish(code === 0 ? 0 : 1, 'mac2jb helper exited ' + code));
  process.on('SIGINT', () => { child.stdin.end(); child.kill('SIGTERM'); });
}

main();
