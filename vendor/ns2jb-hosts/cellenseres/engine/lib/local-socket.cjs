// Use named pipes on Windows and filesystem sockets on POSIX.
const path = require('node:path');

const isPipe = value => typeof value === 'string' && value.startsWith('\\\\');

function endpoint(directory, name = 'memory.sock') {
  if (process.platform === 'win32')
    return '\\\\.\\pipe\\ns2-' + path.basename(directory) + '-' + name.replace(/[^A-Za-z0-9]/g, '');
  return path.join(directory, name);
}

// Only filesystem sockets need chmod and unlink.
const isFileSocket = value => !isPipe(value);

module.exports = {endpoint, isPipe, isFileSocket};
