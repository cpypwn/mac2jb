const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const NAME = 'VacooTube';
const ID = 'vacootube';
const ELECTRON = 'electron-v44.5.1-darwin-arm64.zip';
const ELECTRON_SHA256 = '1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c';
const UPSTREAM_MANIFEST_SHA256 = '0fd54ec5e75978a54de6a70bdbf2472164f8187df0f603de73851fb85ff43ac8';
const APP_LOCK_SHA256 = '1591b7219b83241a0f84ceec2d81e89bf627b7ea3d040566f8713e9aa3b12ad2';
const ADAPTATION_MANIFEST_SHA256 = 'a1c81d55d600d5dbf39b51153d686833b5a1aac209e391f1a4132c465a000061';

async function sha(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function files(folder, relative = '') {
  const result = [];
  for (const entry of await fsp.readdir(path.join(folder, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw Error('VacooTube cannot stage a symlink: ' + name);
    if (entry.isDirectory()) result.push(...await files(folder, name));
    else if (entry.isFile()) result.push(name.split(path.sep).join('/'));
    else throw Error('VacooTube cannot stage a special file: ' + name);
  }
  return result.sort();
}

function shaSync(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, bytes, 0, bytes.length, null);
      if (!count) break;
      hash.update(bytes.subarray(0, count));
    }
  } finally { fs.closeSync(handle); }
  return hash.digest('hex');
}

function filesSync(folder, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(folder, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw Error('VacooTube cannot stage a symlink: ' + name);
    if (entry.isDirectory()) result.push(...filesSync(folder, name));
    else if (entry.isFile()) result.push(name.split(path.sep).join('/'));
    else throw Error('VacooTube cannot stage a special file: ' + name);
  }
  return result.sort();
}

function verifySnapshotSync(integration) {
  const source = path.join(integration, 'upstream');
  if (shaSync(path.join(integration, 'UPSTREAM-SHA256SUMS')) !== UPSTREAM_MANIFEST_SHA256) {
    throw Error('Changed VacooTube upstream inventory manifest');
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(integration, 'PROVENANCE.json'), 'utf8'));
  if (provenance.tag !== 'v1.4.1' || provenance.commit !== 'f28e762a085c4a4adcd655f12b40f4a68d646a4f' ||
      provenance.electron?.sha256 !== ELECTRON_SHA256 ||
      provenance.upstreamInventorySha256 !== UPSTREAM_MANIFEST_SHA256 ||
      provenance.appPackageLockSha256 !== APP_LOCK_SHA256) throw Error('VacooTube provenance changed');
  if (shaSync(path.join(source, 'app/package-lock.json')) !== APP_LOCK_SHA256) {
    throw Error('Changed VacooTube production dependency lockfile');
  }
  const expected = new Map(fs.readFileSync(path.join(integration, 'UPSTREAM-SHA256SUMS'), 'utf8').trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error('Invalid VacooTube upstream inventory');
    }
    return [match[2], match[1]];
  }));
  const actual = filesSync(source);
  if (JSON.stringify(actual) !== JSON.stringify([...expected.keys()].sort())) {
    throw Error('VacooTube upstream inventory differs from v1.4.1 snapshot');
  }
  for (const name of actual) {
    if (shaSync(path.join(source, name)) !== expected.get(name)) throw Error('Changed VacooTube upstream file: ' + name);
  }
}

function verifyAdaptationSync(integration) {
  const manifest = path.join(integration, 'ADAPTATION-SHA256SUMS');
  if (shaSync(manifest) !== ADAPTATION_MANIFEST_SHA256) throw Error('Changed VacooTube Mac adaptation manifest');
  const lines = fs.readFileSync(manifest, 'utf8').trim().split('\n');
  const expected = new Map(lines.map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error('Invalid VacooTube Mac adaptation inventory');
    }
    return [match[2], match[1]];
  }));
  const overlay = filesSync(path.join(integration, 'overlay'))
    .filter(name => name !== 'server/local-package/vacootube-audio')
    .map(name => 'overlay/' + name);
  const actual = ['PROVENANCE.json', 'audio-capture-info.plist', 'audio-capture.swift',
    'build-audio-helper.sh', 'mac-panel.cjs', ...overlay].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected.keys()].sort())) {
    throw Error('Unexpected or missing VacooTube Mac adaptation file');
  }
  for (const name of actual) {
    if (shaSync(path.join(integration, name)) !== expected.get(name)) throw Error('Changed VacooTube Mac adaptation: ' + name);
  }
}

