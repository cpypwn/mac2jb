'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const ABI = 3;
const PAGE = 0x1000;
const MAX_IMAGE = 128 * 1024 * 1024;
const BULK_COMMANDS = ['0x524f001a', '0x524f001b', '0x524f001c'];

function check(value, message) {
  if (!value) throw Error(message);
}

function regularFile(file, maximum) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum,
    'Invalid native package file: ' + path.basename(file));
  return fs.readFileSync(file);
}

function jsonFile(file) {
  return JSON.parse(regularFile(file, 65536).toString('utf8'));
}

function address(value, field) {
  check(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value),
    'Invalid native ' + field);
  const number = Number(BigInt(value));
  check(Number.isSafeInteger(number) && number >= 0, 'Invalid native ' + field);
  return number;
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function overlaps(first, firstSize, second, secondSize) {
  return first < second + secondSize && second < first + firstSize;
}

function inspectPackage(folder) {
  const root = fs.realpathSync(folder);
  check(fs.statSync(root).isDirectory(), 'Native package must be a folder');
  check(!fs.existsSync(path.join(root, 'app.json')),
    'GPU ABI 1 packages belong in the existing MintBrew app path');
  const manifest = jsonFile(path.join(root, 'manifest.json'));
  check(manifest.abi === ABI && manifest.kind === 'native',
    'MintBrew native preparation accepts only HBLauncher ABI 3 native packages');
  check(typeof manifest.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.id),
    'Invalid native package id');
  check(typeof manifest.name === 'string' && manifest.name.length > 0 && manifest.name.length <= 128,
    'Invalid native package name');
  check(typeof manifest.version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(manifest.version),
    'Invalid native package version');
  check(manifest.display === undefined || ['shared', 'exclusive'].includes(manifest.display),
    'Invalid native display mode');
  const assets = manifest.assets || [];
  check(Array.isArray(assets) && assets.length <= 64 && assets.every(name =>
    typeof name === 'string' && name.length > 0 &&
    !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..')),
  'Invalid native package asset list');
  for (const name of assets) {
    if (/^\*\.[A-Za-z0-9]+$/.test(name)) continue;
    const file = path.join(root, 'assets', name);
    check(fs.realpathSync(file).startsWith(path.join(root, 'assets') + path.sep),
      'Native asset escapes its package');
    regularFile(file, MAX_IMAGE);
  }

  const report = jsonFile(path.join(root, 'build/report.json'));
  check(report.format === 'hblauncher-native-app/1' && report.abi === ABI &&
    report.id === manifest.id && report.kind === 'native',
  'Native build report does not match the ABI 3 manifest');
  const code = regularFile(path.join(root, 'build/code.bin'), MAX_IMAGE);
  const data = fs.existsSync(path.join(root, 'build/data.bin'))
    ? regularFile(path.join(root, 'build/data.bin'), MAX_IMAGE) : Buffer.alloc(0);
  check(code.length > 0 && report.codeBytes === code.length &&
    report.codePages === Math.ceil(code.length / PAGE) && report.codeSha256 === sha(code),
  'Native code image does not match its build report');
  check(report.dataBytes === data.length && report.dataSha256 === sha(data) &&
    Number.isSafeInteger(report.dataRegionBytes) && report.dataRegionBytes >= data.length &&
    report.dataRegionBytes <= MAX_IMAGE,
  'Native data image does not match its build report');
  const codeBase = address(report.codeBase, 'code base');
  const dataBase = address(report.dataBase, 'data base');
  const entry = address(report.entry, 'entry');
  const codeRegion = Math.ceil(code.length / PAGE) * PAGE;
  const dataRegion = Math.ceil(Math.max(report.dataRegionBytes, 1) / PAGE) * PAGE;
  check(codeBase % PAGE === 0 && dataBase % PAGE === 0 &&
    entry >= codeBase && entry < codeBase + code.length,
  'Native code/data alignment or entry is invalid');
  for (const [base, size] of [[codeBase, codeRegion], [dataBase, dataRegion]]) {
    check(!overlaps(base, size, 0x08000000, 0x100000) &&
      !overlaps(base, size, 0x0a000000, 0x100000),
    'Native image overlaps the resident HBLauncher image');
  }
  check(!overlaps(codeBase, codeRegion, dataBase, dataRegion),
    'Native code and data images overlap');
  return {id: manifest.id, name: manifest.name, version: manifest.version,
    abi: ABI, kind: 'native', display: manifest.display || 'shared',
    codeBytes: code.length, dataBytes: data.length, codeBase, dataBase,
    source: root, codeSha256: report.codeSha256,
    authoritativeValidationRequired: true};
}

