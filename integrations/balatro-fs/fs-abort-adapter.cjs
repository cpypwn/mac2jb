const net = require('node:net');
const {packet, response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {prepareOwnedLease, cleanupOwnedLease} = require('./fs-owned-prep.cjs');
const {markerCleanupVerified} = require('./fs-marker-cleanup.cjs');
const {readControlledPaths} = require('./fs-controlled-paths.cjs');
const {buildAbortFrames, stageAbortFrames, readAbortReplies,
  closeMovedStorage, buildPositiveFrames, readPositiveReplies} =
  require('./fs-abort-frames.cjs');
const {makeAbortGuardSource, parseAbortGuardReply,
  makeAbortWorkerSource, parseAbortWorkerReply} =
  require('./fs-abort-worker.cjs');
const {LOG_PATH, createOwnedSaveIo, snapshotSaveTree, compareSaveTrees} =
  require('./fs-save-tree-audit.cjs');
const {sampleStableCounters} = require('./fs-counter-probe.cjs');

const COUNTER_MAX_READS = 8;

function uncertain(error) {
  const wrapped = Error('Balatro abort adapter cannot prove resource state; retain resources',
    {cause: error});
  wrapped.resourceStateUncertain = true;
  return wrapped;
}

function parseCounterReply(bytes) {
  const parsed = response(bytes);
  if (parsed.result !== 0 || parsed.moves.length || parsed.copies.length ||
      parsed.data.length < 16 * 8) {
    throw Error('Balatro FS counter reply changed or transferred a handle');
  }
  const counters = [];
  for (let i = 0; i < 16; i++) {
    const value = parsed.data.readBigUInt64LE(i * 8);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw Error('Balatro FS counter exceeded the safe integer range');
    }
    counters.push(Number(value));
  }
  return counters;
}

async function sampleCounterPair(readOne, phase,
  maxReads = COUNTER_MAX_READS) {
  if (typeof readOne !== 'function' ||
      typeof phase !== 'string' || !/^[a-z-]+$/.test(phase) ||
      !Number.isInteger(maxReads) || maxReads < 3 ||
      maxReads > COUNTER_MAX_READS) {
    throw new TypeError('Balatro counter phase needs bounded owned reads');
  }
  const rawSamples = [];
  let stable;
  try {
    stable = await sampleStableCounters(async index => {
      const row = await readOne(index);
      rawSamples.push(row);
      return row;
    }, maxReads);
  } catch (error) {
    error.rawSamples = rawSamples;
    error.counterPhase = phase;
    throw error;
  }
  return {phase, samples: stable.samples, reads: stable.reads,
    observedGeneralHeap: stable.observedGeneralHeap,
    rawSamples, counterState: 'get-and-clear'};
}

