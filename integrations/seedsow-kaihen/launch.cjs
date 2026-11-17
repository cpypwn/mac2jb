#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {
  ARCHIVES: KAIHEN_ARCHIVES, requireIPv4, pinnedArchive, extractArchive,
  preserveFailureDiagnostics,
} = require('../kaihen/launch.cjs');

const PREFIX = 'MAC2JB_SEEDSOW_KAIHEN ';
const SOURCE_COMMIT = 'c0e904a9576cb2db8c13f3ab6afdb3a87ccb31b8';
const SOURCE = Object.freeze({
  label: 'Seedsow FS kaiHEN source',
  filename: `seedsow-fs-kaihen-${SOURCE_COMMIT}.zip`,
  url: `https://codeload.github.com/Malev0/seedsow-fs-kaihen/zip/${SOURCE_COMMIT}`,
  sha256: '7dffe6aa6a16844860f06f073d9f8699fed838e46294d17423d898e1c66e92e4',
  archiveRoot: `seedsow-fs-kaihen-${SOURCE_COMMIT}`,
  maxBytes: 16 * 1024 * 1024,
});

function emitLine(value) {
  process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
}

function requireDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) ||
      value.includes('\0') || path.normalize(value) !== value)
    throw Error(`${label} must be an absolute directory`);
  return value;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid())
    throw Error('Seedsow storage must be a private directory owned by this user');
  await fs.chmod(directory, 0o700);
}

