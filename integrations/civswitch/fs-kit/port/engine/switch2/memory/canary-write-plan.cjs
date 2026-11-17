'use strict';

function canaryWritePlan(target) {
  if (target?.name === 'gravcirc') {
    const writeSize = 0xF0000;
    return {writeSize, requiredSaveSpace: writeSize + 0x100000 + 0x10000};
  }
  const writeSize = 0x800000;
  return {writeSize, requiredSaveSpace: writeSize + 0x400000 + 0x10000};
}

module.exports = {canaryWritePlan};
