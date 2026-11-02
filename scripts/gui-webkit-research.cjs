#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');

const moduleNames = Object.freeze(['runtime', 'media', 'network', 'boundaries',
  'fonts', 'webkit', 'fontenv']);
const requiredFiles = Object.freeze([
  'serve-switch2-browser-probe.py', 'switch2-browser-probe.html',
  ...moduleNames.map(name => `switch2-probes-${name}.js`)
]);

function check(ok, message) { if (!ok) throw Error(message); }
function emit(type, fields = {}) {
  process.stdout.write('MAC2JB_WEBKIT ' + JSON.stringify({type, ...fields}) + '\n');
}

function options(args) {
  const command = args.shift();
  check(['inspect', 'serve', '--self-test'].includes(command),
    'Usage: gui-webkit-research.cjs inspect|serve --folder DIRECTORY [--address IP] [--port PORT] [--python PATH]');
  if (command === '--self-test') {
    check(args.length === 0, 'Self-test takes no options.');
    return {command};
  }
  const allowed = command === 'serve'
    ? new Set(['folder', 'address', 'port', 'python']) : new Set(['folder']);
  const result = {command};
  while (args.length) {
    const flag = args.shift();
    check(flag?.startsWith('--') && allowed.has(flag.slice(2)) && args.length,
      'Unknown or incomplete WebKit research option.');
    const name = flag.slice(2);
    check(result[name] === undefined, 'Duplicate WebKit research option.');
    result[name] = args.shift();
  }
  check(typeof result.folder === 'string' && path.isAbsolute(result.folder) &&
    result.folder.length <= 4096, 'Choose an absolute research source folder.');
  if (command === 'serve') {
    check(net.isIP(result.address) === 4, 'Choose a Mac IPv4 address.');
    result.port ??= '8765';
    check(/^(0|[1-9][0-9]{0,4})$/.test(result.port) && Number(result.port) <= 65535,
      'Choose a port from 0 to 65535.');
    result.python ??= '/usr/bin/python3';
    check(path.isAbsolute(result.python), 'Choose an absolute Python 3 executable.');
  }
  return result;
}

async function inspect(folder) {
  const directory = path.resolve(folder);
  check(directory === folder, 'Choose a normalized source folder.');
  const root = await fs.lstat(directory);
  check(root.isDirectory() && !root.isSymbolicLink(), 'Choose a regular research source folder.');
  for (const name of requiredFiles) {
    const item = await fs.lstat(path.join(directory, name)).catch(() => null);
    check(item?.isFile() && !item.isSymbolicLink() && item.size > 0 && item.size <= 2 * 1024 * 1024,
      'The selected folder is missing a regular research file: ' + name);
  }
  return {folder: directory, modules: moduleNames, page: 'switch2-browser-probe.html',
    reportFolder: path.join(directory, 'work/browser-probe/reports')};
}

async function serve(value) {
  const source = await inspect(value.folder);
  const python = await fs.stat(value.python).catch(() => null);
  check(python?.isFile(), 'The Python 3 executable is unavailable.');
  const child = spawn(value.python, [path.join(source.folder, 'serve-switch2-browser-probe.py'),
    '--bind', value.address, '--port', value.port, '--save-reports', '--live'],
  {cwd: source.folder, stdio: ['ignore', 'pipe', 'pipe']});
  let ready = false;
  let outputFailed = false;
  let output = '';
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  child.stdout.on('data', chunk => {
    output += chunk.toString('utf8');
    if (output.length > 16384) {
      outputFailed = true;
      emit('failed', {message: 'The research server produced too much output.'});
      stop();
      return;
    }
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline === -1) break;
      const line = output.slice(0, newline).trim();
      output = output.slice(newline + 1);
      const match = /^Serving feature inventory on [^:]+:(\d+)$/.exec(line);
      if (match && !ready) {
        ready = true;
        emit('ready', {url: `http://${value.address}:${Number(match[1])}/`,
          modules: source.modules, reportFolder: source.reportFolder});
      } else if (line) emit('log', {message: line.slice(0, 512)});
    }
  });
  child.stderr.on('data', chunk => {
    const message = chunk.toString('utf8').trim().slice(0, 512);
    if (message) emit('log', {message});
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (!ready && code !== 0) reject(Error('The research server did not start.'));
      else {
        emit('stopped', {code, signal});
        resolve({code, signal, outputFailed});
      }
    });
  });
}

async function main(args = process.argv.slice(2)) {
  const value = options([...args]);
  if (value.command === '--self-test') {
    check(moduleNames.length === 7 && requiredFiles.length === 9,
      'WebKit research adapter self-test failed.');
    process.stdout.write('WebKit research adapter self-test passed.\n');
    return;
  }
  if (value.command === 'inspect') {
    emit('source', await inspect(value.folder));
    return;
  }
  const result = await serve(value);
  if (result.outputFailed || !(result.code === 0 || result.signal === 'SIGTERM')) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  emit('failed', {message: error.message.slice(0, 512)});
  process.exitCode = 1;
});

module.exports = {moduleNames, requiredFiles, options, inspect, serve};
