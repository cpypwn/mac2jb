'use strict';

// Isolated save-path GetEntryType probe: classifies Balatro's save handler as
// LENIENT (accepts root-relative .. and >255-char components) or STRICT
// (rejects root-relative .. with 2-6006). Queries the marker/absent plus
// root-relative /.. and /..\ and a valid-parent control.
const {response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} = require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const {paths} = require('./marker-path-control.cjs');

const DESCRIPTOR_BYTES = 0x800;

function descriptorFor(fullPath) {
  const basename = fullPath.slice('save:/'.length);
  const input = Buffer.alloc(DESCRIPTOR_BYTES, '/');
  input.write(basename, DESCRIPTOR_BYTES - 1 - Buffer.byteLength(basename),
    'ascii');
  input[DESCRIPTOR_BYTES - 1] = 0;
  return input;
}

async function runPathSemantics({preflight, adapter, onPhase = () => {}}) {
  const prepared = await adapter.prepare(preflight);
  const transport = prepared.transport;
  const cloneHandle = prepared.clone.handle;
  const marker = paths(preflight.markerNonce).marker;
  const absent = paths(preflight.markerNonce).absent;
  const base = marker.slice('save:/'.length);
  const cases = [
    ['direct-marker', marker],
    ['direct-absent', absent],
    ['root-relative-slash', `save:/../${base}`],
    ['root-relative-backslash', `save:/..\\${base}`],
    ['valid-parent', `save:/selected/../${base}`],
    ['nested-valid-parent', `save:/a/../b/../../${base}`],
  ];
  const results = [];
  for (const [name, fullPath] of cases) {
    onPhase(name);
    const descriptor = descriptorFor(fullPath);
    await transport.native.write(transport.pathAddress, descriptor);
    const raw = await transport.sendPacket(cloneHandle,
      pathPacket(7, Buffer.alloc(0), transport.pathAddress, DESCRIPTOR_BYTES));
    const reply = response(raw);
    results.push({name, fullPath, result: reply.result,
      canonical: reply.canonicalResult,
      type: reply.result === 0 && reply.data.length >= 4 ?
        reply.data.readUInt32LE() : null});
  }
  const cleaned = await adapter.cleanup(prepared);
  if (cleaned?.arena !== 'released') throw Error('path-semantics cleanup failed');
  return {pathResults: results, cleanup: 'verified'};
}

module.exports = {runPathSemantics};
