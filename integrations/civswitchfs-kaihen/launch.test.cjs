'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bridge = require('./launch.cjs');

const runtimeRoot = path.resolve(__dirname, '../..');

test('pinned runtime and SD assets verify without downloads', () => {
  bridge.verifyAssets(runtimeRoot);
  bridge.verifyAssets(runtimeRoot, {sd: true});
  const entries = bridge.readSdFiles(bridge.paths(runtimeRoot));
  assert.equal(entries.get('kaihen/bin/bootstrap.bin').length, 27948);
  assert.equal(entries.get('kaihen/bin/ro/main').length, 23854);
  assert.equal(entries.get('kaihen/bin/hen/main').length, 78765);
  assert.equal(entries.get('kaihen/bin/game/main').length, 63424);
  assert.equal(entries.get('hbmenu.nro').length, 11790974);
  assert.equal(entries.get('switch/ounceshell/ounceshell.nro').length, 22294859);
  assert.equal(entries.has('switch/kaihen-stremio/kaihen-stremio.nro'), false);
});

test('shared kaiHEN SD writer stages verified assets and preserves other files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-kaihen-sd-'));
  try {
    const entries = bridge.readSdFiles(bridge.paths(runtimeRoot));
    fs.writeFileSync(path.join(root, 'existing.txt'), 'keep');
    bridge.writeSdFolder(root, entries);
    assert.deepEqual(fs.readFileSync(path.join(root, 'kaihen/bin/bootstrap.bin')),
      entries.get('kaihen/bin/bootstrap.bin'));
    assert.equal(fs.existsSync(path.join(root, 'switch/kaihen-stremio')), false);
    assert.equal(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('SD folder writer preserves and backs up an existing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-civ-kaihen-'));
  let backup;
  try {
    fs.mkdirSync(path.join(root, 'kaihen', 'bin'), {recursive: true});
    fs.writeFileSync(path.join(root, 'kaihen', 'bin', 'bootstrap.bin'), 'older');
    const files = new Map([['kaihen/bin/bootstrap.bin', Buffer.from('newer')]]);
    backup = bridge.writeSdFolder(root, files, true);
    assert.equal(fs.readFileSync(path.join(root, 'kaihen/bin/bootstrap.bin'), 'utf8'), 'newer');
    assert.equal(fs.readFileSync(path.join(backup, 'kaihen/bin/bootstrap.bin'), 'utf8'), 'older');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
    if (backup) fs.rmSync(backup, {recursive: true, force: true});
  }
});

test('failed verified backup blocks persistent trigger transfer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-civ-kaihen-'));
  let calls = 0;
  try {
    await assert.rejects(
      bridge.install('10.0.0.91', runtimeRoot, async () => { calls++; return 'no backup'; }, {backupRoot: root}),
      /backup was not confirmed/
    );
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('verified backup precedes persistent trigger transfer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-civ-kaihen-'));
  const calls = [];
  try {
    const backup = await bridge.install('10.0.0.91', runtimeRoot, async (_host, code, _timeout, onLine) => {
      calls.push(code);
      if (code.includes('MAC2JB_CIV_BACKUP')) {
        onLine('MAC2JB_CIV_BACKUP BEGIN {"version":1,"directory":"save:/saves/Single","count":0,"chunkSize":512}');
        onLine('MAC2JB_CIV_BACKUP END {"count":0}');
        return 'Executed successfully\n';
      }
      if (code.includes('Installer ready.')) return 'Installer ready.\n';
      if (code.includes('stageChunk')) return code.match(/Template \d+\/\d+ received\./)?.[0] + '\n';
      if (code.includes('installFromTemplate')) return 'Installed. Restart the game, then open Load Game menu.\n';
      throw Error('Unexpected transfer');
    }, {backupRoot: root});
    assert.ok(fs.existsSync(path.join(backup, 'manifest.json')));
    assert.ok(calls[0].includes('MAC2JB_CIV_BACKUP'));
    assert.ok(calls.at(-1).includes('installFromTemplate'));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('one-shot chain only succeeds after HEN confirmation', async () => {
  await assert.rejects(
    bridge.runOnce('10.0.0.91', runtimeRoot, async (_host, _code, _timeout, onLine) => {
      onLine('CHAIN: promotion did not retain a session');
    }),
    /without confirming HEN/
  );
  await bridge.runOnce('10.0.0.91', runtimeRoot, async (_host, code, _timeout, onLine) => {
    assert.ok(Buffer.byteLength(code) < 500000);
    onLine('KH: === HEN IS RUNNING ===');
  });
});

test('chain progress follows actual upstream landmarks without invented stage counts', () => {
  assert.deepEqual(bridge.chainProgress('Preparing file-system access and save data...'),
    {phase: 'fs-preparation', message: 'Preparing filesystem access'});
  assert.deepEqual(bridge.chainProgress('Checking the canary window...'),
    {phase: 'canary', message: 'Checking the canary window'});
  assert.deepEqual(bridge.chainProgress('MEMORY ADDRESS VERIFIED'),
    {phase: 'memory-verified', message: 'Memory address verified'});
  assert.deepEqual(bridge.chainProgress('CHAIN: promotion retained a session — starting kaiHEN'),
    {phase: 'hen-starting', message: 'Starting kaiHEN'});
  assert.equal(bridge.chainProgress('KH: --- stage: loader-copy'), null);
});
