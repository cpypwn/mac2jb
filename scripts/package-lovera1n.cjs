#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const engine = 'integrations/civswitch/fs-kit/port/engine';
const port = 'integrations/civswitch/fs-kit/port';
const gravity = 'integrations/gravcirc-fs';
const fixedFiles = [
  'integrations/lovera1n.cjs',
  'integrations/lovera1n-NOTICE.txt',
  'integrations/civswitch/fs-kit/LICENSE',
  'integrations/balatro-fs/live-readonly-map.v1.0.1f.json',
  ...[
    'lovera1n.cjs', 'run-canary.cjs', 'run-full.cjs', 'probe.cjs',
    'repl-client.cjs', 'stage.cjs', 'relay.cjs', 'timing-proof.cjs',
    'geometry-proof.cjs', 'qualify-timing.cjs', 'probe.lua', 'bridge.lua',
    'profile.v1.2.1.json', 'sdk-timing.v1.2.1.json',
  ].map(name => `${gravity}/${name}`),
  ...['run.cjs', 'rpc.cjs', 'dump-firmware.cjs', 'bootstrap.bas', 'build-payload.cjs']
    .map(name => `${engine}/${name}`),
  `${port}/sdk-functions.gravcirc.json`,
  `${port}/sdk-layout.gravcirc.json`,
];

function relativeFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, directory), {withFileTypes: true})) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...relativeFiles(name));
    else if (entry.isFile()) result.push(name);
    else throw Error(`Unsupported source entry: ${name}`);
  }
  return result;
}

function packageFiles() {
  const target = require(path.join(root, engine, 'shared/target.cjs')).loadTarget('gravcirc');
  const artifacts = target.artifacts;
  const app = Object.values(artifacts.app).map(name => `${port}/${name}`);
  const engineFiles = ['lib', 'shared', 'switch2']
    .flatMap(name => relativeFiles(`${engine}/${name}`))
    .filter(name => (!name.endsWith('.test.cjs') &&
      /\.(?:cjs|json|bin|S|c|ld)$/.test(name)) ||
      name === `${engine}/switch2/ro/payload/main`)
    .filter(name => !name.includes('/runs/'));
  return [...new Set([...fixedFiles, ...app, ...engineFiles])].sort();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifestFor(directory, files) {
  return {
    schemaVersion: 1,
    name: 'lovera1n',
    entry: 'integrations/lovera1n.cjs',
    node: '>=18, built-in modules only',
    files: files.map(name => {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Invalid package file: ${name}`);
      return {path: name, bytes: stat.size, sha256: sha256(file)};
    }),
  };
}

function verify(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'lovera1n-manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'lovera1n' ||
      !Array.isArray(manifest.files)) throw Error('Invalid lovera1n manifest');
  const names = manifest.files.map(item => item.path);
  if (names.length !== new Set(names).size) throw Error('Duplicate package path');
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' ||
        !item.path.startsWith('integrations/') ||
        item.path.split('/').includes('..') || item.path.includes('\\') ||
        item.path.includes('\0')) throw Error(`Invalid package path: ${item.path}`);
    const file = path.join(directory, item.path);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes ||
        sha256(file) !== item.sha256) throw Error(`Package file changed: ${item.path}`);
  }
  const actual = relativeFilesFrom(directory)
    .filter(name => name !== 'lovera1n-manifest.json');
  if (actual.join('\n') !== [...names].sort().join('\n'))
    throw Error('Package contains unlisted files or is missing files');
  return manifest;
}

function relativeFilesFrom(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), {withFileTypes: true})) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...relativeFilesFrom(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw Error(`Unsupported package entry: ${name}`);
  }
  return result.sort();
}

function assemble(destination) {
  const output = path.resolve(destination);
  if (fs.existsSync(output)) throw Error(`Output already exists: ${output}`);
  const files = packageFiles();
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.mkdirSync(output, {mode: 0o700});
  try {
    for (const name of files) {
      const from = path.join(root, name);
      if (!fs.lstatSync(from).isFile()) throw Error(`Source is not a file: ${name}`);
      const to = path.join(output, name);
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
    const manifest = manifestFor(output, files);
    fs.writeFileSync(path.join(output, 'lovera1n-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n');
    verify(output);
    return {output, manifest};
  } catch (error) {
    fs.rmSync(output, {recursive: true, force: true});
    throw error;
  }
}

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('usage: node scripts/package-lovera1n.cjs --out NEW_DIRECTORY | --verify DIRECTORY\n');
    return;
  }
  if (args.length !== 2 || !['--out', '--verify'].includes(args[0]))
    throw Error('usage: node scripts/package-lovera1n.cjs --out NEW_DIRECTORY | --verify DIRECTORY');
  const result = args[0] === '--out' ? assemble(args[1]) :
    {output: path.resolve(args[1]), manifest: verify(path.resolve(args[1]))};
  const bytes = result.manifest.files.reduce((sum, item) => sum + item.bytes, 0);
  process.stdout.write(`${result.output}: ${result.manifest.files.length} files, ${bytes} bytes verified\n`);
}

module.exports = {packageFiles, manifestFor, relativeFilesFrom, assemble, verify, main};
if (require.main === module) {
  try {main();}
  catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 1;}
}
