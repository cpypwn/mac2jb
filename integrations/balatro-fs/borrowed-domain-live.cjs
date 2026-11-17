const crypto = require('node:crypto');
const net = require('node:net');
const {NativeClient} = require('../civswitch/fs-kit/port/engine/lib/native.cjs');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {probeDomainLive} = require('./probe-domain-live.cjs');
const {matchingBoot} = require('./clone-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const {openConnection} = require('./native-readonly-smoke.cjs');
const {makeIdleSource, parseIdleReply, makeReleaseSource,
  parseReleaseReply} = require('./native-counter-overlap.cjs');
const {sameImage, sameArena, makeIdleSource: makeOwnedIdleSource,
  parseIdleReply: parseOwnedIdleReply, formatFailure} = require('./fs-root-batch-live.cjs');
const {balatroTarget} = require('./clone-control-live.cjs');
const {runBorrowedControlDiscriminator} = require('./borrowed-control-discriminator.cjs');
const bridge = require('./transport-probe.cjs');

async function runFreshBorrowedDomain({host, macIp,
  nonce = crypto.randomBytes(8).toString('hex'), execute = executeLua,
  identifyImage = identify, inspectArena = checkArena, probe = probeDomainLive,
  stage = stageNativeBridge, connect = openConnection,
  makeNative = (connection, addresses) => new NativeClient(connection,
    addresses, balatroTarget()),
  makeTransport = options => new BalatroCloneTransport(options),
  runOne = runBorrowedControlDiscriminator, onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('Balatro borrowed-domain check needs IPv4 and a fresh owner nonce');
  }
  if ([execute, identifyImage, inspectArena, probe, stage, connect, makeNative,
    makeTransport, runOne, onPhase].some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro borrowed-domain dependencies are incomplete');
  }
  let currentPhase = 'preflight';
  const phase = value => {currentPhase = value; onPhase(value);};
  const currentDomain = () => probe({host, nonceBytes: () => Buffer.from(nonce, 'hex')});
  const idle = image => execute({host, port: 9026,
    source: makeIdleSource({nonce, mainBase: image.mainBase,
      sdkBase: image.sdkBase}), timeoutMs: 10000});

  phase('verify fresh pinned Balatro image, idle state, and direct absent path');
  const beforeImage = await identifyImage(host);
  const evidence = await currentDomain();
  sameImage(beforeImage, beforeImage, evidence.sdkBase);
  parseIdleReply(await idle(beforeImage), nonce);
  matchingBoot(evidence, await currentDomain());

  phase(`reserve fresh owned arena ${nonce}`);
  const reserved = await inspectArena({host, phase: 'reserve', nonce, execute});
  if (reserved.phase !== 'reserve' || reserved.nonce !== nonce ||
      reserved.bytes !== 0x200000 || !/^0x[0-9a-f]+$/.test(reserved.base || '')) {
    throw Error(`Balatro arena reservation is uncertain; owner=${nonce}; inspect before retry`);
  }
  const arena = await inspectArena({host, phase: 'inspect', nonce, execute});
  sameArena(arena, arena, nonce);
  if (arena.base !== reserved.base) {
    throw Error(`Balatro arena changed after reservation; owner=${nonce}`);
  }
  sameImage(beforeImage, await identifyImage(host), evidence.sdkBase);
  matchingBoot(evidence, await currentDomain());

  let staged;
  let connection;
  let native;
  let transport;
  let hello;
  let result;
  let operationError;
  const cleanupErrors = [];
  try {
    phase('stage owner-bound native bridge');
    staged = await stage({host, macIp, nonce, port: bridge.PORT,
      execute, onPhase: phase});
    if (staged.stage !== 'ready' || staged.nonce !== nonce ||
        staged.port !== bridge.PORT || staged.arenaBase !== arena.base) {
      throw Error('Balatro native bridge owner or arena changed');
    }
    phase('connect immediately and verify exact native greeting');
    connection = await connect(host, bridge.PORT, 15000);
    hello = bridge.parseHello(await connection.read(128),
      {arenaBase: arena.base});
    if (hello.mainBase !== beforeImage.mainBase ||
        hello.sdkBase !== evidence.sdkBase ||
        hello.sdkCrc32 !== Number.parseInt(evidence.sdkCrc32, 16)) {
      throw Error('Balatro native greeting differs from the fresh pinned image');
    }
    sameImage(beforeImage, await identifyImage(host), evidence.sdkBase);
    native = makeNative(connection, {sdk: Number(BigInt(hello.sdkBase)),
      scratch: Number(BigInt(hello.scratch))});
    transport = makeTransport({native, evidence, inspectLive: currentDomain});
    await transport.initialize();
    phase('read full manager and slot tables around one borrowed-handle HIPC control');
    result = await runOne({evidence, transport, inspectDomain: currentDomain,
      onPhase: phase});
  } catch (error) {operationError = error;}
  finally {
    if (transport?.ownedHandles.size) {
      cleanupErrors.push(Error('Balatro borrowed-domain check acquired an unexpected handle'));
    }
    if (native) {
      phase('stop native bridge once');
      try {await native.stop();} catch (error) {cleanupErrors.push(error);}
    } else connection?.close();
    if (staged?.stage === 'ready') {
      phase('close owner-bound listener once');
      try {
        bridge.parseCloseReply(await execute({host, port: 9026,
          source: bridge.makeCloseSource({nonce, hostIp: macIp, port: bridge.PORT}),
          timeoutMs: 15000}), {port: bridge.PORT});
      } catch (error) {cleanupErrors.push(error);}
    }
  }
  if (operationError || cleanupErrors.length) {
    const error = new AggregateError([...(operationError ? [operationError] : []),
      ...cleanupErrors],
    'Balatro borrowed-domain discriminator stopped; arena retained for owner inspection');
    error.diagnostic = {owner: nonce, arenaBase: arena.base,
      currentPhase, greeting: hello || null,
      oneSend: operationError?.diagnostic || null,
      ownedHandles: transport ? [...transport.ownedHandles] : null,
      saveWrites: 0, domainClones: 0, markerWrites: 0,
      releaseAttempted: false};
    throw error;
  }

  phase('verify pinned image, owner, idle state, and manager after cleanup');
  sameImage(beforeImage, await identifyImage(host), evidence.sdkBase);
  sameArena(arena, await inspectArena({host, phase: 'inspect', nonce, execute}), nonce);
  parseOwnedIdleReply(await execute({host, port: 9026,
    source: makeOwnedIdleSource({nonce, mainBase: beforeImage.mainBase,
      sdkBase: beforeImage.sdkBase, arenaBase: arena.base}), timeoutMs: 10000}), nonce);
  matchingBoot(evidence, await currentDomain());

  phase(`detach verified owner once ${nonce}`);
  const released = parseReleaseReply(await execute({host, port: 9026,
    source: makeReleaseSource({nonce, arenaBase: arena.base,
      sdkBase: beforeImage.sdkBase}), timeoutMs: 10000}),
  {nonce, arenaBase: arena.base});
  if (released.arena !== 'detached' || released.owner !== nonce) {
    throw Error(`Balatro owner release reply changed; owner=${nonce}; no retry`);
  }
  sameImage(beforeImage, await identifyImage(host), evidence.sdkBase);
  parseIdleReply(await idle(beforeImage), nonce);
  matchingBoot(evidence, await currentDomain());
  return {...result, gameProfile: evidence.gameProfile,
    sdkBase: evidence.sdkBase, sdkCrc32: evidence.sdkCrc32,
    owner: nonce, arenaBase: arena.base, arena: 'detached',
    listener: 'closed', nativeBridge: 'closed',
    saveWrites: 0, domainClones: 0, markerWrites: 0,
    rpcLoggingMayWriteSave: true};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || net.isIP(argv[0]) !== 4 || net.isIP(argv[1]) !== 4) {
    process.stderr.write('usage: node borrowed-domain-live.cjs <switch-ipv4> <mac-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runFreshBorrowedDomain({
      host: argv[0], macIp: argv[1],
      onPhase: label => process.stderr.write(`phase: ${label}\n`)}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\nNo automatic retry was attempted.\n`);
    if (error.diagnostic) process.stderr.write(`${JSON.stringify(error.diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {runFreshBorrowedDomain, main};
if (require.main === module) main();
