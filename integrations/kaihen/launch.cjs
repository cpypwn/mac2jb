#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const {createReadStream, createWriteStream, constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const readline = require('node:readline');

const PREFIX = 'MAC2JB_KAIHEN ';
const SOURCE_COMMIT = '0b6906a829286630255af2842a7b83946091f933';
const ARCHIVES = Object.freeze({
  source: Object.freeze({
    label: 'Civ7 kaiHEN launcher',
    filename: `civ7-fs-kaihen-${SOURCE_COMMIT}.zip`,
    url: `https://github.com/s8n/civ7-fs-kaihen/archive/${SOURCE_COMMIT}.zip`,
    sha256: 'd3efb5b29594040dbc2c86df167923e707669d91ec34ab5bd79fc166498f97c5',
    archiveRoot: `civ7-fs-kaihen-${SOURCE_COMMIT}`,
    maxBytes: 64 * 1024 * 1024,
  }),
  kaihen: Object.freeze({
    label: 'kaiHEN 20261117.1',
    filename: 'kaiHEN-20261117.1.zip',
    url: 'https://github.com/ouncebrew/kaihen/releases/download/20261117.1/kaiHEN-20261117.1.zip',
    sha256: '3f7ded0b360b2f0bf97f8e958c3bfe93a8d76dd8d43ce2e8f7d060e647ad0978',
    archiveRoot: null,
    maxBytes: 64 * 1024 * 1024,
  }),
});

function event(type, message, fields = {}) {
  return {type, message, ...fields};
}

function emitLine(value) {
  process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
}

function requireIPv4(value) {
  if (!net.isIPv4(value)) throw Error('Enter a valid Switch IPv4 address');
  return value;
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      value.includes('\0')) throw Error(`${label} must be an absolute directory`);
  return value;
}

function defaultSupportRoot() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb', 'KaiHEN');
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid())
    throw Error('KaiHEN storage must be a private directory owned by this user');
  await fs.chmod(directory, 0o700);
}

async function sha256(file) {
  const digest = crypto.createHash('sha256');
  for await (const part of createReadStream(file)) digest.update(part);
  return digest.digest('hex');
}

async function downloadUrl(url, destination, maxBytes, signal) {
  const deadline = AbortSignal.timeout(120000);
  const response = await fetch(url, {signal: signal ? AbortSignal.any([signal, deadline]) : deadline});
  if (!response.ok || !response.body) throw Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw Error('Download exceeds its size limit');
  let bytes = 0;
  const limit = new Transform({transform(chunk, _, done) {
    bytes += chunk.length;
    done(bytes > maxBytes ? Error('Download exceeds its size limit') : null, chunk);
  }});
  await pipeline(Readable.fromWeb(response.body), limit,
    createWriteStream(destination, {flags: 'wx', mode: 0o600}));
}

async function pinnedArchive(cacheRoot, spec, options = {}) {
  const emit = options.emit || emitLine;
  const download = options.download || downloadUrl;
  await privateDirectory(cacheRoot);
  const archive = path.join(cacheRoot, spec.filename);
  let cached = false;
  try {
    const info = await fs.lstat(archive);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid())
      throw Error('KaiHEN archive cache contains an untrusted file');
    cached = (await sha256(archive)) === spec.sha256;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!cached) {
    emit(event('downloading', `Downloading ${spec.label}`));
    const temporary = archive + '.' + crypto.randomBytes(8).toString('hex') + '.part';
    try {
      await download(spec.url, temporary, spec.maxBytes, options.abortSignal);
      if (await sha256(temporary) !== spec.sha256)
        throw Error(`${spec.label} download did not match its pinned SHA-256`);
      await fs.rename(temporary, archive);
    } finally {await fs.rm(temporary, {force: true});}
  }
  emit(event('verified', `${spec.label} archive verified`));
  return archive;
}

async function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let errorText = '';
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); });
    child.stderr.on('data', bytes => { errorText = (errorText + bytes.toString('utf8')).slice(-4096); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) :
      reject(Error(`${path.basename(program)} exited with ${code}: ${errorText.trim()}`)));
  });
}

function validateEntries(names, archiveRoot) {
  if (!names.length) throw Error('Archive is empty');
  for (const name of names) {
    const parts = name.replace(/\/$/, '').split('/');
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') ||
        parts.some(part => !part || part === '.' || part === '..') ||
        (archiveRoot && parts[0] !== archiveRoot))
      throw Error('Archive contains an unsafe path');
  }
}

async function extractArchive(archive, destination, archiveRoot) {
  const listing = await command('/usr/bin/unzip', ['-Z', '-1', archive]);
  validateEntries(listing.trimEnd().split('\n'), archiveRoot);
  await fs.mkdir(destination, {recursive: true, mode: 0o700});
  await command('/usr/bin/unzip', ['-q', archive, '-d', destination]);
}

