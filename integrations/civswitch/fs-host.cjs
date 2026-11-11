'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {spawn} = require('node:child_process');

const PREFIX = 'MAC2JB_CIVSWITCH_FS ';
const SOURCE_PORT = path.join(__dirname, 'fs-kit', 'port');
const LOADER_WAIT_MS = 5 * 60 * 1000;

function emitLine(event) {
  process.stdout.write(PREFIX + JSON.stringify(event) + '\n');
}

function event(emit, type, fields = {}) {
  emit({type, phase: type, ...fields});
}

function requireIPv4(value, label) {
  if (!net.isIPv4(value)) throw Error('Enter a valid ' + label + ' IPv4 address');
  return value;
}

async function stage(sourcePort, runtimeRoot, macIp, prepare) {
  if (!path.isAbsolute(runtimeRoot)) throw Error('Runtime root must be an absolute path');
  const runs = path.join(runtimeRoot, 'runs');
  await fs.mkdir(runs, {recursive: true, mode: 0o700});
  const root = path.join(runs, 'civswitch-fs-' + crypto.randomBytes(8).toString('hex'));
  await fs.mkdir(root, {mode: 0o700});
  try {
    const stagedPort = path.join(root, 'port');
    await fs.cp(sourcePort, stagedPort, {recursive: true, errorOnExist: true, force: false});
    const bridgeFile = path.join(stagedPort, 'civ_bridge.js');
    const original = await fs.readFile(bridgeFile, 'utf8');
    const token = "PC_IP: '<PC_IP>'";
    if (original.split(token).length !== 2) throw Error('Pinned CivSwitch bridge address placeholder changed');
    await fs.writeFile(bridgeFile, original.replace(token, "PC_IP: '" + macIp + "'"), {mode: 0o600});
    await prepare(stagedPort);
    return {root, stagedPort, bridgeFile};
  } catch (error) {
    await fs.rm(root, {recursive: true, force: true});
    throw error;
  }
}

function monitor(child, emit) {
  const state = {runPath: null, held: false, exited: false, code: null, signal: null, lines: []};
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const collect = line => {
    state.lines.push(line);
    if (state.lines.length > 24) state.lines.shift();
    const match = /^Run folder: (.+)$/.exec(line);
    if (match) state.runPath = match[1];
    if (/^4\/4 verified\./.test(line)) state.held = true;
    if (/^[1-4]\/4 |^Firmware: /.test(line)) event(emit, 'progress', {message: line});
    changed();
  };
  readline.createInterface({input: child.stdout}).on('line', collect);
  readline.createInterface({input: child.stderr}).on('line', collect);
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    Object.assign(state, {exited: true, code, signal});
    changed();
    resolve({code, signal});
  }));
  function until(predicate, timeoutMs = 0) {
    if (predicate(state)) return Promise.resolve(state);
    if (state.exited) return Promise.reject(Error('CivSwitch FS host exited before it was ready: ' + state.lines.at(-1)));
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        if (predicate(state)) {cleanup(); resolve(state);}
        else if (state.exited) {cleanup(); reject(Error('CivSwitch FS host exited before it was ready: ' + state.lines.at(-1)));}
      };
      const cleanup = () => {listeners.delete(check); clearTimeout(timer);};
      listeners.add(check);
      if (timeoutMs) timer = setTimeout(() => {cleanup(); reject(Error('CivSwitch FS host startup timed out'));}, timeoutMs);
    });
  }
  return {state, until, closed};
}

function sendBridge(consoleIp, port, script, emit) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: consoleIp, port, allowHalfOpen: true});
    let connected = false;
    let buffer = '';
    socket.setTimeout(15000, () => {
      if (!connected) socket.destroy(Error('CivSwitch loader connection timed out'));
    });
    socket.once('connect', () => {
      connected = true;
      socket.setTimeout(0);
      socket.end(script);
      resolve(socket);
    });
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) event(emit, 'bridge-log', {message: line});
      }
    });
    socket.once('error', error => {
      if (!connected) reject(Error('CivSwitch loader connection failed: ' + error.message));
      else event(emit, 'bridge-log', {message: 'CivSwitch loader connection ended: ' + error.message});
    });
  });
}

async function verifiedRun(stagedPort, runPath) {
  const expected = await fs.realpath(path.join(stagedPort, 'engine', 'runs')) + path.sep;
  const resolved = await fs.realpath(runPath);
  if (!resolved.startsWith(expected)) throw Error('CivSwitch FS host reported a run path outside its staged source');
  const resultPath = path.join(resolved, 'result.json');
  const connectionPath = path.join(resolved, 'connection.json');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const connection = JSON.parse(await fs.readFile(connectionPath, 'utf8'));
  if (result.target !== 'civ7' || !result.verified || !result.fs?.verified ||
      !result.fs?.retainedEndpoint?.ready || result.rpc?.state !== 'listening' ||
      !Number.isInteger(connection.port)) {
    throw Error('CivSwitch FS host did not provide verified held RPC and FS proof');
  }
  return {runPath: resolved, resultPath, connectionPath};
}

