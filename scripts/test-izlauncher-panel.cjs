'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readPanel, verifyPanelEvent} = require('./izlauncher-panel.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-panel-')));
  const runs = path.join(root, 'runs');
  fs.mkdirSync(runs, {mode: 0o700});
  const directory = fs.mkdtempSync(path.join(runs, 'izlauncher-'));
  const file = path.join(directory, 'pc-screen-local.json');
  const url = 'http://127.0.0.1:53674/#' + 'a'.repeat(48);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, directory, file, url};
}

test('only the active private IZlauncher run can provide a local panel URL', t => {
  const f = fixture(t);
  assert.equal(readPanel(f.root, f.directory), null);
  fs.writeFileSync(f.file, JSON.stringify({url: f.url, port: 53674}), {mode: 0o600});
  const panel = {path: f.directory, url: f.url};
  assert.deepEqual(readPanel(f.root, f.directory), panel);
  assert.deepEqual(verifyPanelEvent(f.root, panel), panel);
  assert.throws(() => verifyPanelEvent(f.root, {...panel, url: f.url.replace('a', 'b')}), /does not match/);
  assert.throws(() => verifyPanelEvent(f.root, {...panel, path: f.directory + '/..'}), /Invalid IZlauncher run directory/);
});

test('invalid or public panel reports cannot reach the GUI', t => {
  const f = fixture(t);
  for (const [url, port] of [
    ['https://127.0.0.1:53674/#' + 'a'.repeat(48), 53674],
    ['http://localhost:53674/#' + 'a'.repeat(48), 53674],
    ['http://127.0.0.1:53674/?x=1#' + 'a'.repeat(48), 53674],
    ['http://127.0.0.1:53674/#' + 'a'.repeat(48), 53675],
    ['http://127.0.0.1:65536/#' + 'a'.repeat(48), 65536]
  ]) {
    fs.writeFileSync(f.file, JSON.stringify({url, port}), {mode: 0o600});
    assert.throws(() => readPanel(f.root, f.directory), /Invalid local panel address/);
  }
  fs.writeFileSync(f.file, JSON.stringify({url: f.url, port: 53674}));
  fs.chmodSync(f.file, 0o644);
  assert.throws(() => readPanel(f.root, f.directory), /Invalid local panel report/);
  fs.unlinkSync(f.file);
  fs.symlinkSync(path.join(f.root, 'target.json'), f.file);
  assert.throws(() => readPanel(f.root, f.directory), /Invalid local panel report/);
});
