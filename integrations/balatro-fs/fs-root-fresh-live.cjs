const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {probeDomainLive} = require('./probe-domain-live.cjs');
const {matchingBoot, validateEvidence} = require('./clone-control.cjs');
const {makeIdleSource, parseIdleReply, makeReleaseSource,
  parseReleaseReply} = require('./native-counter-overlap.cjs');
const {formatFailure, sameImage, sameArena,
  runRootBatchLive} = require('./fs-root-batch-live.cjs');

async function runFreshRootBatch({host, macIp, evidence,
  directoryPath = '/',
  nonce = crypto.randomBytes(8).toString('hex'), execute = executeLua,
  identifyImage = identify, inspectArena = checkArena, probe = probeDomainLive,
  rootBatch = runRootBatchLive, onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce || '') ||
      !['/', '/.lovegame'].includes(directoryPath)) {
    throw new TypeError('Balatro fresh root probe needs IPv4 addresses and a new owner nonce');
  }
  validateEvidence(evidence);
  if ([execute, identifyImage, inspectArena, probe, rootBatch, onPhase]
    .some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro fresh root probe dependencies are invalid');
  }
  const domain = () => probe({host,
    nonceBytes: () => Buffer.from(evidence.nonce, 'hex')});
  const idle = async image => parseIdleReply(await execute({host, port: 9026,
    source: makeIdleSource({nonce, mainBase: image.mainBase,
      sdkBase: image.sdkBase}), timeoutMs: 10000}), nonce);

  onPhase('verify pinned Balatro image, idle state, and same-boot domain');
  const before = await identifyImage(host);
  sameImage(before, before, evidence.sdkBase);
  await idle(before);
  matchingBoot(evidence, await domain());

  let arena;
  let releaseAttempted = false;
  onPhase(`reserve fresh 2 MiB arena owner=${nonce}`);
  arena = await inspectArena({host, phase: 'reserve', nonce, execute});
  if (arena.phase !== 'reserve' || arena.nonce !== nonce ||
      arena.bytes !== 0x200000 || !/^0x[0-9a-f]+$/.test(arena.base || '')) {
    throw Error(`Balatro fresh arena reservation was not verified; owner=${nonce}; inspect before retry`);
  }
  onPhase(`fresh arena retained owner=${nonce} base=${arena.base}`);
  const inspected = await inspectArena({host, phase: 'inspect', nonce, execute});
  sameArena(inspected, inspected, nonce);
  if (inspected.base !== arena.base) {
    throw Error(`Balatro fresh arena moved after reservation; owner=${nonce} base=${arena.base}`);
  }
  sameImage(before, await identifyImage(host), evidence.sdkBase);
  matchingBoot(evidence, await domain());

  // The root runner closes only its own cloned domain, native bridge, and
  // listener. A failure can leave an uncertain native resource, so this wrapper
  // never detaches the arena on that path.
  const result = await rootBatch({host, macIp, arenaNonce: nonce, evidence,
    directoryPath, execute, identifyImage, inspectArena, probe, onPhase});
  if (!result || result.complete !== false ||
      result.ownedCloneClosed !== true ||
      result.nativeBridgeClosed !== true ||
      result.retainedArenaVerified !== true) {
    throw Error(`Balatro root read did not prove full owned cleanup; arena retained owner=${nonce}`);
  }

  onPhase(`verify retained arena before owner-bound detach owner=${nonce} base=${arena.base}`);
  const beforeRelease = await inspectArena({host, phase: 'inspect', nonce, execute});
  sameArena(inspected, beforeRelease, nonce);
  sameImage(before, await identifyImage(host), evidence.sdkBase);
  matchingBoot(evidence, await domain());
  releaseAttempted = true;
  onPhase(`detach owned arena once owner=${nonce} base=${arena.base}`);
  const released = parseReleaseReply(await execute({host, port: 9026,
    source: makeReleaseSource({nonce, arenaBase: arena.base,
      sdkBase: before.sdkBase}), timeoutMs: 10000}),
  {nonce, arenaBase: arena.base});
  if (released.arena !== 'detached' || released.owner !== nonce) {
    throw Error('Balatro fresh arena detach reply did not verify');
  }
  sameImage(before, await identifyImage(host), evidence.sdkBase);
  await idle(before);
  matchingBoot(evidence, await domain());
  onPhase(`fresh owner detached and idle owner=${nonce}`);
  return {...result, arenaOwner: nonce, arenaBase: arena.base,
    arena: 'detached', postState: 'pinned image, idle state, and mounted domain verified',
    releaseAttempted};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3 || net.isIP(argv[0]) !== 4 || net.isIP(argv[1]) !== 4) {
    process.stderr.write('usage: node fs-root-fresh-live.cjs <switch-ipv4> <mac-ipv4> <same-boot-evidence.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const evidence = validateEvidence(JSON.parse(fs.readFileSync(argv[2], 'utf8')));
    const result = await runFreshRootBatch({host: argv[0], macIp: argv[1],
      evidence, onPhase: phase => process.stderr.write(`phase: ${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\nNo automatic retry or owner release after uncertain cleanup was attempted.\n`);
    if (error.diagnostic) process.stderr.write(`${JSON.stringify(error.diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {runFreshRootBatch, main};
if (require.main === module) main();
