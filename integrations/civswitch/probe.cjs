'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

async function probe(address, options = {}) {
  if (!net.isIPv4(address)) throw Error('Enter the Switch IPv4 address.');
  const port = options.port ?? 9026;
  const waitMs = options.waitMs ?? 90000;
  const attemptMs = options.attemptMs ?? 10000;
  const intervalMs = options.intervalMs ?? 2000;
  const emit = options.emit ?? (() => {});
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CivSwitch loader port.');
  const marker = 'mac2jb-civswitch-' + crypto.randomBytes(16).toString('hex');
  const script = 'log(' + JSON.stringify(marker) + ');';
  const deadline = Date.now() + waitMs;
  while (true) {
    emit('probe-wait', {message: 'Waiting for the CivSwitch loader on ' + address + ':' + port});
    const result = await new Promise(resolve => {
      let settled = false;
      const socket = net.createConnection({host: address, port, allowHalfOpen: true});
      const chunks = [];
      let size = 0;
      const finish = value => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(attemptMs, () => finish({error: 'timeout'}));
      socket.once('connect', () => socket.end(script));
      socket.on('data', bytes => {
        size += bytes.length;
        if (size > 65536) return finish({error: 'response-too-large'});
        chunks.push(bytes);
      });
      socket.once('end', () => finish({response: Buffer.concat(chunks).toString('utf8')}));
      socket.once('error', error => finish({error: error.code || 'connection-error'}));
    });
    if (result.response !== undefined) {
      const lines = result.response.split(/\r?\n/).map(line => line.trim());
      if (lines.includes(marker) && lines.includes('Executed successfully')) {
        emit('loader-ready', {message: 'CivSwitch Remote JS Loader verified on ' + address + ':' + port});
        return {address, port, marker};
      }
      throw Error('A service answered on port ' + port + ', but it did not confirm the CivSwitch loader probe.');
    }
    if (!['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'timeout'].includes(result.error))
      throw Error('CivSwitch loader probe failed: ' + result.error);
    if (Date.now() + intervalMs >= deadline) throw Error('The CivSwitch loader did not answer on port ' + port + '. Check the Switch IP and chat payload result.');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw Error('usage: node probe.cjs SWITCH_IPV4');
  const emit = (type, fields) => process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type, ...fields}) + '\n');
  await probe(args[0], {emit});
}

if (require.main === module) main().catch(error => {
  process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type: 'failed', message: error.message}) + '\n');
  process.exitCode = 1;
});

module.exports = {probe};
