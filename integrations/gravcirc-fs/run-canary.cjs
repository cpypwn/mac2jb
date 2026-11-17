const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {probe} = require('./probe.cjs');
const {executeLua} = require('./repl-client.cjs');
const {stage, validateProfile} = require('./stage.cjs');
const {relay} = require('./relay.cjs');
const {qualifyTimingProof} = require('./timing-proof.cjs');
const {requireGeometryProof} = require('./geometry-proof.cjs');
const {loadTarget, assertCanarySupported, assertWorkerSupported} =
  require('../civswitch/fs-kit/port/engine/shared/target.cjs');

const ENGINE = path.join(__dirname, '../civswitch/fs-kit/port/engine/run.cjs');
const DEFAULT_PROFILE = path.join(__dirname, 'profile.v1.2.1.json');
const STATUS_SOURCE = [
  'if not LS or not LS.fs_bridge then return "GC_BRIDGE_V1\\tabsent" end',
  'local b=LS.fs_bridge; local p=b.profile or {}',
  'return table.concat({"GC_BRIDGE_V1",tostring(b.stage),tostring(p.hostIp),',
  'tostring(p.port or 39380),tostring(p.gameProfile),tostring(p.sdkCrc32)},"\\t")',
].join('\n');
const APP_ARENA_BYTES = {app: 0x80000, 'write-size': 0x2400000,
  'one-mib': 0x2400000, 'split-mib': 0x2400000,
  geometry: 0x2400000, canary: 0x2400000,
  full: 0x2400000};

function args(values) {
  if (values.length < 2 || values.length > 3 ||
      net.isIP(values[0]) !== 4 || net.isIP(values[1]) !== 4) {
    throw Error('Usage: node run-canary.cjs <switch-ipv4> <mac-ipv4> [measured-profile.json]');
  }
  return {switchIp: values[0], macIp: values[1],
    profilePath: values[2] ? path.resolve(values[2]) : DEFAULT_PROFILE};
}

function parseStatus(reply) {
  if (typeof reply !== 'string') throw Error('Gravity Circuit bridge status is not text');
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith('-> GC_BRIDGE_V1\t'));
  if (lines.length !== 1) throw Error('Gravity Circuit bridge status was not recognized');
  const fields = lines[0].slice(3).split('\t');
  if (fields.length === 2 && fields[1] === 'absent') return {stage: 'absent'};
  if (fields.length !== 6) throw Error('Gravity Circuit bridge status is incomplete');
  const [, stageName, hostIp, portText, gameProfile, crcText] = fields;
  const port = Number(portText), sdkCrc32 = Number(crcText);
  if (!['accept', 'send-hello', 'read-request', 'read-header', 'read-data',
    'send-response', 'closed'].includes(stageName) ||
      net.isIP(hostIp) !== 4 || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !Number.isInteger(sdkCrc32) || sdkCrc32 < 0 || sdkCrc32 > 0xffffffff)
    throw Error('Gravity Circuit bridge status has invalid fields');
  return {stage: stageName, hostIp, port, gameProfile, sdkCrc32};
}

async function ensureBridge({switchIp, macIp, profile}, dependencies = {}) {
  const runProbe = dependencies.probe || probe;
  const runLua = dependencies.executeLua || executeLua;
  const runStage = dependencies.stage || stage;
  const live = await runProbe({host: switchIp});
  if (!live.runtimeReady || live.gameId !== 'gravity-circuit')
    throw Error('Gravity Circuit native REPL is not ready');
  const measured = validateProfile(profile, {nativeProfile: live.nativeProfile, macIp});
  const status = parseStatus(await runLua({host: switchIp, source: STATUS_SOURCE}));
  if (status.stage === 'absent' || status.stage === 'closed') {
    return runStage({switchIp, macIp, profile: measured});
  }
  if (status.stage !== 'accept')
    throw Error(`Gravity Circuit bridge is busy at ${status.stage}; refusing to take over a native request`);
  if (status.hostIp !== macIp || status.port !== measured.port ||
      status.gameProfile !== measured.gameProfile || status.sdkCrc32 !== measured.sdkCrc32)
    throw Error('Gravity Circuit bridge belongs to a different measured profile or Mac address');
  return {probe: live, bridge: {status: 'listening', port: status.port, reused: true}};
}

async function reserveAppArena({switchIp, mode}, dependencies = {}) {
  const bytes = APP_ARENA_BYTES[mode];
  if (!bytes || net.isIP(switchIp) !== 4) throw Error('Invalid Gravity Circuit app arena request');
  const source = `return assert(LS.fs_bridge, "FS bridge is absent"):reserveAppArena(${bytes})`;
  const reply = await (dependencies.executeLua || executeLua)({host: switchIp, source});
  const matches = [...reply.matchAll(/^-> GC_APP_ARENA_V1\t(\d+)\t(\d+)\s*$/gm)];
  if (matches.length !== 1 || Number(matches[0][2]) < bytes ||
      Number(matches[0][1]) % 4096 !== 0 || Number(matches[0][1]) < 0x1000 ||
      Number(matches[0][1]) + Number(matches[0][2]) >= 2 ** 39)
    throw Error('Gravity Circuit app arena was not reserved and verified');
  return {base: Number(matches[0][1]), bytes: Number(matches[0][2])};
}

