'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const jellyfin = require('./gui-civswitch-jellyfin.cjs');

const root = path.resolve(__dirname, '..');

test('bundled package has the pinned identity and rejects changed bytes', async () => {
  const pin = jellyfin.verifyPin();
  const bundled = await jellyfin.readBundled(root);
  assert.equal(bundled.package.id, 'jellyfin-civswitch');
  assert.equal(bundled.package.metadata.release, '0.0.1');
  const changed = Buffer.from(await fs.readFile(bundled.file));
  changed[changed.length - 2] ^= 1;
  assert.throws(() => jellyfin.inspectPackage(changed, pin), /checksum/);
});

test('install sends the bundled package only after launcher availability', async () => {
  const requests = [];
  const options = {
    probe: async () => ({state: {busy: false, mode: 'launcher', closed: false}, entries: []}),
    request: async (_address, operation) => {
      requests.push(operation);
      return {entry: {id: 'jellyfin-civswitch', name: 'Jellyfin'}};
    }
  };
  const result = await jellyfin.install(root, '192.168.1.20', options);
  assert.equal(result.entry.id, 'jellyfin-civswitch');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].op, 'install');
  assert.equal(requests[0].package.id, 'jellyfin-civswitch');
  requests.length = 0;
  await assert.rejects(jellyfin.install(root, '192.168.1.20', {
    ...options, probe: async () => ({state: {busy: true, mode: 'app', closed: false}, entries: []})
  }), /Return to the CivHomebrew launcher/);
  assert.equal(requests.length, 0);
});

test('launch requires the installed package and verifies the response', async () => {
  const requests = [];
  const options = {
    probe: async () => ({state: {busy: false, mode: 'launcher', closed: false}, entries: []}),
    request: async (_address, operation) => {
      requests.push(operation);
      return {state: 'accepted', name: 'Jellyfin'};
    }
  };
  await assert.rejects(jellyfin.launch('192.168.1.20', options), /Install Jellyfin/);
  assert.equal(requests.length, 0);
  await jellyfin.launch('192.168.1.20', {
    ...options, probe: async () => ({state: {busy: false, mode: 'launcher', closed: false},
      entries: [{id: 'jellyfin-civswitch'}]})
  });
  assert.deepEqual(requests, [{op: 'run', id: 'jellyfin-civswitch'}]);
});

test('self-test checks the bundled package and notices offline', async () => {
  const events = [];
  await jellyfin.main(['--self-test', root], {emit: (type, fields) => events.push({type, ...fields})});
  assert.equal(events.at(-1).type, 'self-test');
});
