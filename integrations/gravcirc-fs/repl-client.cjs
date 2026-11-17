const net = require('node:net');

const DEFAULT_PORT = 9026;
const MAX_REQUEST_BYTES = 32768;
const MAX_REPLY_BYTES = 65536;

function executeLua({ host, port = DEFAULT_PORT, source, timeoutMs = 15000 }) {
  if (net.isIP(host) !== 4) throw new TypeError('host must be an IPv4 address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('port must be between 1 and 65535');
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('source must be a nonempty Lua chunk');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  const request = Buffer.from(source, 'utf8');
  if (request.length > MAX_REQUEST_BYTES) {
    throw new RangeError(`Lua chunk exceeds ${MAX_REQUEST_BYTES} bytes`);
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket({ allowHalfOpen: true });
    const reply = [];
    let replyBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Gravity Circuit REPL timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }

    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => {
      replyBytes += chunk.length;
      if (replyBytes > MAX_REPLY_BYTES) {
        fail(new Error(`Gravity Circuit REPL reply exceeds ${MAX_REPLY_BYTES} bytes`));
        return;
      }
      reply.push(chunk);
    });
    socket.on('end', () => finish(Buffer.concat(reply).toString('utf8')));
    socket.on('error', fail);
    socket.on('close', () => {
      if (!settled) fail(new Error('Gravity Circuit REPL closed without a reply'));
    });
    socket.connect({ host, port });
  });
}

module.exports = {
  DEFAULT_PORT,
  MAX_REQUEST_BYTES,
  MAX_REPLY_BYTES,
  executeLua,
};
