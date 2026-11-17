'use strict';

// Owns only the proposed Balatro save scratch paths. The event worker, pin,
// reservation group, and positive wave have separate resource ledgers.
const {createHash} = require('node:crypto');
const {packet, response} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} =
  require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {matchingBoot, copyRequest, copiedHandle} =
  require('./clone-control.cjs');
const {claimClone, belongsToTransport} =
  require('./fs-attempt-packets.cjs');
const {LOG_PATH, createOwnedSaveIo, snapshotSaveTree,
  compareSaveTrees} = require('./fs-save-tree-audit.cjs');
const {buildGapFirstXInput} = require('./fs-gap-first-x-input.cjs');

const FILE_BYTES = 0x700000;
const CHUNK_BYTES = 0x10000;
const FILL_BYTE = 0x66;
const PATH_BYTES = 0x600;
const MIN_FREE_MARGIN_BYTES = 0x1000;
const cleanupAttempts = new WeakSet();

function check(condition, reason) {
  if (!condition) throw Error(`Balatro gap scratch lease: ${reason}`);
}

function uncertain(cause, reason, detail = {}) {
  const error = Error(`Balatro gap scratch lease: ${reason}; retain exact owner`,
    {cause});
  error.resourceStateUncertain = true;
  error.diagnostic = detail;
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function quiescentVerified(quiescent) {
  if (!quiescent || !quiescent.workerState ||
      !['not-started', 'joined-closed'].includes(quiescent.workerState)) {
    return false;
  }
  // Gap event worker (13-role gate): reservation group, pin storage, and
  // candidate storage must all be closed before scratch removal.
  if (quiescent.groupClosed === true &&
      quiescent.pinStorageClosed === true &&
      quiescent.candidateStorageClosed === true) return true;
  // Positive (3-role abort worker): there is no reservation group or candidate
  // storage; the moved pin-storage handle and the service handles must instead
  // be closed before scratch removal.
  if (quiescent.workerState === 'joined-closed' &&
      quiescent.serviceHandles === 'closed' &&
      quiescent.movedStorageHandleClosed === true) return true;
  return false;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function validPath(value, root) {
  check(typeof value === 'string' && value.startsWith(root) &&
    Buffer.byteLength(value, 'ascii') < PATH_BYTES &&
    !value.includes('\\') && !value.includes(':') &&
    !value.includes('\0') &&
    value.split('/').slice(1).every(part => part && part !== '.' &&
      part !== '..'),
  'scratch path is outside the nonce-owned save root');
  return value;
}

function expectedPaths(plan) {
  const root = `/bal-gap-${plan.arenaNonce}`;
  check(plan?.mode === 'balatro-first-x-0x800-hypothesis' &&
    plan.scratchRoot === root &&
    plan.selectedDirectory === `${root}/selected` &&
    plan.absentDirectory === `${root}/absent__` &&
    plan.positiveAttemptAllowed === false &&
    plan.markerHitVerified === false &&
    plan.fsStageVerified === false,
  'first-X path plan changed');
  return {root: validPath(root, root),
    selected: validPath(plan.selectedDirectory, root),
    absent: validPath(plan.absentDirectory, root),
    canaryDirectory: validPath(plan.canaryDirectory, root),
    canaryFile: validPath(plan.canaryFile, root),
    file: validPath(`${root}/commit_data`, root)};
}

function expectedDelta(paths) {
  const changed = [`save:${paths.root}`, `save:${paths.selected}`,
    `save:${paths.file}`];
  const parts = paths.canaryFile.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    changed.push(`save:${acc}`);
  }
  return [...new Set(changed)].sort();
}

async function snapshot({transport, cloneHandle, logPrefixBytes = null}) {
  const io = createOwnedSaveIo(transport, cloneHandle);
  return snapshotSaveTree({io, logPrefixBytes});
}

function makeIo(transport, cloneHandle, paths, writeBufferAddress) {
  const borrowed = transport.evidence.sessionManager.borrowedHandle;
  const pathAddress = transport.pathAddress;
  const dataAddress = transport.dataAddress;
  check(transport instanceof BalatroCloneTransport &&
    transport.initialized === true &&
    transport.ownedHandles.has(cloneHandle) && cloneHandle !== borrowed &&
    pathAddress === transport.scratch + 0x20000 &&
    dataAddress === transport.scratch + 0x22000 &&
    dataAddress + CHUNK_BYTES < transport.scratch + 0x40000 &&
    (writeBufferAddress === undefined ||
      (Number.isSafeInteger(writeBufferAddress) &&
      writeBufferAddress % 0x1000 === 0 && writeBufferAddress >= 0x1000 &&
      writeBufferAddress + FILE_BYTES < 2 ** 39)),
  'scratch IO requires one initialized owned clone, exact app buffers, and a large commit buffer');

  async function send(handle, bytes, phase) {
    check(transport.ownedHandles.has(handle) && handle !== borrowed &&
      Buffer.isBuffer(bytes) && bytes.length === 256,
    `${phase} targeted an unowned handle or packet`);
    let raw, parsed;
    try {raw = await transport.sendPacket(handle, bytes);
      parsed = response(raw);}
    catch (cause) {throw uncertain(cause, `${phase} execution is unknown`,
      {phase, cloneHandle, file: paths.file});}
    return parsed;
  }

  async function pathRequest(command, pathname, input = Buffer.alloc(0)) {
    const value = pathname === '/' || pathname === 'save:/' ? pathname :
      validPath(pathname, paths.root);
    const bytes = Buffer.alloc(PATH_BYTES);
    bytes.write(value, 0, 'ascii');
    await transport.native.write(pathAddress, bytes);
    return send(cloneHandle, pathPacket(command, input, pathAddress,
      PATH_BYTES), `path-command-${command}`);
  }

  function simple(reply, label) {
    if (reply?.moves?.length || reply?.copies?.length)
      throw uncertain(null, `${label} transferred an unexpected handle`,
        {label, cloneHandle});
    check(reply?.result === 0, `${label} returned a nonzero result`);
    return reply;
  }

  return {
    async freeSpace() {
      await transport.native.write(transport.pathAddress,
        Buffer.from('save:/\0', 'utf8'));
      const out = await transport.writeOutput(8);
      const result = await transport.call('freeSpace',
        [out, transport.pathAddress], null);
      check(result === 0, `free space returned a nonzero result (0x${result.toString(16)})`);
      const freeBytes = (await transport.readOutput(8)).readBigUInt64LE();
      check(freeBytes >= BigInt(FILE_BYTES + MIN_FREE_MARGIN_BYTES) &&
        freeBytes <= BigInt(Number.MAX_SAFE_INTEGER),
      `save free space is below the bounded scratch requirement (free ${freeBytes} < needed ${FILE_BYTES + MIN_FREE_MARGIN_BYTES})`);
      return Number(freeBytes);
    },
    async entry(pathname) {
      const result = await pathRequest(7, pathname);
      if (result.moves.length || result.copies.length)
        throw uncertain(null, 'entry type transferred an unexpected handle',
          {pathname, cloneHandle});
      if (result.result === 0x202) return {result: 0x202, type: null};
      check(result.result === 0 && result.data.length >= 4,
        'entry type returned an unexpected result');
      return {result: 0, type: result.data.readUInt32LE()};
    },
    async createDirectory(pathname) {
      simple(await pathRequest(2, pathname), 'create directory');
    },
    async createFileAt(pathname, size) {
      simple(await pathRequest(0, pathname,
        Buffer.concat([u64(0), u64(size)])), 'create file at path');
    },
    async createFile() {
      simple(await pathRequest(0, paths.file,
        Buffer.concat([u64(0), u64(FILE_BYTES)])), 'create file');
    },
    async openFile() {
      const result = await pathRequest(8, paths.file, u32(3));
      if (result.result !== 0 || result.copies.length ||
          result.moves.length !== 1)
        throw uncertain(null, 'open scratch file did not move one handle',
          {cloneHandle, file: paths.file});
      const handle = result.moves[0];
      if (!Number.isInteger(handle) || handle <= 0 ||
          handle >= 0xffff8000 || handle === cloneHandle ||
          handle === borrowed || transport.ownedHandles.has(handle))
        throw uncertain(null, 'scratch file handle ownership is ambiguous',
          {cloneHandle, handle});
      transport.ownedHandles.add(handle);
      return handle;
    },
    async writeFile(handle) {
      check(transport.ownedHandles.has(handle) && handle !== cloneHandle &&
        handle !== borrowed, 'scratch file handle is not owned');
      check(Number.isSafeInteger(writeBufferAddress) &&
        writeBufferAddress % 0x1000 === 0 && writeBufferAddress >= 0x1000 &&
        writeBufferAddress + FILE_BYTES < 2 ** 39,
      'commit write requires a large page-aligned buffer');
      // One large owned commit write. Its effect on the canary is measured
      // separately from any later path-trigger wave.
      await transport.native.write(writeBufferAddress,
        Buffer.alloc(FILE_BYTES, FILL_BYTE));
      simple(await send(handle, packet(1,
        Buffer.concat([u64(0), u64(0), u64(FILE_BYTES)]),
        {send: [{address: writeBufferAddress, size: FILE_BYTES, mode: 1}]}),
      'write-scratch-commit'), 'write scratch commit');
    },
    async close(handle) {
      check(transport.ownedHandles.has(handle) && handle !== borrowed,
        'scratch close would target an unowned handle');
      try {const result = await transport.closeOwned(handle);
        check(result?.closed === true, 'scratch close did not verify');}
      catch (cause) {throw uncertain(cause, 'scratch handle close is unknown',
        {handle, cloneHandle});}
    },
    async deleteFile() {
      simple(await pathRequest(1, paths.file), 'delete file');
    },
    async deleteFileAt(pathname) {
      simple(await pathRequest(1, pathname), 'delete file at path');
    },
    async deleteDirectory(pathname) {
      simple(await pathRequest(3, pathname), 'delete directory');
    },
    async commit() {
      simple(await send(cloneHandle, packet(10), 'commit scratch cleanup'),
        'commit scratch cleanup');
    },
  };
}

async function prepareGapScratchLease({preflight, prepared, plan,
  writeBufferAddress, reconnect = null, onPhase = () => {},
  snapshotTree = snapshot}) {
  check(typeof onPhase === 'function' && typeof snapshotTree === 'function',
    'phase callback and bounded save snapshot are required');
  const transport = prepared?.transport;
  const expectedPlan = buildGapFirstXInput({preflight});
  check(preflight?.gameProfile === profile.gameProfile &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.markerWrittenAndVerified === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.ownedHandlesOpen === true &&
    prepared.explicitSaveWrites === 1 &&
    transport instanceof BalatroCloneTransport &&
    transport.initialized === true &&
    transport.evidence.sdkBase === preflight.sdkBase &&
    transport.native.addresses?.sdk === Number(BigInt(preflight.sdkBase)) &&
    transport.native.addresses?.scratch ===
      Number(BigInt(preflight.arenaBase) + 0x10000n) &&
    prepared.context?.arena === BigInt(preflight.arenaBase) &&
    prepared.context.sdk === BigInt(preflight.sdkBase) &&
    prepared.context.scratch === BigInt(transport.scratch) &&
    prepared.context.nonce === preflight.arenaNonce &&
    belongsToTransport(prepared.clone, transport, 'clone') &&
    transport.ownedHandles.has(prepared.file?.handle) &&
    prepared.root?.role === 'root' && prepared.root.closed === false &&
    !transport.ownedHandles.has(prepared.root.handle) &&
    plan?.arenaNonce === preflight.arenaNonce &&
    plan.markerNonce === preflight.markerNonce &&
    Object.keys(expectedPlan.sha256).every(name =>
      plan.sha256?.[name] === expectedPlan.sha256[name] &&
      Buffer.isBuffer(plan.descriptors?.[name]) &&
      plan.descriptors[name].equals(expectedPlan.descriptors[name])),
  'fresh pinned owner, marker, and first-X path plan are required');
  const paths = expectedPaths(plan);
  const originalHandles = new Set(transport.ownedHandles);
  let phase = 'verify-mounted-domain', copyAttempted = false;
  let mutationStarted = false, cloneHandle = null, fileHandle = null;
  try {
    onPhase(phase);
    matchingBoot(transport.evidence, await transport.inspectLive());
    const copied = copyRequest(transport.evidence);
    phase = 'copy-distinct-owned-save';
    onPhase(phase);
    copyAttempted = true;
    const copyReply = await transport.sendControl(copied.borrowedHandle,
      copied.packet);
    cloneHandle = copiedHandle(copyReply, copied.borrowedHandle);
    const clone = claimClone({transport, controlReply: copyReply});
    check(clone.handle === cloneHandle &&
      !originalHandles.has(cloneHandle) &&
      cloneHandle !== prepared.root.handle &&
      cloneHandle !== prepared.file.handle &&
      cloneHandle !== prepared.clone.handle,
    'scratch clone must be distinct from all retained handles');
    const io = makeIo(transport, cloneHandle, paths, writeBufferAddress);
    phase = 'snapshot-before-scratch';
    onPhase(phase);
    let baselineTree;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        baselineTree = await snapshotTree({transport, cloneHandle});
        break;
      } catch (error) {
        if (attempt === 3 || typeof reconnect !== 'function') throw error;
        onPhase(`retry-snapshot-${attempt}`);
        await reconnect({transport});
      }
    }
    check(baselineTree?.coverage === 'bounded-cloned-save-tree' &&
      baselineTree.complete === true &&
      !baselineTree.directories.includes(paths.root) &&
      !baselineTree.directories.includes(paths.selected) &&
      !Object.hasOwn(baselineTree.files, paths.file),
    'scratch paths already exist or save baseline is incomplete');
    phase = 'free-space-and-path-controls';
    onPhase(phase);
    const freeSpaceBytes = await io.freeSpace();
    for (const pathname of [paths.root, paths.selected, paths.file,
      paths.absent, paths.canaryDirectory, paths.canaryFile])
      check((await io.entry(pathname)).result === 0x202,
        'nonce-owned scratch path was not absent');
    phase = 'create-scratch-root';
    onPhase(phase);
    mutationStarted = true;
    await io.createDirectory(paths.root);
    phase = 'create-selected-directory';
    onPhase(phase);
    await io.createDirectory(paths.selected);
    phase = 'create-deep-canary';
    onPhase(phase);
    await io.createDirectory(paths.canaryDirectory);
    let canaryDir = paths.canaryDirectory;
    for (let depth = 0; depth < 42; depth++) {
      canaryDir += '/' + plan.canaryComponent;
      await io.createDirectory(canaryDir);
    }
    await io.createFileAt(paths.canaryFile, 0);
    const canaryBefore = await io.entry(paths.canaryFile);
    check(canaryBefore.result === 0 && canaryBefore.type === 1,
      'deep canary did not initialize as a file');
    phase = 'create-commit-file';
    onPhase(phase);
    await io.createFile();
    phase = 'open-write-commit-file';
    onPhase(phase);
    fileHandle = await io.openFile();
    await io.writeFile(fileHandle);
    await io.close(fileHandle);
    fileHandle = null;
    const canaryAfter = await io.entry(paths.canaryFile);
    const canaryFlipped = canaryAfter.result === 0 && canaryAfter.type === 0;
    const states = {
      root: await io.entry(paths.root),
      selected: await io.entry(paths.selected),
      file: await io.entry(paths.file),
      absent: await io.entry(paths.absent),
    };
    check(states.root.result === 0 && states.root.type === 0 &&
      states.selected.result === 0 && states.selected.type === 0 &&
      states.file.result === 0 && states.file.type === 1 &&
      states.absent.result === 0x202,
    'scratch paths are not exact file/directory controls');
    phase = 'snapshot-staged-scratch';
    onPhase(phase);
    const stagedTree = await snapshotTree({transport, cloneHandle,
      logPrefixBytes: baselineTree.files[LOG_PATH]?.size ?? null});
    const stageAudit = compareSaveTrees(baselineTree, stagedTree);
    const delta = expectedDelta(paths);
    check(stageAudit.completeSaveTreeVerified === true &&
      JSON.stringify(stageAudit.changedPaths) === JSON.stringify(delta) &&
      stagedTree.files[paths.file]?.size === FILE_BYTES &&
      stagedTree.files[paths.file]?.sha256 ===
        sha(Buffer.alloc(FILE_BYTES, FILL_BYTE)) &&
      transport.ownedHandles.size === originalHandles.size + 1 &&
      [...originalHandles].every(handle => transport.ownedHandles.has(handle)),
    'staged scratch delta, content, or handle ledger differs');
    const lease = {arenaNonce: preflight.arenaNonce,
      markerNonce: preflight.markerNonce,
      sdkBase: preflight.sdkBase,
      transport, clone, cloneHandle,
      originalHandles, paths,
      writeBytes: FILE_BYTES, writeChunkBytes: FILE_BYTES,
      writeBufferAddress,
      commitFileHandleClosed: true,
      freeSpaceBytes, baselineTree, stagedTree,
      expectedDelta: delta, stageAudit,
      selectedDirectoryCreatedAndVerified: true,
      noBorrowedHandleMutation: true,
      positiveAttemptAllowed: false,
      fsSideMarkerReadbackVerified: false,
      canaryBeforeCommit: canaryBefore,
      canaryAfterCommit: canaryAfter,
      readCanary: () => io.entry(paths.canaryFile),
      canaryType: canaryAfter.type, canaryFlipped,
      changedPaths: canaryFlipped ? ['canary'] : [],
      markerHitVerified: false, fsStageVerified: false};
    return lease;
  } catch (cause) {
    if (cloneHandle && !mutationStarted &&
        phase === 'free-space-and-path-controls' &&
        cause?.resourceStateUncertain !== true &&
        transport.ownedHandles.has(cloneHandle)) {
      try {await transport.closeOwned(cloneHandle);} catch (cleanup) {
        throw uncertain(new AggregateError([cause, cleanup]),
          'pre-mutation clone close is unknown', {phase, cloneHandle});
      }
    }
    if (!copyAttempted && !mutationStarted) throw cause;
    if (!mutationStarted && cloneHandle &&
        !transport.ownedHandles.has(cloneHandle))
      throw cause;
    throw uncertain(cause, 'scratch preparation did not finish',
      {phase, cloneHandle, fileHandle, mutationStarted,
        ownedHandles: [...transport.ownedHandles]});
  }
}

