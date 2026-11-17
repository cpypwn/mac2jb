'use strict';

const path = require('node:path');
const {response} = require('../../shared/domain.cjs');
const {pathPacket, pathPackets} = require('./paths.cjs');
const seam = require('./marker-first-seam.cjs');

const PREFIX_BYTES = 0x800;
const TAIL_BYTES = Buffer.byteLength('SPAN_MARKER') + 1;
const TWO_X_TRANSPORT_REJECTION = 0xce01;

function sources(scratch, segments) {
  const marker = seam.payload(scratch, segments, 'SPAN_MARKER', 'SPAN_MARKER');
  const absent = seam.payload(scratch, segments, 'SPAN_MARKER', 'SPAN_ABSENT');
  const prefix = marker.bytes.subarray(0, PREFIX_BYTES);
  if (!prefix.equals(absent.bytes.subarray(0, PREFIX_BYTES)) ||
      prefix[PREFIX_BYTES - 1] !== 0x2f || prefix.includes(0) ||
      path.posix.normalize(prefix.toString('ascii')).replace(/\/+$/, '') !==
        path.posix.join(scratch, ...segments))
    throw Error('Two-X prefix does not resolve to the owned directory');
  const tails = {
    marker: Buffer.from(marker.bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + TAIL_BYTES)),
    absent: Buffer.from(absent.bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + TAIL_BYTES)),
  };
  if (tails.marker.length !== TAIL_BYTES || tails.absent.length !== TAIL_BYTES ||
      tails.marker.at(-1) !== 0 || tails.absent.at(-1) !== 0 ||
      tails.marker.subarray(0, -1).toString('ascii') !== 'SPAN_MARKER' ||
      tails.absent.subarray(0, -1).toString('ascii') !== 'SPAN_ABSENT')
    throw Error('Two-X tails differ from the matched owned paths');
  const prefixControl = Buffer.from(prefix);
  prefixControl[PREFIX_BYTES - 1] = 0;
  return {prefix: Buffer.from(prefix), prefixControl,
    prefixPath: path.posix.join(scratch, ...segments),
    tails: {...tails, terminator: Buffer.from([0])},
    markerPath: marker.path, absentPath: absent.path};
}

function request(address, tailAddress = null, tailSize = TAIL_BYTES) {
  if (tailAddress !== null && tailSize !== 1 && tailSize !== TAIL_BYTES)
    throw Error('Invalid two-X tail descriptor size');
  return tailAddress === null ? pathPacket(7, Buffer.alloc(0), address, PREFIX_BYTES) :
    pathPackets(7, Buffer.alloc(0), [
      {address, size: PREFIX_BYTES}, {address: tailAddress, size: tailSize},
    ]);
}

async function query(s, handle, prefixAddress, tailAddress, source, kind) {
  if (!Buffer.isBuffer(source.prefix) || source.prefix.length !== PREFIX_BYTES ||
      source.prefix[PREFIX_BYTES - 1] !== 0x2f || source.prefix.includes(0) ||
      !['prefix', 'terminator', 'marker', 'absent'].includes(kind))
    throw Error('Invalid two-X direct query');
  if (!Buffer.isBuffer(source.prefixControl) ||
      source.prefixControl.length !== PREFIX_BYTES ||
      source.prefixControl[PREFIX_BYTES - 1] !== 0 ||
      !source.prefixControl.subarray(0, PREFIX_BYTES - 1)
        .equals(source.prefix.subarray(0, PREFIX_BYTES - 1)))
    throw Error('Invalid terminated prefix control');
  await s.write(prefixAddress, kind === 'prefix' ? source.prefixControl : source.prefix);
  if (kind !== 'prefix') {
    if (!Buffer.isBuffer(source.tails?.[kind]) ||
        source.tails[kind].length !== (kind === 'terminator' ? 1 : TAIL_BYTES) ||
        source.tails[kind].at(-1) !== 0)
      throw Error('Invalid two-X direct tail');
    await s.write(tailAddress, source.tails[kind]);
  }
  await s.write(s.base, request(prefixAddress, kind === 'prefix' ? null : tailAddress,
    kind === 'terminator' ? 1 : TAIL_BYTES));
  const transport = await s.call('send', s.base, 4096, handle);
  await s.record({operation: 'Owned direct GetEntryType ' + kind, handle, transport});
  if (transport) return {kind, transport, result: null, type: null};
  const reply = response(await s.readOwned(s.base, 256));
  if (reply.moves.length || reply.copies.length || reply.objects.length)
    throw Error('Two-X direct lookup unexpectedly returned an object');
  const result = reply.canonicalResult;
  const observation = {kind, transport, result,
    type: result ? null : reply.data.readUInt32LE()};
  await s.record({operation: 'Owned direct GetEntryType ' + kind + ' CMIF',
    handle, result: observation.result, type: observation.type});
  return observation;
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.twoXDirectEnabled !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped ||
      !Array.isArray(report.cases) || report.cases.length !== 0 ||
      report.twoXDirect?.mode !== 'owned-prefix-two-x' ||
      report.twoXDirect.completed !== true)
    throw Error('Two-X direct diagnostic did not finish cleanly');
  const diagnostic = report.twoXDirect;
  for (const side of [diagnostic.before, diagnostic.after])
    if (side?.marker?.result !== 0 || side.marker.type !== 1 ||
        side.absent?.result !== 0x202 || side.prefix?.result !== 0 ||
        side.prefix.type !== 0)
      throw Error('Two-X direct owned-path controls did not verify');
  if (!Array.isArray(diagnostic.observations) ||
      diagnostic.observations.some(item =>
        !Number.isInteger(item.transport) || item.transport < 0 ||
        item.transport !== 0 && (item.result !== null || item.type !== null) ||
        item.transport === 0 && (!Number.isInteger(item.result) ||
          item.result === 0 && !Number.isInteger(item.type))) ||
      diagnostic.observations[0].transport !== 0 ||
      diagnostic.observations[0].result !== 0 ||
      diagnostic.observations[0].type !== 0 ||
      diagnostic.observations[0].kind !== 'prefix')
    throw Error('Two-X direct packet or prefix control did not verify');
  const rejected = diagnostic.status === 'transport-rejected-two-x';
  if (rejected ?
    diagnostic.observations.length !== 2 ||
      diagnostic.observations[1].kind !== 'terminator' ||
      diagnostic.observations[1].transport !== TWO_X_TRANSPORT_REJECTION ||
      diagnostic.transportResult !== TWO_X_TRANSPORT_REJECTION :
    diagnostic.status !== 'path-comparison-completed' ||
      diagnostic.observations.map(item => item.kind).join(',') !==
        'prefix,terminator,marker,absent' ||
      diagnostic.observations.some(item => item.transport !== 0) ||
      diagnostic.observations[1].result !== 0 ||
      diagnostic.observations[1].type !== 0)
    throw Error('Two-X direct transport or path-comparison outcome differs');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) ||
      retained.handles.length || !Array.isArray(retained.threads) ||
      retained.threads.length || !Array.isArray(retained.created) ||
      retained.created.length || retained.group || retained.cacheNeedsRestore ||
      retained.released !== true)
    throw Error('Two-X direct diagnostic retained resources');
  return {diagnostic: 'two-x-direct', session, status: diagnostic.status,
    transportResult: rejected ? TWO_X_TRANSPORT_REJECTION : null,
    parserOutcome: rejected ? 'unmeasured' : 'observed',
    observations: diagnostic.observations, cleanedUp: true};
}

module.exports = {PREFIX_BYTES, TAIL_BYTES, TWO_X_TRANSPORT_REJECTION,
  sources, request, query, verifyReport};
