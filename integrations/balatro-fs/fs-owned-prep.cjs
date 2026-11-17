const {packet, response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {matchingBoot, copyRequest, copiedHandle, relativePath} =
  require('./clone-control.cjs');
const {BalatroCloneTransport, pathPacket} = require('./clone-transport.cjs');
const {claimClone, claimFile, makePinRequest} = require('./fs-attempt-packets.cjs');
const {claimOpenedService} = require('./fs-counter-probe.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const cleanupAttempts = new WeakSet();

function check(condition, reason) {
  if (!condition) throw Error(`Balatro owned preparation: ${reason}`);
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function isExact(state, bytes) {
  return state?.result === 0 && state.type === 1 &&
    Buffer.isBuffer(state.bytes) && state.bytes.equals(bytes);
}

function isAbsent(state, result) {
  return state?.result === result && state.type === null &&
    state.bytes === null;
}

function checkInputs({preflight, evidence, transport, context}) {
  check(preflight?.gameProfile === profile.gameProfile &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    preflight.sdkBase === evidence?.sdkBase &&
    preflight.arenaBase === `0x${(BigInt(preflight.arenaBase)).toString(16)}` &&
    preflight.markerHitVerified === false && preflight.fsStageVerified === false &&
    transport instanceof BalatroCloneTransport &&
    transport.evidence === evidence &&
    context?.sdk === BigInt(preflight.sdkBase) &&
    context?.arena === BigInt(preflight.arenaBase) &&
    context?.nonce === preflight.arenaNonce &&
    context?.scratch === BigInt(transport.scratch) &&
    transport.scratch === Number(context.arena + 0x10000n) &&
    transport.ownedHandles.size === 0 &&
    transport.rawOwnedHandles instanceof Set &&
    transport.rawOwnedHandles.size === 0,
  'fresh same-boot owner and empty transport are required');
}

async function openQualifiedRoot({transport, context, onPhase = () => {}}) {
  check(typeof onPhase === 'function', 'root phase callback is invalid');
  const native = transport.native;
  const symbol = profile.symbols['nn::sm::GetServiceHandle'];
  onPhase('verify-get-service-symbol');
  await native.verifyFunction(transport.sdk + symbol.offset,
    Buffer.from(symbol.bytes, 'hex'));
  // NativeClient stages every write at scratch+0x40080 and uses scratch+0x4040
  // for its own reply. Both locations change before GetServiceHandle executes.
  // The path and guarded-output slots belong to this transport and stay clear
  // of the native packet workspace while the root service is opened.
  const nameAddress = transport.pathAddress;
  const outputAddress = transport.outputAddress;
  check(nameAddress === transport.scratch + 0x20000 &&
    outputAddress === transport.scratch + 0x20800 &&
    outputAddress + 12 < transport.scratch + 0x40000,
  'root service name or output overlaps the native packet workspace');
  const guard = Buffer.alloc(12);
  guard.writeUInt32LE(0x5a17eacc, 0);
  guard.writeUInt32LE(0x5a17eacc, 8);
  await native.write(nameAddress, Buffer.from('fsp-srv\0', 'ascii'));
  await native.write(outputAddress, guard);
  onPhase('open-fsp-service');
  const opened = await native.call(symbol.offset, outputAddress + 4,
    nameAddress, 7);
  onPhase('read-opened-service-handle');
  const data = await native.read(outputAddress, 12);
  check(opened?.result === 0n && data.readUInt32LE(0) === 0x5a17eacc &&
    data.readUInt32LE(8) === 0x5a17eacc,
  'fsp-srv native service open changed');
  const root = claimOpenedService(context, opened.result, data.readUInt32LE(4));
  check(root.handle !== transport.evidence.sessionManager.borrowedHandle,
    'fsp-srv root reused the borrowed session handle');
  transport.registerRawOwned(root.handle);
  onPhase('initialize-fsp-service');
  const reply = response(await transport.sendPacket(root.handle,
    packet(1, Buffer.alloc(8), {pid: true})));
  check(reply.result === 0 && reply.copies.length === 0 &&
    reply.moves.length === 0,
  'fsp-srv initialization did not complete');
  makePinRequest({context, root});
  return root;
}

async function prepareOwnedLease({preflight, evidence, transport, context,
  onPhase = () => {}}) {
  checkInputs({preflight, evidence, transport, context});
  check(typeof onPhase === 'function', 'phase callback is invalid');
  const owned = paths(preflight.markerNonce);
  const marker = content(preflight.markerNonce);
  const missing = Number.parseInt(evidence.absentPathResult, 16);
  onPhase('verify-mounted-domain');
  matchingBoot(evidence, await transport.inspectLive());
  await transport.initialize();
  check(isAbsent(await transport.readOriginal(owned.marker), missing) &&
    isAbsent(await transport.readOriginal(owned.absent), missing),
  'owned marker or absent path already exists');
  let markerMayExist = false;
  let root = null;
  let serviceOpenAttempted = false;
  let cloneHandle = null;
  let fileHandle = null;
  let clone;
  let file;
  try {
    onPhase('open-qualified-fsp-root');
    serviceOpenAttempted = true;
    root = await openQualifiedRoot({transport, context,
      onPhase: label => onPhase(`root:${label}`)});
    onPhase('write-owned-marker');
    markerMayExist = true;
    // Do NOT read the written marker back via the direct readOriginal (openDirect
    // on the existing marker collides with the abandoned fsp-srv write session).
    // The marker content is verified via the clone read below, after the copy.
    check((await transport.writeMarker(owned.marker, marker, {onPhase}))?.verified === true &&
      isAbsent(await transport.readOriginal(owned.absent), missing),
    'owned marker write or direct absent readback changed');
    onPhase('verify-mounted-domain-before-copy');
    matchingBoot(evidence, await transport.inspectLive());
    const control = copyRequest(evidence);
    const cloneReply = await transport.sendControl(control.borrowedHandle,
      control.packet);
    cloneHandle = copiedHandle(cloneReply, control.borrowedHandle);
    clone = claimClone({transport, controlReply: cloneReply});
    onPhase('verify-cloned-marker');
    const retained = await transport.openCloneFile(cloneHandle, relativePath(owned.marker));
    check(retained.result === 0 && retained.type === 1 &&
      Number.isInteger(retained.file) && retained.file > 0 &&
      retained.file < 0xffff8000 && retained.file !== cloneHandle &&
      retained.file !== control.borrowedHandle &&
      retained.file !== root.handle,
    'cloned marker open did not transfer one distinct handle');
    fileHandle = retained.file;
    file = claimFile({clone, openReply: retained.openReply});
    check((await transport.readOpenFile(fileHandle)).equals(marker),
    'retained file content differs from the owned marker');
    check(isAbsent(await transport.readClone(cloneHandle,
      relativePath(owned.absent)), missing),
    'cloned absent path appeared after copy');
    onPhase('retain-owned-file');
    return {arenaNonce: preflight.arenaNonce,
      markerNonce: preflight.markerNonce, sdkBase: preflight.sdkBase,
      markerPath: owned.marker, absentPath: owned.absent,
      markerWrittenAndVerified: true, borrowedSession: 'preserved',
      ownedHandlesOpen: true, explicitSaveWrites: 1,
      context, root, transport, clone, file,
      receiveAddress: transport.dataAddress,
      pathAddress: transport.pathAddress};
  } catch (error) {
    if (serviceOpenAttempted || root || markerMayExist) {
      throw new Error('Balatro owned preparation failed after native service open began; retain resources and restart before another attempt',
        {cause: error});
    }
    throw error;
  }
}

async function closeQualifiedRoot(prepared) {
  const {root, transport} = prepared;
  check(root?.role === 'root' && root.closed === false &&
    Number.isInteger(root.handle) && root.handle > 0 &&
    !transport.ownedHandles.has(root.handle) &&
    transport.rawOwnedHandles.has(root.handle),
  'qualified root is absent or already closed');
  const reply = await transport.closeRawOwned(root.handle);
  check(reply?.closed === true && reply.method === 'worker-svcCloseHandle',
    'qualified root worker close was not verified');
  root.closed = true;
  return reply;
}

async function cleanupOwnedLease(prepared, {onPhase = () => {}} = {}) {
  check(prepared?.transport instanceof BalatroCloneTransport &&
    prepared.ownedHandlesOpen === true &&
    !cleanupAttempts.has(prepared) &&
    typeof onPhase === 'function',
  'owned cleanup is unavailable or was attempted already');
  cleanupAttempts.add(prepared);
  const {transport} = prepared;
  const cloneHandle = prepared.clone?.handle;
  const fileHandle = prepared.file?.handle;
  const completedCleanupPhases = [];
  let markerResult = null;
  let currentPhase = 'verify-owned-handles';
  const runPhase = async (name, action) => {
    currentPhase = name;
    try {
      onPhase(name);
      const value = await action();
      completedCleanupPhases.push(name);
      return value;
    } catch (cause) {
      const error = new Error(`Balatro owned cleanup failed at ${currentPhase}; retain resources`,
        {cause});
      error.resourceStateUncertain = true;
      error.cleanupPhase = currentPhase;
      error.diagnostic = {...(cause?.diagnostic || {}),
        cleanupPhase: currentPhase,
        completedCleanupPhases: [...completedCleanupPhases]};
      throw error;
    }
  };
  await runPhase('verify-owned-handles', async () => {
    check(transport.ownedHandles.has(cloneHandle) &&
      transport.ownedHandles.has(fileHandle) && cloneHandle !== fileHandle &&
      transport.rawOwnedHandles.has(prepared.root?.handle),
    'owned file, cloned save, or root handle is missing');
  });
  // Neutralize the marker while the owned clone/file handles are still open.
  // deleteMarker now straight-skips the overwrite (re-opening the existing
  // marker for write collides with the abandoned fsp-srv write session), so the
  // nonce-bound marker is left in place and no direct read-back is performed.
  await runPhase('neutralize-owned-marker', async () => {
    markerResult = await transport.deleteMarker(prepared.markerPath, null,
      {onPhase: label => {currentPhase = label; onPhase(label);}});
    check(markerResult?.verified === true &&
      markerResult.overwritten === false,
    'marker skip/delete did not verify');
  });
  await runPhase('close-owned-file', async () => {
    check((await transport.closeOwned(fileHandle))?.closed === true,
      'owned file close was not verified');
  });
  await runPhase('close-cloned-save', async () => {
    check((await transport.closeOwned(cloneHandle))?.closed === true,
      'cloned save close was not verified');
  });
  await runPhase('close-fsp-root', () => closeQualifiedRoot(prepared));
  prepared.ownedHandlesOpen = false;
  const markerRemoved = markerResult?.removed === true;
  return {ownedHandlesClosed: true, markerNeutralized: false,
    markerRemoved, markerRetained: !markerRemoved,
    borrowedSession: 'preserved'};
}

module.exports = {prepareOwnedLease, cleanupOwnedLease, openQualifiedRoot,
  closeQualifiedRoot,
  isExact, isAbsent};
