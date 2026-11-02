#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'vendor/switch2-captive-portal-research');
const record = JSON.parse(fs.readFileSync(path.join(root,
  'packaging/switch2-browser-research-provenance.json'), 'utf8'));
const required = [
  'serve-switch2-browser-probe.py', 'switch2-browser-probe.html',
  ...['runtime', 'media', 'network', 'boundaries', 'fonts', 'webkit', 'fontenv']
    .map(name => `switch2-probes-${name}.js`),
  ...['h264.mp4', 'vp8.webm', 'vp9.webm'].map(name =>
    `probe-fixtures/probe-${name}`)
];

function check(ok, message) { if (!ok) throw Error(message); }
check(record.revision === '07cd867af2f1dc8f7b6ce59d964c3827cc3997b3' &&
  record.repository === 'https://github.com/Jmesmykil/switch2-captive-portal-research' &&
  record.files && typeof record.files === 'object' &&
  !Array.isArray(record.files) && Object.keys(record.files).length === 28,
'The pinned browser research provenance is invalid.');
for (const name of required) check(Object.hasOwn(record.files, name),
  'The included browser research is missing ' + name);

for (const [name, expected] of Object.entries(record.files)) {
  check(name.split('/').every(part => part && part !== '.' && part !== '..') &&
    /^[a-f0-9]{64}$/.test(expected), 'The browser research file list is invalid.');
  const file = path.join(folder, name);
  const info = fs.lstatSync(file);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 &&
    info.size <= 2 * 1024 * 1024, 'An included browser research file is invalid: ' + name);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  check(digest === expected, 'An included browser research file changed: ' + name);
}
process.stdout.write('Pinned browser research files verified: ' +
  Object.keys(record.files).length + '\n');
