const crypto = require('node:crypto');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const domain = require('../civswitch/fs-kit/port/engine/shared/domain.cjs');

const MAX_ADDRESS = 1n << 39n;
const SDK_DATA_START = BigInt(captured.mappings.sdkData.base) -
  BigInt(captured.identity.sdkBase);
const SDK_DATA_END = SDK_DATA_START + BigInt(captured.mappings.sdkData.size);

function address(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase hexadecimal address`);
  }
  const parsed = BigInt(value);
  if (parsed < 0x1000n || parsed >= MAX_ADDRESS) {
    throw new RangeError(`${name} is outside user address space`);
  }
  return parsed;
}

function positive(value, name, max = 0xffffffff) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' ||
      evidence.gameProfile !== profile.gameProfile ||
      evidence.runtimeVersion !== profile.runtimeVersion ||
      evidence.sdkCodeSha256 !== profile.sdkCode.sha256 ||
      !/^[0-9a-f]{16}$/.test(evidence.nonce || '') ||
      evidence.status !== 'read-only; mounted domain not cloned') {
    throw new Error('Balatro mounted-domain evidence is absent or does not match the pinned target');
  }
  const sdkBase = address(evidence.sdkBase, 'sdkBase');
  if (sdkBase % 0x1000n || sdkBase + SDK_DATA_END >= MAX_ADDRESS) {
    throw new RangeError('Balatro SDK base or data extent is invalid');
  }
  const {mount, proxy, sessionManager} = evidence;
  if (!mount || !proxy || !sessionManager || mount.name !== 'save') {
    throw new Error('Balatro mounted save, proxy, and session manager evidence is required');
  }
  for (const [name, value] of [
    ['mount.accessor', mount.accessor], ['mount.implementation', mount.implementation],
    ['mount.service', mount.service], ['mount.manager', mount.manager],
    ['proxy.object', proxy.object], ['proxy.manager', proxy.manager],
    ['sessionManager.slot', sessionManager.slot],
  ]) address(value, name);
  const serviceVtable = address(mount.serviceVtable, 'mount.serviceVtable');
  const vtableOffset = serviceVtable - sdkBase;
  if (vtableOffset < SDK_DATA_START || vtableOffset >= SDK_DATA_END ||
      evidence.mount.serviceVtableOffset !== `0x${vtableOffset.toString(16)}`) {
    throw new Error('Balatro service vtable is outside the measured SDK mapping');
  }
  if (mount.manager !== proxy.manager ||
      mount.objectId === proxy.objectId ||
      sessionManager.stateSize !== captured.fsProxy.managerStateSize ||
      sessionManager.stateValue !== captured.fsProxy.managerState) {
    throw new Error('Balatro mounted domain does not match the measured session manager');
  }
  positive(mount.objectId, 'mount.objectId', 65535);
  positive(proxy.objectId, 'proxy.objectId', 65535);
  positive(sessionManager.borrowedHandle, 'sessionManager.borrowedHandle', 0xffff7fff);
  if (typeof evidence.absentPathResult !== 'string' ||
      !/^0x[0-9a-f]{8}$/.test(evidence.absentPathResult) ||
      evidence.absentPathResult === '0x00000000') {
    throw new Error('Balatro exact absent-path Result is required');
  }
  return evidence;
}

function matchingBoot(expected, observed) {
  validateEvidence(expected);
  validateEvidence(observed);
  for (const name of ['nonce', 'sdkBase', 'absentPathResult']) {
    if (expected[name] !== observed[name]) throw new Error(`Balatro live ${name} changed`);
  }
  for (const group of ['mount', 'proxy', 'sessionManager']) {
    for (const [name, value] of Object.entries(expected[group])) {
      if (observed[group][name] !== value) {
        throw new Error(`Balatro live ${group}.${name} changed`);
      }
    }
  }
  return observed;
}

function copyRequest(evidence) {
  validateEvidence(evidence);
  const input = Buffer.alloc(4);
  input.writeUInt32LE(evidence.mount.objectId);
  return {borrowedHandle: evidence.sessionManager.borrowedHandle,
    packet: domain.control(1, input)};
}

function copiedHandle(reply, borrowedHandle) {
  if (!Buffer.isBuffer(reply) || reply.length < 64) {
    throw new Error('Balatro domain-copy reply is missing or truncated');
  }
  const parsed = domain.response(reply);
  if (parsed.result || parsed.moves.length !== 1 || parsed.copies.length ||
      parsed.objects.length || !Number.isInteger(parsed.moves[0]) ||
      parsed.moves[0] <= 0 || parsed.moves[0] >= 0xffff8000 ||
      parsed.moves[0] === borrowedHandle) {
    throw new Error('Balatro domain-copy reply did not transfer one owned handle');
  }
  return parsed.moves[0];
}

function state(value, expectedResult, bytes = null) {
  if (!value || value.result !== expectedResult) return false;
  if (expectedResult === 0) {
    return value.type === 1 && Buffer.isBuffer(value.bytes) &&
      Buffer.isBuffer(bytes) && value.bytes.equals(bytes);
  }
  return value.type === null && value.bytes === null;
}

function relativePath(path) {
  if (!path.startsWith('save:/')) throw new Error('Balatro marker path has an unexpected mount');
  return path.slice('save:'.length);
}

async function runCloneControl({evidence, transport, nonceBytes = crypto.randomBytes,
  onPhase = () => {}}) {
  validateEvidence(evidence);
  if (!transport || typeof transport.inspectLive !== 'function' ||
      typeof transport.readOriginal !== 'function' ||
      typeof transport.writeMarker !== 'function' ||
      typeof transport.sendControl !== 'function' ||
      typeof transport.readClone !== 'function' ||
      typeof transport.closeOwned !== 'function' ||
      typeof transport.deleteMarker !== 'function' || typeof onPhase !== 'function') {
    throw new TypeError('Balatro clone control requires a complete owned transport');
  }
  const nonceRaw = nonceBytes(8);
  if (!Buffer.isBuffer(nonceRaw) || nonceRaw.length !== 8) {
    throw new TypeError('Balatro clone nonce must be eight bytes');
  }
  const nonce = nonceRaw.toString('hex');
  const {marker, absent} = paths(nonce);
  const markerBytes = content(nonce);
  const missing = Number.parseInt(evidence.absentPathResult, 16);
  onPhase('clone: verify mounted domain');
  matchingBoot(evidence, await transport.inspectLive());
  onPhase(`clone: verify owned paths are absent; marker ${marker}`);
  if (!state(await transport.readOriginal(marker), missing) ||
      !state(await transport.readOriginal(absent), missing)) {
    throw new Error('Balatro marker or absent path exists before clone control');
  }
  let markerMayExist = false;
  let ownedHandle = null;
  let primaryError = null;
  const cleanupErrors = [];
  try {
    onPhase(`clone: write marker ${marker}`);
    markerMayExist = true;
    const written = await transport.writeMarker(marker, markerBytes, {onPhase});
    onPhase(`clone: writeMarker verified=${written?.verified}`);
    if (written?.verified !== true) {
      throw new Error('Balatro marker write was not verified before copying');
    }
    // Do NOT read the marker back through the direct save here: writeMarker's
    // closeDirect abandons an fsp-srv write session on the marker, so any later
    // direct OpenFile (mode 1 read or mode 2 write) on that existing marker
    // faults and resets the bridge. The clone is a mounted-domain copy taken
    // AFTER writeMarker, so its marker and absent-path contents mirror the
    // direct save; verify both through the proven non-crashing clone path
    // (sendOwned GetEntryType/OpenFile/ReadFile) instead of a direct read-back.
    onPhase('clone: copy mounted domain');
    const request = copyRequest(evidence);
    const reply = await transport.sendControl(request.borrowedHandle, request.packet);
    ownedHandle = copiedHandle(reply, request.borrowedHandle);
    onPhase(`clone: owned handle ${ownedHandle} received; verify marker and absent path`);
    if (!state(await transport.readClone(ownedHandle, relativePath(marker)), 0, markerBytes) ||
        !state(await transport.readClone(ownedHandle, relativePath(absent)), missing)) {
      throw new Error('Balatro cloned filesystem marker or absent-path control failed');
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (markerMayExist) {
      try {
        onPhase(`clone: remove marker ${marker}`);
        if ((await transport.deleteMarker(marker, ownedHandle, {onPhase}))?.verified !== true) {
          throw new Error('Balatro marker cleanup was not verified');
        }
      } catch (error) {cleanupErrors.push(error);}
    }
    if (ownedHandle !== null) {
      try {
        onPhase(`clone: close owned handle ${ownedHandle}`);
        if ((await transport.closeOwned(ownedHandle, {onPhase}))?.closed !== true) {
          throw new Error('owned Balatro clone handle did not close');
        }
      } catch (error) {cleanupErrors.push(error);}
    }
    onPhase('clone: cleanup attempted');
  }
  if (primaryError && cleanupErrors.length) {
    throw new AggregateError([primaryError, ...cleanupErrors],
      'Balatro clone control failed and cleanup was not verified');
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Balatro clone control cleanup was not verified');
  }
  return {gameProfile: profile.gameProfile, nonce,
    marker, absent, ownedCloneVerified: true,
    markerContentVerified: true, absentPathVerified: true,
    cleanup: 'verified', markerWaveAttempted: false};
}

module.exports = {validateEvidence, matchingBoot, copyRequest, copiedHandle,
  relativePath, runCloneControl};
