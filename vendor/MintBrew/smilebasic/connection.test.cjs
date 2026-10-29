const test = require('node:test');
const assert = require('node:assert/strict');
const {addresses, chooseHost, connectCommand, interfaceKind, describe} = require('./connection.cjs');

const interfaces = {
  lo: [{family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true}],
  enp3s0: [{family: 'IPv4', address: '192.168.1.50', netmask: '255.255.255.0', internal: false}],
  wlp2s0: [{family: 'IPv4', address: '192.168.1.51', netmask: '255.255.255.0', internal: false}],
  docker0: [{family: 'IPv4', address: '172.17.0.1', netmask: '255.255.0.0', internal: false}],
  tailscale0: [{family: 'IPv4', address: '100.64.0.2', netmask: '255.255.255.255', internal: false}],
  'br-abc123': [{family: 'IPv4', address: '172.18.0.1', netmask: '255.255.0.0', internal: false}],
};

test('lists physical LAN addresses before virtual ones', () => {
  assert.deepEqual(addresses(interfaces).map(entry => entry.address),
    ['192.168.1.50', '192.168.1.51', '172.18.0.1', '172.17.0.1']);
  assert.deepEqual(addresses(interfaces).map(entry => entry.kind),
    ['Ethernet', 'Wi-Fi', 'virtual', 'virtual']);
});

test('skips loopback, link-local and /32 addresses', () => {
  const list = addresses({
    lo: interfaces.lo,
    enp3s0: [{family: 'IPv4', address: '169.254.10.2', netmask: '255.255.0.0'}],
    tailscale0: interfaces.tailscale0,
  });
  assert.deepEqual(list, []);
});

test('an explicit address must be assigned to this computer', async () => {
  assert.equal(await chooseHost(['192.168.1.51'], interfaces), '192.168.1.51');
  await assert.rejects(() => chooseHost(['192.0.2.10'], interfaces), /not assigned to this computer/);
  await assert.rejects(() => chooseHost(['not-an-ip'], interfaces), /Usage/);
  await assert.rejects(() => chooseHost(['192.168.1.50', '192.168.1.51'], interfaces), /Usage/);
});

test('the only LAN address is chosen without prompting', async () => {
  assert.equal(await chooseHost([], {enp3s0: interfaces.enp3s0}), '192.168.1.50');
});

test('several addresses require a choice when not interactive', async () => {
  await assert.rejects(() => chooseHost([], interfaces, {interactive: false}),
    /Choose the computer address.*192\.168\.1\.50 \(enp3s0, Ethernet\)/s);
});

test('no LAN address gives a network hint', async () => {
  await assert.rejects(() => chooseHost([], {lo: interfaces.lo}, {interactive: false}),
    /same Wi-Fi or Ethernet network/);
});

test('interface labels and descriptions stay readable', () => {
  assert.equal(interfaceKind('enp4s0'), 'Ethernet');
  assert.equal(interfaceKind('wlo1'), 'Wi-Fi');
  assert.equal(interfaceKind('Wi-Fi'), 'Wi-Fi');
  assert.equal(interfaceKind('Ethernet 2'), 'Ethernet');
  assert.equal(interfaceKind('docker0'), 'virtual');
  assert.equal(describe({address: '192.168.1.50', interface: 'enp4s0', kind: 'Ethernet'}),
    '192.168.1.50 (enp4s0, Ethernet)');
});

test('the connection command contains the chosen address', () => {
  assert.equal(connectCommand('192.0.2.10'), 'V=START(39380,192,0,2,10,0,0,0,0)');
  assert.equal(connectCommand('10.0.0.5', [1, 2, 3, 4]), 'V=START(39380,10,0,0,5,1,2,3,4)');
});
