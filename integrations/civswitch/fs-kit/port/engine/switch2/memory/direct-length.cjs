'use strict';

const path = require('node:path');
const {pathPacket} = require('./paths.cjs');
const ladder = require('./extent-ladder.cjs');

const MAX_BYTES = 0x2000;
const ABSENT = 'SPAN_ABSENT';

function requestBytes(scratch, segments, name, chunk) {
  const {bytes, terminatorOffset, path: filename} =
    ladder.payloadForChunk(scratch, segments, name, chunk);
  const request = bytes.subarray(0, terminatorOffset + 1);
  if (request.length > MAX_BYTES || request[request.length - 1] !== 0 ||
      request.subarray(0, -1).includes(0) ||
      path.posix.normalize(request.subarray(0, -1).toString('ascii')) !== filename)
    throw Error('Invalid direct-length owned path');
  return {bytes: request, filename, terminatorOffset};
}

function diagnosticPacket(address, size) {
  if (!Number.isInteger(size) || size <= 0x800 || size > MAX_BYTES)
    throw Error('Direct-length descriptor exceeds its bounded size');
  const packet = pathPacket(7, Buffer.alloc(0), address, 0x800);
  const descriptor = packet.readUInt32LE(8);
  packet.writeUInt32LE((descriptor & 0xffff) | (size << 16), 8);
  return packet;
}

async function query(s, domain, handle, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0x800 || bytes.length > MAX_BYTES ||
      bytes[bytes.length - 1] !== 0 || bytes.subarray(0, -1).includes(0))
    throw Error('Invalid direct-length path bytes');
  const buffer = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
  bytes.copy(buffer);
  await s.write(s.base + 0x4000, buffer);
  return domain.send(s, 'Bounded direct long-path control', handle,
    diagnosticPacket(s.base + 0x4000, bytes.length));
}

function typeOf(reply) {
  return {result: reply.canonicalResult,
    type: reply.result ? null : reply.data.readUInt32LE()};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.directLengthEnabled !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped ||
      !Array.isArray(report.cases) || report.cases.length !== 0 ||
      report.directLength?.mode !== 'bounded-direct-get-entry-type' ||
      report.directLength.completed !== true ||
      !Array.isArray(report.directLength.levels) ||
      report.directLength.levels.length !== ladder.CHUNKS.length)
    throw Error('Direct-length diagnostic did not finish with clean resources');
  const levels = report.directLength.levels.map((level, index) => {
    const chunk = ladder.CHUNKS[index];
    if (level.chunk !== chunk || level.terminatorOffset !== chunk * 0x800 - 1 ||
        level.size !== chunk * 0x800 ||
        level.markerPath !== ladder.markerPath(report.scratch, report.directLength.segments,
          'SPAN_MARKER', chunk) ||
        level.absentPath !== ladder.markerPath(report.scratch, report.directLength.segments,
          ABSENT, chunk) ||
        [level.before, level.after].some(control =>
          control?.marker?.result !== 0 || control.marker.type !== 1 ||
          control.absent?.result !== 0x202) ||
        !Number.isInteger(level.direct?.marker?.result) ||
        !Number.isInteger(level.direct?.absent?.result) ||
        level.direct.absent.result === 0 && level.direct.absent.type === 1)
      throw Error('Direct-length owned path controls did not verify');
    return {chunk, size: level.size, marker: level.direct.marker,
      absent: level.direct.absent};
  });
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) ||
      retained.handles.length || !Array.isArray(retained.threads) || retained.threads.length ||
      !Array.isArray(retained.created) || retained.created.length || retained.group ||
      retained.cacheNeedsRestore)
    throw Error('Direct-length diagnostic retained native resources');
  return {diagnostic: 'direct-path-length', session, levels, cleanedUp: true};
}

module.exports = {MAX_BYTES, ABSENT, requestBytes, diagnosticPacket, query, typeOf, verifyReport};
