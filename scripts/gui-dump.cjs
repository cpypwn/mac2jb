#!/usr/bin/env node
'use strict';
// Run the unchanged fork's CodeFS capture only after the GUI's held 4/4 result.
// The runner and its retained FS worker must already share this destination.
process.umask(0o077);
const fs = require('node:fs/promises');
const {createReadStream} = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MINIMUM_FREE_BYTES = 512n * 1024n * 1024n;
const check = (condition, message) => {if (!condition) throw Error(message);};
const inside = (root, file) => file.startsWith(root + path.sep);
const digestPattern = /^[a-f0-9]{64}$/;

async function ownedPath(file, kind) {
  check(path.isAbsolute(file), 'Use absolute session and dump paths.');
  const absolute = path.resolve(file), info = await fs.lstat(absolute);
  check(!info.isSymbolicLink() && (kind === 'directory' ? info.isDirectory() : info.isFile()) &&
    info.uid === process.getuid() && (info.mode & 0o022) === 0 &&
    await fs.realpath(absolute) === absolute,
  'Expected an owned regular ' + kind + ' without symlinks: ' + absolute);
  return absolute;
}

async function runFile(root, file) {
  check(typeof file === 'string' && path.isAbsolute(file),
    'The session proof is missing an absolute file path.');
  check(inside(root, path.resolve(file)),
    'The session proof points outside its run folder.');
  await ownedPath(path.dirname(file), 'directory');
  return ownedPath(file, 'file');
}

async function readJSON(file) {return JSON.parse(await fs.readFile(file, 'utf8'));}

function heldProof(value) {
  return value?.verified === true && value?.restored === true &&
    value?.cleanup?.deferred === true && value?.cleanup?.cleanedUp !== true &&
    value?.cleanup?.donor?.cleanedUp === true && value?.retainedEndpoint?.ready === true &&
    value?.retainedEndpoint?.session === value?.session &&
    typeof value?.retainedEndpoint?.socketPath === 'string' &&
    path.isAbsolute(value.retainedEndpoint.socketPath);
}

async function verifiedSession(directory) {
  const root = await ownedPath(directory, 'directory');
  if (/\/civswitch-fs-[a-f0-9]{16}\/port\/engine\/runs\/switch2-[A-Za-z0-9_-]+$/.test(root))
    await require('./prepare-civswitch-savekit.cjs').verifyPreparedRun(null, root);
  if (/\/artemis-fs-[a-f0-9]{16}\/port\/engine\/runs\/switch2-[A-Za-z0-9_-]+$/.test(root))
    await require('./prepare-artemis-fs.cjs').verifyPreparedRun(null, root);
  const engine = await ownedPath(path.join(root, 'switch2'), 'directory');
  const result = await readJSON(await runFile(root, path.join(root, 'result.json')));
  const current = await readJSON(await runFile(root, path.join(engine, 'fs-execution-current.json')));
  check(result.platform === 2 && result.verified === true && !result.error &&
    result.rpc?.mode === 'held' && result.rpc?.state === 'listening' &&
    heldProof(result.fs) && heldProof(current) && !current.error &&
    typeof current.session === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(current.session) &&
    result.fs.session === current.session && result.fs.file === current.file &&
    result.fs.retainedEndpoint.socketPath === current.retainedEndpoint.socketPath,
  'A verified, restored 4/4 run with its held RPC and FS endpoint is required.');
  const proofFile = await runFile(root, current.file);
  // The fork's current FS summary has a proof-file pointer and a numeric trial
  // count, but no report field. The full original proof owns that report link.
  const proof = await readJSON(proofFile);
  const reportFile = await runFile(root, proof.report);
  const acquisition = await readJSON(await runFile(root, path.join(engine, 'current-acquisition.json')));
  check(acquisition.session === current.session && acquisition.report === reportFile &&
    (current.report === undefined || current.report === reportFile) &&
    (result.fs.report === undefined || result.fs.report === reportFile),
    'The held endpoint must still belong to the current acquisition.');
  const report = await readJSON(reportFile);
  check(proof.session === current.session && proof.report === reportFile &&
    proof.verified === true && !proof.error && Array.isArray(proof.trials) && proof.trials.length === 2 &&
    proof.trials.every(row => row.verified === true && row.restored === true && !row.pending) &&
    report.session === current.session && report.retainedMemory?.ready === true &&
    report.retainedMemory?.zeroCountVerified === true && !report.retainedMemory?.pending &&
    report.memoryControl?.socketPath === current.retainedEndpoint.socketPath,
  'Both FS instruction trials must be verified and restored in this run.');
  const execution = await readJSON(await runFile(root, path.join(engine, 'ro/current-execution.json')));
  const loader = await readJSON(await runFile(root,
    path.join(engine, 'ro', current.session + '-loader-root-copy.json')));
  check(execution.session === current.session && execution.report === reportFile && execution.verified === true &&
    loader.session === current.session && loader.report === reportFile &&
    loader.verified === true && loader.restored === true && Number.isSafeInteger(loader.copy?.handle) &&
    loader.copy.handle > 0,
  'The verified RO identity and retained CodeFS root are required.');
  const moduleFile = await runFile(root, path.join(engine, 'firmware-dump.cjs'));
  return {root, proofFile, reportFile, session: current.session, moduleFile};
}

