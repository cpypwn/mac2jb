const {performance} = require('node:perf_hooks');

const GEOMETRY_SIZES = Object.freeze([0x1000, 0x10000, 0x40000, 0x80000,
  0x100000, 0x400000, 0x800000]);

function selectedGeometrySizes(raw, required = false) {
  if (raw === undefined || raw === '') {
    if (required) throw Error('NS2_WRITE_SIZE_MAX must name an enumerated probe size');
    return GEOMETRY_SIZES;
  }
  if (!/^(?:0x[0-9a-f]+|[1-9][0-9]*)$/i.test(String(raw)))
    throw Error('NS2_WRITE_SIZE_MAX must name an enumerated probe size');
  const max = Number(raw);
  if (!GEOMETRY_SIZES.includes(max))
    throw Error('NS2_WRITE_SIZE_MAX must name an enumerated probe size');
  return GEOMETRY_SIZES.filter(size => size <= max);
}

async function removeEmptyScratch(name, actions) {
  if (!/^NS2_GAP_WSP_[0-9]+$/.test(name)) throw Error('Scratch path is not owned by this probe');
  const row = {name, path: '/' + name};
  try {
    row.type = await actions.statType();
    if (row.type !== 0) throw Error('Previous write-size scratch is not a directory');
    row.contents = await actions.listContents();
    if (row.contents.length !== 0) throw Error('Previous write-size scratch is not empty');
    row.deleteResult = await actions.deleteDir();
    if (row.deleteResult !== 0) throw Error('Previous empty write-size scratch could not be removed');
    row.commitResult = await actions.commitDelete();
    if (row.commitResult !== 0) throw Error('Previous empty write-size scratch removal did not commit');
    row.verifiedAbsent = await actions.verifyAbsent();
    if (!row.verifiedAbsent) throw Error('Previous write-size scratch remains after commit');
    return row;
  } catch (error) {
    error.scratchRow = row;
    throw error;
  }
}

async function probeGeometryFile(size, actions) {
  if (!GEOMETRY_SIZES.includes(size)) throw Error('Unsupported geometry probe size');
  const row = {size, commitTimingSource: 'Mac-side monotonic wall time'};
  const requireZero = (value, action) => {
    if (value !== 0) throw Error(`${action} failed at 0x${size.toString(16)}: 0x${Number(value).toString(16)}`);
  };
  let open = false;
  const now = actions.now || (() => performance.now());
  try {
    row.createResult = await actions.create(size);
    requireZero(row.createResult, 'Create');
    try {
      await actions.openWrite();
      open = true;
      const write = await actions.write(size);
      row.result = write.result;
      row.canonical = write.canonicalResult;
      requireZero(row.result, 'Write');
    } finally {
      if (open) {
        await actions.close();
        open = false;
        row.closed = 0;
      }
    }
    const writeCommitStarted = now();
    try {row.writeCommitResult = await actions.commitWrite();}
    finally {row.writeCommitMacWallMs = now() - writeCommitStarted;}
    requireZero(row.writeCommitResult, 'Write commit');
    if (size === 0x800000 || size === 0x80000) {
      row.readBack = await actions.readBack();
      requireZero(row.readBack.result, 'Read back');
      if (row.readBack.matches !== true) throw Error('Write-size tail differs after commit');
    }
    row.deleteResult = await actions.delete();
    requireZero(row.deleteResult, 'Delete');
    const deleteCommitStarted = now();
    try {row.commitResult = await actions.commitDelete();}
    finally {row.deleteCommitMacWallMs = now() - deleteCommitStarted;}
    requireZero(row.commitResult, 'Delete commit');
    return row;
  } catch (error) {
    error.probeRow = row;
    throw error;
  }
}

function verifiesBoundedWrite(proof, targetName, maxSize) {
  if (targetName !== 'gravcirc' || !GEOMETRY_SIZES.includes(maxSize) || maxSize > 0x80000)
    return false;
  const expected = selectedGeometrySizes(String(maxSize));
  return proof?.verified === true && proof.cleanedUp === true &&
    proof.scratchCreateCommitResult === 0 && proof.scratchDeleteResult === 0 &&
    proof.scratchCommitResult === 0 && proof.maxSize === maxSize &&
    proof.results?.length === expected.length && expected.every((size, index) => {
      const row = proof.results[index];
      return row?.size === size && row.createResult === 0 && row.result === 0 &&
        row.closed === 0 && row.writeCommitResult === 0 && row.deleteResult === 0 &&
        row.commitResult === 0 && row.commitTimingSource === 'Mac-side monotonic wall time' &&
        Number.isFinite(row.writeCommitMacWallMs) && row.writeCommitMacWallMs >= 0 &&
        Number.isFinite(row.deleteCommitMacWallMs) && row.deleteCommitMacWallMs >= 0;
    });
}

function verifiesGeometryWrite(proof, targetName) {
  if (targetName === 'gravcirc') {
    const candidate = proof?.results?.find(row => row.size === 0x80000);
    return verifiesBoundedWrite(proof, targetName, 0x80000) &&
      candidate?.readBack?.result === 0 && candidate.readBack.matches === true;
  }
  return proof?.verified === true && proof.cleanedUp === true &&
    proof.scratchDeleteResult === 0 && proof.scratchCommitResult === 0 &&
    proof.results?.some(row => row.size === 0x800000 && row.result === 0 &&
      row.readBack?.result === 0 && row.readBack.matches === true &&
      row.closed === 0 && row.deleteResult === 0 && row.commitResult === 0) === true;
}

module.exports = {GEOMETRY_SIZES, selectedGeometrySizes, removeEmptyScratch,
  probeGeometryFile, verifiesBoundedWrite, verifiesGeometryWrite};