async function verifySnapshot(integration) {
  const source = path.join(integration, 'upstream');
  if (await sha(path.join(integration, 'UPSTREAM-SHA256SUMS')) !== UPSTREAM_MANIFEST_SHA256) {
    throw Error('Changed VacooTube upstream inventory manifest');
  }
  const provenance = JSON.parse(await fsp.readFile(path.join(integration, 'PROVENANCE.json'), 'utf8'));
  if (provenance.tag !== 'v1.4.1' || provenance.commit !== 'f28e762a085c4a4adcd655f12b40f4a68d646a4f' ||
      provenance.electron?.sha256 !== ELECTRON_SHA256 ||
      provenance.upstreamInventorySha256 !== UPSTREAM_MANIFEST_SHA256 ||
      provenance.appPackageLockSha256 !== APP_LOCK_SHA256) throw Error('VacooTube provenance changed');
  if (await sha(path.join(source, 'app/package-lock.json')) !== APP_LOCK_SHA256) {
    throw Error('Changed VacooTube production dependency lockfile');
  }
  const lines = (await fsp.readFile(path.join(integration, 'UPSTREAM-SHA256SUMS'), 'utf8')).trim().split('\n');
  const expected = new Map(lines.map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error('Invalid VacooTube upstream inventory');
    }
    return [match[2], match[1]];
  }));
  const actual = await files(source);
  if (JSON.stringify(actual) !== JSON.stringify([...expected.keys()].sort())) {
    throw Error('VacooTube upstream inventory differs from v1.4.1 snapshot');
  }
  for (const name of actual) {
    if (await sha(path.join(source, name)) !== expected.get(name)) throw Error('Changed VacooTube upstream file: ' + name);
  }
  return source;
}

async function downloadArchive(target) {
  const supplied = process.env.IZ_VACOOTUBE_ELECTRON_ARCHIVE;
  if (supplied) await fsp.copyFile(supplied, target);
  else {
    const url = 'https://github.com/electron/electron/releases/download/v44.5.1/' + ELECTRON;
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error('Official Electron download failed: ' + response.status);
    const output = await fsp.open(target, 'w', 0o600);
    try { for await (const bytes of response.body) await output.write(bytes); }
    finally { await output.close(); }
  }
  if (await sha(target) !== ELECTRON_SHA256) throw Error('Pinned Electron archive checksum mismatch');
}

