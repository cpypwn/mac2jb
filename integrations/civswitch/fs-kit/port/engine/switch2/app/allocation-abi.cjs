function allocationArgs(target, output, bytes) {
  return target.name === 'gravcirc' ? [output, bytes] : [output, 4096, bytes];
}

function freeArgs(target, address, bytes) {
  return target.name === 'gravcirc' ? [address, bytes] : [address, 0, 0];
}

module.exports = {allocationArgs, freeArgs};
