'use strict';

async function measureGeometryControl({wave, releasePin, attempts = 30}) {
  if (typeof wave !== 'function' || typeof releasePin !== 'function' ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 30)
    throw Error('Invalid bounded geometry control');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const row = await wave();
    if (row?.profile !== 'abort-control' || row.triggerAborted !== true ||
        row.nativeGuard?.completed !== 1 || row.restored !== true ||
        row.pinCostOk !== true || !Number.isInteger(row.newPersistentBytes) ||
        row.newPersistentBytes <= 0 || row.changedPaths?.length !== 0 ||
        row.canaryResult !== 0 || row.canaryType !== 1)
      throw Error('Native abort control or allocation restoration failed during geometry measurement');
    if (row.pinWindowOk === true && row.allPending === true)
      return {row, attempts: attempt};
    await releasePin(row);
  }
  throw Error(`Owned save requests did not overlap a measured pinning window in ${attempts} attempts`);
}

module.exports = {measureGeometryControl};
