#!/usr/bin/env node
'use strict';

process.umask(0o077);

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const defaultHostname = 'ctest.p01.ctest.srv.nintendo.net';
const cdnHostname = 'ctest.cdn.nintendo.net';
const legacyHostname = 'conntest.nintendowifi.net';
const maximumDurationMs = 30 * 60 * 1000;

function check(condition, message) {
  if (!condition) throw Error(message);
}

function parseOptions(argv) {
  const command = argv.shift();
  check(['serve', 'stop', 'status', '--self-test'].includes(command),
    'Usage: gui-dnswitch.cjs serve|stop|status [--address IP] [--hostname HOST] [--url URL] --state FILE --token-file FILE');
  if (command === '--self-test') {
    check(argv.length === 0, 'The self-test takes no options.');
    return {command};
  }
  const allowed = command === 'serve'
    ? new Set(['address', 'hostname', 'url', 'state', 'token-file', 'dns-port', 'http-port'])
    : new Set(['state', 'token-file']);
  const options = {command};
  while (argv.length) {
    const flag = argv.shift();
    check(flag?.startsWith('--') && allowed.has(flag.slice(2)) && argv.length,
      'Unknown or incomplete DNSwitch option: ' + flag);
    const key = flag.slice(2);
    check(options[key] === undefined, 'Duplicate DNSwitch option: ' + flag);
    options[key] = argv.shift();
  }
  check(options.state && options['token-file'], 'DNSwitch requires --state and --token-file.');
  if (command === 'serve') {
    check(options.address, 'DNSwitch requires a Mac LAN IPv4 address.');
    options.hostname ??= defaultHostname;
    options.url ??= '';
    options['dns-port'] ??= '53';
    options['http-port'] ??= '80';
    options.address = validateAddress(options.address);
    options.hostname = validateHostname(options.hostname);
    options.url = validateRedirect(options.url);
    options.dnsPort = validatePort(options['dns-port']);
    options.httpPort = validatePort(options['http-port']);
  }
  return options;
}

function validateAddress(address) {
  check(typeof address === 'string' && net.isIP(address) === 4,
    'Choose an IPv4 address assigned to this Mac.');
  const bytes = address.split('.').map(Number);
  check(bytes.length === 4 && bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
    bytes.join('.') === address && bytes[0] !== 0 && bytes[0] < 224 &&
    address !== '255.255.255.255', 'Choose a usable Mac LAN IPv4 address.');
  return address;
}

function validateHostname(hostname) {
  check(typeof hostname === 'string' && hostname.length <= 253 && hostname.length > 0 &&
    hostname === hostname.toLowerCase() && /^[a-z0-9.-]+$/.test(hostname) &&
    hostname.split('.').every(label => label.length > 0 && label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
  'The captive portal hostname is invalid.');
  return hostname;
}

function validateRedirect(value) {
  if (value === '') return '';
  check(typeof value === 'string' && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value),
    'Enter a valid HTTP or HTTPS redirect URL.');
  let url;
  try { url = new URL(value); } catch { throw Error('Enter a valid HTTP or HTTPS redirect URL.'); }
  check(['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password,
    'Enter a valid HTTP or HTTPS redirect URL without credentials.');
  return url.href;
}

function validatePort(value) {
  check(typeof value === 'string' && /^(0|[1-9]\d{0,4})$/.test(value), 'Invalid network port.');
  const port = Number(value);
  check(port <= 65535, 'Invalid network port.');
  return port;
}

function portalNames(hostname) {
  return new Set([hostname, defaultHostname, cdnHostname, legacyHostname]);
}

function parseQuestion(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 17 || packet.length > 1232) return null;
  const flags = packet.readUInt16BE(2);
  if ((flags & 0xf800) !== 0 || (flags & 0x0200) !== 0 || packet.readUInt16BE(4) !== 1 ||
    packet.readUInt16BE(6) !== 0 || packet.readUInt16BE(8) !== 0 || packet.readUInt16BE(10) > 1) return null;
  let offset = 12;
  let nameLength = 0;
  const labels = [];
  for (;;) {
    if (offset >= packet.length) return null;
    const length = packet[offset++];
    if (length === 0) break;
    if (length > 63 || offset + length > packet.length || nameLength + length + 1 > 253) return null;
    const label = packet.subarray(offset, offset + length).toString('ascii');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) return null;
    labels.push(label.toLowerCase());
    nameLength += length + 1;
    offset += length;
  }
  if (!labels.length || offset + 4 > packet.length) return null;
  const type = packet.readUInt16BE(offset);
  const questionClass = packet.readUInt16BE(offset + 2);
  offset += 4;
  if (packet.readUInt16BE(10) === 0 && offset !== packet.length) return null;
  return {name: labels.join('.'), type, questionClass, flags, end: offset};
}

