'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const {runCompatibilityCheck, request} = require('./fs-host.cjs');

const PREFIX = 'MAC2JB_ARTEMIS_FS ';
const SOURCE = path.join(__dirname, 'kit', 'port');
const BRIDGE = 'nora/nora_bridge.lua';

function emitLine(value) { process.stdout.write(PREFIX + JSON.stringify(value) + '\n'); }

async function stage(runtimeRoot, source = SOURCE) {
  if (!path.isAbsolute(runtimeRoot) || path.resolve(runtimeRoot) !== runtimeRoot)
    throw Error('Runtime root must be an absolute canonical path');
  const runs = path.join(runtimeRoot, 'runs');
  await fs.mkdir(runs, {recursive: true, mode: 0o700});
  const root = path.join(runs, 'artemis-fs-' + crypto.randomBytes(8).toString('hex'));
  await fs.mkdir(root, {mode: 0o700});
  try {
    const port = path.join(root, 'port');
    await fs.cp(source, port, {recursive: true, errorOnExist: true, force: false});
    await require('../../scripts/prepare-artemis-fs.cjs').prepare(port);
    return {root, port, bridge: path.join(port, BRIDGE)};
  } catch (error) {
    await fs.rm(root, {recursive: true, force: true});
    throw error;
  }
}

function monitor(child, emit) {
  const state = {runPath: null, held: false, exited: false, lines: []};
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const line = value => {
    state.lines.push(value);
    if (state.lines.length > 32) state.lines.shift();
    const run = /^Run folder: (.+)$/.exec(value);
    if (run) state.runPath = run[1];
    if (/^4\/4 verified\./.test(value)) state.held = true;
    if (/^[1-4]\/4 |^Firmware: /.test(value))
      emit({type: 'progress', message: value, ...(state.runPath ? {runPath: state.runPath} : {})});
    changed();
  };
  readline.createInterface({input: child.stdout}).on('line', line);
  readline.createInterface({input: child.stderr}).on('line', line);
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    Object.assign(state, {exited: true, code, signal}); changed(); resolve({code, signal});
  }));
  function until(predicate, timeoutMs = 0) {
    if (predicate(state)) return Promise.resolve(state);
    if (state.exited) return Promise.reject(Error('Artemis FS host stopped before verification: ' + (state.lines.at(-1) || 'no output')));
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        if (predicate(state)) {cleanup(); resolve(state);}
        else if (state.exited) {cleanup(); reject(Error('Artemis FS host stopped before verification: ' + (state.lines.at(-1) || 'no output')));}
      };
      const cleanup = () => {listeners.delete(check); clearTimeout(timer);};
      listeners.add(check);
      if (timeoutMs) timer = setTimeout(() => {cleanup(); reject(Error('Artemis FS host timed out before verification'));}, timeoutMs);
    });
  }
  return {state, closed, until};
}

async function verifiedRun(port, reported) {
  const expected = await fs.realpath(path.join(port, 'engine', 'runs')) + path.sep;
  const runPath = await fs.realpath(reported);
  if (runPath !== reported || !runPath.startsWith(expected) ||
      !/^switch2-[A-Za-z0-9_-]{1,64}$/.test(path.basename(runPath)))
    throw Error('Artemis FS host reported a run outside its private source');
  const resultPath = path.join(runPath, 'result.json');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const connection = JSON.parse(await fs.readFile(path.join(runPath, 'connection.json'), 'utf8'));
  if (result.target !== 'artemis-seedsow' || !result.verified || !result.fs?.verified ||
      result.fs?.retainedEndpoint?.ready !== true || result.rpc?.mode !== 'held' ||
      result.rpc?.state !== 'listening' || connection.addresses?.target !== 'artemis-seedsow' ||
      !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)
    throw Error('Artemis FS host did not produce verified held RPC and filesystem proof');
  await require('../../scripts/gui-dump.cjs').verifiedSession(runPath);
  await require('../../scripts/prepare-artemis-fs.cjs').verifyPreparedRun(null, runPath);
  return {runPath, resultPath};
}

async function verifiedStop(resultPath) {
  try {
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    return result.rpc?.state === 'closed' && result.fs?.cleanup?.cleanedUp === true && !result.error;
  } catch {return false;}
}

