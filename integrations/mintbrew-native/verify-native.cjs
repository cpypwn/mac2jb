'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {inspectPackage} = require('./contract.cjs');

const upstreamCommit = '18b4748ba98eeac7df17beb5d3418985eb74897c';

function check(value, message) {
  if (!value) throw Error(message);
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sourceDigest(root) {
  const digest = crypto.createHash('sha256');
  let files = 0;
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) =>
      a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && ['build', 'run', 'runs', 'release', 'node_modules', '.git']
        .includes(entry.name)) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (name === 'tests/preview/out') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file, name);
      } else {
        check(entry.isFile(), 'Unexpected native source entry: ' + name);
        digest.update(name + '\0');
        digest.update(image(file));
        digest.update('\0');
        files++;
      }
    }
  }
  visit(root);
  return {files, sha256: digest.digest('hex')};
}

function image(file, maxBytes = 128 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    'Invalid native image: ' + file);
  return fs.readFileSync(file);
}

function elfArchitecture(file) {
  const elf = image(file);
  check(elf.length >= 64 && elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    elf[4] === 2 && elf[5] === 1 && elf.readUInt16LE(18) === 183,
  'Expected an ELF64 AArch64 image: ' + file);
}

function verifyLauncher(root) {
  const build = path.join(root, 'launcher/build');
  const report = JSON.parse(image(path.join(build, 'report.json'), 65536).toString('utf8'));
  const code = image(path.join(build, 'code.bin'));
  const data = image(path.join(build, 'data.bin'));
  check(report.format === 'hblauncher-native-app/1' && report.kind === 'launcher' &&
    report.abi === 3 && report.codeBase === '0x08000000' &&
    report.dataBase === '0x0A000000' && Number.parseInt(report.entry, 16) === 0x08000000,
  'Invalid ABI 3 launcher report');
  check(code.length > 0 && report.codeBytes === code.length && report.dataBytes === data.length &&
    report.codeSha256 === sha(code) && report.dataSha256 === sha(data),
  'Launcher image does not match its build report');
  const elf = path.join(build, 'launcher.elf');
  if (fs.existsSync(elf)) elfArchitecture(elf);
  return {codeBytes: code.length, dataBytes: data.length, codeSha256: report.codeSha256,
    dataSha256: report.dataSha256};
}

function verifyPackage(folder) {
  const app = inspectPackage(folder);
  const elf = path.join(folder, 'build/app.elf');
  if (fs.existsSync(elf)) elfArchitecture(elf);
  return {id: app.id, name: app.name, version: app.version, kind: app.kind,
    codeBytes: app.codeBytes, dataBytes: app.dataBytes, codeSha256: app.codeSha256};
}

function verifyAppsDir(folder) {
  const entries = fs.readdirSync(folder, {withFileTypes: true}).filter(entry => entry.isDirectory());
  return entries.map(entry => verifyPackage(path.join(folder, entry.name)));
}

function main(args) {
  if (args[0] === '--package' && args.length === 2) {
    console.log(JSON.stringify(verifyPackage(path.resolve(args[1])), null, 2));
    return;
  }
  if (args[0] === '--apps-dir' && args.length === 2) {
    console.log(JSON.stringify(verifyAppsDir(path.resolve(args[1])), null, 2));
    return;
  }
  if (args[0] === '--all' && (args.length === 2 ||
    args.length === 3 && args[2] === '--write-marker')) {
    const root = path.resolve(args[1]);
    const abi = JSON.parse(image(path.join(root, 'sdk/abi.json'), 65536).toString('utf8'));
    check(abi.abiVersion === 3, 'Expected HBLauncher ABI 3');
    const result = {format: 'mac2jb-native-build/1', upstreamCommit,
      toolchain: {llvm: '23.1.4', lld: '23.1.4', vulkanHeaders: '1.4.363.0'},
      source: sourceDigest(root),
      buildToolSha256: sha(Buffer.concat([
        image(path.join(__dirname, 'build-native.sh')),
        image(path.join(__dirname, 'toolchain-gcc.py'))])),
      launcher: verifyLauncher(root),
      apps: ['hello-cpu', 'gpu-triangle', 'mintnes'].map(id =>
        verifyPackage(path.join(root, 'apps', id)))};
    if (args[2] === '--write-marker') {
      fs.writeFileSync(path.join(__dirname, 'build-report.json'), JSON.stringify(result, null, 2) + '\n');
    } else {
      const marker = JSON.parse(image(path.join(__dirname, 'build-report.json'), 65536).toString('utf8'));
      check(JSON.stringify(marker) === JSON.stringify(result),
        'Native build marker does not match the staged source or images');
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw Error('Usage: verify-native.cjs --all UPSTREAM [--write-marker] | --package FOLDER | --apps-dir FOLDER');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
