#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {verifyPull} = require('./gui-savekit-tools.cjs');

const TITLE_ID = '0400f5802371e000';
const NAME = index => `ER_____0000_userdata${String(index).padStart(4, '0')}`;
const SIZES = [...Array(10).fill(0x280000), 0x60000, 0x240010];
const PROFILE_FLAGS = 0x1954;
const PROFILE_BASE = PROFILE_FLAGS + 10;
const PROFILE_SIZE = 0x24c;

function check(ok, message) {
  if (!ok) throw Error(message);
}

function parseArgs(argv) {
  const allowed = new Set(['--pc', '--switch', '--output', '--pc-slot', '--switch-slot']);
  check(argv.length === 10, 'Choose a PC .sl2, Switch SaveKit backup, output folder and both slots.');
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    check(allowed.has(argv[i]) && args[argv[i]] === undefined && argv[i + 1],
      'Invalid Elden Ring conversion option.');
    args[argv[i]] = argv[i + 1];
  }
  check(Object.keys(args).length === allowed.size, 'A conversion option is missing.');
  for (const key of ['--pc', '--switch', '--output'])
    check(path.isAbsolute(args[key]), 'Choose absolute input and output paths.');
  for (const key of ['--pc-slot', '--switch-slot']) {
    check(/^[0-9]$/.test(args[key]), 'Choose a slot from 1 to 10.');
    args[key] = Number(args[key]);
  }
  return args;
}

function pcEntries(data, selectedSlot = -1) {
  check(data.length >= 0x300 && data.length <= 64 * 1024 * 1024 &&
    data.toString('ascii', 0, 4) === 'BND4' && data.readUInt32LE(0xc) === 12,
  'This is not a complete Elden Ring PC .sl2 save.');
  const ranges = [];
  const entries = [];
  for (let index = 0; index < 12; index++) {
    const record = 0x40 + index * 0x20;
    const size = Number(data.readBigUInt64LE(record + 8));
    const offset = data.readUInt32LE(record + 0x10);
    check(size === SIZES[index] + 16 && offset >= 0x300 &&
      offset + size <= data.length, 'The PC save has an unexpected Elden Ring entry.');
    ranges.push([offset, offset + size]);
    const payload = data.subarray(offset + 16, offset + size);
    const hash = crypto.createHash('md5').update(payload).digest();
    const digest = data.subarray(offset, offset + 16);
    const emptySlot = index < 10 && digest.equals(Buffer.alloc(16));
    check((!emptySlot || index !== selectedSlot) && (emptySlot || hash.equals(digest)),
      `PC character data ${index + 1} failed its checksum.`);
    entries.push(payload);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++)
    check(ranges[index - 1][1] <= ranges[index][0], 'The PC save has overlapping entries.');
  return entries;
}

function patchAccount(slot, sourceAccount, targetAccount, version) {
  check(!sourceAccount.equals(Buffer.alloc(8)), 'The PC save has no usable account ID.');
  const offsets = [];
  let position = slot.indexOf(sourceAccount, 0);
  while (position !== -1) {
    offsets.push(position);
    position = slot.indexOf(sourceAccount, position + 1);
  }
  check(offsets.length === 1 && offsets[0] >= 16,
    'Could not identify exactly one account ID in the selected PC character.');
  const offset = offsets[0];
  check(slot.readUInt32LE(offset - 16) === version &&
    slot.readUInt32LE(offset - 12) === version,
  'The selected PC character has an unrecognized account record.');
  targetAccount.copy(slot, offset);
}

async function regularFile(file, size) {
  const info = await fs.lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.size === size,
    'The Switch backup has an unexpected Elden Ring save file.');
  return fs.readFile(file);
}

