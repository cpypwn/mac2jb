const {performance} = require('node:perf_hooks');

const SIZE = 0x100000;
const CHUNK_SIZE = 0x80000;

function requireZero(value, operation) {
  if (value !== 0) throw Error(`${operation} failed: 0x${Number(value).toString(16)}`);
}

async function attemptSplitMiB(actions) {
  const now = actions.now || (() => performance.now());
  const row = {size: SIZE, chunkSize: CHUNK_SIZE,
    commitTimingSource: 'Mac-side monotonic wall time', chunks: []};
  try {
    const freeBytes = await actions.freeBytes();
    row.freeBytes = typeof freeBytes === 'bigint' ? freeBytes.toString() : null;
    if (typeof freeBytes !== 'bigint' || freeBytes < BigInt(SIZE))
      throw Error('Save free space is below the selected candidate');
    row.scratchCreateResult = await actions.createDirectory();
    requireZero(row.scratchCreateResult, 'Scratch directory create');
    row.scratchCreateCommitResult = await actions.commitDirectoryCreate();
    requireZero(row.scratchCreateCommitResult, 'Scratch directory create commit');
    row.createResult = await actions.createFile(SIZE);
    requireZero(row.createResult, 'Probe file create');
    row.createCommitResult = await actions.commitFileCreate();
    requireZero(row.createCommitResult, 'Probe file create commit');
    for (let index = 0; index < 2; index++) {
      const chunk = {index, offset: index * CHUNK_SIZE,
        size: CHUNK_SIZE, fill: index === 0 ? 0x66 : 0x77};
      row.chunks.push(chunk);
      let open = false;
      try {
        await actions.openWrite();
        open = true;
        chunk.writeResult = await actions.writeChunk(chunk.offset, chunk.size, chunk.fill);
        requireZero(chunk.writeResult, `Probe chunk ${index + 1} write`);
      } finally {
        if (open) {
          await actions.close();
          chunk.closed = true;
        }
      }
      const started = now();
      try {chunk.commitResult = await actions.commitWrite(index);}
      finally {chunk.commitMacWallMs = now() - started;}
      requireZero(chunk.commitResult, `Probe chunk ${index + 1} commit`);
      chunk.readBack = await actions.readBackChunk(chunk.offset, chunk.size, chunk.fill);
      requireZero(chunk.readBack.result, `Probe chunk ${index + 1} readback`);
      if (chunk.readBack.matches !== true)
        throw Error(`Committed probe chunk ${index + 1} differs from the written bytes`);
    }
    row.fileDeleteResult = await actions.deleteFile();
    requireZero(row.fileDeleteResult, 'Probe file delete');
    row.fileDeleteCommitResult = await actions.commitFileDelete();
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
    error.splitRow = row;
    throw error;
  }
}

function verifiesSplitMiB(proof, targetName) {
  const row = proof?.attempt;
  return targetName === 'gravcirc' && proof?.target === 'gravcirc' &&
    proof?.mode === 'split-mib' && proof.verified === true && proof.cleanedUp === true &&
    Array.isArray(proof.leftovers) && proof.leftovers.every(item => item.verifiedAbsent === true) &&
    row?.size === SIZE && row.chunkSize === CHUNK_SIZE &&
    /^\d+$/.test(String(row.freeBytes)) && BigInt(row.freeBytes) >= BigInt(SIZE) &&
    row.scratchCreateResult === 0 && row.scratchCreateCommitResult === 0 &&
    row.createResult === 0 && row.createCommitResult === 0 &&
    Array.isArray(row.chunks) && row.chunks.length === 2 &&
    row.chunks.every((chunk, index) => chunk.index === index &&
      chunk.offset === index * CHUNK_SIZE && chunk.size === CHUNK_SIZE &&
      chunk.fill === (index === 0 ? 0x66 : 0x77) && chunk.writeResult === 0 &&
      chunk.closed === true && chunk.commitResult === 0 &&
      chunk.readBack?.result === 0 && chunk.readBack.matches === true &&
      Array.isArray(chunk.readBack.samples) && chunk.readBack.samples.length === 2 &&
      chunk.readBack.samples.every((sample, sampleIndex) =>
        sample.offset === chunk.offset + (sampleIndex === 0 ? 0 : CHUNK_SIZE - 0x10) &&
        sample.matches === true) &&
      Number.isFinite(chunk.commitMacWallMs) && chunk.commitMacWallMs >= 0) &&
    row.fileDeleteResult === 0 && row.fileDeleteCommitResult === 0 &&
    row.fileVerifiedAbsent === true && row.directoryDeleteResult === 0 &&
    row.directoryDeleteCommitResult === 0 && row.verifiedAbsent === true;
}

module.exports = {SIZE, CHUNK_SIZE, attemptSplitMiB, verifiesSplitMiB};