async function verifiedStop(resultPath) {
  try {
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    return result.rpc?.state === 'closed' && result.fs?.cleanup?.cleanedUp === true && !result.error;
  } catch {
    return false;
  }
}

async function failureDetails(stagedPort, reportedRunPath) {
  if (!stagedPort || typeof reportedRunPath !== 'string') return null;
  try {
    const runs = await fs.realpath(path.join(stagedPort, 'engine', 'runs'));
    const runPath = await fs.realpath(reportedRunPath);
    if (runPath !== reportedRunPath || path.dirname(runPath) !== runs ||
        !/^switch2-[A-Za-z0-9]{6}$/.test(path.basename(runPath))) return null;
    const directory = await fs.lstat(runPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) return null;
    async function readPrivate(file, limit) {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== process.getuid() ||
            (info.mode & 0o077) !== 0 || info.size > limit) return null;
        const buffer = Buffer.alloc(limit + 1);
        let used = 0;
        while (used < buffer.length) {
          const {bytesRead} = await handle.read(buffer, used, buffer.length - used, used);
          if (!bytesRead) break;
          used += bytesRead;
        }
        return used > limit ? null : buffer.toString('utf8', 0, used);
      } catch {return null;} finally {await handle?.close();}
    }
    const resultPath = path.join(runPath, 'result.json');
    const resultText = await readPrivate(resultPath, 64 * 1024);
    let result;
    try {result = resultText && JSON.parse(resultText);} catch {return null;}
    const acquisitionDirectory = path.join(runPath, 'switch2');
    const acquisitionInfo = await fs.lstat(acquisitionDirectory).catch(() => null);
    const acquisitionPath = path.join(acquisitionDirectory, 'acquisition.log');
    const acquisition = acquisitionInfo?.isDirectory() && !acquisitionInfo.isSymbolicLink() &&
      acquisitionInfo.uid === process.getuid() && (acquisitionInfo.mode & 0o077) === 0
      ? await readPrivate(acquisitionPath, 256 * 1024) : null;
    const reason = typeof result?.error === 'string' ? result.error.split('\n', 1)[0]
      .replace(/^Error:\s*/, '').slice(0, 240) : '';
    const cause = acquisition?.split('\n').find(line => /^Error: /.test(line))
      ?.replace(/^Error:\s*/, '').slice(0, 180);
    const logPath = acquisition ? acquisitionPath :
      await readPrivate(path.join(runPath, 'run.log'), 256 * 1024) !== null
        ? path.join(runPath, 'run.log') : resultText ? resultPath : null;
    return {runPath, logPath, reason, cause};
  } catch {return null;}
}

async function waitForLoader(consoleIp, port, options = {}) {
  const emit = options.emit || emitLine;
  const probe = options.probe || require('./probe.cjs').probe;
  const deadline = Date.now() + (options.timeoutMs ?? LOADER_WAIT_MS);
  let lastReport = 0;
  while (Date.now() < deadline) {
    if (options.shouldStop?.()) return false;
    if (options.hostExited?.()) throw Error('CivSwitch FS host stopped while waiting for the saved loader');
    if (Date.now() - lastReport >= 10000 || lastReport === 0) {
      event(emit, 'loader-wait', {message: 'Waiting for the saved CivSwitch loader on the Switch'});
      lastReport = Date.now();
    }
    try {
      await probe(consoleIp, {port, waitMs: 2500, attemptMs: 1500, intervalMs: 250, emit: () => {}});
      if (options.shouldStop?.()) return false;
      if (options.hostExited?.()) throw Error('CivSwitch FS host stopped before the bridge was sent');
      event(emit, 'loader-ready', {message: 'Saved CivSwitch loader verified'});
      return true;
    } catch (error) {
      if (options.shouldStop?.()) return false;
      if (!/The CivSwitch loader did not answer on port |CivSwitch loader probe failed: (?:ECONNRESET|ECONNABORTED|EPIPE)/.test(error.message))
        throw error;
    }
  }
  throw Error('The saved CivSwitch loader did not open within five minutes. Open Load Game on the Switch, then try again.');
}