function createAbortAdapter({preflight, evidence, transport, context,
  host, macIp, port, mainBase, inspectIdentity, executeSource,
  stopNative, closeTransport, releaseArena, reconnectNative = null,
  onPhase = () => {}}) {
  if (!preflight || !evidence || !(transport instanceof BalatroCloneTransport) ||
      !context || net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !/^0x[0-9a-f]+$/.test(mainBase || '') ||
      [inspectIdentity, executeSource, stopNative, closeTransport,
        releaseArena, onPhase]
        .some(callback => typeof callback !== 'function')) {
    throw new TypeError('Balatro abort adapter needs one complete qualified owner');
  }
  if (preflight.gameProfile !== profile.gameProfile ||
      evidence.gameProfile !== profile.gameProfile ||
      preflight.sdkBase !== evidence.sdkBase ||
      preflight.arenaNonce !== context.nonce ||
      preflight.arenaBase !== `0x${context.arena.toString(16)}` ||
      transport.evidence !== evidence ||
      transport.native.addresses?.sdk !== Number(BigInt(preflight.sdkBase)) ||
      transport.native.addresses?.scratch !== Number(context.scratch)) {
    throw Error('Balatro abort adapter owner or image is not internally consistent');
  }
  let prepared;
  let beforeTree;
  let lastAudit;
  let stopped = false;
  let closedTransport = false;
  let releaseAttempted = false;
  let stopAttempted = false;
  let closeAttempted = false;
  const adapter = {
    async inspect() {
      const identity = await inspectIdentity();
      if (identity?.mainBase !== mainBase ||
          identity.sdkCodeSha256 !== profile.sdkCode.sha256) {
        throw Error('Balatro current image does not match pinned main and SDK');
      }
      return identity;
    },
    async prepare(input) {
      if (prepared || input !== preflight) {
        throw Error('Balatro abort adapter cannot reuse an owned preparation');
      }
      prepared = await prepareOwnedLease({preflight, evidence, transport,
        context, onPhase});
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const io = createOwnedSaveIo(transport, prepared.clone.handle);
          beforeTree = await snapshotSaveTree({io});
          if (beforeTree?.coverage !== 'bounded-cloned-save-tree' ||
              beforeTree.complete !== true) {
            throw Error('Balatro owned save tree was not fully inventoried');
          }
          break;
        } catch (error) {
          if (attempt === 3 || typeof reconnectNative !== 'function')
            throw uncertain(error);
          onPhase(`retry-snapshot-${attempt}`);
          await reconnectNative({transport});
        }
      }
      return prepared;
    },
    async readPaths(lease) {
      if (lease !== prepared) throw Error('Balatro path read used a different lease');
      return readControlledPaths({transport, clone: lease.clone,
        nonce: preflight.markerNonce});
    },
    async counterPair(phase) {
      if (!prepared || typeof phase !== 'string' || !/^[a-z-]+$/.test(phase)) {
        throw Error('Balatro counters require the prepared owned root');
      }
      return sampleCounterPair(async () => {
        const reply = await transport.sendPacket(prepared.root.handle,
          packet(1009));
        return parseCounterReply(reply);
      }, phase);
    },
    async executeWave(plan) {
      if (!prepared || plan?.arenaNonce !== preflight.arenaNonce ||
          plan?.markerNonce !== preflight.markerNonce) {
        throw Error('Balatro wave plan does not own the prepared marker');
      }
      let workerRequestSent = false;
      try {
        const staged = buildAbortFrames(plan, {arenaBase: preflight.arenaBase,
          sdkBase: preflight.sdkBase});
        const stageReceipt = await stageAbortFrames(transport.native, staged);
        const options = {nonce: preflight.arenaNonce,
          arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
          mainBase, waveId: plan.waveId, hostIp: macIp, port,
          staged, stageReceipt};
        onPhase('verify-staged-frames-before-worker');
        const guardReply = await executeSource({host, port: 9026,
          source: makeAbortGuardSource(options), timeoutMs: 15000});
        parseAbortGuardReply(guardReply, options);
        onPhase('run-native-abort-worker-once');
        const source = makeAbortWorkerSource(options);
        workerRequestSent = true;
        const reply = await executeSource({host, port: 9026,
          source, timeoutMs: 15000});
        const worker = parseAbortWorkerReply(reply, options);
        const parsed = await readAbortReplies(transport.native, staged, worker);
        const moved = await closeMovedStorage(transport.native, staged, parsed);
        return {...worker, rows: parsed.rows,
          movedStorageHandleClosed: moved.closed,
          receiveBufferVerified: parsed.receiveBufferVerified,
          triggerControl: parsed.triggerControl,
          borrowedSession: 'preserved',
          negativePathControl: 'executed-absent-path-0x202'};
      } catch (error) {
        if (!workerRequestSent) {
          error.workerNotStarted = true;
          throw error;
        }
        throw uncertain(error);
      }
    },
    async executePositiveWave(plan) {
      if (!prepared || plan?.arenaNonce !== preflight.arenaNonce ||
          plan?.markerNonce !== preflight.markerNonce) {
        throw Error('Balatro positive wave plan does not own the prepared marker');
      }
      let workerRequestSent = false;
      try {
        const staged = buildPositiveFrames(plan, {arenaBase: preflight.arenaBase,
          sdkBase: preflight.sdkBase});
        const stageReceipt = await stageAbortFrames(transport.native, staged);
        const options = {nonce: preflight.arenaNonce,
          arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
          mainBase, waveId: plan.waveId, hostIp: macIp, port,
          staged, stageReceipt};
        onPhase('verify-staged-frames-before-positive-worker');
        const guardReply = await executeSource({host, port: 9026,
          source: makeAbortGuardSource(options), timeoutMs: 15000});
        parseAbortGuardReply(guardReply, options);
        onPhase('run-native-positive-worker-once');
        const source = makeAbortWorkerSource(options);
        workerRequestSent = true;
        const reply = await executeSource({host, port: 9026,
          source, timeoutMs: 15000});
        const worker = parseAbortWorkerReply(reply, options);
        const parsed = await readPositiveReplies(transport.native, staged, worker);
        const moved = await closeMovedStorage(transport.native, staged, parsed);
        return {...worker, rows: parsed.rows,
          movedStorageHandleClosed: moved.closed,
          receiveBufferVerified: parsed.receiveBufferVerified,
          triggerControl: parsed.triggerControl,
          positivePathControl: 'executed-b-filler-candidate',
          borrowedSession: 'preserved'};
      } catch (error) {
        if (!workerRequestSent) {
          error.workerNotStarted = true;
          throw error;
        }
        throw uncertain(error);
      }
    },
    async auditPaths(lease) {
      if (lease !== prepared || beforeTree?.coverage !== 'bounded-cloned-save-tree' ||
          beforeTree.complete !== true) {
        throw Error('Balatro save audit has no verified before snapshot');
      }
      try {
        const io = createOwnedSaveIo(transport, prepared.clone.handle);
        const beforeLog = beforeTree.files?.[LOG_PATH];
        if (beforeTree.logPresent &&
            (!beforeLog || !Number.isSafeInteger(beforeLog.size))) {
          throw Error('Balatro activity log baseline is incomplete');
        }
        const afterTree = await snapshotSaveTree({io,
          logPrefixBytes: beforeLog ? beforeLog.size : null});
        const compared = compareSaveTrees(beforeTree, afterTree);
        if (compared?.coverage !== 'bounded-cloned-save-tree' ||
            compared.completeSaveTreeVerified !== true ||
            !Array.isArray(compared.changedPaths)) {
          throw Error('Balatro save audit lacks complete tree coverage');
        }
        lastAudit = {coverage: compared.coverage,
          completeSaveTreeVerified: compared.completeSaveTreeVerified,
          logState: compared.logState,
          logGrowthBytes: compared.logGrowthBytes,
          logPrefixVerified: compared.logPrefixVerified,
          changed: compared.changedPaths.map(name => {
            const path = name.slice('save:'.length);
            return {path: name, before: beforeTree.files[path] || null,
              after: afterTree.files[path] || null,
              beforeDirectory: beforeTree.directories.includes(path),
              afterDirectory: afterTree.directories.includes(path)};
          })};
        return compared.changedPaths;
      } catch (error) {
        throw uncertain(error);
      }
    },
    auditDetails() {return lastAudit;},
    async cleanup(lease) {
      if (lease !== prepared || stopped || closedTransport || releaseAttempted ||
          stopAttempted || closeAttempted) {
        throw Error('Balatro abort cleanup is not one-shot');
      }
      const failures = [];
      let owned = null;
      try {
        owned = await cleanupOwnedLease(lease, {onPhase});
        if (owned.ownedHandlesClosed !== true ||
            !markerCleanupVerified(owned) ||
            owned.borrowedSession !== 'preserved') {
          throw Error('Balatro owned save cleanup was not verified');
        }
      } catch (error) {
        failures.push(error);
      }
      // Release the bridge and arena best-effort even when owned-marker cleanup
      // was incomplete. Record every failure instead of letting a marker error
      // mask a later bridge or arena failure.
      stopAttempted = true;
      try {
        await stopNative({host, port: 9026, nonce: preflight.arenaNonce});
        stopped = true;
      } catch (error) { failures.push(error); }
      closeAttempted = true;
      try {
        await closeTransport({host, port: 9026, nonce: preflight.arenaNonce,
          hostIp: macIp, nativePort: port});
        closedTransport = true;
      } catch (error) { failures.push(error); }
      releaseAttempted = true;
      try {
        const released = await releaseArena({host, port: 9026,
          nonce: preflight.arenaNonce, arenaBase: preflight.arenaBase,
          sdkBase: preflight.sdkBase});
        if (released?.arena !== 'released') {
          throw Error('Balatro retained arena release was not verified');
        }
      } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures,
          'Balatro owned cleanup and bridge/arena release were incomplete');
      }
      return {...owned, arena: 'released'};
    },
  };
  return adapter;
}

module.exports = {COUNTER_MAX_READS, parseCounterReply,
  sampleCounterPair, createAbortAdapter};