function commandAvailable(command) {
  const result = spawnSync(command, ['--version'], {stdio: 'ignore', timeout: 5000});
  return !result.error && result.status === 0;
}

function inspectHost({nativeRoot, hostRoot, toolAvailable = commandAvailable} = {}) {
  const source = nativeRoot && path.resolve(nativeRoot);
  const host = hostRoot && path.resolve(hostRoot);
  const abiFile = source && path.join(source, 'sdk/abi.json');
  let nativeSource = false;
  try {
    nativeSource = jsonFile(abiFile).abiVersion === ABI &&
      fs.statSync(path.join(source, 'host/lib/runtime.cjs')).isFile();
  } catch {}
  let builtLauncher = false;
  if (nativeSource) {
    try {
      const report = jsonFile(path.join(source, 'launcher/build/report.json'));
      const code = regularFile(path.join(source, 'launcher/build/code.bin'), MAX_IMAGE);
      const data = regularFile(path.join(source, 'launcher/build/data.bin'), MAX_IMAGE);
      builtLauncher = report.abi === ABI && report.kind === 'launcher' &&
        report.codeBytes === code.length && report.dataBytes === data.length &&
        report.codeSha256 === sha(code) && report.dataSha256 === sha(data);
    } catch {}
  }
  let builtHello = false, fontAtlas = false;
  try {builtHello = inspectPackage(path.join(source, 'apps/hello-cpu')).id === 'hello-cpu';} catch {}
  try {fontAtlas = fs.statSync(path.join(source, 'assets/font_atlas.r8')).size === 1024 * 1024;} catch {}
  let bulkMapSource = false;
  if (host) {
    try {
      const file = fs.readFileSync(path.join(host, 'engine/switch2/ro/payload/process.c'), 'utf8');
      bulkMapSource = BULK_COMMANDS.every(id =>
        new RegExp('command\\s*==\\s*' + id, 'i').test(file));
    } catch {}
  }
  const buildTools = ['clang', 'ld.lld', 'llvm-objcopy', 'llvm-nm'];
  const missingBuildTools = buildTools.filter(name => !toolAvailable(name));
  const blockers = [];
  if (!nativeSource) blockers.push('HBLauncher ABI 3 source is unavailable');
  if (!builtLauncher) blockers.push('the native launcher has no verified built image');
  if (!builtHello) blockers.push('the Hello CPU sample has no verified built image');
  if (!fontAtlas) blockers.push('the native font atlas is missing');
  if (!bulkMapSource) blockers.push('the host payload source lacks ABI 3 bulk map commands');
  return {nativeSource, builtLauncher, builtHello, fontAtlas, bulkMapSource, missingBuildTools,
    readyForLiveLaunch: blockers.length === 0, consoleTested: false,
    mintbrewHandoffReady: false, blockers};
}

function refuseLiveLaunch(host) {
  check(host?.readyForLiveLaunch === true,
    'Native ABI 3 launch is unavailable: ' + (host?.blockers || ['host not inspected']).join('; '));
  return true;
}

module.exports = {inspectPackage, inspectHost, refuseLiveLaunch};

if (require.main === module) {
  try {
    const [folder, nativeRoot, hostRoot] = process.argv.slice(2);
    check(folder && nativeRoot && hostRoot && process.argv.length === 5,
      'Usage: node contract.cjs PACKAGE_FOLDER HBLAUNCHER_SOURCE HOST_SOURCE');
    console.log(JSON.stringify({package: inspectPackage(folder),
      host: inspectHost({nativeRoot, hostRoot})}, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
