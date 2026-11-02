'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const placeholder = '__MAC2JB_CIV_HELLO_NONCE__';

function payload(marker) {
  const source = fs.readFileSync(path.join(__dirname, 'hello.js'), 'utf8');
  if (source.split(placeholder).length !== 2 || Buffer.byteLength(source) > 32768) {
    throw Error('The CivSwitch demo payload is invalid.');
  }
  return source.replace(placeholder, marker);
}

async function sendHello(address, options = {}) {
  if (!net.isIPv4(address)) throw Error('Enter the Switch IPv4 address.');
  const port = options.port ?? 9026;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw Error('Invalid CivSwitch demo connection settings.');
  }
  const marker = 'mac2jb-civ-hello-' + crypto.randomBytes(16).toString('hex');
  const script = payload(marker);
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({host: address, port, allowHalfOpen: true});
    const chunks = [];
    let size = 0;
    let done = false;
    let deadline;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    deadline = setTimeout(() => finish(Error('The CivSwitch demo response timed out.')), timeoutMs);
    socket.setTimeout(timeoutMs, () => finish(Error('The CivSwitch demo response timed out.')));
    socket.once('connect', () => socket.end(script));
    socket.on('data', bytes => {
      size += bytes.length;
      if (size > 131072) return finish(Error('The CivSwitch demo response was too large.'));
      chunks.push(bytes);
    });
    socket.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    socket.once('error', error => finish(Error('CivSwitch demo connection failed: ' + (error.code || error.message))));
  });
  const lines = response.split(/\r?\n/).map(line => line.trim());
  const errorLine = lines.find(line => line.startsWith('Error in payload:'));
  if (errorLine) throw Error(errorLine);
  if (!lines.includes(marker) || !lines.includes('Executed successfully')) {
    throw Error('The CivSwitch loader did not confirm the cpypwn demo.');
  }
  return {address, port};
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw Error('usage: node send-hello.cjs SWITCH_IPV4');
  const emit = (type, fields) => process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type, ...fields}) + '\n');
  emit('demo-sending', {message: 'Sending the cpypwn display to the CivSwitch loader'});
  await sendHello(args[0]);
  emit('demo-ready', {message: 'The cpypwn display is running on the Switch'});
}

if (require.main === module) main().catch(error => {
  process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type: 'failed', message: error.message}) + '\n');
  process.exitCode = 1;
});

module.exports = {payload, sendHello};
