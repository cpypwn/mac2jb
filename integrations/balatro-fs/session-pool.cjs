// Pinned 1.0.1f SDK: HipcSimpleClientSessionManager at 0xcd9ec,
// SetSessionCountImpl at 0xcdcb0, and Allocate at 0xcdbc0.
// The first pool node is not necessarily the next session returned by Allocate.
const CAPACITY = 16;
const NODE_BYTES = 16;
const POOL_OFFSET = 0x80;
const MANAGER_BYTES = 0x800;
const SLOT_BYTES = 0x800;

function hex(value) {return `0x${value.toString(16)}`;}

function inspectSessionPool(manager, slots, managerAddress) {
  if (!Buffer.isBuffer(manager) || manager.length !== MANAGER_BYTES ||
      !Buffer.isBuffer(slots) || slots.length !== SLOT_BYTES ||
      !Number.isSafeInteger(managerAddress) || managerAddress < 4096 ||
      managerAddress >= 2 ** 39) {
    throw new TypeError('Balatro session-pool snapshot is incomplete');
  }
  const pool = Number(manager.readBigUInt64LE(0x10));
  const capacity = manager.readUInt32LE(0x58);
  const sessionCount = manager.readUInt32LE(0x5c);
  if (pool !== managerAddress + POOL_OFFSET || capacity !== CAPACITY ||
      sessionCount !== 3 || manager.readUInt32LE(0x08) !== 2048) {
    throw Error('Balatro pinned SDK session-manager layout changed');
  }
  const idleHead = Number(manager.readBigUInt64LE(0x40));
  const spareHead = Number(manager.readBigUInt64LE(0x48));
  const seen = new Set();
  const walk = (head, label) => {
    const nodes = [];
    let address = head;
    while (address !== 0) {
      if (!Number.isSafeInteger(address) || address < pool ||
          address >= pool + CAPACITY * NODE_BYTES ||
          (address - pool) % NODE_BYTES !== 0 || seen.has(address) ||
          nodes.length >= CAPACITY) {
        throw Error(`Balatro ${label} session list is corrupt or cyclic`);
      }
      seen.add(address);
      const index = (address - pool) / NODE_BYTES;
      const handle = slots.readUInt32LE(index * NODE_BYTES);
      const next = Number(slots.readBigUInt64LE(index * NODE_BYTES + 8));
      if (label === 'idle' && (handle < 1 || handle >= 0xffff8000)) {
        throw Error('Balatro idle session contains an invalid handle');
      }
      nodes.push({index, address: hex(address), handle});
      address = next;
    }
    return nodes;
  };
  const idle = walk(idleHead, 'idle');
  const spare = walk(spareHead, 'spare');
  if (seen.size !== CAPACITY || idle.length > sessionCount ||
      idle.length === 0 || new Set(idle.map(node => node.handle)).size !== idle.length) {
    throw Error('Balatro idle/spare session lists do not partition the pinned pool');
  }
  return {pool: hex(pool), idleHead: hex(idleHead), spareHead: hex(spareHead),
    capacity, sessionCount, idleCount: idle.length, spareCount: spare.length,
    idle, spare, nextBorrowable: idle[0],
    livenessVerified: false};
}

module.exports = {CAPACITY, NODE_BYTES, POOL_OFFSET, MANAGER_BYTES,
  SLOT_BYTES, inspectSessionPool};