function answerQuestion(packet, address, names = portalNames(defaultHostname)) {
  const question = parseQuestion(packet);
  if (!question || !names.has(question.name)) return null;
  const isAddressQuestion = question.type === 1 && question.questionClass === 1;
  const answer = isAddressQuestion;
  const response = Buffer.alloc(question.end + (answer ? 16 : 0));
  packet.copy(response, 0, 0, question.end);
  response.writeUInt16BE(0x8400 | (question.flags & 0x0100), 2);
  response.writeUInt16BE(answer ? 1 : 0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  if (answer) {
    let offset = question.end;
    response.writeUInt16BE(0xc00c, offset); offset += 2;
    response.writeUInt16BE(1, offset); offset += 2;
    response.writeUInt16BE(1, offset); offset += 2;
    response.writeUInt32BE(60, offset); offset += 4;
    response.writeUInt16BE(4, offset); offset += 2;
    for (const octet of address.split('.')) response[offset++] = Number(octet);
  }
  return response;
}

function nameErrorAnswer(packet, question) {
  const response = Buffer.from(packet.subarray(0, question.end));
  response.writeUInt16BE(0x8003 | (question.flags & 0x0100), 2);
  response.writeUInt16BE(0, 6);
  response.writeUInt16BE(0, 8);
  response.writeUInt16BE(0, 10);
  return response;
}

function routeQuestion(packet, address, names) {
  const question = parseQuestion(packet);
  if (!question) return null;
  if (names.has(question.name)) return answerQuestion(packet, address, names);
  return nameErrorAnswer(packet, question);
}

function createTrafficLogger(write = line => process.stdout.write(line), limit = 200) {
  let count = 0;
  return event => {
    if (count >= limit) return;
    count += 1;
    write('MAC2JB_DNSWITCH ' + JSON.stringify({at: new Date().toISOString(), ...event}) + '\n');
  };
}

function dnsTraffic(question, reply) {
  const name = /(?:^|\.)(?:nintendo|nintendowifi)\.net$/.test(question.name)
    ? question.name : 'other';
  return {type: 'dns', name, qtype: question.type, rcode: reply.readUInt16BE(2) & 15};
}

async function privatePaths(statePath, tokenPath) {
  check(path.isAbsolute(statePath) && path.isAbsolute(tokenPath) &&
    path.normalize(statePath) === statePath && path.normalize(tokenPath) === tokenPath &&
    path.dirname(statePath) === path.dirname(tokenPath) && statePath !== tokenPath,
  'DNSwitch state and token files must be in the same private absolute directory.');
  const directory = path.dirname(statePath);
  const info = await fs.lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
    await fs.realpath(directory) === directory &&
    (info.uid === process.getuid() || process.getuid() === 0),
  'DNSwitch requires a private session directory owned by the app user.');
  const tokenInfo = await fs.lstat(tokenPath);
  check(tokenInfo.isFile() && !tokenInfo.isSymbolicLink() && tokenInfo.uid === info.uid &&
    (tokenInfo.mode & 0o077) === 0 && tokenInfo.size === 64,
  'DNSwitch requires an owned 0600 token file.');
  const token = (await fs.readFile(tokenPath, 'utf8')).trim();
  check(/^[0-9a-f]{64}$/.test(token), 'DNSwitch token is invalid.');
  try {
    const stateInfo = await fs.lstat(statePath);
    check(stateInfo.isFile() && !stateInfo.isSymbolicLink() && stateInfo.uid === info.uid &&
      (stateInfo.mode & 0o077) === 0,
    'DNSwitch state file must be an owned 0600 regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {directory, owner: info.uid, group: info.gid, statePath, token};
}

async function writeState(paths, value) {
  check(process.getuid() === paths.owner, 'DNSwitch must write state as the app user.');
  const temporary = path.join(paths.directory, '.dnswitch-state-' + crypto.randomBytes(8).toString('hex'));
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
    await fs.rename(temporary, paths.statePath);
  } finally {
    await fs.rm(temporary, {force: true}).catch(() => {});
  }
}

function dropPrivileges(paths) {
  if (process.getuid() !== 0 || paths.owner === 0) return;
  process.setgroups([paths.group]);
  process.setgid(paths.group);
  process.setuid(paths.owner);
  check(process.getuid() === paths.owner, 'DNSwitch could not drop administrator privileges.');
}

function handlePortal(redirect, record = () => {}) {
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      record({type: 'http', method: 'OTHER', status: 405});
      response.writeHead(405, {'allow': 'GET, HEAD'}).end();
      return;
    }
    record({type: 'http', method: request.method, status: 200});
    const link = redirect
      ? `<a href="${redirect.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}" aria-label="Open research page">cpypwn</a>`
      : 'cpypwn';
    const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#061711">
<title>cpypwn</title>
<style>
  html,body{width:100%;height:100%;margin:0;overflow:hidden}
  body{background:#061711;color:#effff6;font-family:system-ui,-apple-system,sans-serif}
  .scene{position:fixed;inset:0;overflow:hidden;background:radial-gradient(ellipse at 50% 55%,#143629 0%,#09221b 43%,#061711 80%)}
  .scene:after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 30%,rgba(0,0,0,.38) 100%);pointer-events:none}
  .orb{position:absolute;display:block;opacity:.53;border:1px solid rgba(255,255,255,.13);box-shadow:inset 0 0 3vmin rgba(255,255,255,.12),0 0 7vmin rgba(86,252,182,.12);will-change:transform,border-radius,background-color}
  .orb.one{width:46vmin;height:43vmin;left:4%;top:4%;animation:one 13s ease-in-out infinite alternate}
  .orb.two{width:39vmin;height:48vmin;right:1%;top:3%;animation:two 16s ease-in-out infinite alternate}
  .orb.three{width:43vmin;height:39vmin;left:14%;bottom:-17%;animation:three 14s ease-in-out infinite alternate}
  .orb.four{width:32vmin;height:34vmin;right:17%;bottom:-11%;animation:four 18s ease-in-out infinite alternate}
  .ring{position:absolute;display:block;width:63vmin;height:63vmin;left:50%;top:50%;margin:-31.5vmin;border:1px solid rgba(152,255,207,.2);border-radius:44% 56% 62% 38%/54% 40% 60% 46%;box-shadow:0 0 4vmin rgba(100,255,184,.12),inset 0 0 3vmin rgba(100,255,184,.09);animation:ring 24s linear infinite;pointer-events:none}
  .ring.inner{width:48vmin;height:48vmin;margin:-24vmin;border-color:rgba(255,255,255,.1);animation-duration:19s;animation-direction:reverse}
  main{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:1rem;z-index:1;text-align:center}
  h1{margin:0;color:#f2fff7;font-size:clamp(3.8rem,15vw,10rem);font-weight:800;letter-spacing:.035em;line-height:1;text-shadow:0 0 .22em rgba(164,255,207,.6),0 0 .8em rgba(76,244,173,.3);animation:glow 7s ease-in-out infinite alternate}
  h1 a{color:inherit;text-decoration:none}
  h1 a:focus-visible{outline:2px solid #9fffc9;outline-offset:.12em;border-radius:.08em}
  @keyframes one{0%{transform:translate(-5%,-8%) rotate(-18deg);border-radius:44% 56% 37% 63%/58% 36% 64% 42%;background-color:#42e6aa}50%{background-color:#5986e8}100%{transform:translate(42%,25%) rotate(62deg);border-radius:62% 38% 54% 46%/41% 65% 35% 59%;background-color:#ad76d8}}
  @keyframes two{0%{transform:translate(14%,-5%) rotate(22deg);border-radius:63% 37% 48% 52%/45% 61% 39% 55%;background-color:#ba6dd0}50%{background-color:#f29a73}100%{transform:translate(-46%,37%) rotate(-55deg);border-radius:39% 61% 65% 35%/61% 38% 62% 39%;background-color:#59d9bc}}
  @keyframes three{0%{transform:translate(-12%,8%) rotate(30deg);border-radius:40% 60% 59% 41%/52% 34% 66% 48%;background-color:#e3a35e}50%{background-color:#77a7e8}100%{transform:translate(58%,-40%) rotate(-50deg);border-radius:58% 42% 37% 63%/39% 63% 37% 61%;background-color:#48df9d}}
  @keyframes four{0%{transform:translate(12%,5%) rotate(-25deg);border-radius:58% 42% 64% 36%/42% 56% 44% 58%;background-color:#6a9ce8}50%{background-color:#72e6b0}100%{transform:translate(-54%,-38%) rotate(65deg);border-radius:37% 63% 43% 57%/64% 39% 61% 36%;background-color:#d77cb6}}
  @keyframes ring{to{transform:rotate(360deg)}}
  @keyframes glow{to{text-shadow:0 0 .3em rgba(193,255,222,.8),0 0 1.1em rgba(89,170,255,.38)}}
  @media(prefers-reduced-motion:reduce){.orb,.ring,h1{animation:none}}
</style>
<div class="scene" aria-hidden="true">
  <span class="orb one"></span><span class="orb two"></span>
  <span class="orb three"></span><span class="orb four"></span>
  <span class="ring"></span><span class="ring inner"></span>
</div>
<main><h1>${link}</h1></main>
</html>`;
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(page), 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'});
    response.end(request.method === 'HEAD' ? undefined : page);
  };
}

function authenticated(request, token) {
  const candidate = request.headers.authorization;
  if (typeof candidate !== 'string' || !/^Bearer [0-9a-f]{64}$/.test(candidate)) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate.slice(7)), Buffer.from(token));
}

async function listenHttp(server, port, address) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {server.removeListener('error', reject); resolve();});
  });
  return server.address().port;
}

async function listenDns(server, port, address) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.bind(port, address, () => {server.removeListener('error', reject); resolve();});
  });
  return server.address().port;
}

function closeHttp(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function closeDns(server) {
  return new Promise(resolve => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

async function serve(options) {
  const paths = await privatePaths(options.state, options['token-file']);
  const names = portalNames(options.hostname);
  const dns = dgram.createSocket('udp4');
  const recordTraffic = createTrafficLogger();
  const portal = http.createServer(handlePortal(options.url, recordTraffic));
  const control = http.createServer();
  portal.headersTimeout = 5000;
  portal.requestTimeout = 5000;
  control.headersTimeout = 5000;
  control.requestTimeout = 5000;
  let closing;
  let timeout;
  let state;
  async function stop(reason = 'stopped') {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(timeout);
      await Promise.all([closeHttp(control), closeHttp(portal), closeDns(dns)]);
      await writeState(paths, {...state, phase: 'stopped', reason, stoppedAt: new Date().toISOString()});
    })();
    return closing;
  }
  control.on('request', (request, response) => {
    if (request.method !== 'POST' || request.url !== '/stop' || !authenticated(request, paths.token)) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, {'content-type': 'application/json'}).end('{"stopping":true}');
    setImmediate(() => {stop('requested').catch(error => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });});
  });
  dns.on('message', (packet, remote) => {
    const reply = routeQuestion(packet, options.address, names);
    if (reply && !closing) {
      const question = parseQuestion(packet);
      if (question) recordTraffic(dnsTraffic(question, reply));
      dns.send(reply, remote.port, remote.address, () => {});
    }
  });
  try {
    const controlPort = await listenHttp(control, 0, '127.0.0.1');
    const httpPort = await listenHttp(portal, options.httpPort, options.address);
    const dnsPort = await listenDns(dns, options.dnsPort, options.address);
    dropPrivileges(paths);
    const startedAt = new Date();
    state = {phase: 'ready', address: options.address, hostname: options.hostname,
      acceptedHostnames: [...names], dnsPort, httpPort, controlPort, pid: process.pid,
      startedAt: startedAt.toISOString(), expiresAt: new Date(startedAt.getTime() + maximumDurationMs).toISOString()};
    await writeState(paths, state);
    timeout = setTimeout(() => {stop('timeout').catch(error => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });}, maximumDurationMs);
    process.once('SIGTERM', () => {stop('signal').catch(() => {process.exitCode = 1;});});
    process.once('SIGINT', () => {stop('signal').catch(() => {process.exitCode = 1;});});
    process.stdout.write(JSON.stringify(state) + '\n');
    return {state, stop};
  } catch (error) {
    await Promise.all([closeHttp(control), closeHttp(portal), closeDns(dns)]);
    dropPrivileges(paths);
    await writeState(paths, {phase: 'failed', message: error.message, failedAt: new Date().toISOString()});
    throw error;
  }
}

async function readState(paths) {
  const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'));
  check(state && typeof state === 'object' && !Array.isArray(state), 'DNSwitch state is invalid.');
  return state;
}

async function stop(options) {
  const paths = await privatePaths(options.state, options['token-file']);
  const state = await readState(paths);
  check(state.phase === 'ready' && Number.isSafeInteger(state.controlPort) &&
    state.controlPort > 0 && state.controlPort <= 65535, 'DNSwitch is not running.');
  await new Promise((resolve, reject) => {
    const request = http.request({hostname: '127.0.0.1', port: state.controlPort, path: '/stop',
      method: 'POST', headers: {authorization: 'Bearer ' + paths.token}, timeout: 3000}, response => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve() : reject(Error('DNSwitch rejected stop request.')));
    });
    request.once('timeout', () => request.destroy(Error('DNSwitch stop timed out.')));
    request.once('error', reject);
    request.end();
  });
  return {stopping: true};
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions([...argv]);
  if (options.command === '--self-test') {
    const hostname = validateHostname(defaultHostname);
    const ip = validateAddress('192.168.1.42');
    check(portalNames(hostname).has(legacyHostname) && ip === '192.168.1.42', 'DNSwitch self-test failed.');
    process.stdout.write('DNSwitch self-test passed.\n');
    return;
  }
  if (options.command === 'serve') return serve(options);
  const paths = await privatePaths(options.state, options['token-file']);
  if (options.command === 'status') {
    const state = await readState(paths);
    process.stdout.write(JSON.stringify(state) + '\n');
    return state;
  }
  const result = await stop(options);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});

module.exports = {defaultHostname, cdnHostname, legacyHostname, maximumDurationMs, parseOptions,
  validateAddress, validateHostname, validateRedirect, portalNames, parseQuestion,
  answerQuestion, nameErrorAnswer, routeQuestion, createTrafficLogger, dnsTraffic,
  privatePaths, handlePortal, serve, stop, main};
