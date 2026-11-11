'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'integrations/artemis-fs/kit/port');
const markerName = '.mac2jb-artemis-fs.json';
const targetName = 'artemis-seedsow';
const check = (value, message) => {if (!value) throw Error(message);};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const overlayNames = ['engine/shared/ipc.cjs', 'engine/switch2/ro/ncm.cjs'];
const memoryName = 'engine/switch2/memory/fs-memory-control.cjs';

async function regular(file) {
  const info = await fs.lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o022) === 0, 'Untrusted Artemis host file: '+file);
  return fs.readFile(file);
}

async function files(directory) {
  const entries = new Map();
  async function walk(folder, prefix) {
    const info = await fs.lstat(folder);
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() &&
      (info.mode & 0o022) === 0, 'Untrusted Artemis host folder: '+folder);
    for (const item of await fs.readdir(folder, {withFileTypes:true})) {
      const name = prefix ? prefix+'/'+item.name : item.name;
      if (name === 'engine/runs' || name === markerName) continue;
      check(item.isFile() || item.isDirectory(), 'Unexpected Artemis host entry: '+name);
      if (item.isDirectory()) await walk(path.join(folder,item.name),name);
      else entries.set(name,await regular(path.join(folder,item.name)));
    }
  }
  await walk(directory,'');
  return entries;
}

async function bundleFiles() {return files(bundle);}

async function expectedFiles() {
  const expected = await bundleFiles();
  for (const name of overlayNames) {
    const original = await regular(path.join(root, 'integrations/civswitch/fs-kit/port', name));
    check(sha(expected.get(name)) === sha(original), 'Artemis SaveKit overlay source changed: '+name);
    expected.set(name, await regular(path.join(root, 'vendor/ns2-savekit/overlay', name)));
  }
  const originalMemory = await regular(path.join(root, 'integrations/civswitch/fs-kit/port', memoryName));
  check(sha(expected.get(memoryName)) === sha(originalMemory), 'Artemis memory endpoint source changed');
  expected.set(memoryName, Buffer.from(require('./prepare-civswitch-savekit.cjs').patchedMemory(originalMemory.toString('utf8'))));
  return expected;
}

async function compare(actual, expected) {
  check(actual.size === expected.size, 'The staged Artemis source has an unexpected file');
  for (const [name, bytes] of expected)
    check(actual.has(name) && sha(actual.get(name)) === sha(bytes),
      'The staged Artemis source changed: '+name);
}

async function stagePath(stage) {
  check(path.isAbsolute(stage) && path.resolve(stage) === stage && await fs.realpath(stage) === stage &&
    path.basename(stage) === 'port' &&
    /^artemis-fs-[a-f0-9]{16}$/.test(path.basename(path.dirname(stage))) &&
    path.basename(path.dirname(path.dirname(stage))) === 'runs',
    'This is not a private Artemis host stage');
}

async function digest(stage) {
  const target = require(path.join(stage, 'engine/shared/target.cjs')).loadTarget(targetName, {portRoot:stage});
  return require(path.join(stage, 'engine/run.cjs')).sourceDigest(target);
}

async function prepare(stage) {
  await stagePath(stage);
  await compare(await files(stage), await bundleFiles());
  const expected = await expectedFiles();
  for (const name of [...overlayNames,memoryName])
    await fs.writeFile(path.join(stage,name),expected.get(name),{mode:0o600});
  await compare(await files(stage), expected);
  const sourceSha256 = await digest(stage);
  const marker = {format:'mac2jb-artemis-fs-stage-v1', target:targetName, sourceSha256};
  await fs.writeFile(path.join(stage,markerName),JSON.stringify(marker)+'\n',{flag:'wx',mode:0o600});
  return marker;
}

async function verifyPreparedRun(runtimeRoot, runDirectory) {
  const run = await fs.realpath(runDirectory);
  const stage = path.dirname(path.dirname(path.dirname(run)));
  const inferredRoot = path.dirname(path.dirname(path.dirname(stage)));
  const realRoot = await fs.realpath(runtimeRoot || inferredRoot);
  check(run === runDirectory && stage.startsWith(path.join(realRoot,'runs')+path.sep) &&
    /^switch2-[A-Za-z0-9_-]{1,64}$/.test(path.basename(run)) &&
    path.basename(path.dirname(run)) === 'runs' &&
    path.basename(path.dirname(path.dirname(run))) === 'engine',
    'This is not a staged Artemis FS run');
  await stagePath(stage);
  await compare(await files(stage), await expectedFiles());
  const sourceSha256 = await digest(stage);
  const marker = JSON.parse(await regular(path.join(stage,markerName)));
  check(marker.format === 'mac2jb-artemis-fs-stage-v1' && marker.target === targetName &&
    marker.sourceSha256 === sourceSha256, 'The Artemis host stage was not prepared by this app');
  const result = JSON.parse(await regular(path.join(run,'result.json')));
  check(result.target === targetName && result.sourceSha256 === sourceSha256,
    'The Artemis FS run does not match its prepared host');
  const target = require(path.join(stage,'engine/shared/target.cjs')).loadTarget(targetName,{portRoot:stage});
  const artifacts = require(path.join(stage,'engine/shared/target.cjs')).validateArtifacts(target);
  const replacements = {};
  if (artifacts.sdkFunctions) replacements['engine/shared/sdk-functions.json'] = sha(await regular(artifacts.sdkFunctions.file));
  if (artifacts.sdkLayout) replacements['engine/shared/sdk-layout.json'] = sha(await regular(artifacts.sdkLayout.file));
  for (const [name, artifact] of Object.entries(artifacts.app))
    replacements['engine/switch2/app/'+name] = sha(await regular(artifact.file));
  return {profile:{id:targetName,label:'Seedsow Lullaby FS'}, sourceDirectory:stage,
    sourceSha256, replacements, target:targetName};
}

module.exports = {prepare,verifyPreparedRun,bundleFiles,expectedFiles};