async function runFsHost(options) {
  const consoleIp = requireIPv4(options.consoleIp, 'Switch');
  const macIp = requireIPv4(options.macIp, 'Mac');
  const runtimeRoot = options.runtimeRoot;
  const emit = options.emit || emitLine;
  const sourcePort = options.sourcePort || SOURCE_PORT;
  const preparation = require('../../scripts/prepare-civswitch-savekit.cjs');
  const prepare = options.prepare || preparation.prepare;
  const verifyPrepared = options.verifyPrepared || preparation.verifyPreparedRun;
  const loaderPort = options.loaderPort || 9026;
  if (!Number.isInteger(loaderPort) || loaderPort < 1 || loaderPort > 65535) throw Error('Invalid CivSwitch loader port');

  let child, loader, staged;
  let host;
  let stopping = false;
  let bridgeSent = false;
  const stop = () => {
    stopping = true;
    if (child && !child.killed && (!bridgeSent || host?.state.held)) child.kill('SIGINT');
  };
  const interrupt = () => stop();
  const terminate = () => stop();
  if (options.handleSignals !== false) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  options.abortSignal?.addEventListener('abort', stop, {once: true});
  try {
    event(emit, 'preparing', {message: 'Preparing the pinned CivSwitch FS host'});
    staged = await stage(sourcePort, runtimeRoot, macIp, prepare);
    if (stopping) {
      await fs.rm(staged.root, {recursive: true, force: true});
      event(emit, 'stopped', {message: 'CivSwitch FS host stopped before starting'});
      return {stopped: true};
    }
    event(emit, 'host-starting', {message: 'Waiting for the CivSwitch FS host', stagePath: staged.root});
    child = (options.spawn || spawn)(process.execPath,
      [path.join(staged.stagedPort, 'engine', 'run.cjs'), '--target', 'civ7', '--rpc', macIp],
      {cwd: staged.stagedPort, env: {...process.env, NS2_TARGET: 'civ7'}, stdio: ['ignore', 'pipe', 'pipe']});
    host = monitor(child, emit);
    await host.until(state => Boolean(state.runPath), 30000);
    const runPath = host.state.runPath;
    if (stopping) {await host.closed; return {stopped: true, runPath};}
    if (options.waitForLoader) {
      const ready = await waitForLoader(consoleIp, loaderPort, {
        emit, probe: options.probeLoader, timeoutMs: options.loaderWaitMs,
        shouldStop: () => stopping, hostExited: () => host.state.exited,
      });
      if (!ready) {
        await host.closed;
        event(emit, 'stopped', {message: 'CivSwitch FS host stopped before the saved loader opened', runPath});
        return {stopped: true, runPath};
      }
    }
    const script = await fs.readFile(staged.bridgeFile, 'utf8');
    if (stopping) {await host.closed; return {stopped: true, runPath};}
    loader = await sendBridge(consoleIp, loaderPort, script, emit);
    bridgeSent = true;
    event(emit, 'bridge-sent', {message: 'CivSwitch bridge sent; waiting for FS verification', runPath});
    await host.until(state => state.held);
    const proof = await verifiedRun(staged.stagedPort, runPath);
    await verifyPrepared(runtimeRoot, proof.runPath);
    event(emit, 'held-ready', {message: 'CivSwitch FS and RPC verified', ...proof});
    if (stopping) stop();
    const outcome = await host.closed;
    if (!stopping || !(await verifiedStop(proof.resultPath))) {
      throw Error('Held CivSwitch FS host ended unexpectedly: ' + (host.state.lines.at(-1) || outcome.signal || outcome.code));
    }
    event(emit, 'stopped', {message: 'CivSwitch FS host stopped', runPath});
    return {stopped: true, ...proof};
  } catch (error) {
    if (child && !child.killed && (!bridgeSent || host?.state.held)) child.kill('SIGINT');
    const details = await failureDetails(staged?.stagedPort, host?.state.runPath);
    const message = details?.reason && /exited before it was ready/.test(error.message)
      ? details.reason.replace(/\. Inspect .*/, '') + (details.cause ? ': ' + details.cause : '')
      : error.message;
    event(emit, 'failed', {message, ...(details?.runPath ? {runPath: details.runPath} : {}),
      ...(details?.logPath ? {logPath: details.logPath} : {})});
    throw error;
  } finally {
    if (loader && !loader.destroyed) loader.destroy();
    options.abortSignal?.removeEventListener('abort', stop);
    if (options.handleSignals !== false) {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    }
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length < 3 || args.length > 4 || (args.length === 4 && args[3] !== '--wait-for-loader'))
    throw Error('usage: node fs-host.cjs SWITCH_IPV4 MAC_IPV4 RUNTIME_ROOT [--wait-for-loader]');
  await runFsHost({consoleIp: args[0], macIp: args[1], runtimeRoot: args[2],
    waitForLoader: args[3] === '--wait-for-loader'});
}

if (require.main === module) main().catch(() => {process.exitCode = 1;});

module.exports = {runFsHost, stage, monitor, sendBridge, verifiedRun, verifiedStop,
  failureDetails, waitForLoader, PREFIX};