async function cleanupGapScratchLease({lease, quiescent, onPhase = () => {},
  snapshotTree = snapshot}) {
  check(lease?.transport instanceof BalatroCloneTransport &&
    !cleanupAttempts.has(lease) &&
    quiescentVerified(quiescent) &&
    typeof onPhase === 'function' &&
    typeof snapshotTree === 'function' &&
    lease.transport.ownedHandles.has(lease.cloneHandle) &&
    lease.commitFileHandleClosed === true &&
    lease.positiveAttemptAllowed === false,
  'one-shot scratch cleanup needs quiescent native resources');
  cleanupAttempts.add(lease);
  const {transport, cloneHandle, paths, baselineTree, stagedTree} = lease;
  let phase = 'snapshot-before-scratch-cleanup';
  try {
    const beforeDelete = await snapshotTree({transport, cloneHandle,
      logPrefixBytes: stagedTree.files[LOG_PATH]?.size ?? null});
    const unchanged = compareSaveTrees(stagedTree, beforeDelete);
    check(unchanged.completeSaveTreeVerified === true &&
      unchanged.changedPaths.length === 0 &&
      beforeDelete.files[paths.file]?.size === FILE_BYTES &&
      beforeDelete.files[paths.file]?.sha256 ===
        stagedTree.files[paths.file].sha256,
    'scratch content or another saved path changed before cleanup');
    const io = makeIo(transport, cloneHandle, paths);
    phase = 'delete-commit-file';
    onPhase(phase);
    await io.deleteFile();
    phase = 'delete-deep-canary';
    onPhase(phase);
    await io.deleteFileAt(paths.canaryFile);
    const canarySegments = paths.canaryFile.split('/').filter(Boolean);
    let canaryAcc = '';
    const canaryDirs = [];
    for (const segment of canarySegments.slice(0, -1)) {
      canaryAcc += '/' + segment;
      canaryDirs.push(canaryAcc);
    }
    for (let i = canaryDirs.length - 1; i >= 1; i--)
      await io.deleteDirectory(canaryDirs[i]);
    phase = 'delete-selected-directory';
    onPhase(phase);
    await io.deleteDirectory(paths.selected);
    phase = 'delete-scratch-root';
    onPhase(phase);
    await io.deleteDirectory(paths.root);
    phase = 'commit-scratch-removal';
    onPhase(phase);
    await io.commit();
    for (const pathname of [paths.file, paths.canaryFile,
      paths.canaryDirectory, paths.selected, paths.root])
      check((await io.entry(pathname)).result === 0x202,
        'scratch path remains after committed cleanup');
    phase = 'snapshot-after-scratch-cleanup';
    onPhase(phase);
    const afterTree = await snapshotTree({transport, cloneHandle,
      logPrefixBytes: baselineTree.files[LOG_PATH]?.size ?? null});
    const restored = compareSaveTrees(baselineTree, afterTree);
    check(restored.completeSaveTreeVerified === true &&
      restored.changedPaths.length === 0,
    'save tree did not return to its exact baseline');
    phase = 'close-distinct-scratch-clone';
    onPhase(phase);
    await io.close(cloneHandle);
    check(transport.ownedHandles.size === lease.originalHandles.size &&
      [...lease.originalHandles].every(handle =>
        transport.ownedHandles.has(handle)) &&
      !transport.ownedHandles.has(
        transport.evidence.sessionManager.borrowedHandle),
    'owned handle ledger did not return to its baseline');
    return {arenaNonce: lease.arenaNonce,
      selectedDirectory: paths.selected, commitFile: paths.file,
      scratchPathsRemoved: true,
      completeSaveTreeRestored: true,
      changedPaths: restored.changedPaths,
      cloneHandleClosed: true,
      borrowedSession: 'preserved',
      cleanup: 'verified',
      positiveAttemptAllowed: false,
      fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false};
  } catch (cause) {
    throw uncertain(cause, 'scratch cleanup did not finish',
      {phase, cloneHandle, paths,
        ownedHandles: [...transport.ownedHandles]});
  }
}

module.exports = {FILE_BYTES, CHUNK_BYTES, FILL_BYTE,
  PATH_BYTES, MIN_FREE_MARGIN_BYTES,
  expectedPaths, expectedDelta, makeIo, quiescentVerified,
  prepareGapScratchLease, cleanupGapScratchLease};
