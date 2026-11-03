'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');

const run = promisify(execFile);
const script = path.join(__dirname, 'gui-bundled-browser-probes.cjs');
const {ids, bundledSource, options, inspectSource} =
  require('./gui-bundled-browser-probes.cjs');

test('bundled catalog lists seven original bounded probes', async () => {
  const source = await inspectSource(bundledSource);
  assert.deepEqual(source.manifest.probes.map(item => item.id), ids);
  for (const name of ['index.html', 'style.css', 'probes.js', 'manifest.json'])
    assert.ok(source.assets[name].length > 0);
  await run(process.execPath, ['--check',
    path.join(bundledSource, 'probes.js')]);
  const selfTest = await run(process.execPath, [script, '--self-test']);
  assert.match(selfTest.stdout, /self-test passed/);
});

test('probe arguments require bounded choices and absolute local paths', () => {
  const good = options(['serve', '--address', '127.0.0.1', '--probe', 'runtime',
    '--reports', '/tmp/browser-reports']);
  assert.equal(good.port, '8765');
  assert.throws(() => options(['serve', '--address', 'bad', '--probe', 'runtime',
    '--reports', '/tmp/reports']), /IPv4/);
  assert.throws(() => options(['serve', '--address', '127.0.0.1', '--probe', 'other',
    '--reports', '/tmp/reports']), /seven bundled/);
  assert.throws(() => options(['serve', '--address', '127.0.0.1', '--probe', 'runtime',
    '--reports', 'relative']), /absolute report/);
  assert.throws(() => options(['serve', '--address', '127.0.0.1', '--probe', 'runtime',
    '--reports', '/tmp/reports', '--port', '65536']), /port/);
});

test('local page serves selected probe and keeps reports private', async t => {
  const reports = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-browser-reports-'));
  t.after(() => fs.rm(reports, {recursive: true, force: true}));
  const child = spawn(process.execPath, [script, 'serve', '--address', '127.0.0.1',
    '--probe', 'media', '--reports', reports, '--port', '0'],
  {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => {if (child.exitCode === null) child.kill('SIGTERM');});
  const url = await new Promise((resolve, reject) => {
    let lines = '';
    const timer = setTimeout(() => reject(Error('Browser page did not become ready')), 3000);
    child.stdout.on('data', bytes => {
      lines += bytes.toString('utf8');
      for (;;) {
        const newline = lines.indexOf('\n');
        if (newline === -1) break;
        const line = lines.slice(0, newline);
        lines = lines.slice(newline + 1);
        if (!line.startsWith('MAC2JB_BROWSER ')) continue;
        const event = JSON.parse(line.slice('MAC2JB_BROWSER '.length));
        if (event.type === 'ready') {
          clearTimeout(timer);
          assert.equal(event.probe, 'media');
          assert.equal(event.reportFolder, reports);
          resolve(event.url);
        } else if (event.type === 'failed') {
          clearTimeout(timer);
          reject(Error(event.message));
        }
      }
    });
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {
      clearTimeout(timer);
      reject(Error('Browser page closed before readiness: ' + code));
    });
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/\?probe=media$/);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Browser probes/);
  const base = url.slice(0, url.indexOf('?'));
  const manifest = await fetch(new URL('manifest.json', base));
  assert.equal(manifest.status, 200);
  assert.deepEqual((await manifest.json()).probes.map(item => item.id), ids);
  const javascript = await fetch(new URL('probes.js', base));
  assert.equal(javascript.status, 200);
  assert.match(await javascript.text(), /function probeMedia/);
  const ping = await fetch(new URL('ping', base));
  assert.deepEqual(await ping.json(), {ok: true});
  const report = await fetch(new URL('report', base), {method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({probe: 'media', timestamp: new Date().toISOString(),
      userAgent: 'fixture', result: {h264: 'maybe'}})});
  assert.equal(report.status, 201);
  const names = await fs.readdir(reports);
  assert.equal(names.length, 1);
  assert.match(names[0], /-media-[a-f0-9]{8}\.json$/);
  const stored = JSON.parse(await fs.readFile(path.join(reports, names[0]), 'utf8'));
  assert.equal(stored.result.h264, 'maybe');
  assert.equal((await fs.stat(path.join(reports, names[0]))).mode & 0o777, 0o600);
  assert.equal((await fetch('http://127.0.0.1:' + new URL(url).port + '/report')).status, 404);
  child.kill('SIGTERM');
  const closed = await new Promise(resolve => child.once('close',
    (code, signal) => resolve({code, signal})));
  assert.equal(closed.code, 0);
});