async function convert(args) {
  const inputInfo = await fs.lstat(args['--pc']);
  check(inputInfo.isFile() && !inputInfo.isSymbolicLink() &&
    inputInfo.size >= 0x300 && inputInfo.size <= 64 * 1024 * 1024,
  'Choose an Elden Ring PC .sl2 file.');
  const pc = pcEntries(await fs.readFile(args['--pc']), args['--pc-slot']);
  const backup = args['--switch'];
  const manifest = await verifyPull(backup, {titleId: TITLE_ID});
  check(manifest.files === 12 && manifest.entries.length === 12 &&
    manifest.entries.every(entry => {
      const index = Number(entry.path.match(/^\/ER_____0000_userdata(\d{4})$/)?.[1]);
      return Number.isInteger(index) && index >= 0 && index < 12 &&
        entry.size === SIZES[index];
    }), 'Choose a complete Elden Ring SaveKit backup with 12 files.');

  const sourceSlot = args['--pc-slot'];
  const targetSlot = args['--switch-slot'];
  const pcGlobal = pc[10];
  const pcSlot = pc[sourceSlot];
  const targetPath = path.join(backup, NAME(targetSlot));
  const switchGlobal = await regularFile(path.join(backup, NAME(10)), SIZES[10]);
  await regularFile(targetPath, SIZES[targetSlot]);
  const sourceVersion = pcSlot.readUInt32LE(0);
  const pcVersion = pcGlobal.readUInt32LE(0);
  const switchVersion = switchGlobal.readUInt32LE(0);
  check(sourceVersion > 0 && sourceVersion === pcVersion &&
    switchVersion > 0 && sourceVersion <= switchVersion,
  'The PC character version is incompatible with this Switch backup.');
  check(pcGlobal[PROFILE_FLAGS + sourceSlot] === 1,
    'The selected PC character slot is empty.');
  check(switchGlobal[PROFILE_FLAGS + targetSlot] <= 1,
    'The Switch backup has an unrecognized character profile.');
  const sourceProfile = PROFILE_BASE + sourceSlot * PROFILE_SIZE;
  const targetProfile = PROFILE_BASE + targetSlot * PROFILE_SIZE;
  check(targetProfile + PROFILE_SIZE <= switchGlobal.length &&
    sourceProfile + PROFILE_SIZE <= pcGlobal.length,
  'The Elden Ring profile summary is incomplete.');

  const convertedSlot = Buffer.from(pcSlot);
  patchAccount(convertedSlot, pcGlobal.subarray(4, 12), switchGlobal.subarray(4, 12), sourceVersion);
  const convertedGlobal = Buffer.from(switchGlobal);
  pcGlobal.copy(convertedGlobal, targetProfile, sourceProfile, sourceProfile + PROFILE_SIZE);
  convertedGlobal[PROFILE_FLAGS + targetSlot] = 1;

  const output = args['--output'];
  const outputInfo = await fs.lstat(output);
  check(outputInfo.isDirectory() && !outputInfo.isSymbolicLink() &&
    (await fs.readdir(output)).length === 0,
  'Choose a new, empty output folder.');
  const saveFolder = path.join(output, 'save-files');
  await fs.mkdir(saveFolder, {mode: 0o700});
  try {
    const slotOutput = path.join(saveFolder, NAME(targetSlot));
    const globalOutput = path.join(saveFolder, NAME(10));
    await fs.writeFile(slotOutput, convertedSlot, {flag: 'wx', mode: 0o600});
    await fs.writeFile(globalOutput, convertedGlobal, {flag: 'wx', mode: 0o600});
    check((await fs.readFile(slotOutput)).equals(convertedSlot) &&
      (await fs.readFile(globalOutput)).equals(convertedGlobal),
    'The converted files could not be verified on disk.');
  } catch (error) {
    await fs.rm(saveFolder, {recursive: true, force: true});
    throw error;
  }
  return {status: 'complete', saveFolder,
    message: `Converted PC character ${sourceSlot + 1} for Switch slot ${targetSlot + 1}. Select the converted save-files folder in SaveKit to write it.`};
}

async function main() {
  const result = await convert(parseArgs(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = {parseArgs, pcEntries, patchAccount, convert};
if (require.main === module)
  main().catch(error => {process.stderr.write(String(error.message) + '\n'); process.exitCode = 1;});