async function runFsHost(options) {
  const emit = options.emit || emitLine;
  const runtimeRoot = options.runtimeRoot;
  let child, host, staged, bridgeController, bridgePromise, heldProof;
  let stopping = false, bridgeError;
  const stop = () => {
    stopping = true;
    if (child && !child.killed) child.kill('SIGINT');
  };
  if (options.handleSignals !== false) {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  options.abortSignal?.addEventListener('abort', stop, {once: true});
  try {
    const profile = await runCompatibilityCheck({...options, emit: value => {
      if (value.type !== 'probe-ready' && value.type !== 'failed') emit(value);
    }});
    if (profile.game !== 'seedsow') throw Error('Only Seedsow Lullaby has an experimental Artemis FS bridge');
    if (stopping) {emit({type:'stopped', message:'Artemis FS attempt stopped'}); return {stopped:true};}
    emit({type:'preparing', message:'Preparing the pinned Seedsow filesystem host'});
    staged = await stage(runtimeRoot, options.sourcePort || SOURCE);
    if (stopping) {emit({type:'stopped', message:'Artemis FS attempt stopped'}); return {stopped:true};}
    child = (options.spawn || spawn)(process.execPath,
      [path.join(staged.port, 'engine', 'run.cjs'), '--target', 'artemis-seedsow', '--rpc', options.macIp],
      {cwd: staged.port, env: {...process.env, NS2_TARGET:'artemis-seedsow',
        NS2_CONSOLE_IP:options.consoleIp, NS2_ROM_MOUNT:'game', NS2_CONNECT_TIMEOUT_MS:'120000'},
      stdio:['ignore','pipe','pipe']});
    host = monitor(child, emit);
    const script = await fs.readFile(staged.bridge, 'utf8');
    if (Buffer.byteLength(script) > 0x7000) throw Error('Artemis bridge exceeds the launcher upload limit');
    if (stopping) {await host.closed; emit({type:'stopped', message:'Artemis FS attempt stopped'}); return {stopped:true};}
    bridgeController = new AbortController();
    bridgePromise = request(options.consoleIp, options.port || 8080, 'POST', '/eval', script,
      {timeoutMs:0, limit:1024 * 1024, signal:bridgeController.signal}).then(response => {
      if (!response.startsWith('status: ok\n'))
        bridgeError = Error('Artemis bridge returned an error: '+response.trim().slice(0, 240));
    }, error => {bridgeError = error;});
    const earlyBridgeEnd = bridgePromise.then(() => {
      if (!host.state.held) throw bridgeError || Error('Artemis bridge ended before filesystem verification');
    });
    emit({type:'progress', message:'Sending Seedsow bridge and connecting the filesystem host'});
    await Promise.race([host.until(state => Boolean(state.runPath), 130000), earlyBridgeEnd]);
    emit({type:'progress', message:'Seedsow bridge connected; waiting for filesystem verification', runPath:host.state.runPath});
    await Promise.race([
      host.until(state => state.held),
      earlyBridgeEnd,
    ]);
    heldProof = await verifiedRun(staged.port, host.state.runPath);
    emit({type:'held-ready', message:'Seedsow filesystem access and held RPC verified', runPath:heldProof.runPath,
      resultPath:heldProof.resultPath});
    const outcome = await host.closed;
    if (!stopping || !(await verifiedStop(heldProof.resultPath)))
      throw Error('Held Artemis FS host ended unexpectedly: '+(host.state.lines.at(-1) || outcome.signal || outcome.code));
    emit({type:'stopped', message:'Artemis FS session finished', runPath:heldProof.runPath});
    return {stopped:true, runPath:heldProof.runPath};
  } catch (error) {
    if (child && !child.killed) child.kill('SIGINT');
    const runPath = host?.state.runPath;
    emit({type:'failed', message:error.message,
      ...(runPath ? {runPath, logPath:path.join(runPath, 'run.log')} : {})});
    throw error;
  } finally {
    bridgeController?.abort();
    await bridgePromise?.catch(() => {});
    options.abortSignal?.removeEventListener('abort', stop);
    if (options.handleSignals !== false) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

module.exports = {runFsHost, stage, monitor, verifiedRun, verifiedStop};