async function requireRegular(file, label) {
  let info;
  try { info = await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw Error(`Missing ${label}`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Missing ${label}`);
}

async function guardBridgeSetup(source) {
  const file = path.join(source, 'launch', 'unix', 'setup.sh');
  const original = await fs.readFile(file, 'utf8');
  const preflightAnchor = 'export NS2_FAST\n';
  if (!original.includes(preflightAnchor))
    throw Error('Seedsow setup changed; inspect its bridge startup before running');
  const start = original.indexOf('if command -v lsof >/dev/null 2>&1; then\n  pids=$(lsof -ti tcp:31337');
  const end = original.indexOf('\nsleep 0.5\n', start);
  if (start < 0 || end < 0) throw Error('Seedsow setup changed; inspect its bridge cleanup before running');
  const guard = `if command -v lsof >/dev/null 2>&1 && lsof -ti tcp:31337 >/dev/null 2>&1; then
  echo 'Local port 31337 is in use. Stop the other Seedsow bridge before continuing.'
  exit 1
fi`;
  const guarded = original.slice(0, start) + guard + original.slice(end);
  await fs.writeFile(file, guarded.replace(preflightAnchor, preflightAnchor + guard + '\n'), {mode: 0o600});
}

async function stage(supportRoot, archives, options = {}) {
  const runBase = path.join(supportRoot, 'runs');
  await privateDirectory(runBase);
  const runRoot = await fs.mkdtemp(path.join(runBase, 'seedsow-'));
  await fs.chmod(runRoot, 0o700);
  const unpack = path.join(runRoot, 'unpack');
  const source = path.join(runRoot, 'source');
  const kaihen = path.join(runRoot, 'kaihen');
  const extract = options.extract || extractArchive;
  try {
    await extract(archives.source, unpack, SOURCE.archiveRoot);
    await fs.rename(path.join(unpack, SOURCE.archiveRoot), source);
    await fs.rm(unpack, {recursive: true, force: true});
    await extract(archives.kaihen, kaihen, null);
    for (const name of ['ns2-run.cjs', 'launch/unix/setup.sh', 'tools/hen.cjs',
      'tools/seedsow-bridge.cjs', 'ns2jb-main/ns2jb-main/engine/switch2/pipeline.cjs'])
      await requireRegular(path.join(source, name), `Seedsow ${name}`);
    for (const name of ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin',
      'hbmenu.nro', 'programs/ounceshell.nro'])
      await requireRegular(path.join(kaihen, name), `kaiHEN ${name}`);
    if (!options.skipSetupGuard) await guardBridgeSetup(source);
    return {runRoot, source, kaihen};
  } catch (error) {
    await fs.rm(runRoot, {recursive: true, force: true});
    throw error;
  }
}

function observe(child, emit, source) {
  const state = {recent: [], runPath: null, started: false, step: 0, logged: 0};
  const receive = line => {
    if (!line.trim()) return;
    state.recent.push(line);
    if (state.recent.length > 60) state.recent.shift();
    if (state.logged++ < 3000 && !/\bfps\b/i.test(line))
      emit({type: 'log', message: line.slice(0, 2048)});
    const run = /^run directory: (.+)$/.exec(line);
    if (run) {
      const candidate = path.resolve(run[1]);
      if (candidate.startsWith(path.join(source, 'runs') + path.sep)) state.runPath = candidate;
    }
    const progress = /^([1-4])\/4\s+(.+)$/i.exec(line.trim());
    if (progress) {
      state.step = Math.max(state.step, Number(progress[1]));
      emit({type: 'progress', step: state.step, message: line.trim()});
    } else if (/Staging HEN to SD and starting it/.test(line)) {
      state.step = 4;
      emit({type: 'progress', step: 4, message: '4/4 Starting kaiHEN'});
    }
    if (/^kaiHEN started\. Quit the game/.test(line)) state.started = true;
  };
  readline.createInterface({input: child.stdout}).on('line', receive);
  readline.createInterface({input: child.stderr}).on('line', receive);
  return state;
}

function failureReason(state, code) {
  const specific = [...state.recent].reverse().find(line =>
    /FAILED:|failed|error|not reachable|timed out/i.test(line) &&
    !/^\s+at /.test(line) && !/artifacts in/.test(line));
  return specific?.trim().slice(0, 500) || `Seedsow host exited with status ${code}`;
}

function stopGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
}

async function launch(options) {
  const consoleIp = requireIPv4(options.consoleIp);
  const runtimeRoot = requireDirectory(options.runtimeRoot, 'Runtime root');
  const supportRoot = requireDirectory(options.supportRoot ||
    path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb', 'SeedsowKaiHEN'),
  'Seedsow support root');
  const emit = options.emit || emitLine;
  const node = options.node || path.join(runtimeRoot, 'node');
  if (!options.spawnProcess) await fs.access(node, fs.constants.X_OK);
  await privateDirectory(supportRoot);
  emit({type: 'preparing', message: 'Preparing Seedsow kaiHEN'});
  const cache = path.join(supportRoot, 'archives');
  const specs = options.specs || {source: SOURCE, kaihen: KAIHEN_ARCHIVES.kaihen};
  const [sourceArchive, kaihenArchive] = await Promise.all([
    pinnedArchive(cache, specs.source, options),
    pinnedArchive(cache, specs.kaihen, options),
  ]);
  if (options.abortSignal?.aborted) return {stopped: true};
  emit({type: 'preparing', message: 'Preparing Seedsow source and kaiHEN files'});
  const staged = await stage(supportRoot, {source: sourceArchive, kaihen: kaihenArchive}, options);
  let child;
  try {
    if (options.abortSignal?.aborted) return {stopped: true};
    emit({type: 'running', message: 'Connecting to Seedsow Lullaby'});
    const spawnProcess = options.spawnProcess || spawn;
    child = spawnProcess(node, [path.join(staged.source, 'ns2-run.cjs'),
      '--ip', consoleIp, '--dir', staged.kaihen], {
      cwd: staged.source,
      env: {...process.env, PATH: runtimeRoot + path.delimiter + (process.env.PATH || '')},
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const state = observe(child, emit, staged.source);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      emit({type: 'stopping', message: 'Stopping the Seedsow host'});
      if (options.spawnProcess) child.kill('SIGTERM'); else stopGroup(child);
    };
    options.abortSignal?.addEventListener('abort', stop, {once: true});
    if (options.abortSignal?.aborted) stop();
    let outcome;
    try {
      outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({code, signal}));
      });
    } finally { options.abortSignal?.removeEventListener('abort', stop); }
    if (stopping) {
      emit({type: 'stopped', message: 'Seedsow kaiHEN stopped'});
      return {stopped: true};
    }
    if (outcome.code !== 0 || !state.started) {
      let diagnostics = null;
      try { diagnostics = await preserveFailureDiagnostics(supportRoot, state); }
      catch (error) { emit({type: 'log', message: `Could not preserve diagnostics: ${error.message}`}); }
      if (diagnostics) emit({type: 'log', message: `Diagnostics saved at ${diagnostics}`});
      throw Error(failureReason(state, outcome.code));
    }
    emit({type: 'installed', step: 4,
      message: 'kaiHEN is running. Close Seedsow normally; hold R while opening a native game.'});
    return {installed: true};
  } finally {
    if (child && !options.spawnProcess) stopGroup(child);
    await fs.rm(staged.runRoot, {recursive: true, force: true});
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2) throw Error('usage: node integrations/seedsow-kaihen/launch.cjs SWITCH_IPV4 RUNTIME_ROOT');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try { return await launch({consoleIp: args[0], runtimeRoot: args[1], abortSignal: controller.signal}); }
  finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) main().catch(error => {
  emitLine({type: 'failed', message: error.message});
  process.exitCode = 1;
});

module.exports = {PREFIX, SOURCE, requireDirectory, guardBridgeSetup, stage,
  observe, failureReason, launch, main};
