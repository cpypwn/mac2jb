'use strict';

const {pathPacket} = require('./paths.cjs');
const {response} = require('../../shared/domain.cjs');

const SIZES = Object.freeze([0x800, 0x801]);
const MIDPOINT = 0xc00;
const SOURCE_BYTES = MIDPOINT;

function requestBytes(filename) {
  if (typeof filename !== 'string' || !filename.startsWith('/') ||
      filename.includes('\0') || Buffer.byteLength(filename, 'ascii') >= 0x800 ||
      !/^[\x20-\x7e]+$/.test(filename))
    throw Error('Invalid owned threshold path');
  const bytes = Buffer.alloc(SOURCE_BYTES);
  bytes.write(filename + '\0', 'ascii');
  return bytes;
}

function diagnosticPacket(address, size) {
  if (![...SIZES, MIDPOINT].includes(size))
    throw Error('Invalid X descriptor threshold size');
  const bytes = pathPacket(7, Buffer.alloc(0), address, 0x800);
  if (size > 0x800) {
    const descriptor = bytes.readUInt32LE(8);
    bytes.writeUInt32LE((descriptor & 0xffff) | (size << 16), 8);
  }
  return bytes;
}

async function query(s, handle, address, size) {
  const request = diagnosticPacket(address, size);
  await s.write(s.base, request);
  const transport = await s.call('send', s.base, 4096, handle);
  await s.record({operation: 'Owned X descriptor threshold ' + size, handle, transport});
  if (transport) return {size, transport, result: null, type: null};
  const reply = response(await s.readOwned(s.base, 256));
  if (reply.moves.length || reply.copies.length || reply.objects.length)
    throw Error('Threshold lookup unexpectedly returned an object');
  const result = reply.canonicalResult;
  return {size, transport, result, type: result ? null : reply.data.readUInt32LE()};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.xSizeThresholdEnabled !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped ||
      !Array.isArray(report.cases) || report.cases.length !== 0 ||
      report.xSizeThreshold?.mode !== 'owned-short-path' ||
      report.xSizeThreshold.completed !== true)
    throw Error('X descriptor threshold diagnostic did not finish cleanly');
  const threshold = report.xSizeThreshold;
  if (threshold.before?.result !== 0 || threshold.before.type !== 1 ||
      threshold.after?.result !== 0 || threshold.after.type !== 1 ||
      !Array.isArray(threshold.observations) ||
      ![2, 3].includes(threshold.observations.length) ||
      threshold.observations[0].size !== SIZES[0] ||
      threshold.observations[0].transport !== 0 ||
      threshold.observations[0].result !== 0 ||
      threshold.observations[0].type !== 1 ||
      threshold.observations[1].size !== SIZES[1] ||
      threshold.observations.slice(1).some(item =>
        !Number.isInteger(item.transport) || item.transport < 0 ||
        item.transport !== 0 && (item.result !== null || item.type !== null) ||
        item.transport === 0 && (!Number.isInteger(item.result) ||
          item.result === 0 && item.type !== 1)) ||
      (threshold.observations.length === 3 &&
        (threshold.observations[2].size !== MIDPOINT ||
         threshold.observations[1].transport !== 0 ||
         threshold.observations[1].result !== 0 ||
         threshold.observations[1].type !== 1)))
    throw Error('X descriptor threshold controls did not verify');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) ||
      retained.handles.length || !Array.isArray(retained.threads) ||
      retained.threads.length || !Array.isArray(retained.created) ||
      retained.created.length || retained.group || retained.cacheNeedsRestore)
    throw Error('X descriptor threshold retained resources');
  return {diagnostic: 'x-descriptor-threshold', session,
    observations: threshold.observations, cleanedUp: true};
}

module.exports = {SIZES, MIDPOINT, SOURCE_BYTES, requestBytes, diagnosticPacket, query, verifyReport};
