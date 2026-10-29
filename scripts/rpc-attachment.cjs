#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const {selectedProfile, trustedProfileForDigest} = require('./host-profiles.cjs');
const {verifiedSession} = require('./gui-dump.cjs');
const FORMAT = 'mac2jb-local-rpc-attachment-v1';
const OWNER = '.mac2jb-attachment-owner.json';
const ATTEMPT = '.mac2jb-hblauncher-attempt.json';
const applications = new Set(['hblauncher', 'gpubrewlauncher', 'mintbrew', 'custom-homebrew', 'izlauncher', 'stremio', 'ouncecake', 'system-code-dump']);
const check = (value, message) => {if (!value) throw Error(message);};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function owned(file, kind = 'file', privateMode = true) {
  check(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file,
    'Use an absolute canonical local run path.');
  const info = await fs.lstat(file);
  check(!info.isSymbolicLink() && info.uid === process.getuid() &&
    (kind === 'directory' ? info.isDirectory() : kind === 'socket' ? info.isSocket() : info.isFile()) &&
    (info.mode & (privateMode ? 0o077 : 0o022)) === 0 && await fs.realpath(file) === file,
    'Expected an owned '+(privateMode ? 'private ' : '')+kind+' without symlinks: '+file);
  return info;
}
async function readJSON(file) {
  const info = await owned(file);
  check(info.size <= 8 * 1024 * 1024, 'Attachment metadata exceeds its limit.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function absent(file) {
  try {await fs.lstat(file); return false;} catch (error) {if (error.code === 'ENOENT') return true; throw error;}
}
async function writeJSON(file, value, exclusive = false) {
  await fs.writeFile(file, JSON.stringify(value, null, 2)+'\n', {flag: exclusive ? 'wx' : 'w', mode: 0o600});
}

// do not require code from the selected run until every bundled input matches.
// generated json/captures may be present, but extra executable modules may not.
async function verifyCode(directory, source) {
  const expected = new Map();
  async function sourceFiles(relative) {
    const folder = path.join(source, 'engine', relative);
    await owned(folder, 'directory', false);
    for (const item of await fs.readdir(folder, {withFileTypes: true})) {
      const name = relative+'/'+item.name, file = path.join(source, 'engine', name);
      if (item.isDirectory()) await sourceFiles(name);
      else {
        const info = await owned(file, 'file', false);
        check(info.size <= 16 * 1024 * 1024, 'Bundled code input exceeds its limit.');
        expected.set(name, hash(await fs.readFile(file)));
      }
    }
  }
  await sourceFiles('shared'); await sourceFiles('switch2');
  function archivedSource(name) {
    const memory = /^switch2\/memory\/reserved-gap-\d{10,17}-(.+)\.cjs$/.exec(name);
    if (memory) {
      const suffix = memory[1], direct = new Set(['cache-address-plan','fs-memory-control','session-tools',
        'run-control','capture-workers','native-links']);
      if (direct.has(suffix)) return 'switch2/memory/'+suffix+'.cjs';
      if (['native-worker','affinity'].includes(suffix)) return 'switch2/app/'+suffix+'.cjs';
      const copies = {'source':'probe-reserved-gap','address-plan-source':'cache-address-plan',
        'signed-plan-source':'signed-cache-plan','mounted-rom-source':'mounted-rom',
        'memory-control-source':'fs-memory-control','active-fs-memory-control':'fs-memory-control',
        'active-fs-root-control':'fs-root-control'};
      if (copies[suffix]) return 'switch2/memory/'+copies[suffix]+'.cjs';
      const root = /^root-control-([a-f0-9]{12})$/.exec(suffix);
      if (root && expected.get('switch2/memory/fs-root-control.cjs')?.startsWith(root[1]))
        return 'switch2/memory/fs-root-control.cjs';
    }
    const retained = /^switch2\/retained\/reserved-gap-\d{10,17}-implementation-([a-f0-9]{12})\.cjs$/.exec(name);
    if (retained && expected.get('switch2/retained/retained-memory.cjs')?.startsWith(retained[1]))
      return 'switch2/retained/retained-memory.cjs';
    const control = /^switch2\/ro\/control-([a-f0-9]{12})\.cjs$/.exec(name);
    if (control && expected.get('switch2/ro/control.cjs')?.startsWith(control[1])) return 'switch2/ro/control.cjs';
    return null;
  }
  async function runFiles(relative) {
    const folder = path.join(directory, relative);
    await owned(folder, 'directory', false);
    for (const item of await fs.readdir(folder, {withFileTypes: true})) {
      const name = relative+'/'+item.name, file = path.join(directory, name);
      if (item.isDirectory()) await runFiles(name);
      else {
        check(!item.isSymbolicLink(), 'The selected run contains a source-tree symlink: '+name);
        const executable = /\.(?:cjs|mjs|js|node)$/i.test(name) || path.basename(name) === 'package.json';
        // the live runner atomically renames generated json/capture temporary
        // files. They are not code inputs, and may vanish after readdir.
        if (!expected.has(name) && !executable) continue;
        const info = await owned(file, 'file', false);
        if (expected.has(name)) {
          check(info.size <= 16 * 1024 * 1024 && hash(await fs.readFile(file)) === expected.get(name),
            'The selected run contains changed host code: '+name);
        } else if (executable) {
          const original = archivedSource(name);
          check(original && info.size <= 16 * 1024 * 1024 && hash(await fs.readFile(file)) === expected.get(original),
            'The selected run contains an unrecognized executable module: '+name);
        }
      }
    }
  }
  await runFiles('shared'); await runFiles('switch2');
  for (const [name, digest] of expected) {
    const file = path.join(directory, name);
    await owned(file, 'file', false);
    check(hash(await fs.readFile(file)) === digest, 'The selected run is missing matching host code: '+name);
  }
  return hash(JSON.stringify([...expected].sort(([a], [b]) => a.localeCompare(b))));
}

function statusRequest(port, timeoutMs = 180000, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({host:'127.0.0.1', port, path:'/', method:'POST', signal,
      headers:{'content-type':'application/json'}}, response => {
      const parts = []; let length = 0;
      response.on('data', part => {
        length += part.length;
        if (length > 256 * 1024) response.destroy(Error('RPC status response exceeded its limit.'));
        else parts.push(part);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(parts));
          check(response.statusCode === 200 && value.ready === true, 'The original native RPC bridge is not ready.');
          resolve(value);
        } catch (error) {reject(error);}
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Error('RPC status timed out; no request was replayed.')));
    request.on('error', reject); request.end('{"command":"status"}');
  });
}
function retainedInfo(socketPath, timeoutMs = 60000, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({path:socketPath, signal}); let text = '';
    socket.setEncoding('utf8'); socket.setTimeout(timeoutMs, () => socket.destroy(Error('Retained status timed out; no request was replayed.')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write('{"command":"retained-info"}\n'));
    socket.on('data', part => {
      text += part;
      if (Buffer.byteLength(text) > 256 * 1024) socket.destroy(Error('Retained status response exceeded its limit.'));
    });
    socket.on('end', () => {
      try {const value = JSON.parse(text); check(!value.error, value.error || 'Retained status failed.'); resolve(value);}
      catch (error) {reject(error);}
    });
  });
}