function startHost(macIp, timeoutMs = 30000, dependencies = {}, mode = 'canary') {
  const displayName = loadTarget('gravcirc').displayName;
  const modeFlag = {app: '--app-only', 'write-size': '--write-size-only',
    'one-mib': '--one-mib-retry', 'split-mib': '--split-mib',
    geometry: '--geometry-only', canary: '--canary-only',
    full: '--rpc'}[mode];
  if (!modeFlag) throw Error('Unknown Gravity Circuit run mode');
  if (mode === 'full' && !dependencies.timingProof)
    throw Error('Gravity Circuit full run requires a fresh native timing proof');
  const child = (dependencies.spawnProcess || spawn)(process.execPath,
    [ENGINE, '--target', 'gravcirc', modeFlag, macIp],
    {stdio: ['ignore', 'pipe', 'pipe'], detached: mode === 'full',
      env: {...process.env, ...(dependencies.runRoot ?
        {NS2_RUN_ROOT: dependencies.runRoot} : {}),
        ...(['write-size', 'geometry'].includes(mode) ?
        {NS2_WRITE_SIZE_MAX: '524288'} : {}),
        ...(mode === 'one-mib' ? {NS2_ONE_SHOT_SIZE: String(
          require('../civswitch/fs-kit/port/engine/switch2/app/one-mib-transaction.cjs')
            .parseOneShotSize(dependencies.retrySize))} : {}),
        ...(dependencies.timingProof ?
        {NS2_GC_TIMING_PROOF: JSON.stringify(dependencies.timingProof)} : {})}});
  let complete = false, settled = false, stdout = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  let heldResolve, heldReject;
  const heldReady = mode === 'full' ? new Promise((resolve, reject) => {
    heldResolve = resolve; heldReject = reject;
  }) : null;
  heldReady?.catch(() => {});
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      readyReject(Error('Gravity Circuit FS listener did not start in time'));
    }
    child.kill('SIGTERM');
  }, timeoutMs);
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    stdout += chunk.toString('utf8');
    const lines = stdout.split('\n');
    stdout = lines.pop();
    for (const line of lines) {
      if (!settled && line === `Waiting for ${displayName} at ${macIp}:39380.`) {
        settled = true;
        clearTimeout(timeout);
        readyResolve();
      }
      if (heldResolve && line.startsWith(`4/4 verified. ${displayName} RPC and FS memory endpoint remain live`)) {
        heldResolve();
        heldResolve = null;
      }
    }
  });
  child.stderr.pipe(process.stderr);
  const finished = new Promise((resolve, reject) => {
    child.once('error', error => {
      if (!settled) readyReject(error);
      if (heldReject) heldReject(error);
      reject(error);
    });
    child.once('close', (code, signal) => {
      complete = true;
      clearTimeout(timeout);
      if (!settled) readyReject(Error(`Gravity Circuit FS listener exited before ready (${code ?? signal})`));
      if (heldReject && heldResolve)
        heldReject(Error(`Gravity Circuit FS host exited before held RPC was ready (${code ?? signal})`));
      resolve({code, signal});
    });
  });
  finished.catch(() => {});
  return {ready, heldReady, finished, stop() {if (!complete) child.kill('SIGTERM');}};
}

async function main(values = process.argv.slice(2), dependencies = {}, mode = 'canary') {
  const {switchIp, macIp, profilePath} = args(values);
  if (mode === 'one-mib')
    require('../civswitch/fs-kit/port/engine/switch2/app/one-mib-transaction.cjs')
      .parseOneShotSize(dependencies.retrySize);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (mode === 'geometry' || mode === 'app' || mode === 'write-size' ||
      mode === 'one-mib' || mode === 'split-mib')
    assertWorkerSupported(loadTarget('gravcirc'));
  else if (mode === 'canary') {
    const target = loadTarget('gravcirc');
    (dependencies.assertCanarySupported || assertCanarySupported)(target);
    (dependencies.requireGeometryProof || requireGeometryProof)(target,
      dependencies.geometryProofPath || process.env.NS2_GC_GEOMETRY_PROOF);
  }
  else throw Error('Unknown Gravity Circuit run mode');
  const start = dependencies.startHost || startHost;
  const runRelay = dependencies.relay || relay;
  const staged = await ensureBridge({switchIp, macIp, profile}, dependencies);
  process.stdout.write(`Gravity Circuit bridge ${staged.bridge.reused ? 'reused' : 'staged'} on port ${staged.bridge.port}.\n`);
  const arena = await reserveAppArena({switchIp, mode}, dependencies);
  process.stdout.write(`Gravity Circuit app arena reserved: ${arena.bytes} bytes.\n`);
  const timingProof = await (dependencies.qualifyTimingProof || qualifyTimingProof)({switchIp}, dependencies);
  process.stdout.write(`Gravity Circuit native counter verified: ${timingProof.measuredFrequency} Hz.\n`);
  if (dependencies.beforeHostStart) await dependencies.beforeHostStart();
  const host = start(macIp, undefined, {...dependencies, timingProof}, mode);
  try {
    await host.ready;
    const traffic = await runRelay({switchIp, macIp, bridgePort: staged.bridge.port});
    const outcome = await host.finished;
    if (outcome.code !== 0) throw Error(`Gravity Circuit ${mode}-only host exited without verification`);
    return {traffic, outcome};
  } finally {host.stop();}
}

module.exports = {args, parseStatus, ensureBridge, reserveAppArena, startHost, main};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
