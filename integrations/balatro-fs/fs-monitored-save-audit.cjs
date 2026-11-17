const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {LOGGER_SHA256, takeSnapshot} = require('./rpc-log-snapshot.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const ABSENT_RESULT = '0x00000202';

function check(condition, reason) {
  if (!condition) throw Error(`Balatro monitored save audit: ${reason}`);
}

function exactPaths(states, markerBytes) {
  return states?.explicitSaveWrites === 0 &&
    ['original', 'cloned', 'padded'].every(source => {
      const marker = states[source]?.marker;
      const absent = states[source]?.absent;
      return marker?.result === 0 && marker.type === 1 &&
        Buffer.isBuffer(marker.bytes) && marker.bytes.equals(markerBytes) &&
        absent?.result === 0x202 && absent.type === null &&
        absent.bytes === null;
    });
}

function validSnapshot(snapshot) {
  const state = snapshot?.readonly;
  const log = snapshot?.log;
  return snapshot?.gameProfile === profile.gameProfile &&
    /^[0-9a-f]{16}$/.test(snapshot.nonce || '') &&
    state?.gameProfile === profile.gameProfile &&
    Number.isSafeInteger(state.freeBytes) && state.freeBytes >= 0 &&
    state.absentPathResult === ABSENT_RESULT &&
    log?.sourcePinned === true &&
    log.loggerSourceSha256 === LOGGER_SHA256 &&
    Number.isSafeInteger(log.sizeBytes) && log.sizeBytes >= 0 &&
    Number.isSafeInteger(log.phaseSizeBytes) && log.phaseSizeBytes >= -1;
}

function assessMonitoredState({before, after, beforePaths, afterPaths,
  markerNonce}) {
  check(/^[0-9a-f]{16}$/.test(markerNonce || ''),
    'marker nonce is missing');
  check(validSnapshot(before) && validSnapshot(after) &&
    before.nonce !== after.nonce,
  'fresh pinned snapshots are required on both sides of the wave');
  const markerBytes = content(markerNonce);
  check(exactPaths(beforePaths, markerBytes) &&
    exactPaths(afterPaths, markerBytes),
  'original, cloned, or padded marker/absent controls changed');
  check(after.log.sizeBytes >= before.log.sizeBytes,
    'RPC activity log shrank');
  check(after.log.phaseSizeBytes === before.log.phaseSizeBytes,
    'RPC phase file size changed');
  check(after.readonly.freeBytes === before.readonly.freeBytes,
    'free-space drift cannot be attributed from RPC log growth alone');
  const owned = paths(markerNonce);
  return {
    coverage: 'monitored-properties-only',
    completeSaveTreeVerified: false,
    unchangedMonitoredProperties: true,
    monitoredPaths: [owned.marker, owned.absent,
      'save:/bl_log.txt', 'save:/bl_phase.txt'],
    logGrowthBytes: after.log.sizeBytes - before.log.sizeBytes,
    logContentVerified: false,
    phaseContentVerified: false,
    freeBytesBeforeAndAfter: before.readonly.freeBytes,
    absentPathResult: ABSENT_RESULT,
  };
}

async function captureMonitoredState({host, inspect = takeSnapshot}) {
  check(typeof inspect === 'function', 'snapshot dependency is invalid');
  return inspect({host});
}

module.exports = {ABSENT_RESULT, assessMonitoredState,
  captureMonitoredState, exactPaths, validSnapshot};
