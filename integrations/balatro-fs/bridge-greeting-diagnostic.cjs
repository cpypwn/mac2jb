const crypto = require('node:crypto');
const net = require('node:net');
const {performance} = require('node:perf_hooks');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const {openConnection} = require('./native-readonly-smoke.cjs');
const {makeIdleSource, parseIdleReply, makeReleaseSource,
  parseReleaseReply} = require('./native-counter-overlap.cjs');
const {sameImage, sameArena, formatFailure,
  makeIdleSource: makeRetainedIdleSource,
  parseIdleReply: parseRetainedIdleReply} = require('./fs-root-batch-live.cjs');
const {MARKER, makeStateSource, parseStateReply} = require('./bridge-state.cjs');
const transport = require('./transport-probe.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const SNAPSHOT_DELAY_MS = 1000;
const GREETING_TIMEOUT_MS = 15000;
const MAX_OPERATION_MS = 90000;

function delay(ms) {return new Promise(resolve => setTimeout(resolve, ms));}

async function runBridgeGreetingDiagnostic({host, macIp,
  nonce = crypto.randomBytes(8).toString('hex'), execute = executeLua,
  identifyImage = identify, inspectArena = checkArena,
  stage = stageNativeBridge, connect = openConnection,
  sleep = delay, clock = () => performance.now(), onPhase = () => {},
  maxOperationMs = MAX_OPERATION_MS}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce) ||
      !Number.isInteger(maxOperationMs) || maxOperationMs < SNAPSHOT_DELAY_MS ||
      maxOperationMs > MAX_OPERATION_MS ||
      [execute, identifyImage, inspectArena, stage, connect, sleep, clock, onPhase]
        .some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro greeting diagnostic needs IPv4 and bounded dependencies');
  }
  const start = clock();
  const events = [];
  const phase = label => {
    events.push({phase: label, elapsedMs: Math.round(clock() - start)});
    onPhase(label);
  };
  const checkBudget = () => {
    if (clock() - start >= maxOperationMs) {
      throw Error(`Balatro greeting operation exceeded ${maxOperationMs} ms; stopping before another phase`);
    }
  };
  const idle = async image => parseIdleReply(await execute({host, port: 9026,
    source: makeIdleSource({nonce, mainBase: image.mainBase,
      sdkBase: image.sdkBase}), timeoutMs: 10000}), nonce);
  phase('verify pinned Balatro image and idle state');
  const before = await identifyImage(host);
  sameImage(before, before, before.sdkBase);
  await idle(before);
  checkBudget();
  phase('reserve fresh owner-bound 2 MiB arena');
  const arena = await inspectArena({host, phase: 'reserve', nonce, execute});
  if (arena.phase !== 'reserve' || arena.nonce !== nonce ||
      arena.bytes !== 0x200000 || !/^0x[0-9a-f]+$/.test(arena.base || '')) {
    throw Error(`Balatro arena reservation is uncertain; owner=${nonce}; no automatic release`);
  }
  const inspected = await inspectArena({host, phase: 'inspect', nonce, execute});
  if (inspected.base !== arena.base) {
    throw Error(`Balatro arena moved after reservation; owner=${nonce}; no automatic release`);
  }
  sameArena(inspected, inspected, nonce);
  sameImage(before, await identifyImage(host), before.sdkBase);

  let staged = false;
  let stageAttempted = false;
  let connection;
  let greeting;
  let beforeConnect;
  let duringConnect;
  let afterGreeting;
  let localAddress;
  let operationError;
  const cleanupErrors = [];
  let listenerClosed = false;
  let releaseAttempted = false;
  let arenaDetached = false;
  const state = async () => parseStateReply(await execute({host, port: 9026,
    source: makeStateSource({nonce, mainBase: before.mainBase,
      sdkBase: before.sdkBase, arenaBase: arena.base, macIp}), timeoutMs: 3000}), nonce);
  try {
    checkBudget();
    phase('stage one native bridge without save-directory IPC');
    stageAttempted = true;
    const ready = await stage({host, macIp, nonce, port: transport.PORT,
      execute, onPhase: phase});
    if (ready.stage !== 'ready' || ready.nonce !== nonce ||
        ready.arenaBase !== arena.base || ready.port !== transport.PORT) {
      throw Error('Balatro native bridge stage reused or changed owner');
    }
    staged = true;
    sameImage(before, await identifyImage(host), before.sdkBase);
    beforeConnect = await state();
    if (beforeConnect.stage !== 'accept' || beforeConnect.accepted !== 0 ||
        beforeConnect.rejectedPeers !== 0 || beforeConnect.client !== 'absent' ||
        beforeConnect.listener !== 'present') {
      throw Error('Balatro bridge was not listening cleanly before connect');
    }
    checkBudget();
    phase('connect one TCP client and begin 128-byte greeting');
    connection = await connect(host, transport.PORT, GREETING_TIMEOUT_MS);
    localAddress = connection.socket?.localAddress || null;
    const readOutcome = connection.read(128).then(
      value => ({ok: true, value}), error => ({ok: false, error}));
    await sleep(SNAPSHOT_DELAY_MS);
    checkBudget();
    phase('snapshot native bridge while TCP client remains open');
    duringConnect = await state();
    if (duringConnect.stage === 'closed' || duringConnect.stage === 'absent') {
      throw Error(`Balatro bridge closed before greeting: ${duringConnect.lastTransportError || duringConnect.stage}`);
    }
    if (duringConnect.rejectedPeers > 0) {
      throw Error(`Balatro bridge rejected the TCP peer: ${duringConnect.lastPeer}`);
    }
    checkBudget();
    const read = await readOutcome;
    if (!read.ok) throw read.error;
    greeting = transport.parseHello(read.value, {arenaBase: arena.base});
    if (greeting.mainBase !== before.mainBase ||
        greeting.sdkBase !== before.sdkBase) {
      throw Error('Balatro native greeting changed the pinned image');
    }
    afterGreeting = await state();
    checkBudget();
    if (afterGreeting.stage !== 'read-request' || afterGreeting.accepted !== 1 ||
        afterGreeting.rejectedPeers !== 0 || afterGreeting.client !== 'present') {
      throw Error('Balatro native greeting completed with changed transport state');
    }
    phase('verified one native bridge greeting; no save-directory IPC issued');
  } catch (error) {
    operationError = error;
  } finally {
    connection?.close();
    if (staged) {
      phase('close the owner-bound transport listener once');
      try {
        transport.parseCloseReply(await execute({host, port: 9026,
          source: transport.makeCloseSource({nonce, hostIp: macIp,
            port: transport.PORT}), timeoutMs: 15000}), {port: transport.PORT});
        listenerClosed = true;
      } catch (error) {cleanupErrors.push(error);}
    }
    if (listenerClosed || !stageAttempted) {
      try {
        const afterArena = await inspectArena({host, phase: 'inspect', nonce, execute});
        sameArena(inspected, afterArena, nonce);
        sameImage(before, await identifyImage(host), before.sdkBase);
        const reply = await execute({host, port: 9026,
          source: makeRetainedIdleSource({nonce, mainBase: before.mainBase,
            sdkBase: before.sdkBase, arenaBase: arena.base}), timeoutMs: 10000});
        parseRetainedIdleReply(reply, nonce);
        releaseAttempted = true;
        phase('detach the verified owner-bound arena once');
        const released = parseReleaseReply(await execute({host, port: 9026,
          source: makeReleaseSource({nonce, arenaBase: arena.base,
            sdkBase: before.sdkBase}), timeoutMs: 10000}),
        {nonce, arenaBase: arena.base});
        arenaDetached = released.arena === 'detached';
        sameImage(before, await identifyImage(host), before.sdkBase);
        await idle(before);
      } catch (error) {cleanupErrors.push(error);}
    }
  }
  const diagnostic = {gameProfile: profile.gameProfile, nonce,
    arenaBase: arena.base, localAddress, beforeConnect, duringConnect,
    afterGreeting, greeting: greeting || null, events,
    maxOperationMs, stageAttempted, listenerClosed, releaseAttempted, arenaDetached,
    explicitSaveDirectoryIpcRequests: 0, fsMarkerVerified: false,
    fsStageVerified: false};
  if (operationError || cleanupErrors.length) {
    const error = new AggregateError([
      ...(operationError ? [operationError] : []), ...cleanupErrors],
    'Balatro bridge greeting diagnostic stopped; no automatic retry');
    error.diagnostic = diagnostic;
    throw error;
  }
  return {...diagnostic,
    status: 'one native greeting verified and all owned resources released; no FS marker or 2/4 claimed'};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node bridge-greeting-diagnostic.cjs <switch-ipv4> <mac-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runBridgeGreetingDiagnostic({host: argv[0], macIp: argv[1],
      onPhase: value => process.stderr.write(`phase: ${value}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\n`);
    if (error.diagnostic) process.stderr.write(`${JSON.stringify(error.diagnostic, null, 2)}\n`);
    process.stderr.write('No automatic retry was attempted. Inspect owner state before another run.\n');
    process.exitCode = 1;
  }
}

module.exports = {MARKER, SNAPSHOT_DELAY_MS, GREETING_TIMEOUT_MS, MAX_OPERATION_MS,
  makeStateSource, parseStateReply, runBridgeGreetingDiagnostic, main};
if (require.main === module) main();
