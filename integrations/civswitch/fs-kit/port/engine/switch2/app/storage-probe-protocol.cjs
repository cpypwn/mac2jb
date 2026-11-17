const {packet} = require('../../shared/ipc.cjs');

function temporaryStorageInput() {
  const input = Buffer.alloc(0x48);
  input[0] = 3;
  input[8 + 0x20] = 4;
  return input;
}

function spacePacket(command, address) {
  if (![11, 12].includes(command) || !Number.isSafeInteger(address) ||
      address <= 0 || BigInt(address) >= 1n << 39n) {
    throw Error('Invalid filesystem space request');
  }
  const a = BigInt(address);
  const bytes = packet(command);
  bytes.writeUInt32LE(4 | 1 << 16, 0);
  bytes.writeUInt32LE(Number(0x301n << 16n | ((a >> 36n) & 7n) << 6n |
    ((a >> 32n) & 15n) << 12n), 8);
  bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
  return bytes;
}

module.exports = {temporaryStorageInput, spacePacket};
