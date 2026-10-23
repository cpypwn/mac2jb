#!/usr/bin/env node
'use strict';
// Starts the untouched ns2jb host, captures its per-session pairing command,
// and makes that command available to mac2jb-commands while the host is alive.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const hostDir = path.join(root, 'vendor/ns2jb');
const runs = path.join(hostDir, 'runs');
const active = path.join(runs, 'mac2jb-active-connect.txt');
fs.mkdirSync(runs, {recursive: true, mode: 0o700});
let child, published = false, partial = '';
try {
  child = spawn(process.execPath, ['run.cjs', ...process.argv.slice(2)], {
    cwd: hostDir, stdio: ['inherit', 'pipe', 'inherit']
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
function publish(command) {
  if (published) return;
  const tmp = active + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, `${child.pid}\n${command}\n`, {mode: 0o600, flag: 'wx'});
    fs.renameSync(tmp, active);
    published = true;
    console.log('mac2jb: active V=START command is ready for mac2jb-commands.');
  } catch (error) {
    console.error('mac2jb: cannot publish active START command:', error.message);
    try {fs.unlinkSync(tmp)} catch {}
    child.kill('SIGTERM');
  }
}
child.stdout.on('data', chunk => {
  const str = chunk.toString();
  process.stdout.write(str);
  partial += str;
  let idx;
  while ((idx = partial.indexOf('\n')) >= 0) {
    const line = partial.slice(0, idx).trim();
    partial = partial.slice(idx+1);
    if (/^V=START\(\d+(?:,\d+){8}\)$/.test(line)) publish(line);
  }
  if (partial.length > 16384) partial = partial.slice(-16384);
});
child.on('error', error => {console.error('ns2jb host failed:', error.message);});
child.on('close', (code, signal) => {
  if (published) {
    try {
      const content = fs.readFileSync(active, 'utf8');
      if (content.startsWith(`${child.pid}\n`)) fs.unlinkSync(active);
    } catch {}
  }
  if (signal) {
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
