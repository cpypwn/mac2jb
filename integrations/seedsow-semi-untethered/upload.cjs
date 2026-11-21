#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const base = __dirname;
const provenance = require('./provenance.json');

function validIPv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

async function verifyFiles() {
  for (const [name, expected] of Object.entries(provenance.files)) {
    const file = path.join(base, 'upstream', name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Invalid bundled source file: ${name}`);
    const actual = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    if (actual !== expected) throw Error(`Bundled source checksum mismatch: ${name}`);
  }
}

async function run() {
  const [, , command, address] = process.argv;
  if (command !== '--check' && command !== '--host')
    throw Error('Usage: upload.cjs --check | --host SWITCH_IPV4');
  if (command === '--host' && (!address || !validIPv4(address)))
    throw Error('Enter a valid Switch IPv4 address');
  await verifyFiles();
  if (command === '--check') {
    process.stdout.write('Bundled Seedsow uploader verified\n');
    return;
  }

  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-upload-'));
  let child;
  let output = '';
  try {
    await fs.mkdir(path.join(staging, 'lua'));
    await fs.mkdir(path.join(staging, 'tools'));
    for (const name of Object.keys(provenance.files)) {
      const target = path.join(staging, name);
      await fs.copyFile(path.join(base, 'upstream', name), target);
    }
    child = spawn(process.execPath,
      [path.join(staging, 'tools/upload-semi-untethered.cjs'), '--host', address],
      {cwd: staging, stdio: ['ignore', 'pipe', 'pipe']});
    const forward = data => {
      const value = String(data);
      output = (output + value).slice(-65536);
      process.stdout.write(value);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGTERM', terminate);
    process.once('SIGINT', terminate);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
    if (code !== 0) throw Error(`Seedsow uploader exited with code ${code}`);
    if (!/commit_rc=0x0\b/i.test(output) || !output.includes('Upload complete.'))
      throw Error('Uploader did not confirm a successful save commit');
  } finally {
    if (child?.pid && !child.killed && child.exitCode === null) child.kill('SIGTERM');
    await fs.rm(staging, {recursive: true, force: true});
  }
}

run().catch(error => {
  process.stderr.write(`Seedsow upload failed: ${error.message}\n`);
  process.exitCode = 1;
});
