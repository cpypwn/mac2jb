function fileReadOptions(address, size) {
  return {receive: [{address, size, mode: 1}]};
}

module.exports = {fileReadOptions};