async function inspect(root, directory, options = {}) {
  await owned(directory, 'directory');
  check(selectedProfile(root).supportsHeldRPC, 'Select a host profile that supports held RPC.');
  const result = await readJSON(path.join(directory, 'result.json'));
  const trusted = trustedProfileForDigest(root, result.sourceSha256), profile = trusted.profile;
  // bounded private reads supplement the ordinary held proof validator.
  const current = await readJSON(path.join(directory, 'switch2/fs-execution-current.json'));
  async function runJSON(file) {
    check(typeof file === 'string' && file.startsWith(directory+path.sep) && path.resolve(file) === file,
      'The held proof points outside its run folder.');
    return readJSON(file);
  }
  const executionProof = await runJSON(current.file);
  const report = await runJSON(executionProof.report);
  const acquisition = await readJSON(path.join(directory, 'switch2/current-acquisition.json'));
  await readJSON(path.join(directory, 'switch2/ro/current-execution.json'));
  check(typeof current.session === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(current.session), 'Invalid held session identity.');
  await readJSON(path.join(directory, 'switch2/ro', current.session+'-loader-root-copy.json'));
  const proof = await verifiedSession(directory);
  check(proof.root === directory && proof.session === path.basename(directory), 'The selected held run has a different session identity.');
  const connectionFile = path.join(directory, 'connection.json');
  const connection = await readJSON(connectionFile), addresses = connection.addresses;
  check(Number.isSafeInteger(connection.port) && connection.port > 0 && connection.port <= 65535 &&
    addresses?.session === proof.session && addresses?.platform === 2 && addresses?.target === 'switch2',
    'The native bridge does not belong to the selected held run.');
  for (const name of ['scratch','main','sdk','backing','controller'])
    check(Number.isSafeInteger(addresses[name]) && addresses[name] >= 4096 && addresses[name] < 2 ** 39,
      'Invalid held native address: '+name);
  const socketPath = current.retainedEndpoint.socketPath;
  check(acquisition.socketPath === socketPath && report.memoryControl?.socketPath === socketPath,
    'The held retained endpoint does not belong to the current acquisition.');
  check(path.isAbsolute(socketPath) && path.resolve(socketPath) === socketPath &&
    !(await fs.lstat(socketPath)).isSymbolicLink(), 'The retained endpoint must be an owned local socket.');
  // macos tmpdir commonly starts with /var, whose system alias is /private/var.
  const canonicalSocket = await fs.realpath(socketPath);
  await owned(canonicalSocket, 'socket');
  await owned(path.dirname(canonicalSocket), 'directory');
  const connectionSha256 = hash(await fs.readFile(connectionFile));
  const codeSha256 = await verifyCode(directory, trusted.sourceDirectory);
  const status = await (options.statusRequest || statusRequest)(connection.port, options.timeoutMs, options.signal);
  check(status?.ready === true, 'The original native RPC bridge is not ready.');
  let info, busy = false;
  try {info = await (options.retainedInfo || retainedInfo)(socketPath, options.timeoutMs, options.signal);}
  catch (error) {
    // the upstream runner rejects this read-only request before dispatch when
    // another retained operation owns it. Monitoring must not interrupt that work.
    if (options.allowRetainedBusy && error.message === 'Another memory request is active') busy = true;
    else throw error;
  }
  check(busy || info?.ready === true && info.steadyStateReliable === true && info.requiresCorruption === false &&
    info.session === proof.session && info.report === proof.reportFile &&
    Number.isSafeInteger(info.corruptionCount) && Array.isArray(report.cases) && info.corruptionCount === report.cases.length,
    'The live retained endpoint did not confirm this exact held session.');
  check(hash(await fs.readFile(connectionFile)) === connectionSha256,
    'The original native bridge changed while checking its identity.');
  return {directory, session:proof.session, profileId:profile.id, sourceSha256:profile.sourceSha256,
    proofFile:proof.proofFile, reportFile:proof.reportFile, socketPath, connectionSha256, codeSha256,
    description:profile.label+' · '+proof.session, status:{...status, ...(busy ? {retainedBusy:true} : {})}};
}
function identity(value) {
  return JSON.stringify(['directory','session','profileId','sourceSha256','proofFile','reportFile','socketPath',
    'connectionSha256','codeSha256'].map(key => value[key]));
}
async function claimedStatus(initial, options) {
  const directory = initial.directory;
  await owned(directory, 'directory');
  const result = await readJSON(path.join(directory, 'result.json'));
  const current = await readJSON(path.join(directory, 'switch2/fs-execution-current.json'));
  const held = value => value?.session === initial.session && value.file === initial.proofFile &&
    value.verified === true && value.restored === true && !value.error &&
    value.cleanup?.deferred === true && value.cleanup?.cleanedUp !== true &&
    value.cleanup?.donor?.cleanedUp === true && value.retainedEndpoint?.ready === true &&
    value.retainedEndpoint.session === initial.session && value.retainedEndpoint.socketPath === initial.socketPath;
  check(result.platform === 2 && result.sourceSha256 === initial.sourceSha256 && result.verified === true && !result.error &&
    result.rpc?.mode === 'held' && result.rpc?.state === 'listening' && held(result.fs) && held(current),
    'The original held RPC session is no longer available.');
  const connectionFile = path.join(directory, 'connection.json'), connection = await readJSON(connectionFile);
  check(hash(await fs.readFile(connectionFile)) === initial.connectionSha256,
    'The original held RPC session connection changed.');
  // once an app owns the attempt, never probe the retained fs runner: even an
  // info request takes its exclusive busy flag. Mutable in-flight proof fields
  // are not evidence of session loss. Native status is serialized by the bridge.
  const status = await (options.statusRequest || statusRequest)(connection.port, options.timeoutMs, options.signal);
  check(status?.ready === true, 'The original native RPC bridge is not ready.');
  return status;
}
async function manifestDirectory(root) {
  const directory = path.join(root, '.attachments');
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  await owned(directory, 'directory'); return directory;
}

