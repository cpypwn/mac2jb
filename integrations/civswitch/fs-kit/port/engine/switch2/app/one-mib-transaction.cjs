const {performance} = require('node:perf_hooks');

const SIZE = 0x100000;
const SIZES = Object.freeze([0xA0000, 0xC0000, 0xE0000, 0xF0000, 0x100000, 0x200000]);
const MAX_OLD_FILE = 0x1000000;

function parseOneShotSize(raw) {
  if (raw === undefined || raw === '' || raw === '1m') return SIZE;
  if (raw === '2m') return 0x200000;
  if (raw === '640k') return 0xA0000;
  if (raw === '768k') return 0xC0000;
  if (raw === '896k') return 0xE0000;
  if (raw === '960k') return 0xF0000;
  if (!/^[1-9][0-9]*$/.test(String(raw)) || !SIZES.includes(Number(raw)))
    throw Error('One-shot save write size must be 640k, 768k, 1m, or 2m');
  return Number(raw);
}

function requireZero(value, operation) {
  if (value !== 0) throw Error(`${operation} failed: 0x${Number(value).toString(16)}`);
}

async function clearOwnedScratch(name, actions) {
  if (!/^NS2_GAP_WSP_[0-9]+$/.test(name)) throw Error('Scratch path is not owned by this probe');
  const row = {name, path: `/${name}`};
  try {
    row.type = await actions.statType();
    if (row.type !== 0) throw Error('Owned scratch path is not a directory');
    row.contents = await actions.listContents();
    if (row.contents.length > 1 || row.contents.some(item =>
      item.name !== 'probe_data' || item.type !== 1 ||
      !Number.isSafeInteger(Number(item.size)) || Number(item.size) < 0 ||
      Number(item.size) > MAX_OLD_FILE))
      throw Error('Owned scratch contains an unexpected entry');
    if (row.contents.length === 1) {
      row.fileDeleteResult = await actions.deleteFile();
      requireZero(row.fileDeleteResult, 'Old probe file delete');
      row.fileCommitResult = await actions.commitFileDelete();
      requireZero(row.fileCommitResult, 'Old probe file delete commit');
      row.fileVerifiedAbsent = await actions.verifyFileAbsent();
      if (!row.fileVerifiedAbsent) throw Error('Old probe file remains after delete commit');
    }
    row.directoryDeleteResult = await actions.deleteDirectory();
    requireZero(row.directoryDeleteResult, 'Old probe directory delete');
    row.directoryCommitResult = await actions.commitDirectoryDelete();
    requireZero(row.directoryCommitResult, 'Old probe directory delete commit');
    row.verifiedAbsent = await actions.verifyDirectoryAbsent();
    if (!row.verifiedAbsent) throw Error('Old probe directory remains after delete commit');
    return row;
  } catch (error) {
    error.scratchRow = row;
    throw error;
  }
}

async function attemptOneMiB(actions, size = SIZE) {
  if (!SIZES.includes(size)) throw Error('One-shot save write size must be 1m or 2m');
  const row = {size, commitTimingSource: 'Mac-side monotonic wall time'};
  const now = actions.now || (() => performance.now());
  let open = false;
  try {
    const freeBytes = await actions.freeBytes();
    row.freeBytes = typeof freeBytes === 'bigint' ? freeBytes.toString() : null;
    if (typeof freeBytes !== 'bigint' || freeBytes < BigInt(size))
      throw Error('Save free space is below the selected candidate');
    row.scratchCreateResult = await actions.createDirectory();
    requireZero(row.scratchCreateResult, 'Scratch directory create');
    row.scratchCreateCommitResult = await actions.commitDirectoryCreate();
    requireZero(row.scratchCreateCommitResult, 'Scratch directory create commit');
    row.createResult = await actions.createFile(size);
    requireZero(row.createResult, 'Probe file create');
    await actions.openWrite();
    open = true;
    try {
      row.writeResult = await actions.write(size);
      requireZero(row.writeResult, 'Probe file write');
    } finally {
      if (open) {
        await actions.close();
        open = false;
        row.closed = true;
      }
    }
    const writeStarted = now();
    try {row.writeCommitResult = await actions.commitWrite();}
    finally {row.writeCommitMacWallMs = now() - writeStarted;}
    requireZero(row.writeCommitResult, 'Probe file write commit');
    row.readBack = await actions.readBack();
    requireZero(row.readBack.result, 'Probe file readback');
    if (row.readBack.matches !== true) throw Error('Committed probe file differs from the written bytes');
    row.fileDeleteResult = await actions.deleteFile();
    requireZero(row.fileDeleteResult, 'Probe file delete');
    const fileDeleteStarted = now();
    try {row.fileDeleteCommitResult = await actions.commitFileDelete();}
    finally {row.fileDeleteCommitMacWallMs = now() - fileDeleteStarted;}
    requireZero(row.fileDeleteCommitResult, 'Probe file delete commit');
    row.fileVerifiedAbsent = await actions.verifyFileAbsent();
    if (!row.fileVerifiedAbsent) throw Error('Probe file remains after delete commit');
    row.directoryDeleteResult = await actions.deleteDirectory();
    requireZero(row.directoryDeleteResult, 'Probe directory delete');
    row.directoryDeleteCommitResult = await actions.commitDirectoryDelete();
    requireZero(row.directoryDeleteCommitResult, 'Probe directory delete commit');
    row.verifiedAbsent = await actions.verifyDirectoryAbsent();
    if (!row.verifiedAbsent) throw Error('Probe directory remains after delete commit');
    return row;
  } catch (error) {
    error.retryRow = row;
    throw error;
  }
}

function verifiesOneMiBRetry(proof, targetName, expectedSize = SIZE) {
  const row = proof?.attempt;
  return SIZES.includes(expectedSize) && targetName === 'gravcirc' && proof?.mode === 'one-mib-retry' &&
    proof.verified === true && proof.cleanedUp === true &&
    Array.isArray(proof.leftovers) && proof.leftovers.every(item => item.verifiedAbsent === true) &&
    row?.size === expectedSize && /^\d+$/.test(String(row.freeBytes)) &&
    BigInt(row.freeBytes) >= BigInt(expectedSize) &&
    row.scratchCreateResult === 0 && row.scratchCreateCommitResult === 0 &&
    row.createResult === 0 && row.writeResult === 0 && row.closed === true &&
    row.writeCommitResult === 0 && row.readBack?.result === 0 && row.readBack.matches === true &&
    row.fileDeleteResult === 0 && row.fileDeleteCommitResult === 0 &&
    row.fileVerifiedAbsent === true && row.directoryDeleteResult === 0 &&
    row.directoryDeleteCommitResult === 0 && row.verifiedAbsent === true &&
    row.commitTimingSource === 'Mac-side monotonic wall time' &&
    Number.isFinite(row.writeCommitMacWallMs) && row.writeCommitMacWallMs >= 0;
}

module.exports = {SIZE, SIZES, parseOneShotSize, clearOwnedScratch,
  attemptOneMiB, verifiesOneMiBRetry};
