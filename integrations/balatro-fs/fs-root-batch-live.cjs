const fs = require('node:fs');
const net = require('node:net');
const {NativeClient} = require('../civswitch/fs-kit/port/engine/lib/native.cjs');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {probeDomainLive} = require('./probe-domain-live.cjs');
const {matchingBoot, validateEvidence, copyRequest, copiedHandle} = require('./clone-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {createOwnedSaveIo, probeSaveRoot} = require('./fs-save-tree-audit.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const {openConnection} = require('./native-readonly-smoke.cjs');
const {makeStateSource, parseStateReply} = require('./bridge-state.cjs');
const bridge = require('./transport-probe.cjs');
const {balatroTarget} = require('./clone-control-live.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const IDLE_MARKER = 'BAL_ROOT_BATCH_IDLE_V1';
const BRIDGE_SNAPSHOT_DELAY_MS = 1000;

function delay(ms) {return new Promise(resolve => setTimeout(resolve, ms));}

function formatFailure(error) {
  const lines = [error?.stack || error?.message || String(error)];
  for (const child of error?.errors || []) {
    lines.push(`cause: ${formatFailure(child)}`);
  }
  return lines.join('\n');
}

function sameImage(before, after, sdkBase) {
  if (!before || !after || before.state !== 'serving' || after.state !== 'serving' ||
      before.codeHeadProfile !== '1.0.1f' || after.codeHeadProfile !== '1.0.1f' ||
      !/^1\.0\.1f(?:-|$)/.test(before.metadataVersion || '') ||
      !/^1\.0\.1f(?:-|$)/.test(after.metadataVersion || '') ||
      before.metadataVersion !== after.metadataVersion ||
      before.mainBase !== after.mainBase || before.sdkBase !== sdkBase ||
      after.sdkBase !== sdkBase || before.presentAddress !== after.presentAddress ||
      before.sampleFingerprintSha256 !== after.sampleFingerprintSha256 ||
      before.presentHead !== after.presentHead || before.memcpyHead !== after.memcpyHead ||
      before.memcpyOffset !== after.memcpyOffset) {
    throw Error('Balatro root probe image changed or is not the pinned 1.0.1f build');
  }
  return after;
}

function sameArena(before, after, nonce) {
  if (!before || !after || before.nonce !== nonce || after.nonce !== nonce ||
      before.phase !== 'inspect' || after.phase !== 'inspect' ||
      before.bytes !== 0x200000 || after.bytes !== 0x200000 ||
      before.base !== after.base || !/^0x[0-9a-f]+$/.test(before.base || '')) {
    throw Error('Balatro root probe retained arena changed');
  }
  return after;
}

function makeIdleSource({nonce, mainBase, sdkBase, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      [mainBase, sdkBase, arenaBase].some(value => !/^0x[0-9a-f]+$/.test(value || ''))) {
    throw new TypeError('Balatro root idle gate needs a pinned image and arena owner');
  }
  return `local b=BL\nlocal h=b and b.fs_bridge\nif not b or b.state~='serving' or not b.info or b.info.version~='${profile.runtimeVersion}' or\n   string.format('0x%x',b.info.main_base or 0)~='${mainBase}' or\n   string.format('0x%x',b.info.sdk_base or 0)~='${sdkBase}' or\n   not h or h.owner~='${nonce}' or h.stage~='ready' or\n   string.format('0x%x',h.base or 0)~='${arenaBase}' or h.bytes~=0x200000 or\n   b.fs_worker_hold or b.fs_transport then\n  return '${IDLE_MARKER}\\tfail\\t${nonce}'\nend\nreturn '${IDLE_MARKER}\\tidle\\t${nonce}'`;
}

function parseIdleReply(reply, nonce) {
  if (typeof reply !== 'string' || !/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('Balatro root idle reply or owner is invalid');
  }
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${IDLE_MARKER}\t`));
  if (lines.length !== 1 || lines[0] !== `-> ${IDLE_MARKER}\tidle\t${nonce}`) {
    throw Error('Balatro root probe has active native state or a changed owner');
  }
  return {idle: true, nonce};
}

async function runRootBatchLive({host, macIp, arenaNonce, evidence,
  directoryPath = '/',
  execute = executeLua, identifyImage = identify, inspectArena = checkArena,
  probe = probeDomainLive, stage = stageNativeBridge, connect = openConnection,
  sleep = delay,
  makeNative = (connection, addresses) => new NativeClient(connection, addresses, balatroTarget()),
  makeTransport = options => new BalatroCloneTransport(options),
  makeIo = createOwnedSaveIo, runBatch = probeSaveRoot, onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(arenaNonce || '') ||
      !['/', '/.lovegame'].includes(directoryPath)) {
    throw new TypeError('Balatro root probe requires Switch/Mac IPv4 and a retained arena owner');
  }
  validateEvidence(evidence);
  if ([execute, identifyImage, inspectArena, probe, stage, connect, sleep, makeNative,
    makeTransport, makeIo, runBatch, onPhase].some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro root probe dependencies are invalid');
  }
  const currentEvidence = () => probe({host,
    nonceBytes: () => Buffer.from(evidence.nonce, 'hex')});
  const idle = (image, arena) => execute({host, port: 9026,
    source: makeIdleSource({nonce: arenaNonce, mainBase: image.mainBase,
      sdkBase: image.sdkBase, arenaBase: arena.base}), timeoutMs: 15000});
  let currentPhase = 'preflight';
  const phase = label => {currentPhase = label; onPhase(label);};

  phase('verify pinned image, retained arena, and idle state');
  const beforeImage = await identifyImage(host);
  sameImage(beforeImage, beforeImage, evidence.sdkBase);
  const beforeArena = await inspectArena({host, phase: 'inspect', nonce: arenaNonce, execute});
  sameArena(beforeArena, beforeArena, arenaNonce);
  parseIdleReply(await idle(beforeImage, beforeArena), arenaNonce);
  matchingBoot(evidence, await currentEvidence());

  let staged;
  let connection;
  let native;
  let transport;
  let cloneHandle = null;
  let result;
  let hello;
  let inFlightState;
  let postGreetingState;
  let saveDirectoryIpcStarted = false;
  let operationError;
  const cleanupErrors = [];
  const bridgeState = async () => parseStateReply(await execute({host, port: 9026,
    source: makeStateSource({nonce: arenaNonce, mainBase: beforeImage.mainBase,
      sdkBase: beforeImage.sdkBase, arenaBase: beforeArena.base, macIp}),
    timeoutMs: 3000}), arenaNonce);
  try {
    phase('stage fresh owned bridge');
    staged = await stage({host, macIp, nonce: arenaNonce, port: bridge.PORT,
      execute, onPhase: phase});
    if (staged.stage !== 'ready' || staged.nonce !== arenaNonce ||
        staged.arenaBase !== beforeArena.base || staged.port !== bridge.PORT) {
      throw Error('Balatro root probe bridge was reused or owner changed');
    }
    phase('connect and sample native bridge before the greeting deadline');
    connection = await connect(host, bridge.PORT, 15000);
    const readOutcome = connection.read(128).then(
      value => ({ok: true, value}), error => ({ok: false, error}));
    await sleep(BRIDGE_SNAPSHOT_DELAY_MS);
    inFlightState = await bridgeState();
    if (['closed', 'absent'].includes(inFlightState.stage) ||
        inFlightState.rejectedPeers !== 0) {
      throw Error(`Balatro root bridge did not remain open: ${inFlightState.lastTransportError || inFlightState.stage}`);
    }
    const read = await readOutcome;
    if (!read.ok) throw read.error;
    hello = bridge.parseHello(read.value,
      {arenaBase: beforeArena.base});
    if (hello.sdkBase !== evidence.sdkBase || hello.mainBase !== beforeImage.mainBase ||
        hello.sdkCrc32 !== Number.parseInt(evidence.sdkCrc32, 16)) {
      throw Error('Balatro root probe bridge image or SDK changed');
    }
    postGreetingState = await bridgeState();
    if (postGreetingState.stage !== 'read-request' ||
        postGreetingState.accepted !== 1 || postGreetingState.rejectedPeers !== 0 ||
        postGreetingState.client !== 'present') {
      throw Error('Balatro root bridge greeting completed with changed transport state');
    }
    phase('verify same-boot mounted domain after pinned greeting');
    matchingBoot(evidence, await currentEvidence());
    native = makeNative(connection, {sdk: Number(BigInt(hello.sdkBase)),
      scratch: Number(BigInt(hello.scratch))});
    transport = makeTransport({native, evidence, inspectLive: currentEvidence});
    await transport.initialize();
    matchingBoot(evidence, await transport.inspectLive());
    phase('copy owned save domain and read one root directory batch');
    const request = copyRequest(evidence);
    saveDirectoryIpcStarted = true;
    const reply = await transport.sendControl(request.borrowedHandle, request.packet);
    cloneHandle = copiedHandle(reply, request.borrowedHandle);
    if (!transport.ownedHandles.has(cloneHandle)) {
      throw Error('Balatro root probe clone ownership was not tracked');
    }
    result = await runBatch({io: makeIo(transport, cloneHandle),
      path: directoryPath});
    if (result?.complete !== false ||
        result?.coverage !== 'first-root-directory-batch-only' ||
        result?.path !== directoryPath || !Array.isArray(result.entries) ||
        result.entries.length > 4) {
      throw Error('Balatro root probe exceeded its one-batch read scope');
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (transport && cloneHandle !== null) {
      if (transport.ownedHandles.size === 1 && transport.ownedHandles.has(cloneHandle)) {
        phase('close owned clone handle');
        try {await transport.closeOwned(cloneHandle);} catch (error) {cleanupErrors.push(error);}
      } else {
        cleanupErrors.push(Error('Balatro root probe has unclosed or uncertain owned handles'));
      }
    } else if (transport?.ownedHandles.size) {
      cleanupErrors.push(Error('Balatro root probe transferred an unclaimed owned handle'));
    }
    if (native) {
      phase('stop native bridge');
      try {await native.stop();} catch (error) {cleanupErrors.push(error);}
    } else connection?.close();
    if (staged?.stage === 'ready') {
      phase('close owned listener');
      try {
        bridge.parseCloseReply(await execute({host, port: 9026,
          source: bridge.makeCloseSource({nonce: arenaNonce, hostIp: macIp,
            port: bridge.PORT}), timeoutMs: 15000}), {port: bridge.PORT});
      } catch (error) {cleanupErrors.push(error);}
    }
  }
  if (operationError || cleanupErrors.length) {
    const error = new AggregateError([...(operationError ? [operationError] : []), ...cleanupErrors],
      'Balatro root protocol probe stopped; inspect owned resources before any retry');
    error.diagnostic = {arenaNonce, currentPhase, inFlightState,
      postGreetingState, greeting: hello || null,
      ownedHandles: transport ? [...transport.ownedHandles] : null,
      explicitSaveDirectoryIpcStarted: saveDirectoryIpcStarted};
    throw error;
  }
  phase('verify pinned image, arena, idle state, and mounted domain after cleanup');
  sameImage(beforeImage, await identifyImage(host), evidence.sdkBase);
  sameArena(beforeArena, await inspectArena({host, phase: 'inspect',
    nonce: arenaNonce, execute}), arenaNonce);
  parseIdleReply(await idle(beforeImage, beforeArena), arenaNonce);
  matchingBoot(evidence, await currentEvidence());
  return {gameProfile: profile.gameProfile, arenaNonce,
    status: 'one owned save root directory batch verified; no FS marker or 2/4 claimed',
    ...result, ownedCloneClosed: true, nativeBridgeClosed: true,
    retainedArenaVerified: true};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || net.isIP(argv[0]) !== 4 || net.isIP(argv[1]) !== 4) {
    process.stderr.write('usage: node fs-root-batch-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce> <same-boot-evidence.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const evidence = validateEvidence(JSON.parse(fs.readFileSync(argv[3], 'utf8')));
    const result = await runRootBatchLive({host: argv[0], macIp: argv[1],
      arenaNonce: argv[2], evidence,
      onPhase: phase => process.stderr.write(`phase: ${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\nNo automatic retry was attempted.\n`);
    if (error.diagnostic) process.stderr.write(`${JSON.stringify(error.diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {IDLE_MARKER, BRIDGE_SNAPSHOT_DELAY_MS, formatFailure, sameImage, sameArena, makeIdleSource,
  parseIdleReply, runRootBatchLive, main};
if (require.main === module) main();