async function validateManifest(root, directory, manifestPath = process.env.MAC2JB_ATTACHED_RUN_MANIFEST, options = {}) {
  root = await fs.realpath(root);
  check(typeof manifestPath === 'string' && path.dirname(manifestPath) === path.join(root, '.attachments') &&
    /^[a-f0-9]{64}\.json$/.test(path.basename(manifestPath)),
    'The launcher must attach to this app’s current held run or an explicitly authorized local attachment.');
  await owned(path.dirname(manifestPath), 'directory');
  const manifest = await readJSON(manifestPath);
  check(manifest.format === FORMAT && manifest.root === root && manifest.directory === directory &&
    manifest.token+'.json' === path.basename(manifestPath) && applications.has(manifest.application),
    'The local attachment authorization does not match this run.');
  const owner = await readJSON(path.join(directory, OWNER));
  check(owner.token === manifest.token && owner.session === manifest.session && owner.application === manifest.application,
    'The local attachment does not own this one-application attempt.');
  const current = await inspect(root, directory, options);
  check(identity(current) === identity(manifest), 'The authorized held run changed.');
  return current;
}

async function prepare(root, config, options = {}) {
  check(config && config.kind === 'local' && typeof config.runDirectory === 'string' &&
    path.isAbsolute(config.runDirectory), 'Choose an existing local held RPC run folder.');
  root = await fs.realpath(root);
  const directory = path.resolve(config.runDirectory);
  // reject aliased selections rather than following a link into another run.
  check(config.runDirectory === directory, 'Use the canonical path to the held run folder.');
  const initial = await inspect(root, directory, options);
  check(await absent(path.join(directory, ATTEMPT)) && await absent(path.join(directory, OWNER)),
    'This held session already has a homebrew attempt. Start a fresh console session.');
  const token = crypto.randomBytes(32).toString('hex');
  const manifestPath = path.join(await manifestDirectory(root), token+'.json');
  const manifest = {...initial, format:FORMAT, root, token, created:new Date().toISOString()};
  delete manifest.status;
  await writeJSON(manifestPath, manifest, true);
  let closed = false, lost, claimed = false, claimInFlight;
  const probes = new Set();
  function abortVerification() {for (const controller of probes) controller.abort();}
  async function removeAuthorization() {
    try {const value = await readJSON(manifestPath); if (value.token === token) await fs.unlink(manifestPath);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  async function verify({allowRetainedBusy = true} = {}) {
    check(!closed && !lost, lost?.message || 'The local RPC attachment is closed.');
    const controller = new AbortController(); probes.add(controller);
    try {
      const probeOptions = {...options, allowRetainedBusy, signal:controller.signal};
      const current = claimed ? {status:await claimedStatus(initial, probeOptions)} : await inspect(root, directory, probeOptions);
      check(!closed, 'The local RPC attachment is closed.');
      if (!claimed) check(identity(current) === identity(initial), 'The original held RPC session changed.');
      if (!claimed) check(await absent(path.join(directory, ATTEMPT)) && await absent(path.join(directory, OWNER)),
        'Another homebrew attempt claimed the original session.');
      else {
        const owner = await readJSON(path.join(directory, OWNER));
        check(owner.token === token && owner.session === initial.session && owner.application === manifest.application,
          'The original session attachment ownership changed.');
      }
      return current.status;
    } catch (error) {
      if (!controller.signal.aborted) {lost = error; await removeAuthorization().catch(()=>{});}
      throw error;
    } finally {probes.delete(controller);}
  }
  async function claimApplication(application) {
    check(applications.has(application), 'Unknown homebrew application.');
    check(!claimed && !claimInFlight, 'This attachment has already used its homebrew attempt.');
    claimInFlight = (async () => {
      await verify({allowRetainedBusy:false});
      await writeJSON(path.join(directory, OWNER), {token, session:initial.session, application,
        created:new Date().toISOString()}, true);
      claimed = true; manifest.application = application;
      check(!closed, 'The local RPC attachment is closed.');
      check(await absent(path.join(directory, ATTEMPT)), 'Another helper already claimed this held session.');
      await writeJSON(manifestPath, manifest);
    })();
    return claimInFlight;
  }
  async function releaseApplication() {
    check(claimed && !closed && !lost, 'No live application claim can be released.');
    await claimInFlight;
    const status = await verify();
    check(status?.ready === true && await absent(path.join(directory, ATTEMPT)),
      'The app did not prove a pre-transfer failure. Keep this session claimed.');
    const ownerFile = path.join(directory, OWNER), owner = await readJSON(ownerFile);
    check(owner.token === token && owner.session === initial.session && owner.application === manifest.application,
      'The original session attachment ownership changed.');
    const application = manifest.application;
    delete manifest.application;
    try {
      await writeJSON(manifestPath, manifest);
      await fs.unlink(ownerFile);
    } catch (error) {
      manifest.application = application;
      await writeJSON(manifestPath, manifest).catch(() => {});
      throw error;
    }
    claimed = false; claimInFlight = undefined;
    return status;
  }
  async function close() {
    if (closed) return; closed = true;
    abortVerification();
    await claimInFlight?.catch(()=>{});
    await removeAuthorization();
    // never remove the original attempt/owner markers, stop its host or retire fs.
  }
  return {directory, sourceSession:initial.session, description:initial.description,
    manifestPath, verify, abortVerification, claimApplication, releaseApplication, close};
}

module.exports = {prepare, validateManifest, inspect, verifyCode, statusRequest, retainedInfo, OWNER, ATTEMPT};
