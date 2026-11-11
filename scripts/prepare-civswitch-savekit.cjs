#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
const bundled = path.join(root, 'integrations/civswitch/fs-kit/port');
const markerName = '.mac2jb-civswitch-savekit.json';
const check = (condition, message) => {if (!condition) throw Error(message);};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const overlays = new Map([
  ['engine/shared/ipc.cjs', {
    original: 'a29650186333a7bc6b3e5ef69a5d1a48dc9c8a471325616994a8a77739304412',
    patched: '2b29b3ecb10cf79fa7f445dd887aff3bf2280604efcf33acd19fab5ba4c68d84'
  }],
  ['engine/switch2/ro/ncm.cjs', {
    original: 'fdda25755a8023356d92995e9493f6ab515a69bf91a334e544fd66d5e289f7f6',
    patched: '36b76a1a47193f97005672710367ef819a4f58ad17eaa798871b9924d88f55cf'
  }]
]);
const memoryRelative = 'engine/switch2/memory/fs-memory-control.cjs';
const originalMemorySha = '9483337dfc6d627dd5a7b3867b8499e79f78af09803662f3158d79e91bca8194';

function replaceOnce(source, before, after) {
  check(source.includes(before) && source.indexOf(before) === source.lastIndexOf(before),
    'The pinned CivSwitch memory endpoint changed.');
  return source.replace(before, after);
}
function patchedMemory(source) {
  check(sha(Buffer.from(source)) === originalMemorySha,
    'The pinned CivSwitch memory endpoint changed.');
  let result = replaceOnce(source,
    "  const socketPath = path.join(runControl.state.directory, 'memory.sock');",
    "  const socketDirectory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'm2civ-'));\n" +
    "  await fs.chmod(socketDirectory, 0o700);\n" +
    "  const socketPath = path.join(socketDirectory, 'memory.sock');\n" +
    "  check(Buffer.byteLength(socketPath) < 100, 'The local memory socket path is too long');");
  result = replaceOnce(result,
    "    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});\n" +
    "    // 2026-11-10: path-based unix sockets are blocked in this environment\n" +
    "    // (listen() on a filesystem path fails EACCES — named pipes unavailable).\n" +
    "    // Serve over TCP loopback instead; all clients consume\n" +
    "    // report.memoryControl.socketPath via net.connect/net.createConnection,\n" +
    "    // which accept a \"host:port\" string unchanged.\n" +
    "    state.socketPath = '127.0.0.1:' + server.address().port;\n" +
    "    state.listening = 'tcp-loopback';",
    "    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(socketPath, resolve);});\n" +
    "    await fs.chmod(socketPath, 0o600);\n" +
    "    state.listening = 'unix';");
  result = replaceOnce(result,
    "    if (typeof state.socketPath === 'string' && !state.socketPath.startsWith('127.0.0.1:'))\n" +
    "      await fs.rm(state.socketPath, {force: true});",
    "    await fs.rm(socketPath, {force: true});\n" +
    "    await fs.rm(socketDirectory, {recursive: true, force: true});");
  return result;
}