async function copySource(source, overlay, destination) {
  await fsp.cp(source, destination, { recursive: true, filter: name => {
    const relative = path.relative(source, name);
    return !relative || !relative.split(path.sep).some(part => part === 'runtime' || part.startsWith('.'));
  } });
  for (const name of await files(overlay)) {
    if (name === 'server/local-package/vacootube-audio') continue;
    const target = path.join(destination, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(overlay, name), target);
  }
  await fsp.copyFile(path.join(overlay, 'server/local-package/vacootube-audio'),
    path.join(destination, 'server/local-package/vacootube-audio'));
  for (const folder of ['server/streaming/lib', 'server/streaming/run16/lib']) {
    await fsp.copyFile(path.join(__dirname, '../mac-stream-host.cjs'),
      path.join(destination, folder, 'mac-stream-host.cjs'));
  }
  await fsp.copyFile(path.join(__dirname, 'mac-panel.cjs'),
    path.join(destination, 'server/streaming/lib/mac-panel.cjs'));
  const descriptorFile = path.join(destination, 'module.json');
  const descriptor = JSON.parse(await fsp.readFile(descriptorFile, 'utf8'));
  descriptor.server.assets.push('server/streaming/lib/mac-stream-host.cjs',
    'server/streaming/run16/lib/mac-stream-host.cjs',
    'server/streaming/lib/mac-panel.cjs');
  await fsp.writeFile(descriptorFile, JSON.stringify(descriptor, null, 2) + '\n');
  for (const [name, before, after] of [
    ['server/streaming/lib/route-gate.cjs', "mode==='handheld'?'wifi':null", "mode==='handheld'?'ethernet-or-wifi':null"],
    ['server/streaming/lib/route-gate.cjs', "'waiting-for-wifi'?'Waiting for the portable Wi-Fi connection'", "'waiting-for-portable-network'?'Waiting for the portable Wi-Fi or Ethernet connection'"],
    ['server/streaming/lib/route-gate.cjs', ":'waiting-for-wifi'};", ":'waiting-for-portable-network'};"],
    ['server/streaming/application-host.cjs',
      "openWindow=url=>require(require('node:path').join(require('./lib/platform.cjs').root,\"core/services/open-panel.cjs\")).openPanel(url,{env:{...process.env,HB_OPEN_PANEL:'1'}})",
      "openWindow=url=>require('./lib/mac-panel.cjs').openPanel(url)"],
    ...['server/streaming/lib/pc-stream-delta.cjs', 'server/streaming/run16/lib/pc-stream-delta.cjs']
      .flatMap(name => [
        [name, "const host=process.env.HB_STREAM_HOST||'10.42.0.1';if(!net.isIPv4(host)||host==='0.0.0.0')throw Error('Invalid PC stream host');", ''],
        [name, 'report.consoleIP=consoleIP;',
          "report.consoleIP=consoleIP;const host=await require('./mac-stream-host.cjs').select(consoleIP);report.hostIP=host;"]
      ]),
    ['switch/modules/pc-screen-input.glsl', 'mode==0u?type==1u:type==2u||(policy==1u&&type==1u)', 'mode==0u?(type==1u||type==2u):type==2u||(policy==1u&&type==1u)'],
    ['switch/modules/pc-screen-input.glsl',
      'if(start&&(pressed&HB_B)!=0u){c.atlas[CB+1u]=0u;c.library.w=held?1u:0u;menu=0u;}',
      'if(start&&menu==0u){c.atlas[CB+1u]=0u;c.library.w=held?1u:0u;}'],
    ['switch/modules/pc-screen-draw.glsl', 'if(!displayReady&&menu==0u)return background;', 'if(!displayReady&&menu==0u&&c.atlas[SB+38u]==0u)return background;'],
    ['switch/modules/pc-screen-draw.glsl',
      'return streamMenuDraw(p,color,menu,c.atlas[SB+39u],kind==2u?6u:kind==3u?7u:kind==4u?8u:5u,c.atlas[SB+38u]!=0u);',
      'color=streamMenuDraw(p,color,menu,c.atlas[SB+39u],kind==2u?6u:kind==3u?7u:kind==4u?8u:5u,c.atlas[SB+38u]!=0u);if(menu==0u&&c.atlas[SB+38u]!=0u){float d=box(p,vec2(960,540),vec2(180,56),8);color=mix(color,BLUE,fill(d));color=mix(color,BG,streamStartText(p,vec2(860,512),8.0,0));}return color;']
  ]) {
    const file = path.join(destination, name), value = await fsp.readFile(file, 'utf8');
    if (value.split(before).length !== 2) throw Error('VacooTube Mac route overlay no longer matches ' + name);
    await fsp.writeFile(file, value.replace(before, after));
  }
}

async function prepare(root, runtime, archive, privateWrite) {
  const integration = path.join(root, 'integrations/vacootube');
  verifyAdaptationSync(integration);
  const source = await verifySnapshot(integration);
  const overlay = path.join(integration, 'overlay');
  await run('bash', [path.join(integration, 'build-audio-helper.sh')], { timeout: 120000 });
  const moduleRoot = path.join(runtime, 'modules', NAME);
  if (fs.existsSync(moduleRoot)) throw Error('VacooTube destination already exists');
  await copySource(source, overlay, moduleRoot);
  const runtimeFolder = path.join(moduleRoot, 'runtime');
  await fsp.mkdir(runtimeFolder);
  await downloadArchive(path.join(runtimeFolder, ELECTRON));
  const prepared = await require(path.join(moduleRoot, 'server/local-package/fork-source.cjs')).prepare({
    home: moduleRoot, packagedSource: path.join(moduleRoot, 'app'), execute: run
  });
  await fsp.rm(path.join(prepared, 'node_modules/.bin'), { recursive: true, force: true });
  await fsp.rm(path.join(prepared, 'node_modules/electron-updater/node_modules/.bin'), { recursive: true, force: true });
  const dependencyFiles = ['runtime/source.json', ...(await files(path.join(runtimeFolder, 'source')))
    .map(name => 'runtime/source/' + name)];
  const dependencyHashes = Object.fromEntries(await Promise.all(dependencyFiles.map(async name =>
    [name, await sha(path.join(moduleRoot, name))])));
  await fsp.writeFile(path.join(moduleRoot, 'server/local-package/source-runtime-inventory.json'),
    JSON.stringify({ version: 1, files: dependencyHashes }, null, 2) + '\n');
  const bytes = await archive.pack(moduleRoot);
  const pkg = archive.inspect(bytes);
  if (pkg.descriptor.id !== ID || !pkg.descriptor.platforms.includes('darwin-arm64')) {
    throw Error('VacooTube Mac module descriptor is invalid');
  }
  privateWrite(path.join(moduleRoot, ID + '.izm'), bytes);
  await archive.unpack(bytes, path.join(moduleRoot, '.versions', pkg.sha256));
  for (const name of pkg.descriptor.switch.files) {
    privateWrite(path.join(runtime, 'data/app-links', ID, name.slice(7)),
      await fsp.readFile(path.join(moduleRoot, name)));
  }
  return verifySync(root, runtime, archive);
}

