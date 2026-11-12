'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const adapter = path.join(__dirname, 'gui-webkit-research.cjs');
const {moduleNames, requiredFiles, options, inspect} = require('./gui-webkit-research.cjs');

async function fixture(t, script = 'print("ready")\n') {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-webkit-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  for (const name of requiredFiles)
    await fs.writeFile(path.join(folder, name), name.endsWith('.py') ? script : 'fixture\n');
  return folder;
}

test('adapter accepts a complete local source and lists all bounded modules', async t => {
  const folder = await fixture(t);
  const result = await inspect(folder);
  assert.deepEqual(result.modules, moduleNames);
  assert.equal(result.folder, folder);
  const output = await run(process.execPath, [adapter, 'inspect', '--folder', folder]);
  assert.match(output.stdout, /MAC2JB_WEBKIT .*"type":"source"/);
  assert.match(output.stdout, /"webkit"/);
});

test('adapter rejects incomplete or symlinked selected research files', async t => {
  const folder = await fixture(t);
  await fs.rm(path.join(folder, 'switch2-probes-webkit.js'));
  await assert.rejects(inspect(folder), /missing a regular research file/);
  await fs.symlink(path.join(folder, 'switch2-probes-runtime.js'),
    path.join(folder, 'switch2-probes-webkit.js'));
  await assert.rejects(inspect(folder), /missing a regular research file/);
});

test('server arguments stay bounded and require an absolute selected folder', () => {
  assert.throws(() => options(['serve', '--folder', 'relative', '--address', '127.0.0.1']),
    /absolute research source/);
  assert.throws(() => options(['serve', '--folder', '/tmp/test', '--address', 'not-ip']),
    /IPv4/);
  assert.throws(() => options(['serve', '--folder', '/tmp/test', '--address', '127.0.0.1',
    '--port', '65536']), /port/);
  assert.equal(options(['serve', '--folder', '/tmp/test', '--address', '127.0.0.1']).port,
    '8765');
});

test('server wrapper reports readiness and terminates its Python child', async t => {
  const script = 'import signal,sys,time\n' +
    'print("Serving feature inventory on 127.0.0.1:8765",flush=True)\n' +
    'while True: time.sleep(1)\n';
  const folder = await fixture(t, script);
  const child = spawn(process.execPath, [adapter, 'serve', '--folder', folder,
    '--address', '127.0.0.1', '--python', '/usr/bin/python3'],
  {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => {if (child.exitCode === null) child.kill('SIGTERM');});
  let output = '';
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes.toString(); });
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = error => finish(error);
    const onClose = (code, signal) => finish(Error(
      `WebKit adapter exited before readiness (${code ?? signal}): ${errors.trim() || output.trim()}`));
    const timer = setTimeout(() => finish(Error(
      `WebKit adapter did not report readiness: ${errors.trim() || output.trim()}`)), 15000);
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      if (output.includes('"type":"ready"')) finish();
    });
    child.once('error', onError);
    child.once('close', onClose);
  });
  assert.match(output, /http:\/\/127\.0\.0\.1:8765\//);
  child.kill('SIGTERM');
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  assert.equal(result.code, 0);
  assert.match(output, /"type":"ready"/);
});