async function regular(file) {
  const info = await fs.lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o022) === 0, 'Untrusted CivSwitch source file: '+file);
  return fs.readFile(file);
}
async function sourceFiles(directory, relative = '') {
  const entries = new Map();
  async function walk(folder, prefix) {
    const info = await fs.lstat(folder);
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() &&
      (info.mode & 0o022) === 0, 'Untrusted CivSwitch source folder: '+folder);
    for (const item of await fs.readdir(folder, {withFileTypes:true})) {
      const name = prefix ? prefix+'/'+item.name : item.name;
      if (name === 'engine/runs' || name === markerName) continue;
      check(item.isFile() || item.isDirectory(), 'Unexpected CivSwitch source entry: '+name);
      if (item.isDirectory()) await walk(path.join(folder, item.name), name);
      else entries.set(name, await regular(path.join(folder, item.name)));
    }
  }
  await walk(directory, relative);
  return entries;
}
async function bundledFiles() {
  const files = await sourceFiles(bundled);
  const provenance = JSON.parse(await regular(path.join(root, 'integrations/civswitch/fs-kit/provenance.json')));
  const digest = crypto.createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    digest.update(name).update(Buffer.from([0])).update(bytes).update(Buffer.from([0]));
  }
  check(files.size === provenance.portFileCount &&
    digest.digest('hex') === provenance.portTreeSha256 &&
    provenance.portTreeSha256 === 'a4478da994213f31097fd95ee2420f1cbb81592c64b67f51802a0c82465439a8',
    'The bundled CivSwitch FS source changed.');
  return files;
}
function bridgeForStage(original, staged) {
  const token = "PC_IP: '<PC_IP>'";
  check(original.toString('utf8').split(token).length === 2, 'The pinned CivSwitch bridge placeholder changed.');
  const match = /PC_IP: '([0-9.]+)'/.exec(staged.toString('utf8'));
  check(match && net.isIPv4(match[1]), 'The staged CivSwitch bridge lacks a valid Mac address.');
  return Buffer.from(original.toString('utf8').replace(token, "PC_IP: '"+match[1]+"'"));
}
async function expectedFiles() {
  const expected = await bundledFiles();
  for (const [relative, record] of overlays) {
    check(sha(expected.get(relative)) === record.original,
      'The pinned CivSwitch SaveKit overlay source changed: '+relative);
    const overlay = await regular(path.join(root, 'vendor/ns2-savekit/overlay', relative));
    check(sha(overlay) === record.patched,
      'The bundled SaveKit overlay changed: '+relative);
    expected.set(relative, overlay);
  }
  const original = expected.get(memoryRelative);
  check(original && sha(original) === originalMemorySha,
    'The pinned CivSwitch memory endpoint changed.');
  expected.set(memoryRelative, Buffer.from(patchedMemory(original.toString('utf8'))));
  return expected;
}
async function stagedFiles(stage) {
  const resolved = path.resolve(stage);
  check(path.isAbsolute(stage) && stage === resolved && await fs.realpath(stage) === stage,
    'Choose a canonical staged CivSwitch port.');
  check(path.basename(stage) === 'port' &&
    /^civswitch-fs-[a-f0-9]{16}$/.test(path.basename(path.dirname(stage))) &&
    path.basename(path.dirname(path.dirname(stage))) === 'runs',
    'The CivSwitch stage is not a private mac2jb run.');
  return sourceFiles(stage);
}
async function verifyStage(stage) {
  const expected = await expectedFiles();
  const actual = await stagedFiles(stage);
  expected.set('civ_bridge.js', bridgeForStage(expected.get('civ_bridge.js'), actual.get('civ_bridge.js')));
  check(actual.size === expected.size, 'The staged CivSwitch source has an unexpected file.');
  for (const [name, bytes] of expected)
    check(actual.has(name) && sha(actual.get(name)) === sha(bytes),
      'The staged CivSwitch source changed: '+name);
  const target = require(path.join(stage, 'engine/shared/target.cjs')).loadTarget('civ7', {portRoot:stage});
  const sourceSha256 = await require(path.join(stage, 'engine/run.cjs')).sourceDigest(target);
  return {sourceSha256, expected};
}
async function prepare(stage) {
  const original = await bundledFiles();
  const actual = await stagedFiles(stage);
  original.set('civ_bridge.js', bridgeForStage(original.get('civ_bridge.js'), actual.get('civ_bridge.js')));
  check(original.size === actual.size, 'The staged CivSwitch source has an unexpected file.');
  for (const [name, bytes] of original)
    check(actual.has(name) && sha(actual.get(name)) === sha(bytes),
      'The staged CivSwitch source changed before preparation: '+name);
  const expected = await expectedFiles();
  for (const name of [...overlays.keys(), memoryRelative])
    await fs.writeFile(path.join(stage, name), expected.get(name), {mode:0o600});
  const checked = await verifyStage(stage);
  const marker = {format:'mac2jb-civswitch-fs-stage-v1', target:'civ7',
    sourceSha256:checked.sourceSha256};
  await fs.writeFile(path.join(stage, markerName), JSON.stringify(marker)+'\n', {flag:'wx', mode:0o600});
  return marker;
}
async function verifyPreparedRun(runtimeRoot, runDirectory) {
  const run = await fs.realpath(runDirectory);
  const stage = path.dirname(path.dirname(path.dirname(run)));
  const inferredRoot = path.dirname(path.dirname(path.dirname(stage)));
  const realRoot = await fs.realpath(runtimeRoot || inferredRoot);
  check(run === runDirectory && stage.startsWith(path.join(realRoot, 'runs')+path.sep) &&
    /^switch2-[A-Za-z0-9_-]{1,64}$/.test(path.basename(run)) &&
    path.basename(path.dirname(run)) === 'runs' && path.basename(path.dirname(path.dirname(run))) === 'engine',
    'This is not a staged CivSwitch FS run.');
  const expected = await verifyStage(stage);
  const marker = JSON.parse(await regular(path.join(stage, markerName)));
  check(marker.format === 'mac2jb-civswitch-fs-stage-v1' && marker.target === 'civ7' &&
    marker.sourceSha256 === expected.sourceSha256,
    'The CivSwitch FS stage was not prepared by this app.');
  const result = JSON.parse(await regular(path.join(run, 'result.json')));
  check(result.target === 'civ7' && result.sourceSha256 === marker.sourceSha256,
    'The CivSwitch FS run does not match its prepared host.');
  const target = require(path.join(stage, 'engine/shared/target.cjs')).loadTarget('civ7', {portRoot:stage});
  const artifacts = require(path.join(stage, 'engine/shared/target.cjs')).validateArtifacts(target);
  const replacements = {};
  if (artifacts.sdkFunctions) replacements['engine/shared/sdk-functions.json'] =
    sha(await regular(artifacts.sdkFunctions.file));
  if (artifacts.sdkLayout) replacements['engine/shared/sdk-layout.json'] =
    sha(await regular(artifacts.sdkLayout.file));
  for (const [name, artifact] of Object.entries(artifacts.app))
    replacements['engine/switch2/app/'+name] = sha(await regular(artifact.file));
  return {profile:{id:'civswitch-fs',label:'CivSwitch FS'}, sourceDirectory:stage,
    sourceSha256:marker.sourceSha256, replacements, target:'civ7'};
}

module.exports = {prepare, verifyPreparedRun, verifyStage, patchedMemory, bundledFiles, expectedFiles};
if (require.main === module) (process.argv[2] === '--check-source' ? expectedFiles().then(files =>
  ({ready:true, files:files.size})) : prepare(process.argv[2])).then(value =>
  process.stdout.write(JSON.stringify(value)+'\n')).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