function verifySync(root, runtime, archive) {
  const integration = path.join(root, 'integrations/vacootube');
  verifyAdaptationSync(integration);
  verifySnapshotSync(integration);
  const moduleRoot = path.join(runtime, 'modules', NAME);
  const bytes = fs.readFileSync(path.join(moduleRoot, ID + '.izm'));
  const pkg = archive.inspect(bytes);
  if (pkg.descriptor.id !== ID || !pkg.descriptor.platforms.includes('darwin-arm64')) {
    throw Error('Invalid VacooTube Mac module package');
  }
  for (const file of pkg.files) {
    const version = path.join(moduleRoot, '.versions', pkg.sha256, file.name);
    if (!fs.readFileSync(version).equals(file.bytes)) throw Error('Changed VacooTube prepared module version: ' + file.name);
    if (file.name !== 'checksums.json' && !fs.readFileSync(path.join(moduleRoot, file.name)).equals(file.bytes)) {
      throw Error('Changed VacooTube staged source: ' + file.name);
    }
  }
  if (shaSync(path.join(moduleRoot, 'runtime', ELECTRON)) !== ELECTRON_SHA256) {
    throw Error('Changed VacooTube Electron runtime archive');
  }
  const inventoryFile = pkg.files.find(file => file.name === 'server/local-package/source-runtime-inventory.json');
  if (!inventoryFile) throw Error('Missing VacooTube production dependency inventory');
  const inventory = JSON.parse(inventoryFile.bytes);
  if (inventory.version !== 1 || !inventory.files || typeof inventory.files !== 'object' ||
      Array.isArray(inventory.files)) throw Error('Invalid VacooTube dependency inventory');
  const actualDependencies = ['runtime/source.json', ...filesSync(path.join(moduleRoot, 'runtime/source'))
    .map(name => 'runtime/source/' + name)].sort();
  if (JSON.stringify(actualDependencies) !== JSON.stringify(Object.keys(inventory.files).sort())) {
    throw Error('Unexpected or missing VacooTube dependency file');
  }
  for (const name of actualDependencies) {
    if (!(name === 'runtime/source.json' || name.startsWith('runtime/source/')) ||
        name.split('/').some(part => !part || part === '.' || part === '..') ||
        !/^[a-f0-9]{64}$/.test(inventory.files[name]) ||
        shaSync(path.join(moduleRoot, name)) !== inventory.files[name]) {
      throw Error('Changed VacooTube dependency file: ' + name);
    }
  }
  const expectedLinks = pkg.descriptor.switch.files.map(name => name.slice(7)).sort();
  const actualLinks = filesSync(path.join(runtime, 'data/app-links', ID));
  if (JSON.stringify(expectedLinks) !== JSON.stringify(actualLinks)) {
    throw Error('Unexpected or missing VacooTube console app link');
  }
  for (const name of pkg.descriptor.switch.files) {
    if (!fs.readFileSync(path.join(runtime, 'data/app-links', ID, name.slice(7)))
      .equals(fs.readFileSync(path.join(moduleRoot, name)))) throw Error('Changed VacooTube app link: ' + name);
  }
  const names = new Set([
    ...pkg.files.filter(file => file.name !== 'checksums.json').map(file => file.name),
    ID + '.izm',
    ...pkg.files.map(file => `.versions/${pkg.sha256}/${file.name}`),
    'runtime/' + ELECTRON,
    ...actualDependencies
  ]);
  const physicalFiles = filesSync(moduleRoot).filter(name => !name.startsWith('data/'));
  if (JSON.stringify([...names].sort()) !== JSON.stringify(physicalFiles)) {
    throw Error('Unexpected or missing VacooTube module file');
  }
  const allowed = new Set([...names].map(name => `modules/${NAME}/${name}`));
  for (const name of expectedLinks) allowed.add(`data/app-links/${ID}/${name}`);
  return { allowed, sha256: pkg.sha256, packageBytes: bytes.length };
}

module.exports = { prepare, verify: verifySync, verifySync, verifySnapshot, copySource, ELECTRON, ELECTRON_SHA256 };
