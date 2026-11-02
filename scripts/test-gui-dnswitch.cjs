#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {test} = require('node:test');
const {defaultHostname, cdnHostname, legacyHostname, parseOptions,
  validateAddress, validateHostname, validateRedirect, portalNames,
  parseQuestion, answerQuestion, routeQuestion, createTrafficLogger, dnsTraffic,
  privatePaths} = require('./gui-dnswitch.cjs');

function query(name, type = 1) {
  const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const packet = Buffer.alloc(12);
  packet.writeUInt16BE(0x1234, 0);
  packet.writeUInt16BE(0x0100, 2);
  packet.writeUInt16BE(1, 4);
  return Buffer.concat([packet, ...labels, Buffer.from([0, 0, type, 0, 1])]);
}

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-dnswitch-')));
  fs.chmodSync(directory, 0o700);
  const state = path.join(directory, 'state.json');
  const tokenFile = path.join(directory, 'token');
  fs.writeFileSync(state, '{}\n', {mode: 0o600});
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), {mode: 0o600});
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {directory, state, tokenFile};
}

async function waitForState(file, phase, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let current;
    try {current = JSON.parse(fs.readFileSync(file, 'utf8'));} catch {}
    if (current?.phase === phase) return current;
    if (current?.phase === 'failed') throw Error(current.message);
    if (child.exitCode !== null) throw Error('DNSwitch helper exited before ' + phase);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('DNSwitch helper never reached ' + phase);
}

function udpQuery(port, packet) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {socket.close(); reject(Error('DNS query timed out'));}, 1000);
    socket.once('message', response => {clearTimeout(timeout); socket.close(); resolve(response);});
    socket.once('error', error => {clearTimeout(timeout); socket.close(); reject(error);});
    socket.send(packet, port, '127.0.0.1');
  });
}

function webRequest(port, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port, path: '/', method, timeout: 1000}, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers,
        body: Buffer.concat(parts).toString()}));
    });
    request.once('error', reject);
    request.end();
  });
}

async function runHelper(t, redirect = '') {
  const files = fixture(t);
  const helper = path.join(__dirname, 'gui-dnswitch.cjs');
  const child = spawn(process.execPath, [helper, 'serve', '--address', '127.0.0.1',
    '--hostname', defaultHostname, '--url', redirect, '--state', files.state,
    '--token-file', files.tokenFile, '--dns-port', '0', '--http-port', '0'],
  {stdio: ['ignore', 'pipe', 'pipe']});
  let errors = '';
  child.stderr.on('data', part => {errors += part;});
  t.after(() => {if (child.exitCode === null) child.kill('SIGTERM');});
  const ready = await waitForState(files.state, 'ready', child);
  async function stop() {
    const result = spawnSync(process.execPath, [helper, 'stop', '--state', files.state,
      '--token-file', files.tokenFile], {encoding: 'utf8', timeout: 4000});
    assert.equal(result.status, 0, result.stderr);
    const stopped = await waitForState(files.state, 'stopped', child);
    assert.equal(stopped.reason, 'requested');
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(Error('DNSwitch helper did not exit: ' + errors)), 3000);
      child.once('exit', () => {clearTimeout(timer); resolve();});
    });
  }
  return {...files, ready, child, stop};
}

test('validates narrow address, hostname, redirect and command arguments', () => {
  assert.equal(validateAddress('192.168.1.40'), '192.168.1.40');
  for (const invalid of ['not-an-ip', '192.168.001.40', '224.0.0.1', '0.0.0.0'])
    assert.throws(() => validateAddress(invalid));
  assert.equal(validateHostname(defaultHostname), defaultHostname);
  for (const invalid of ['bad..name', 'Upper.example', '-bad.example', 'bad_.example'])
    assert.throws(() => validateHostname(invalid));
  assert.equal(validateRedirect('https://example.org/path'), 'https://example.org/path');
  for (const invalid of ['file:///etc/passwd', 'https://user:pass@example.org/',
    'javascript:alert(1)', 'https://example.org/\nheader: value'])
    assert.throws(() => validateRedirect(invalid));
  const options = parseOptions(['serve', '--address', '127.0.0.1', '--state', '/tmp/a',
    '--token-file', '/tmp/b']);
  assert.equal(options.hostname, defaultHostname);
  assert.equal(options.dnsPort, 53);
  assert.equal(options.httpPort, 80);
  assert.throws(() => parseOptions(['serve', '--address', '127.0.0.1', '--state', '/tmp/a',
    '--token-file', '/tmp/b', '--bad', 'value']));
});

test('answers only exact Nintendo connection names and rejects malformed DNS packets', () => {
  const accepted = portalNames(defaultHostname);
  for (const name of [defaultHostname, cdnHostname, legacyHostname]) {
    const packet = query(name);
    assert.equal(parseQuestion(packet).name, name);
    const response = answerQuestion(packet, '192.168.1.40', accepted);
    assert.equal(response.readUInt16BE(0), 0x1234);
    assert.equal(response.readUInt16BE(6), 1);
    assert.deepEqual([...response.subarray(-4)], [192, 168, 1, 40]);
  }
  const other = answerQuestion(query('example.com'), '192.168.1.40', accepted);
  assert.equal(other, null);
  const aaaa = answerQuestion(query(defaultHostname, 28), '192.168.1.40', accepted);
  assert.equal(aaaa.readUInt16BE(2) & 0x000f, 0);
  assert.equal(aaaa.readUInt16BE(6), 0);
  const pointer = query(defaultHostname);
  pointer[12] = 0xc0;
  assert.equal(answerQuestion(pointer, '192.168.1.40', accepted), null);
  assert.equal(answerQuestion(Buffer.alloc(12), '192.168.1.40', accepted), null);
  assert.equal(answerQuestion(Buffer.alloc(1233), '192.168.1.40', accepted), null);
});

