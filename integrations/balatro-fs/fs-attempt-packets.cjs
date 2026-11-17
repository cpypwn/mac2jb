const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} = require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const {makeIpcPacket} = require('./fs-counter-probe.cjs');
const {copiedHandle, validateEvidence} = require('./clone-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {paths} = require('./marker-path-control.cjs');
const {DESCRIPTOR_BYTES, TERMINATOR_OFFSET, assessFirstDescriptor} =
  require('./canary-attempt-readiness.cjs');

const capabilities = new WeakMap();
const MAX_ADDRESS = 2 ** 39;

function check(condition, message) {
  if (!condition) throw Error(`Balatro FS packet: ${message}`);
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function memoryAddress(transport, address, bytes) {
  check(Number.isSafeInteger(address) && address % 0x1000 === 0 &&
    address >= transport.scratch && address + bytes <= transport.scratch + 0x80000 &&
    address + bytes < MAX_ADDRESS,
  'buffer must be a page-aligned address in the verified Balatro scratch arena');
  return address;
}

function requireTransport(transport) {
  check(transport instanceof BalatroCloneTransport &&
    transport.ownedHandles instanceof Set &&
    Number.isSafeInteger(transport.scratch) &&
    transport.scratch % 0x1000 === 0 &&
    validateEvidence(transport.evidence) === transport.evidence,
  'verified Balatro clone transport is required');
  return transport;
}

function capability(transport, handle, role) {
  const result = Object.freeze({handle, role});
  capabilities.set(result, {transport, handle, role});
  return result;
}

function requireCapability(value, role) {
  const claim = capabilities.get(value);
  check(claim?.role === role &&
    claim.transport.ownedHandles.has(claim.handle) &&
    claim.handle !== claim.transport.evidence.sessionManager.borrowedHandle,
  `open owned ${role} handle is required`);
  return claim;
}

function belongsToTransport(value, transport, role) {
  const claim = requireCapability(value, role);
  check(claim.transport === requireTransport(transport),
    `${role} capability belongs to a different native transport`);
  return true;
}

function claimClone({transport, controlReply}) {
  requireTransport(transport);
  const borrowed = transport.evidence.sessionManager.borrowedHandle;
  const handle = copiedHandle(controlReply, borrowed);
  check(transport.ownedHandles.has(handle),
    'cloned save handle was not transferred to the owned transport');
  return capability(transport, handle, 'clone');
}

function claimFile({clone, openReply}) {
  const parent = requireCapability(clone, 'clone');
  const reply = openReply;
  check(reply?.result === 0 && Array.isArray(reply.moves) &&
    reply.moves.length === 1 && Array.isArray(reply.copies) &&
    reply.copies.length === 0,
  'cloned file open did not transfer exactly one handle');
  const handle = reply.moves[0];
  check(Number.isInteger(handle) && handle > 0 && handle < 0xffff8000 &&
    handle !== parent.handle &&
    handle !== parent.transport.evidence.sessionManager.borrowedHandle &&
    parent.transport.ownedHandles.has(handle),
  'file handle was not transferred to the owned transport');
  return capability(parent.transport, handle, 'file');
}

function makePinRequest({context, root}) {
  const native = makeIpcPacket(context, root, 'open-storage');
  const request = Buffer.from(native.subarray(0x1000, 0x1100));
  check(request.length === 256 && request.readUInt32LE(24) === 200,
    'owned storage open command changed');
  return {requestKind: 'owned-storage-open', handle: root.handle,
    packet: request};
}

function makeReceiveRequest({file, receiveAddress, bytes = 16}) {
  const owned = requireCapability(file, 'file');
  check(Number.isInteger(bytes) && bytes >= 16 && bytes <= 0x800,
    'receive length must be bounded');
  const address = memoryAddress(owned.transport, receiveAddress, bytes);
  return {requestKind: 'receive-buffer-request', handle: owned.handle,
    packet: packet(0, Buffer.concat([u64(0), u64(0), u64(bytes)]),
      {receive: [{address, size: bytes, mode: 1}]}),
    receiveAddress: address, receiveBytes: bytes};
}

function descriptorInput(nonce, which) {
  check(which === 'marker' || which === 'absent',
    'descriptor must select the marker or absent control');
  const owned = paths(nonce);
  const make = value => {
    const basename = value.slice('save:/'.length);
    const input = Buffer.alloc(DESCRIPTOR_BYTES, '/');
    input.write(basename, TERMINATOR_OFFSET - Buffer.byteLength(basename), 'ascii');
    input[TERMINATOR_OFFSET] = 0;
    return input;
  };
  const markerInput = make(owned.marker);
  const absentInput = make(owned.absent);
  assessFirstDescriptor({mode: 'balatro-first-descriptor',
    nativeDescriptorBytes: DESCRIPTOR_BYTES,
    terminatorOffset: TERMINATOR_OFFSET,
    markerInput, absentInput}, nonce);
  return Buffer.from(which === 'marker' ? markerInput : absentInput);
}

// Local CMIF path packet that lifts the shared paths.cjs 0x800-per-descriptor
// cap. The CivSwitch reference positive path is ~9280 bytes (a single unbroken
// 'B' component up to markerOffset 0x2340), which exceeds 0x800; the fs path
// descriptor size field is 16 bits, so a bounded 0x3000 ceiling is safe.
function largePathPacket(command, input, address, size) {
  check(Number.isInteger(size) && size > 0 && size <= 0x3000 &&
    Number.isInteger(address) && address >= 0x1000,
  'large path descriptor must be a bounded page-aligned buffer');
  const original = packet(command, input);
  const bytes = Buffer.alloc(256);
  original.copy(bytes, 0, 0, 8);
  bytes.writeUInt32LE(4 | 1 << 16);
  const a = BigInt(address);
  bytes.writeUInt32LE(Number(BigInt(0) | BigInt(size) << 16n |
    (a >> 36n & 7n) << 6n | (a >> 32n & 15n) << 12n), 8);
  bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
  const at = 16;
  original.copy(bytes, at, 16, 16 + 16 + input.length);
  return bytes;
}

function makeTriggerRequest({clone, nonce, which = 'marker', pathAddress,
  abort = false, descriptor = null}) {
  const owned = requireCapability(clone, 'clone');
  const input = descriptor ? Buffer.from(descriptor) : descriptorInput(nonce, which);
  const address = memoryAddress(owned.transport, pathAddress, input.length);
  check(input.length >= DESCRIPTOR_BYTES && input[input.length - 1] === 0,
    'custom descriptor must be a bounded NUL-terminated first descriptor');
  if (abort) input[0] = 0;
  const request = largePathPacket(7, Buffer.alloc(0), address, input.length);
  check(request.length === 256 && request.readUInt32LE(8) >>> 16 === input.length,
    'first path descriptor size changed');
  return {requestKind: 'cloned-save-entry-type', handle: owned.handle,
    packet: request, descriptorInput: input, pathAddress: address,
    descriptorBytes: input.length, aborted: abort};
}

module.exports = {claimClone, claimFile, makePinRequest,
  makeReceiveRequest, makeTriggerRequest, descriptorInput,
  belongsToTransport};
