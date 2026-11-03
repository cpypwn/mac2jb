'use strict';
// CMIF input for the save-data open commands:
//
//   51 OpenSaveDataFileSystem            (read-write)
//   52 OpenSaveDataFileSystemBySystemSaveDataId
//   53 OpenReadOnlySaveDataFileSystem
//
//   u8 SaveDataSpaceId, 7 bytes padding, 0x40-byte SaveDataAttribute
//
// The attribute (switchbrew "Filesystem services#SaveDataAttribute"):
//   0x00 ReferenceId / ApplicationId   the game, or 0 for the system forms
//   0x08 UserId (16 bytes)             an account, or 0 for savecommon/device
//   0x18 StaticSaveDataId              system saves only
//   0x20 Type                          SaveDataType
//   0x21 Rank                          Primary 0 / Secondary 1
//   0x22 Index (u16)
//
// Games can own more than one archive: an Account save per user, a common
// Account save (uid 0), and Device/Bcat/Cache archives whose attribute is
// all-zero except Type (and possibly Index, for Cache).
const OFFSET = 8;
const SIZE = OFFSET + 0x40;

function build({space, referenceId, uid, type, rank = 0, index = 0, staticId = 0}) {
  if (!Buffer.isBuffer(uid) || uid.length !== 16) throw Error('uid must be 16 raw bytes');
  const input = Buffer.alloc(SIZE);
  input[0] = space;
  input.writeBigUInt64LE(BigInt(referenceId), OFFSET + 0x00);
  uid.copy(input, OFFSET + 0x08);
  input.writeBigUInt64LE(BigInt(staticId), OFFSET + 0x18);
  input[OFFSET + 0x20] = type;
  input[OFFSET + 0x21] = rank;
  input.writeUInt16LE(index, OFFSET + 0x22);
  return input;
}

// System and SystemBcat saves are opened by static id; everything a game owns
// through ReferenceId uses the generic open.
function openCommand(type) {
  return type === 0 || type === 6 ? 52 : 53;
}

// The archive candidates a sweep tries, in order. Account saves are addressed
// by user and then by common uid 0; Device/Bcat/Cache are all-zero except Type,
// so uid 0 goes first (and is the only candidate for --all, to avoid opening the
// same archive once per account).
function plan({spaces, types, ranks = [0], index = 0, staticId = 0, uids, all = false}) {
  const zero = Buffer.alloc(16);
  const withCommon = uids.some(uid => uid.equals(zero)) ? [...uids] : [...uids, zero];
  const candidates = [];
  for (const space of spaces) {
    for (const type of types) {
      for (const rank of ranks) {
        const list = type === 0 || type === 1
          ? withCommon
          : all ? [zero] : [zero, ...withCommon.filter(uid => !uid.equals(zero))];
        for (const uid of list) candidates.push({space, type, rank, index, staticId, uid});
      }
    }
  }
  return candidates;
}

module.exports = {build, openCommand, plan, OFFSET, SIZE};
