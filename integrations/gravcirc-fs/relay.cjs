const net = require('node:net');

function validateEndpoint(ip, port, label) {
  if (typeof ip !== 'string' || net.isIP(ip) !== 4) {
    throw new TypeError(`${label} must be an IPv4 address`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${label} port must be between 1 and 65535`);
  }
}

function relay({ switchIp, macIp, bridgePort = 39380, hostPort = 39380,
                 connectTimeoutMs = 15000, signal = null }) {
  validateEndpoint(switchIp, bridgePort, 'Switch bridge');
  validateEndpoint(macIp, hostPort, 'Mac FS listener');
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new RangeError('connect timeout must be a positive integer');
  }
  if (signal?.aborted) return Promise.reject(new Error('Gravity Circuit relay stopped'));

  return new Promise((resolve, reject) => {
    const switchSocket = net.createConnection({
      host: switchIp, port: bridgePort, localAddress: macIp,
    });
    const hostSocket = net.createConnection({ host: macIp, port: hostPort });
    const bytes = { toHost: 0, toSwitch: 0 };
    let switchConnected = false;
    let hostConnected = false;
    let started = false;
    let settled = false;
    let switchClosed = false;
    let hostClosed = false;
    const timer = setTimeout(() => fail(new Error('Gravity Circuit relay connection timed out')),
      connectTimeoutMs);
    const abort = () => fail(new Error('Gravity Circuit relay stopped'));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      switchSocket.destroy();
      hostSocket.destroy();
      reject(error);
    }

    function maybeStart() {
      if (!switchConnected || !hostConnected || started || settled) return;
      started = true;
      clearTimeout(timer);
      switchSocket.setNoDelay(true);
      hostSocket.setNoDelay(true);
      switchSocket.setKeepAlive(true);
      hostSocket.setKeepAlive(true);
      switchSocket.pipe(hostSocket);
      hostSocket.pipe(switchSocket);
    }

    function maybeFinish() {
      if (!switchClosed || !hostClosed || settled) return;
      if (!started || bytes.toHost < 128) {
        fail(new Error('Gravity Circuit relay ended before the 128-byte FS greeting'));
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(bytes);
    }

    switchSocket.on('connect', () => { switchConnected = true; maybeStart(); });
    hostSocket.on('connect', () => { hostConnected = true; maybeStart(); });
    switchSocket.on('data', (chunk) => { bytes.toHost += chunk.length; });
    hostSocket.on('data', (chunk) => { bytes.toSwitch += chunk.length; });
    switchSocket.on('error', fail);
    hostSocket.on('error', fail);
    switchSocket.on('close', () => { switchClosed = true; maybeFinish(); });
    hostSocket.on('close', () => { hostClosed = true; maybeFinish(); });
  });
}

async function main() {
  const [switchIp, macIp, bridgeText, hostText] = process.argv.slice(2);
  if (!switchIp || !macIp || process.argv.length > 6) {
    process.stderr.write('usage: node relay.cjs <switch-ipv4> <mac-ipv4> [bridge-port] [host-port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await relay({
      switchIp,
      macIp,
      bridgePort: bridgeText === undefined ? 39380 : Number(bridgeText),
      hostPort: hostText === undefined ? 39380 : Number(hostText),
    });
    process.stdout.write(`Gravity Circuit FS relay closed: ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { relay };
