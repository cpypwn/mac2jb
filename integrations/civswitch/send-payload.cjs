'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

async function sendPayload(address, file, options = {}) {
  if (!net.isIPv4(address)) throw Error('Enter the Switch IPv4 address.');
  if (path.extname(file).toLowerCase() !== '.js') throw Error('Choose a JavaScript .js file.');
  const port = options.port ?? 9026;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw Error('Invalid CivSwitch loader connection settings.');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > 480000) {
    throw Error('Choose a nonempty JavaScript file smaller than 480 KB.');
  }
  const script = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(script, 'utf8') !== stat.size) {
    throw Error('The JavaScript file must be UTF-8 text.');
  }
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({host: address, port, allowHalfOpen: true});
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(Error('The CivSwitch loader response timed out.')));
    socket.once('connect', () => socket.end(script));
    socket.on('data', bytes => {
      size += bytes.length;
      if (size > 1024 * 1024) return finish(Error('The CivSwitch loader response was too large.'));
      chunks.push(bytes);
    });
    socket.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    socket.once('error', error => finish(Error('CivSwitch loader connection failed: ' + (error.code || error.message))));
  });
  const lines = response.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => line.startsWith('Error in payload:') || line.startsWith('EXCEPTION:'))) {
    throw Error(lines.find(line => line.startsWith('Error in payload:') || line.startsWith('EXCEPTION:')));
  }
  if (!lines.includes('Executed successfully')) {
    throw Error('The CivSwitch loader did not confirm JavaScript execution.');
  }
  return response;
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2) throw Error('usage: node send-payload.cjs SWITCH_IPV4 PAYLOAD.js');
  const emit = (type, fields) => process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type, ...fields}) + '\n');
  emit('payload-sending', {message: 'Sending ' + path.basename(args[1]) + ' to the CivSwitch loader'});
  const response = await sendPayload(args[0], args[1]);
  for (const line of response.split(/\r?\n/).filter(Boolean)) {
    process.stdout.write(line + '\n');
  }
  emit('payload-ready', {message: 'CivSwitch confirmed JavaScript execution'});
}

if (require.main === module) main().catch(error => {
  process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type: 'failed', message: error.message}) + '\n');
  process.exitCode = 1;
});

module.exports = {sendPayload};
