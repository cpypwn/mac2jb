#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');

const ids = Object.freeze(['runtime', 'media', 'network', 'boundaries',
  'fonts', 'webkit', 'fontenv']);
const files = Object.freeze(['manifest.json', 'index.html', 'style.css', 'probes.js']);
const bundledSource = path.resolve(__dirname, '../integrations/browser-probes');

function check(ok, message) { if (!ok) throw Error(message); }
function emit(type, fields = {}) {
  process.stdout.write('MAC2JB_BROWSER ' + JSON.stringify({type, ...fields}) + '\n');
}

function options(argv) {
  const args = [...argv];
  const command = args.shift();
  check(command === '--self-test' || command === 'serve',
    'Usage: gui-bundled-browser-probes.cjs --self-test | serve --address IP --probe ID --reports DIRECTORY [--source DIRECTORY] [--port PORT]');
  if (command === '--self-test') {
    check(args.length === 0, 'Self-test takes no options.');
    return {command};
  }
  const value = {command, source: bundledSource, port: '8765'};
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    check(['--address', '--probe', '--reports', '--source', '--port'].includes(flag) &&
      args.length && !seen.has(flag), 'Unknown, duplicate or incomplete browser probe option.');
    seen.add(flag);
    value[flag.slice(2)] = args.shift();
  }
  check(net.isIP(value.address) === 4, 'Choose a Mac IPv4 address.');
  check(ids.includes(value.probe), 'Choose one of the seven bundled browser probes.');
  check(typeof value.reports === 'string' && path.isAbsolute(value.reports) &&
    value.reports.length <= 4096 && path.resolve(value.reports) === value.reports,
  'Choose an absolute report folder.');
  check(typeof value.source === 'string' && path.isAbsolute(value.source) &&
    value.source.length <= 4096 && path.resolve(value.source) === value.source,
  'Choose an absolute probe source folder.');
  check(/^(0|[1-9][0-9]{0,4})$/.test(value.port) &&
    Number(value.port) <= 65535, 'Choose a port from 0 to 65535.');
  return value;
}

async function inspectSource(folder) {
  const root = await fs.lstat(folder);
  check(root.isDirectory() && !root.isSymbolicLink(), 'Probe source must be a regular folder.');
  const assets = {};
  for (const name of files) {
    const file = path.join(folder, name);
    const stat = await fs.lstat(file).catch(() => null);
    check(stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0 &&
      stat.size <= 256 * 1024, 'A bundled probe file is missing or invalid: ' + name);
    assets[name] = await fs.readFile(file);
  }
  const manifest = JSON.parse(assets['manifest.json'].toString('utf8'));
  check(manifest.version === 1 && Array.isArray(manifest.probes) &&
    manifest.probes.length === ids.length, 'The bundled probe catalog is invalid.');
  check(manifest.probes.every((item, index) =>
    item?.id === ids[index] && typeof item.title === 'string' &&
    item.title.length > 0 && item.title.length <= 50 &&
    typeof item.description === 'string' &&
    item.description.length > 0 && item.description.length <= 160),
  'The bundled probe catalog is invalid.');
  return {assets, manifest};
}

async function prepareReports(folder) {
  await fs.mkdir(folder, {recursive: true, mode: 0o700});
  const stat = await fs.lstat(folder);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'The report path must be a regular folder.');
}

function respond(response, code, type, body) {
  response.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});
  response.end(body);
}

function receiveJSON(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) {
        request.destroy();
        reject(Error('Report exceeds the size limit.'));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Error('Invalid report JSON.')); }
    });
    request.once('error', reject);
  });
}

async function serve(value) {
  const {assets} = await inspectSource(value.source);
  await prepareReports(value.reports);
  const token = crypto.randomBytes(16).toString('hex');
  const root = '/' + token + '/';
  let count = 0;
  const server = http.createServer(async (request, response) => {
    try {
      check(typeof request.url === 'string' && request.url.length <= 2048,
        'Invalid request path.');
      const url = new URL(request.url, 'http://localhost');
      if (!url.pathname.startsWith(root)) {
        respond(response, 404, 'text/plain; charset=utf-8', 'Not found');
        return;
      }
      const route = url.pathname.slice(root.length);
      if (request.method === 'GET') {
        const name = route === '' ? 'index.html' : route;
        if (name === 'ping') {
          respond(response, 200, 'application/json; charset=utf-8',
            JSON.stringify({ok: true}));
          return;
        }
        if (Object.hasOwn(assets, name)) {
          const type = name.endsWith('.html') ? 'text/html; charset=utf-8' :
            name.endsWith('.css') ? 'text/css; charset=utf-8' :
            name.endsWith('.js') ? 'text/javascript; charset=utf-8' :
            'application/json; charset=utf-8';
          respond(response, 200, type, assets[name]);
          return;
        }
      }
      if (request.method === 'POST' && route === 'report' &&
          request.headers['content-type']?.split(';')[0] === 'application/json') {
        if (count >= 100) {
          respond(response, 429, 'application/json; charset=utf-8',
            JSON.stringify({error: 'Report limit reached'}));
          return;
        }
        const report = await receiveJSON(request);
        check(report && typeof report === 'object' && !Array.isArray(report) &&
          ids.includes(report.probe) && typeof report.timestamp === 'string' &&
          report.timestamp.length <= 40 && typeof report.userAgent === 'string' &&
          report.userAgent.length <= 300 && report.result &&
          typeof report.result === 'object' && !Array.isArray(report.result),
        'Invalid browser report.');
        const now = new Date().toISOString();
        const name = now.replace(/[:.]/g, '-') + '-' + report.probe + '-' +
          crypto.randomBytes(4).toString('hex') + '.json';
        const payload = JSON.stringify({receivedAt: now, ...report}, null, 2) + '\n';
        await fs.writeFile(path.join(value.reports, name), payload,
          {flag: 'wx', mode: 0o600});
        count++;
        respond(response, 201, 'application/json; charset=utf-8',
          JSON.stringify({saved: true}));
        return;
      }
      respond(response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      if (!response.headersSent) respond(response, 400,
        'application/json; charset=utf-8',
        JSON.stringify({error: String(error.message).slice(0, 160)}));
    }
  });
  server.requestTimeout = 6000;
  server.headersTimeout = 6000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(value.port), value.address, resolve);
  });
  const port = server.address().port;
  const url = 'http://' + value.address + ':' + port + root +
    '?probe=' + value.probe;
  emit('ready', {url, reportFolder: value.reports, probe: value.probe});
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections?.();
    server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const timer = setTimeout(stop, 30 * 60 * 1000);
  timer.unref();
  await new Promise(resolve => server.once('close', resolve));
  clearTimeout(timer);
  emit('stopped', {probe: value.probe});
}

async function main() {
  const value = options(process.argv.slice(2));
  if (value.command === '--self-test') {
    await inspectSource(bundledSource);
    process.stdout.write('Bundled browser probes self-test passed.\n');
  } else await serve(value);
}

if (require.main === module) main().catch(error => {
  emit('failed', {message: String(error.message).slice(0, 512)});
  process.exitCode = 1;
});

module.exports = {ids, files, bundledSource, options, inspectSource, serve};