async function prepareDestination(directory, statfs = fs.statfs) {
  check(typeof directory === 'string' && path.isAbsolute(directory), 'Use an absolute dedicated dump directory.');
  const destination = path.resolve(directory);
  await ownedPath(path.dirname(destination), 'directory');
  try {await ownedPath(destination, 'directory');}
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(destination, {mode: 0o700});
    await ownedPath(destination, 'directory');
  }
  check((await fs.readdir(destination)).length === 0,
    'The dump destination must be empty. Existing captures are never overwritten or removed.');
  const space = await statfs(destination, {bigint: true});
  check(BigInt(space.bavail) * BigInt(space.bsize) >= MINIMUM_FREE_BYTES,
    'The system-code dump needs at least 512 MiB free on the Mac.');
  await fs.chmod(destination, 0o700);
  return destination;
}

async function verifyFile(destination, file, expected, size) {
  check(typeof file === 'string' && path.isAbsolute(file) && inside(destination, path.resolve(file)) &&
    typeof expected === 'string' && digestPattern.test(expected), 'Invalid captured file path or SHA-256.');
  await ownedPath(file, 'file');
  let bytes = 0;
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file, {highWaterMark: 1024 * 1024})) {
    bytes += chunk.length;
    check(size === undefined || bytes <= size, 'A captured file exceeds its recorded size.');
    digest.update(chunk);
  }
  check((size === undefined || bytes === size) && digest.digest('hex') === expected,
    'A captured file failed SHA-256 or size readback: ' + file);
}

async function verifyManifest(destination, run) {
  const file = path.join(destination, 'firmware-dump.json');
  await ownedPath(file, 'file');
  const manifest = await readJSON(file), inventory = manifest.inventory;
  check(manifest.complete === true && manifest.session === run.session &&
    manifest.report === run.reportFile && manifest.fsProofFile === run.proofFile &&
    Number.isSafeInteger(inventory?.total) && inventory.total > 0 && inventory.total <= 1024 &&
    Array.isArray(inventory.keys) && inventory.keys.length === inventory.total && Array.isArray(manifest.entries) &&
    manifest.entries.length === inventory.total,
  'The system-code dump did not produce a complete verified inventory.');
  check(inventory.rawFile === path.join(destination, 'ncm-system-programs.bin'),
    'The inventory path differs from the dedicated destination.');
  await verifyFile(destination, inventory.rawFile, inventory.sha256, 16 * 1024);
  const titles = new Set(inventory.keys.map(row => row.id));
  check(titles.size === inventory.total && [...titles].every(title => /^0x[0-9a-f]{16}$/.test(title)),
    'The system-code inventory contains invalid or duplicate titles.');
  for (const entry of manifest.entries) {
    check(titles.delete(entry.title), 'The dump contains an unexpected or repeated title.');
    if (entry.status === 'codefs-unavailable') {
      check(entry.result === 1032, 'An unexpected CodeFS error was marked unavailable.');
      continue;
    }
    check(['captured', 'no-code-files'].includes(entry.status) && Array.isArray(entry.files) &&
      entry.files.length <= 2 && (entry.status === 'captured' ? entry.files.length > 0 : entry.files.length === 0),
    'A captured title has an incomplete file list.');
    const folder = path.join(destination, entry.title.slice(2));
    await ownedPath(folder, 'directory');
    check(entry.codeInfo?.file === path.join(folder, 'code-info.bin'), 'Unexpected CodeFS metadata path.');
    await verifyFile(destination, entry.codeInfo.file, entry.codeInfo.sha256);
    const names = new Set();
    for (const captured of entry.files) {
      check(['main', 'main.npdm'].includes(captured.name) && !names.has(captured.name) &&
        Number.isSafeInteger(captured.size) && captured.size > 0 && captured.size <= 256 * 1024 * 1024 &&
        captured.file === path.join(folder, captured.name), 'Invalid captured CodeFS file.');
      names.add(captured.name);
      await verifyFile(destination, captured.file, captured.sha256, captured.size);
    }
  }
  return {file, manifest};
}

async function main(args = process.argv.slice(2), options = {}) {
  check(args.length === 2, 'Usage: gui-dump.cjs RUN_DIRECTORY DUMP_DIRECTORY');
  const run = await verifiedSession(args[0]);
  const destination = await prepareDestination(args[1], options.statfs);
  check(destination !== run.root, 'Use a dedicated dump directory.');
  await fs.writeFile(path.join(destination, '.mac2jb-code-dump.json'), JSON.stringify({
    format: 'mac2jb-gui-codefs-v1', runDirectory: run.root, fsProofFile: run.proofFile,
    started: new Date().toISOString()
  }, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const previous = process.env.NS2_FIRMWARE_DUMP_DIR;
  process.env.NS2_FIRMWARE_DUMP_DIR = destination;
  try {
    const upstream = require(run.moduleFile);
    check(typeof upstream.main === 'function', 'The copied fork has no CodeFS capture entrypoint.');
    console.log('Firmware: beginning read-only system-program CodeFS capture');
    await upstream.main(run.proofFile);
    const verified = await verifyManifest(destination, run);
    console.log('Firmware: verified dump manifest: ' + verified.file);
    return {directory: destination, file: verified.file, complete: true, total: verified.manifest.inventory.total};
  } finally {
    if (previous === undefined) delete process.env.NS2_FIRMWARE_DUMP_DIR;
    else process.env.NS2_FIRMWARE_DUMP_DIR = previous;
  }
}

module.exports = {main, verifiedSession, prepareDestination, verifyManifest, MINIMUM_FREE_BYTES};
if (require.main === module) main().catch(error => {
  console.error('Firmware: ' + error.message + ' Partial captures were kept; this operation was not retried.');
  process.exitCode = 1;
});
