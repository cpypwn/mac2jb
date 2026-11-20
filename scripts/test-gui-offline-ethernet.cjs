'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseHardwarePorts, processAlive, readStatus, requireStateDir, stateDir,
  renderDaemonPlist, daemonLabel, installedHelper
} = require('./gui-offline-ethernet.cjs');

test('root-owned live service is not misclassified as stale', () => {
  assert.equal(processAlive(321, () => { throw Object.assign(new Error('permission'), { code: 'EPERM' }); }), true);
  assert.equal(processAlive(321, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), false);
});

test('only physical Ethernet adapters are offered', () => {
  const ports = [
    'Hardware Port: Wi-Fi', 'Device: en0',
    'Hardware Port: USB 10/100/1000 LAN', 'Device: en7',
    'Hardware Port: Thunderbolt 1', 'Device: en8',
    'Hardware Port: Ethernet', 'Device: en2'
  ].join('\n');
  const adapters = parseHardwarePorts(ports, name =>
    'ether aa:bb:cc:dd:ee:ff\nstatus: ' + (name === 'en7' ? 'active' : 'inactive'));
  assert.deepEqual(adapters, [
    { interface: 'en2', label: 'Ethernet', active: false },
    { interface: 'en7', label: 'USB 10/100/1000 LAN', active: true }
  ]);
});

test('status distinguishes local self-check from real Switch requests', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-offline-ethernet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.run.lock'));
  fs.writeFileSync(path.join(dir, '.run.lock/pid'), String(process.pid));
  fs.writeFileSync(path.join(dir, 'network-original.txt'), 'en7\nMAC=aa:bb:cc:dd:ee:ff\n');
  fs.writeFileSync(path.join(dir, 'status.txt'), 'ready\nDirect Ethernet ready\n');
  fs.writeFileSync(path.join(dir, 'ethernet.log'), '2026-11-13 DNS/UDP 192.168.2.2 CTEST local\n');
  let status = readStatus(dir);
  assert.equal(status.phase, 'ready');
  assert.equal(status.switchSeen, false);
  assert.equal(status.connectionCheckPassed, false);
  assert.equal(status.needsRestore, true);
  fs.appendFileSync(path.join(dir, 'ethernet.log'),
    '2026-11-13 DNS/UDP 192.168.2.1 CTEST ctest.p01.ctest.srv.nintendo.net type=1\n' +
    '2026-11-13 HTTP 192.168.2.1 host=ctest.p01.ctest.srv.nintendo.net path=/ -> 200 CTEST OK\n');
  status = readStatus(dir);
  assert.equal(status.switchSeen, true);
  assert.equal(status.connectionCheckPassed, true);
  assert.match(status.lastSwitchRequest, /HTTP 192\.168\.2\.1/);
});

test('stale listener state still requires explicit restoration', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-offline-ethernet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'network-original.txt'), 'en9\nMAC=aa:bb:cc:dd:ee:ff\n');
  fs.writeFileSync(path.join(dir, 'status.txt'), 'ready\nReady\n');
  const status = readStatus(dir);
  assert.equal(status.phase, 'stale');
  assert.equal(status.needsRestore, true);
});

test('privileged commands cannot redirect state to an arbitrary path', () => {
  assert.equal(requireStateDir(stateDir), stateDir);
  assert.throws(() => requireStateDir('/tmp/offline'), /state directory/);
});

test('the responder is launched as a valid launchd job, not a backgrounded process', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-offline-ethernet-plist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'daemon.plist');
  fs.writeFileSync(file, renderDaemonPlist('en7'));
  const lint = childProcess.spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  const json = childProcess.spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.Label, daemonLabel);
  assert.equal(parsed.RunAtLoad, true);
  // KeepAlive must be false so a clean stop or an expected error exit does not restart-loop.
  assert.equal(parsed.KeepAlive, false);
  // The daemon runs helper.sh from the stable root-owned copy, with the hard-coded state dir.
  assert.deepEqual(parsed.ProgramArguments, ['/bin/bash', installedHelper, 'start', 'en7', stateDir]);
  assert.ok(installedHelper.startsWith('/Library/Application Support/mac2jb/'));
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function dnsQuery(name) {
  const labels = name.split('.').map(label => Buffer.concat([
    Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)
  ]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

async function askDns(port, name) {
  const socket = dgram.createSocket('udp4');
  try {
    const answer = new Promise((resolve, reject) => {
      socket.once('message', resolve);
      socket.once('error', reject);
    });
    await new Promise((resolve, reject) =>
      socket.send(dnsQuery(name), port, '127.0.0.1', error => error ? reject(error) : resolve()));
    return await Promise.race([answer, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DNS reply timed out')), 3000))]);
  } finally {
    socket.close();
  }
}

async function askHttp(port, name) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: name }, timeout: 3000 }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
}

test('loopback responder answers four connection checks and blocks other hosts', async t => {
  const responder = path.join(__dirname, '../integrations/offline-ethernet/Responder.pl');
  const dnsPort = await freePort();
  const httpPort = await freePort();
  const args = [responder, '--serve', '--ip', '127.0.0.1', '--peer', '127.0.0.1',
    '--dns-port', String(dnsPort), '--http-port', String(httpPort)];
  const server = childProcess.spawn('/usr/bin/perl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (!server.killed) server.kill('SIGTERM'); });
  let stderr = '';
  server.stderr.on('data', chunk => { stderr += chunk; });
  await Promise.race([
    new Promise((resolve, reject) => {
      server.stdout.on('data', chunk => {
        if (String(chunk).includes('LISTEN DNS')) resolve();
      });
      server.once('exit', code => reject(new Error(`Responder exited ${code}: ${stderr}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Responder did not listen')), 5000))
  ]);
  const names = [
    'ctest.p01.ctest.srv.nintendo.net',
    'ctest-ipv6.p01.ctest.srv.nintendo.net',
    'ctest.cdn.nintendo.net',
    'conntest.nintendowifi.net'
  ];
  for (const name of names) {
    const dns = await askDns(dnsPort, name);
    assert.equal(dns.readUInt16BE(2) & 15, 0, name);
    assert.equal(dns.readUInt16BE(6), 1, name);
    assert.equal(await askHttp(httpPort, name), 200, name);
  }
  const blocked = await askDns(dnsPort, 'example.com');
  assert.equal(blocked.readUInt16BE(2) & 15, 3);
  assert.equal(await askHttp(httpPort, 'example.com'), 404);
  server.kill('SIGTERM');
  const exitCode = await new Promise(resolve => server.once('exit', resolve));
  assert.equal(exitCode, 0);
});
