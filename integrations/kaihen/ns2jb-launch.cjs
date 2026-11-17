#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const kaihen = require('./launch.cjs');

const PREFIX = 'MAC2JB_NS2JB_KAIHEN ';
const PACKAGE_FILES = ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin',
  'hbmenu.nro', 'programs/ounceshell.nro', 'licenses/kaiHEN-GPL-2.0.txt'];

function event(type, message, fields = {}) {
  return {type, message, ...fields};
}

function emitLine(value) {
  process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) ||
      path.normalize(value) !== value || value.includes('\0'))
    throw Error(`${label} must be an absolute directory`);
  return value;
}

function stageTimeout(value) {
  const minutes = value === undefined ? 10 : Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60)
    throw Error('Stage timeout must be between 1 and 60 minutes');
  return minutes;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid())
    throw Error('kaiHEN storage must be a private directory owned by this user');
  await fs.chmod(directory, 0o700);
}

async function regularFile(file, label) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Missing ${label}`);
}

async function checkPackageTree(directory) {
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, {withFileTypes: true})) {
      if (entry.isDirectory()) await walk(path.join(folder, entry.name));
      else if (!entry.isFile()) throw Error('kaiHEN package contains an unsupported file type');
    }
  }
  await walk(directory);
  for (const name of PACKAGE_FILES)
    await regularFile(path.join(directory, name), `kaiHEN ${name}`);
}

async function stagePackage(supportRoot, archive, options = {}) {
  const base = path.join(supportRoot, 'ns2jb-runs');
  await privateDirectory(base);
  const runRoot = await fs.mkdtemp(path.join(base, 'kaihen-'));
  await fs.chmod(runRoot, 0o700);
  const packageRoot = path.join(runRoot, 'package');
  try {
    await (options.extract || kaihen.extractArchive)(archive, packageRoot, null);
    await checkPackageTree(packageRoot);
    return {runRoot, packageRoot};
  } catch (error) {
    await fs.rm(runRoot, {recursive: true, force: true});
    throw error;
  }
}

function startCommand(line, macIp) {
  const match = /^V=START\((\d+(?:,\d+)*)\)$/.exec(line.trim());
  if (!match) return null;
  const args = match[1].split(',').map(Number);
  if (![5, 9].includes(args.length) || args[0] !== 39380 ||
      args.slice(1, 5).join('.') !== macIp ||
      args.some(value => !Number.isSafeInteger(value)) ||
      args.slice(1, 5).some(value => value < 0 || value > 255) ||
      (args.length === 9 && args.slice(5).some(value => value !== 0))) return null;
  return line.trim();
}

function observe(child, emit, hostRoot, macIp) {
  const state = {runPath: null, startCommand: null, pid: null, startupRecord: null,
    installed: false, startupFailed: false, recent: [], logged: 0};
  function receive(line, fromStdout) {
    state.recent.push(line);
    if (state.recent.length > 50) state.recent.shift();
    if (line.trim() && state.logged < 2000 && !/\bfps\b/i.test(line)) {
      emit(event('log', line.slice(0, 2048)));
      state.logged++;
    }
    const phase = /^([1-4])\/4 (.+)$/.exec(line.trim());
    if (phase) emit(event('progress', line.trim(), {step: Number(phase[1]),
      ...(state.runPath ? {runPath: state.runPath} : {})}));
    if (!fromStdout) {
      if (/^HEN startup failed/.test(line)) {
        state.startupFailed = true;
        child.kill('SIGTERM');
      }
      return;
    }
    const run = /^Run folder: (.+)$/.exec(line);
    if (run) {
      const candidate = path.resolve(run[1]);
      const expected = path.join(hostRoot, 'runs') + path.sep;
      if (candidate.startsWith(expected)) state.runPath = candidate;
    }
    const command = startCommand(line, macIp);
    if (command && !state.startCommand) {
      state.startCommand = command;
      emit(event('host-ready', 'SmileBASIC host is ready for the console command',
        {startCommand: command}));
    }
    if (!phase && /^(RO frontend verified\.|Staging |Starting native bootstrap)/.test(line))
      emit(event('progress', line, {step: 4,
        ...(state.runPath ? {runPath: state.runPath} : {})}));
    const started = /^HEN PID (\d+); startup record: (.+)$/.exec(line);
    if (started) {
      state.pid = started[1];
      state.startupRecord = started[2];
    }
    if (/^HEN launch completed!/.test(line) && state.pid && !state.installed) {
      state.installed = true;
      emit(event('installed', 'kaiHEN is running. Close SmileBASIC, then open a Switch 2 game while holding R. hbmenu appears on the second launch.',
        {step: 4, pid: state.pid, startupRecord: state.startupRecord,
          ...(state.runPath ? {runPath: state.runPath} : {})}));
    }
  }
  readline.createInterface({input: child.stdout}).on('line', line => receive(line, true));
  readline.createInterface({input: child.stderr}).on('line', line => receive(line, false));
  return state;
}

function failureReason(state, outcome) {
  if (state.startupFailed) return 'Native HEN startup failed; see session details';
  return kaihen.failureReason(state, outcome);
}

async function launch(options) {
  const macIp = kaihen.requireIPv4(options.macIp);
  const runtimeRoot = requireAbsoluteDirectory(options.runtimeRoot, 'Runtime root');
  const supportRoot = requireAbsoluteDirectory(options.supportRoot ||
    path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb', 'KaiHEN'), 'kaiHEN support root');
  const hostRoot = requireAbsoluteDirectory(options.hostRoot ||
    path.join(runtimeRoot, 'vendor/ns2jb-hosts/kurumuz'), 'Kurumuz host root');
  const node = options.node || path.join(runtimeRoot, 'node');
  const minutes = stageTimeout(options.stageTimeoutMinutes);
  const emit = options.emit || emitLine;
  const spec = options.spec || kaihen.ARCHIVES.kaihen;
  const archivePin = {...spec};
  if (!options.spawnProcess) await fs.access(node, constants.X_OK);
  await regularFile(path.join(hostRoot, 'hen.cjs'), 'Kurumuz hen.cjs');
  await regularFile(path.join(hostRoot, 'run.cjs'), 'Kurumuz run.cjs');
  await privateDirectory(supportRoot);
  emit(event('preparing', 'Preparing kaiHEN for SmileBASIC'));
  const archive = await kaihen.pinnedArchive(path.join(supportRoot, 'archives'),
    archivePin, {...options, emit});
  if (options.abortSignal?.aborted) {
    emit(event('stopped', 'kaiHEN launch stopped before starting'));
    return {stopped: true};
  }
  const staged = await stagePackage(supportRoot, archive, options);
  if (options.abortSignal?.aborted) {
    await fs.rm(staged.runRoot, {recursive: true, force: true});
    emit(event('stopped', 'kaiHEN launch stopped before starting'));
    return {stopped: true};
  }
  try {
    emit(event('running', 'Starting kaiHEN through SmileBASIC', {stagePath: staged.runRoot}));
    const child = (options.spawnProcess || spawn)(node,
      [path.join(hostRoot, 'hen.cjs'), '--dir', staged.packageRoot, macIp],
      {cwd: hostRoot, stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, NS2_BASIC_ARITY: '5',
          MAC2JB_HOST_STAGE_TIMEOUT_MS: String(minutes * 60000)}});
    const state = observe(child, emit, hostRoot, macIp);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      emit(event('stopping', 'Stopping the SmileBASIC kaiHEN host'));
      child.kill('SIGTERM');
    };
    options.abortSignal?.addEventListener('abort', stop, {once: true});
    if (options.abortSignal?.aborted) stop();
    let outcome;
    try {
      outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({code, signal}));
      });
    } finally {options.abortSignal?.removeEventListener('abort', stop);}
    if (stopping) {
      emit(event('stopped', 'kaiHEN host stopped'));
      return {stopped: true};
    }
    if (outcome.code !== 0 || !state.installed) {
      let diagnostics;
      try { diagnostics = await kaihen.preserveFailureDiagnostics(supportRoot, state); }
      catch (error) { emit(event('log', `Could not preserve kaiHEN diagnostics: ${error.message}`)); }
      if (diagnostics) emit(event('log', `kaiHEN diagnostics saved at ${diagnostics}`));
      throw Error(outcome.code !== 0 ? `SmileBASIC kaiHEN failed: ${failureReason(state, outcome)}` :
        'SmileBASIC host ended before kaiHEN startup was confirmed');
    }
    emit(event('finished', 'SmileBASIC host finished; kaiHEN remains active until the Switch restarts'));
    return {installed: true};
  } finally { await fs.rm(staged.runRoot, {recursive: true, force: true}); }
}

async function main(args = process.argv.slice(2)) {
  if (args.length < 2 || args.length > 3)
    throw Error('usage: node integrations/kaihen/ns2jb-launch.cjs MAC_IPV4 RUNTIME_ROOT [STAGE_TIMEOUT_MINUTES]');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await launch({macIp: args[0], runtimeRoot: args[1],
      stageTimeoutMinutes: args[2], abortSignal: controller.signal});
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) main().catch(error => {
  emitLine(event('failed', error.message));
  process.exitCode = 1;
});

module.exports = {PREFIX, PACKAGE_FILES, stageTimeout, stagePackage, startCommand,
  observe, launch, main};