test('non-portal DNS names return NXDOMAIN without upstream queries', () => {
  const names = portalNames(defaultHostname);
  const local = routeQuestion(query(defaultHostname), '192.168.1.40', names);
  assert.deepEqual([...local.subarray(-4)], [192, 168, 1, 40]);
  const unknown = routeQuestion(query('example.com'), '192.168.1.40', names);
  assert.equal(unknown.readUInt16BE(2) & 0x000f, 3);
  assert.equal(unknown.readUInt16BE(6), 0);
  assert.equal(unknown.readUInt16BE(4), 1);
});

test('traffic log is bounded and redacts non-Nintendo domains', () => {
  const lines = [];
  const record = createTrafficLogger(line => lines.push(line), 2);
  const names = portalNames(defaultHostname);
  for (const name of ['private.example', 'api.p01.lp1.tabiji.srv.nintendo.net', 'third.example']) {
    const packet = query(name);
    record(dnsTraffic(parseQuestion(packet), routeQuestion(packet, '192.168.1.40', names)));
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"name":"other"/);
  assert.doesNotMatch(lines[0], /private\.example/);
  assert.match(lines[1], /api\.p01\.lp1\.tabiji\.srv\.nintendo\.net/);
  assert.doesNotMatch(lines.join(''), /third\.example/);
});

test('private state and token must be owned regular files', async t => {
  const f = fixture(t);
  await privatePaths(f.state, f.tokenFile);
  fs.chmodSync(f.tokenFile, 0o644);
  await assert.rejects(privatePaths(f.state, f.tokenFile), /0600 token/);
  fs.chmodSync(f.tokenFile, 0o600);
  fs.rmSync(f.state);
  fs.symlinkSync(f.tokenFile, f.state);
  await assert.rejects(privatePaths(f.state, f.tokenFile), /0600 regular file/);
});

test('local DNS and portal serve, then authenticated stop exits the helper', async t => {
  const f = await runHelper(t);
  assert.equal(f.ready.address, '127.0.0.1');
  assert.ok(f.ready.dnsPort > 0 && f.ready.httpPort > 0 && f.ready.controlPort > 0);
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
  const dns = await udpQuery(f.ready.dnsPort, query(defaultHostname));
  assert.deepEqual([...dns.subarray(-4)], [127, 0, 0, 1]);
  const unknown = await udpQuery(f.ready.dnsPort, query('example.com'));
  assert.equal(unknown.readUInt16BE(2) & 0x000f, 3);
  const web = await webRequest(f.ready.httpPort);
  assert.equal(web.status, 200);
  assert.match(web.body, /<h1>cpypwn<\/h1>/);
  assert.match(web.body, /@keyframes one/);
  assert.match(web.body, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(web.body, /<script\b/);
  assert.equal((await webRequest(f.ready.httpPort, 'POST')).status, 405);
  const unauthorized = await new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port: f.ready.controlPort,
      path: '/stop', method: 'POST'}, response => {response.resume(); response.on('end', () => resolve(response.statusCode));});
    request.once('error', reject);
    request.end();
  });
  assert.equal(unauthorized, 403);
  await f.stop();
});

test('configured research URL waits on the splash until cpypwn is opened', async t => {
  const f = await runHelper(t, 'https://example.org/test?a=1&b=2');
  const web = await webRequest(f.ready.httpPort);
  assert.equal(web.status, 200);
  assert.equal(web.headers.location, undefined);
  assert.match(web.body, /<h1><a href="https:\/\/example\.org\/test\?a=1&amp;b=2" aria-label="Open research page">cpypwn<\/a><\/h1>/);
  assert.match(web.body, /@keyframes one/);
  await f.stop();
});

test('AppleScript launcher keeps DNSwitch alive after osascript exits',
  {skip: process.platform !== 'darwin'}, async t => {
    const f = fixture(t);
    const source = fs.readFileSync(path.join(__dirname, 'dnswitch-launch.applescript'), 'utf8');
    assert.match(source, /trap '' HUP;/);
    assert.doesNotMatch(source, /\bnohup\b/);
    const unprivileged = source.replace('do shell script commandText with administrator privileges',
      'do shell script commandText');
    assert.notEqual(unprivileged, source);
    const launcher = path.join(f.directory, 'launcher.applescript');
    fs.writeFileSync(launcher, unprivileged);
    const helperDirectory = path.join(f.directory, 'helper with spaces');
    fs.mkdirSync(helperDirectory);
    const helper = path.join(helperDirectory, 'service.cjs');
    fs.writeFileSync(helper,
      'const fs = require("node:fs");\n' +
      'const file = process.argv[process.argv.indexOf("--state") + 1];\n' +
      'fs.writeFileSync(file, JSON.stringify({phase:"ready",pid:process.pid}));\n' +
      'setInterval(() => {}, 1000);\n');
    const launch = spawnSync('osascript', [launcher, process.execPath, helper,
      '127.0.0.1', defaultHostname, '', f.state, f.tokenFile],
    {encoding: 'utf8', timeout: 5000});
    assert.equal(launch.status, 0, launch.stderr);
    let pid;
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const state = JSON.parse(fs.readFileSync(f.state, 'utf8'));
        if (state.phase === 'ready') {pid = state.pid; break;}
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(Number.isInteger(pid), 'detached service did not report ready');
      assert.doesNotThrow(() => process.kill(pid, 0));
    } finally {
      if (pid) process.kill(pid, 'SIGTERM');
    }
  });