async function requireRegular(file, label) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Missing ${label}`);
  return file;
}

async function stageArchives(supportRoot, archives, options = {}) {
  const emit = options.emit || emitLine;
  const extract = options.extract || extractArchive;
  const sourceRoot = options.specs?.source?.archiveRoot || ARCHIVES.source.archiveRoot;
  const runBase = path.join(supportRoot, 'runs');
  await privateDirectory(runBase);
  const runRoot = await fs.mkdtemp(path.join(runBase, 'kaihen-'));
  await fs.chmod(runRoot, 0o700);
  const sourceUnpack = path.join(runRoot, 'source-unpack');
  const source = path.join(runRoot, 'source');
  const testship = path.join(runRoot, 'testship');
  try {
    emit(event('extracting', 'Preparing the Civ7 launcher'));
    await extract(archives.source, sourceUnpack, sourceRoot);
    await fs.rename(path.join(sourceUnpack, sourceRoot), source);
    await fs.rm(sourceUnpack, {recursive: true, force: true});
    emit(event('extracting', 'Preparing kaiHEN files'));
    await extract(archives.kaihen, testship, null);
    for (const [name, label] of [
      ['engine/hen.cjs', 'Civ7 kaiHEN entrypoint'],
      ['engine/run.cjs', 'Civ7 FS engine'],
      ['bridge/civ_bridge.js', 'CivSwitch bridge'],
    ]) await requireRegular(path.join(source, name), label);
    for (const name of ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin',
      'hbmenu.nro', 'programs/ounceshell.nro', 'licenses/kaiHEN-GPL-2.0.txt'])
      await requireRegular(path.join(testship, name), `kaiHEN ${name}`);
    return {runRoot, source, testship};
  } catch (error) {
    await fs.rm(runRoot, {recursive: true, force: true});
    throw error;
  }
}

function observe(child, emit, source) {
  const state = {runPath: null, pid: null, startupRecord: null, running: false,
    installed: false, startupFailed: false, recent: [], logged: 0};
  const record = line => {
    state.recent.push(line);
    if (state.recent.length > 40) state.recent.shift();
  };
  function receive(line, fromStdout) {
    record(line);
    const wrapperNoise = /^Error: run\.cjs exited before "RO frontend verified"/.test(line) ||
      /^\s+at ChildProcess\./.test(line) ||
      /^\s+at ChildProcess\.wrapper/.test(line);
    if (line.trim() && state.logged < 2000 && !/\bfps\b/i.test(line) &&
        !wrapperNoise) {
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
      const expected = path.join(source, 'runs') + path.sep;
      if (candidate.startsWith(expected)) state.runPath = candidate;
    }
    if (!phase && /^(RO frontend verified\.|Staging |Starting native bootstrap)/.test(line))
      emit(event('progress', line, {step: 4,
        ...(state.runPath ? {runPath: state.runPath} : {})}));
    const startup = /^HEN PID (\d+); startup record: (.+)$/.exec(line);
    if (startup) {
      state.pid = startup[1];
      state.startupRecord = startup[2];
    }
    if (/^HEN is running\./.test(line)) state.running = true;
    if (state.pid && state.running && !state.installed) {
      state.installed = true;
      emit(event('installed', 'kaiHEN is running. Close Civilization VII normally; hold R while opening a native game.',
        {step: 4, pid: state.pid, startupRecord: state.startupRecord,
          ...(state.runPath ? {runPath: state.runPath} : {})}));
    }
  }
  readline.createInterface({input: child.stdout}).on('line', line => receive(line, true));
  readline.createInterface({input: child.stderr}).on('line', line => receive(line, false));
  return state;
}

function failureReason(state, outcome) {
  const failed = [...state.recent].reverse().find(line =>
    /^ReiAyanami: FAILED: /.test(line));
  if (failed) return failed.slice('ReiAyanami: FAILED: '.length).replace(/^Error:\s*/, '');
  const verification = [...state.recent].reverse().find(line =>
    /\bverified\s+NO - Error: /.test(line));
  if (verification) return verification.split(/\bverified\s+NO - Error: /)[1];
  return state.recent.find(line => /^Error: (?!run\.cjs exited before)/.test(line)) ||
    `Host exited with ${outcome.signal || outcome.code}`;
}

async function preserveFailureDiagnostics(supportRoot, state) {
  if (!state.runPath) return null;
  const destination = path.join(supportRoot, 'last-failure');
  await fs.rm(destination, {recursive: true, force: true});
  await privateDirectory(destination);
  const candidates = [
    ['result.json', 'result.json'],
    ['switch2/pipeline.json', 'pipeline.json'],
  ];
  const acquisitionRoot = path.join(state.runPath, 'switch2');
  try {
    const names = await fs.readdir(acquisitionRoot);
    const acquisition = names.filter(name => /^acquisition-[\w.-]+\.log$/.test(name)).sort().at(-1);
    if (acquisition) candidates.push([`switch2/${acquisition}`, 'acquisition.log']);
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  let copied = 0;
  for (const [sourceName, targetName] of candidates) {
    try {
      const source = path.join(state.runPath, sourceName);
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) continue;
      await fs.copyFile(source, path.join(destination, targetName));
      copied++;
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  if (!copied) {
    await fs.rm(destination, {recursive: true, force: true});
    return null;
  }
  return destination;
}

async function launch(options) {
  const consoleIp = requireIPv4(options.consoleIp);
  const runtimeRoot = requireAbsoluteDirectory(options.runtimeRoot, 'Runtime root');
  const supportRoot = requireAbsoluteDirectory(options.supportRoot || defaultSupportRoot(), 'KaiHEN support root');
  const emit = options.emit || emitLine;
  const specs = options.specs || ARCHIVES;
  const node = options.node || path.join(runtimeRoot, 'node');
  if (!options.spawnProcess) await fs.access(node, constants.X_OK);
  await privateDirectory(supportRoot);
  emit(event('preparing', 'Preparing kaiHEN'));
  const cacheRoot = path.join(supportRoot, 'archives');
  let sourceArchive, kaihenArchive;
  try {
    [sourceArchive, kaihenArchive] = await Promise.all([
      pinnedArchive(cacheRoot, specs.source, options),
      pinnedArchive(cacheRoot, specs.kaihen, options),
    ]);
  } catch (error) {
    if (!options.abortSignal?.aborted) throw error;
    emit(event('stopped', 'kaiHEN launch stopped before starting'));
    return {stopped: true};
  }
  if (options.abortSignal?.aborted) {
    emit(event('stopped', 'kaiHEN launch stopped before starting'));
    return {stopped: true};
  }
  let staged;
  try {staged = await stageArchives(supportRoot,
    {source: sourceArchive, kaihen: kaihenArchive}, options);}
  catch (error) {
    if (!options.abortSignal?.aborted) throw error;
    emit(event('stopped', 'kaiHEN launch stopped before starting'));
    return {stopped: true};
  }
  if (options.abortSignal?.aborted) {
    emit(event('stopped', 'kaiHEN launch stopped before starting'));
    await fs.rm(staged.runRoot, {recursive: true, force: true});
    return {stopped: true};
  }
  try {
    emit(event('running', 'Starting kaiHEN through Civilization VII', {stagePath: staged.runRoot}));
    const spawnProcess = options.spawnProcess || spawn;
    const child = spawnProcess(node, [path.join(staged.source, 'engine', 'hen.cjs'), consoleIp,
      '--dir', staged.testship], {cwd: staged.source, env: {...process.env},
      stdio: ['ignore', 'pipe', 'pipe']});
    const state = observe(child, emit, staged.source);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      emit(event('stopping', 'Stopping at the next safe checkpoint. Keep Civilization VII open.'));
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
    if (state.startupFailed) throw Error('kaiHEN startup failed; see the session details');
    if (stopping) {
      emit(event('stopped', 'kaiHEN launch stopped'));
      return {stopped: true};
    }
    if (outcome.code !== 0) {
      const reason = failureReason(state, outcome);
      let diagnostics = null;
      try {diagnostics = await preserveFailureDiagnostics(supportRoot, state);}
      catch (error) {emit(event('log', `Could not preserve kaiHEN diagnostics: ${error.message}`));}
      if (diagnostics) emit(event('log', `kaiHEN diagnostics saved at ${diagnostics}`));
      throw Error(`Civ7 kaiHEN failed: ${reason}`);
    }
    if (!state.installed) throw Error('Civ7 host ended before kaiHEN startup was confirmed');
    emit(event('finished', 'Civ7 launcher finished; kaiHEN remains active until the Switch restarts'));
    return {installed: true};
  } finally {
    await fs.rm(staged.runRoot, {recursive: true, force: true});
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2) throw Error('usage: node integrations/kaihen/launch.cjs SWITCH_IPV4 RUNTIME_ROOT');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {return await launch({consoleIp: args[0], runtimeRoot: args[1], abortSignal: controller.signal});}
  finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) main().catch(error => {
  emitLine(event('failed', error.message));
  process.exitCode = 1;
});

module.exports = {ARCHIVES, PREFIX, requireIPv4, sha256, pinnedArchive,
  validateEntries, extractArchive, stageArchives, observe, failureReason,
  preserveFailureDiagnostics, launch, main};
