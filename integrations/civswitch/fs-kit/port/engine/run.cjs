#!/usr/bin/env node
const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {listen} = require('./lib/connection.cjs');
const {NativeClient} = require('./lib/native.cjs');
const {qualify} = require('./lib/qualify.cjs');
const {serve} = require('./lib/bridge.cjs');
const {loadTarget, selectedTarget, assertFullSupported, assertWorkerSupported, assertCanarySupported,
  materializeTarget, validateArtifacts} = require('./shared/target.cjs');

const port = 39380;
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const DUMP_MARKER = '.ns2jb-firmware-dump.json';

async function prepareRunRoot(runRoot = process.env.NS2_RUN_ROOT) {
  if (runRoot === undefined) {
    const workspace = path.join(__dirname, 'runs');
    await fs.mkdir(workspace, {recursive: true, mode: 0o700});
    return workspace;
  }
  if (typeof runRoot !== 'string' || !runRoot || !path.isAbsolute(runRoot) ||
      runRoot.includes('\0') || runRoot.split(path.sep).includes('..') ||
      path.normalize(runRoot) !== runRoot || runRoot === path.parse(runRoot).root)
    throw Error('NS2_RUN_ROOT must be a normalized absolute directory without parent traversal');
  const root = path.parse(runRoot).root;
  let current = root;
  for (const part of path.relative(root, runRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let entry;
    try {entry = await fs.lstat(current);}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {await fs.mkdir(current, {mode: 0o700});}
      catch (mkdirError) {if (mkdirError.code !== 'EEXIST') throw mkdirError;}
      entry = await fs.lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw Error('Refusing a symlink or non-directory in NS2_RUN_ROOT: ' + current);
  }
  if (path.relative(await fs.realpath(runRoot), runRoot) !== '')
    throw Error('Refusing a symlink in NS2_RUN_ROOT: ' + runRoot);
  return runRoot;
}

async function prepareDumpDirectory(root = path.join(__dirname, 'dumps')) {
  const parent = path.dirname(root);
  const previous = await fs.lstat(root).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink() ||
        previous.dev !== (await fs.stat(parent)).dev)
      throw Error('Refusing to clean a symlink, mount, or non-directory at ' + root);
    const marker = await fs.readFile(path.join(root, DUMP_MARKER), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!marker || marker.kind !== 'ns2jb-system-code-dump' || marker.version !== 1) {
      if ((await fs.readdir(root)).length)
        throw Error('Refusing to clean an unrecognized nonempty dumps directory: ' + root);
    }
    await fs.rm(root, {recursive: true});
  }
  await fs.mkdir(root, {mode: 0o700});
  await fs.writeFile(path.join(root, DUMP_MARKER), JSON.stringify({
    kind: 'ns2jb-system-code-dump', version: 1, started: new Date().toISOString()
  }, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  return {root, cleaned: !!previous};
}

function addresses(interfaces = os.networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(a =>
    a.family === 'IPv4' && !a.internal && a.netmask !== '255.255.255.255' &&
    !a.address.startsWith('169.254.')).map(a => a.address))];
}

async function chooseHost(args) {
  if (args.length > 1 || args.length === 1 && !net.isIPv4(args[0]))
    throw Error('Usage: node engine/run.cjs [--target civ7|smilebasic|gravcirc] [--rpc] [--dump-firmware] [--write-size-only|--geometry-only|--canary-only] [computer-IP]');
  if (args.length) return args[0];
  const choices = addresses();
  if (choices.length === 1) return choices[0];
  if (!choices.length) throw Error('Connect this computer to the console’s local network.');
  if (!process.stdin.isTTY)
    throw Error('Choose the address on the console’s network: node engine/run.cjs IP\nAvailable: ' + choices.join(', '));
  choices.forEach((address, i) => console.log(`  ${i + 1}. ${address}`));
  const input = require('node:readline/promises').createInterface({input: process.stdin, output: process.stdout});
  try {
    const choice = await input.question('Which computer address can the Switch 2 reach? ');
    if (!/^[1-9][0-9]*$/.test(choice) || !choices[Number(choice) - 1]) throw Error('Choose one of the listed addresses.');
    return choices[Number(choice) - 1];
  } finally {input.close();}
}

function connectCommand(host, basicArgs = 5) {
  if (![5, 9].includes(basicArgs)) throw Error('NS2_BASIC_ARITY must be 5 or 9');
  return `V=START(${[port, ...host.split('.'), ...(basicArgs === 9 ? [0, 0, 0, 0] : [])].join(',')})`;
}

function parseArguments(args) {
  let targetName = process.env.NS2_TARGET || 'civ7';
  const hostArgs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target') {
      if (++i === args.length) throw Error('--target requires civ7, smilebasic, or gravcirc');
      targetName = args[i];
    } else if (arg.startsWith('--target=')) targetName = arg.slice('--target='.length);
    else if (['--rpc', '--dump-firmware', '--app-only', '--canary-only', '--geometry-only',
      '--write-size-only', '--one-mib-retry', '--split-mib'].includes(arg)) continue;
    else hostArgs.push(arg);
  }
  const appOnly = args.includes('--app-only');
  const canaryOnly = args.includes('--canary-only');
  const geometryOnly = args.includes('--geometry-only');
  const writeSizeOnly = args.includes('--write-size-only');
  const oneMiBRetry = args.includes('--one-mib-retry');
  const splitMiB = args.includes('--split-mib');
  if (oneMiBRetry && (appOnly || canaryOnly || geometryOnly || writeSizeOnly ||
      splitMiB || args.includes('--rpc') || args.includes('--dump-firmware') ||
      process.env.NS2_RPC_MODE === '1'))
    throw Error('--one-mib-retry cannot be combined with another run mode');
  if (splitMiB && (appOnly || canaryOnly || geometryOnly || writeSizeOnly || oneMiBRetry ||
      args.includes('--rpc') || args.includes('--dump-firmware') || process.env.NS2_RPC_MODE === '1'))
    throw Error('--split-mib cannot be combined with another run mode');
  if (appOnly && (args.includes('--rpc') || args.includes('--dump-firmware') || process.env.NS2_RPC_MODE === '1'))
    throw Error('--app-only cannot be combined with --rpc or --dump-firmware');
  if (canaryOnly && (appOnly || args.includes('--rpc') || args.includes('--dump-firmware') ||
      process.env.NS2_RPC_MODE === '1'))
    throw Error('--canary-only cannot be combined with --app-only, --rpc, or --dump-firmware');
  if (geometryOnly && (appOnly || canaryOnly || writeSizeOnly || args.includes('--rpc') ||
      args.includes('--dump-firmware') || process.env.NS2_RPC_MODE === '1'))
    throw Error('--geometry-only cannot be combined with another run mode');
  if (writeSizeOnly && (appOnly || canaryOnly || geometryOnly || args.includes('--rpc') ||
      args.includes('--dump-firmware') || process.env.NS2_RPC_MODE === '1'))
    throw Error('--write-size-only cannot be combined with another run mode');
  const selectedName = selectedTarget(targetName);
  if ((writeSizeOnly || oneMiBRetry || splitMiB) && selectedName !== 'gravcirc')
    throw Error('Save write diagnostics are currently scoped to Gravity Circuit');
  const maxWriteSize = writeSizeOnly ?
    require('./switch2/app/write-size-transaction.cjs').selectedGeometrySizes(
      process.env.NS2_WRITE_SIZE_MAX, true).at(-1) : null;
  const retrySize = oneMiBRetry ?
    require('./switch2/app/one-mib-transaction.cjs').parseOneShotSize(process.env.NS2_ONE_SHOT_SIZE) : null;
  if (writeSizeOnly && maxWriteSize > 0x80000)
    throw Error('--write-size-only must stop at or before the 512 KiB candidate');
  return {targetName: selectedName, hostArgs, appOnly,
    rpcMode: args.includes('--rpc') || process.env.NS2_RPC_MODE === '1',
    dumpFirmware: args.includes('--dump-firmware'), canaryOnly, geometryOnly, writeSizeOnly,
    oneMiBRetry, splitMiB, maxWriteSize, retrySize};
}

async function sourceDigest(target = loadTarget(selectedTarget(process.env.NS2_TARGET || 'smilebasic'))) {
  const names = ['run.cjs', 'rpc.cjs', 'dump-firmware.cjs', 'bootstrap.bas'];
  async function walk(folder) {
    for (const entry of await fs.readdir(path.join(__dirname, folder), {withFileTypes: true})) {
      const name = folder + '/' + entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw Error('Unexpected runtime file: ' + name);
    }
  }
  for (const folder of ['lib', 'shared', 'switch2']) await walk(folder);
  const entries = [];
  for (const name of names.sort()) entries.push([name,
    crypto.createHash('sha256').update(await fs.readFile(path.join(__dirname, name))).digest('hex')]);
  const artifacts = validateArtifacts(target);
  const files = [artifacts.sdkFunctions, artifacts.sdkLayout, ...Object.values(artifacts.app)].filter(Boolean);
  for (const artifact of files) entries.push(['artifact/' + path.relative(target.portRoot, artifact.file),
    crypto.createHash('sha256').update(await fs.readFile(artifact.file)).digest('hex')]);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function startEngine(directory, dumpDirectory = null, held = false, target = loadTarget(),
                           appOnly = false, canaryOnly = false, geometryOnly = false,
                           writeSizeOnly = false, maxWriteSize = null, oneMiBRetry = false,
                           retrySize = null, splitMiB = false) {
  const log = await fs.open(path.join(directory, 'run.log'), 'wx', 0o600);
  const output = createWriteStream(null, {fd: log.fd, autoClose: false});
  const child = spawn(process.execPath, [path.join(directory, 'switch2/pipeline.cjs'),
    ...(dumpDirectory ? ['--dump-firmware'] : []), ...(held ? ['--hold-rpc'] : []),
    ...(appOnly ? ['--app-only'] : []), ...(canaryOnly ? ['--canary-only'] : []),
    ...(geometryOnly ? ['--geometry-only'] : []),
    ...(writeSizeOnly ? ['--write-size-only'] : []),
    ...(oneMiBRetry ? ['--one-mib-retry'] : []),
    ...(splitMiB ? ['--split-mib'] : [])],
    {cwd: directory, stdio: ['ignore', 'pipe', 'pipe', ...(held ? ['ipc'] : [])], windowsHide: true,
      env: {...process.env, NS2_TARGET: target.name, NS2_TARGET_ROOT: directory,
        ...(writeSizeOnly ? {NS2_WRITE_SIZE_MAX: String(maxWriteSize)} : {}),
        ...(oneMiBRetry ? {NS2_ONE_SHOT_SIZE: String(retrySize)} : {}),
        ...(dumpDirectory ? {NS2_FIRMWARE_DUMP_DIR: dumpDirectory} : {})}});
  child.stdout.pipe(output, {end: false});
  child.stderr.pipe(output, {end: false});
  const lines = readline.createInterface({input: child.stdout});
  lines.on('line', line => {
    if (/^[1-4]\/4 |^Firmware: /.test(line)) console.log(line);
  });
  let childError;
  child.once('error', error => {childError = error;});
  output.once('error', error => {childError = error; child.kill('SIGTERM');});
  const finished = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})))
    .then(async outcome => {
    if (!output.destroyed)
      await new Promise((resolve, reject) => {output.once('error', reject); output.end(resolve);});
    await log.close();
    return {...outcome, error: childError};
  });
  const ready = held ? new Promise((resolve, reject) => {
    const message = value => {
      if (value?.type !== 'held-ready') return;
      child.removeListener('message', message);
      resolve(value);
    };
    child.on('message', message);
    finished.then(outcome => {
      child.removeListener('message', message);
      reject(outcome.error || Error('The FS endpoint exited before the held session was ready.'));
    }, reject);
  }) : null;
  let releaseSent = false;
  return {child, finished, ready,
    async release() {
      if (held && !releaseSent && child.connected) {
        releaseSent = true;
        child.send({type: 'release'});
      }
      return finished;
    }};
}

function checkEngine(outcome) {
  if (outcome.error) throw outcome.error;
  if (outcome.code !== 0)
    throw Error('The run stopped. Keep the runs folder and restart the console before trying again.');
}

async function readCanaryOutcome(directory) {
  const current = path.join(directory, 'switch2/canary-current.json');
  try {
    return JSON.parse(await fs.readFile(current));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const memory = path.join(directory, 'switch2/memory');
  const files = await fs.readdir(memory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const latest = files.filter(name => /^reserved-gap-\d+\.json$/.test(name)).sort().at(-1);
  if (!latest) throw Error('The canary stage stopped before producing a verification report.');
  const reportPath = path.join(memory, latest);
  const report = JSON.parse(await fs.readFile(reportPath));
  if (report.directLengthEnabled) {
    const levels = (report.directLength?.levels || []).map(level =>
      `${level.size} bytes marker=${level.direct?.marker?.result ?? 'missing'}` +
      ` absent=${level.direct?.absent?.result ?? 'missing'}`).join(', ');
    throw Error(`Direct-length diagnostic ${report.cleanedUp ? 'cleaned up' : 'did not clean up'}: ` +
      `${levels || 'no levels'}. Report: ${reportPath}`);
  }
  const cases = Array.isArray(report.cases) ? report.cases.length : 0;
  const qualified = (report.extentLadder?.levels || []).reduce((count, level) =>
    count + (level.attempts || []).filter(attempt => attempt.qualified).length, 0);
  const hits = (report.cases || []).filter(item => item.selectedMarker).length;
  const cleanup = report.cleanedUp ? 'cleanup completed' : 'cleanup incomplete';
  throw Error(`Positive canary not verified: ${cases} cases, ${qualified} qualified placement windows, ` +
    `${hits} marker hits; ${cleanup}. Report: ${reportPath}`);
}

function waitForRpcStop(connection, signals = process, engineFinished = null) {
  return new Promise(resolve => {
    const socket = connection.socket;
    let settled = false;
    const finish = reason => {
      if (settled) return;
      settled = true;
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', terminate);
      socket.removeListener('close', disconnected);
      resolve(reason);
    };
    const interrupt = () => finish('SIGINT');
    const terminate = () => finish('SIGTERM');
    const disconnected = () => finish('disconnected');
    signals.once('SIGINT', interrupt);
    signals.once('SIGTERM', terminate);
    socket.once('close', disconnected);
    if (engineFinished) engineFinished.then(() => finish('engine-exited'), () => finish('engine-exited'));
    if (connection.error || socket.destroyed) finish('disconnected');
  });
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node engine/run.cjs [--target civ7|smilebasic|gravcirc] [--app-only|--write-size-only|--one-mib-retry|--split-mib|--geometry-only|--canary-only] [--rpc] [--dump-firmware] [computer-IP]\n' +
      'The default target is Civ7 via CivSwitch. Set NS2_WRITE_SIZE_MAX=524288 with --write-size-only for bounded Gravity Circuit save writes. --one-mib-retry clears only owned scratch and attempts one 1 MiB file. --split-mib commits a 1 MiB file creation and two 512 KiB writes separately. --geometry-only measures owned save geometry; --canary-only stops after positive canary verification.');
    return;
  }
  const options = parseArguments(args), {rpcMode, dumpFirmware, appOnly, canaryOnly, geometryOnly,
    writeSizeOnly, maxWriteSize, oneMiBRetry, retrySize, splitMiB} = options;
  const selected = loadTarget(options.targetName);
  const markerBoundary = process.env.NS2_MARKER_BOUNDARY === '1';
  const markerMatchedAbsent = process.env.NS2_MARKER_MATCHED_ABSENT === '1';
  const markerAssembly = process.env.NS2_MARKER_ASSEMBLY === '1';
  const markerFirstDescriptor = process.env.NS2_MARKER_FIRST_DESCRIPTOR === '1';
  const markerFirstSeam = process.env.NS2_MARKER_FIRST_SEAM === '1';
  const directLength = process.env.NS2_DIRECT_LENGTH === '1';
  const xSizeThreshold = process.env.NS2_X_SIZE_THRESHOLD === '1';
  const twoXDirect = process.env.NS2_TWO_X_DIRECT === '1';
  const singlePositive = process.env.NS2_SINGLE_POSITIVE === '1';
  const holeTiming = process.env.NS2_HOLE_TIMING === '1';
  const earlyPositive = process.env.NS2_EARLY_SINGLE_POSITIVE === '1';
  const firstXPositive = process.env.NS2_GC_FIRST_X_POSITIVE === '1';
  const validParentPositive = process.env.NS2_GC_VALID_PARENT_POSITIVE === '1';
  if (holeTiming && (!canaryOnly || selected.name !== 'gravcirc' || singlePositive ||
      earlyPositive ||
      markerBoundary || markerMatchedAbsent || markerAssembly || markerFirstDescriptor ||
      markerFirstSeam || directLength || xSizeThreshold || twoXDirect ||
      process.env.NS2_EXTENT_LADDER === '1' || process.env.NS2_POSITIVE_FILL_SEGMENT))
    throw Error('Hole timing diagnostic requires unmodified Gravity Circuit canary-only mode');
  if (singlePositive && (!canaryOnly || selected.name !== 'gravcirc' ||
      earlyPositive ||
      markerBoundary || markerMatchedAbsent || markerAssembly || markerFirstDescriptor ||
      markerFirstSeam || directLength || xSizeThreshold || twoXDirect ||
      process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('Single-positive diagnostic requires unmodified Gravity Circuit canary-only mode');
  if (earlyPositive && (!canaryOnly || selected.name !== 'gravcirc' || holeTiming ||
      singlePositive || markerBoundary || markerMatchedAbsent || markerAssembly ||
      markerFirstDescriptor || markerFirstSeam || directLength || xSizeThreshold ||
      twoXDirect || process.env.NS2_EXTENT_LADDER === '1' ||
      process.env.NS2_POSITIVE_FILL_SEGMENT))
    throw Error('Early positive diagnostic requires unmodified Gravity Circuit canary-only mode');
  if (firstXPositive && (!earlyPositive || !canaryOnly || selected.name !== 'gravcirc'))
    throw Error('First-X positive diagnostic requires Gravity Circuit early-positive canary-only mode');
  if (validParentPositive && (!firstXPositive ||
      process.env.NS2_GC_FIRST_X_SLASH_SPLIT !== '1' ||
      process.env.NS2_GC_FIRST_X_TERMINATED !== '1' ||
      process.env.NS2_GC_FIRST_X_TAIL_SPACING !== '1' ||
      process.env.NS2_GC_FIRST_X_EDGE_OFFSET === '1'))
    throw Error('Valid-parent positive requires the bounded 0x700 first-X mode');
  if (markerBoundary && (!canaryOnly || selected.name !== 'gravcirc' ||
      process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('Marker boundary requires Gravity Circuit canary-only mode');
  if (markerMatchedAbsent && !markerBoundary)
    throw Error('Matched absent path requires the marker boundary diagnostic');
  if (markerAssembly && (!markerBoundary || !markerMatchedAbsent))
    throw Error('Marker assembly requires matched absent boundary mode');
  if (markerFirstDescriptor && (!canaryOnly || selected.name !== 'gravcirc' ||
      markerBoundary || markerAssembly || markerFirstSeam || process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('First-descriptor diagnostic requires Gravity Circuit canary-only mode');
  if (markerFirstSeam && (!canaryOnly || selected.name !== 'gravcirc' ||
      markerBoundary || markerAssembly || markerFirstDescriptor || directLength ||
      xSizeThreshold || process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('First-seam diagnostic requires Gravity Circuit canary-only mode');
  if (directLength && (!canaryOnly || selected.name !== 'gravcirc' || markerBoundary ||
      markerAssembly || markerFirstDescriptor || markerFirstSeam || process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('Direct-length diagnostic requires Gravity Circuit canary-only mode');
  if (xSizeThreshold && (!canaryOnly || selected.name !== 'gravcirc' || markerBoundary ||
      markerAssembly || markerFirstDescriptor || markerFirstSeam || directLength ||
      process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('X descriptor threshold requires Gravity Circuit canary-only mode');
  if (twoXDirect && (!canaryOnly || selected.name !== 'gravcirc' || markerBoundary ||
      markerAssembly || markerFirstDescriptor || markerFirstSeam || directLength ||
      xSizeThreshold || process.env.NS2_EXTENT_LADDER === '1'))
    throw Error('Two-X direct diagnostic requires Gravity Circuit canary-only mode');
  const target = canaryOnly ? assertCanarySupported(selected) :
    (appOnly || geometryOnly || writeSizeOnly || oneMiBRetry || splitMiB) &&
      selected.name === 'gravcirc' ?
      assertWorkerSupported(selected) : assertFullSupported(selected);
  if (canaryOnly && target.name === 'gravcirc')
    require('./switch2/memory/geometry-proof.cjs').requireGeometryProof(
      target, process.env.NS2_GC_GEOMETRY_PROOF);
  if (earlyPositive)
    require('./switch2/memory/timing-proof.cjs').requireTimingProof(
      target, process.env.NS2_GC_RECEIVE_TIMING_REPORT);
  if (geometryOnly && target.name !== 'gravcirc')
    throw Error('--geometry-only is currently scoped to Gravity Circuit');
  process.env.NS2_TARGET = target.name;
  const host = await chooseHost(options.hostArgs);
  const basicArgs = Number(process.env.NS2_BASIC_ARITY || 5);
  const command = target.name === 'smilebasic' ? connectCommand(host, basicArgs) :
    target.name === 'gravcirc' ?
      `Keep Gravity Circuit open and relay its verified native bridge to ${host}:${port}.` :
      `Set PC_IP='${host}' and PC_PORT=${port} in civ_bridge.js, then launch the completed CivSwitch bridge.`;
  const workspace = await prepareRunRoot();
  let dumpDirectory;
  if (dumpFirmware) {
    const space = await fs.statfs(workspace);
    if (BigInt(space.bavail) * BigInt(space.bsize) < 512n * 1024n * 1024n)
      throw Error('The optional system-code dump needs at least 512 MiB free on the computer before starting.');
    const prepared = await prepareDumpDirectory();
    dumpDirectory = prepared.root;
    if (prepared.cleaned) console.log('Previous system-code dump removed from ' + dumpDirectory);
    console.log('System-code dump folder: ' + dumpDirectory);
  }
  const directory = await fs.mkdtemp(path.join(workspace, 'switch2-'));
  await fs.writeFile(path.join(directory, 'connect.txt'), command + '\n', {mode: 0o600});
  const result = {platform: 2, target: target.name,
    scope: splitMiB ? 'split-mib' : oneMiBRetry ? 'one-mib-retry' :
      writeSizeOnly ? 'write-size-only' : geometryOnly ? 'geometry-only' :
      canaryOnly ? 'canary-only' : appOnly ? 'app-only' : 'full',
    sourceSha256: await sourceDigest(target), started: new Date().toISOString(), verified: false};
  let native, bridge, engine, failure;
  try {
    const connected = await listen({host, port, target, onWaiting() {
      console.log(`Waiting for ${target.displayName} at ${host}:${port}.`);
      if (target.name === 'smilebasic') {
        console.log('In a freshly opened SmileBASIC, load the saved bootstrap and enter:');
        console.log('  RUN\n  REMOVE NSR,&H60000000,&H3FFFFFFF');
        console.log('After the expected Out of memory message, enter:');
        console.log('  ' + command);
        if (basicArgs === 5) {
          console.log('If BASIC says Wrong number of arguments, use the older nine-argument form instead:');
          console.log('  ' + connectCommand(host, 9));
        }
      } else console.log(command);
      console.log('Run folder: ' + directory);
    }});
    native = new NativeClient(connected.connection, connected.addresses, target);
    if (target.name === 'gravcirc') result.compactWire = await native.negotiateCompact();
    console.log('Connected. Checking the application...');
    result.bootstrap = await qualify(native);
    bridge = await serve(native);
    bridge.keepAwake(result.bootstrap.activity);
    await save(path.join(directory, 'connection.json'), {port: bridge.port,
      addresses: {...connected.addresses, session: path.basename(directory), target: target.name}});
    for (const name of ['shared', 'switch2'])
      await fs.cp(path.join(__dirname, name), path.join(directory, name), {recursive: true});
    await materializeTarget(target, directory);
    engine = await startEngine(directory, dumpDirectory, rpcMode, target,
      appOnly, canaryOnly, geometryOnly, writeSizeOnly, maxWriteSize, oneMiBRetry, retrySize,
      splitMiB);
    if (rpcMode) await engine.ready;
    else checkEngine(await engine.finished);
    if (appOnly) {
      result.app = JSON.parse(await fs.readFile(path.join(directory, 'switch2/app-qualification-current.json')));
      if (!result.app.verified || !result.app.cleanup?.cleanedUp)
        throw Error('Application-only qualification or cleanup did not verify.');
    } else if (splitMiB) {
      result.splitMiB = JSON.parse(await fs.readFile(path.join(directory, 'switch2/split-mib-current.json')));
      if (result.splitMiB.session !== path.basename(directory) ||
          !require('./switch2/app/split-mib-transaction.cjs').verifiesSplitMiB(
            result.splitMiB, target.name))
        throw Error('Split MiB Gravity Circuit save write or cleanup did not verify.');
    } else if (oneMiBRetry) {
      result.oneMiB = JSON.parse(await fs.readFile(path.join(directory, 'switch2/one-mib-current.json')));
      if (result.oneMiB.session !== path.basename(directory) ||
          !require('./switch2/app/one-mib-transaction.cjs').verifiesOneMiBRetry(
            result.oneMiB, target.name, retrySize))
        throw Error('One MiB Gravity Circuit save write or cleanup did not verify.');
    } else if (writeSizeOnly) {
      result.writeSize = JSON.parse(await fs.readFile(path.join(directory, 'switch2/write-size-current.json')));
      if (result.writeSize.session !== path.basename(directory) ||
          !require('./switch2/app/write-size-transaction.cjs').verifiesBoundedWrite(
            result.writeSize, target.name, maxWriteSize))
        throw Error('Bounded Gravity Circuit save write or cleanup did not verify.');
    } else if (geometryOnly) {
      result.geometry = JSON.parse(await fs.readFile(path.join(directory, 'switch2/geometry-current.json')));
      if (!result.geometry.verified || result.geometry.session !== path.basename(directory) ||
          !result.geometry.cleanedUp || result.geometry.pinningAllocationBytes <= 0)
        throw Error('Gravity Circuit geometry measurement or cleanup did not complete.');
    } else if (canaryOnly && earlyPositive) {
      result.earlyPositive = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/early-positive-current.json')));
      if (result.earlyPositive.session !== path.basename(directory) ||
          result.earlyPositive.diagnostic !== 'early-positive' ||
          !result.earlyPositive.cleanedUp ||
          !['marker-hit', 'unqualified-marker-hit', 'qualified-miss', 'no-qualified-window',
            'controls-inconclusive', 'timing-inconclusive'].includes(result.earlyPositive.status))
        throw Error('Early positive diagnostic or cleanup did not complete.');
    } else if (canaryOnly && holeTiming) {
      result.holeTiming = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/hole-timing-current.json')));
      if (result.holeTiming.session !== path.basename(directory) ||
          result.holeTiming.diagnostic !== 'hole-timing' ||
          !result.holeTiming.cleanedUp ||
          !['window-found', 'no-window'].includes(result.holeTiming.status))
        throw Error('Hole timing diagnostic or cleanup did not complete.');
    } else if (canaryOnly && singlePositive) {
      result.singlePositive = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/single-positive-current.json')));
      if (result.singlePositive.session !== path.basename(directory) ||
          result.singlePositive.diagnostic !== 'single-positive' ||
          !result.singlePositive.cleanedUp ||
          !['marker-hit', 'qualified-miss', 'no-qualified-window',
            'controls-inconclusive'].includes(result.singlePositive.status))
        throw Error('Single-positive diagnostic or cleanup did not complete.');
    } else if (canaryOnly && twoXDirect) {
      result.twoXDirect = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/two-x-direct-current.json')));
      if (result.twoXDirect.session !== path.basename(directory) ||
          result.twoXDirect.diagnostic !== 'two-x-direct' ||
          !result.twoXDirect.cleanedUp)
        throw Error('Two-X direct diagnostic or cleanup did not complete.');
    } else if (canaryOnly && xSizeThreshold) {
      result.xSizeThreshold = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/x-size-threshold-current.json')));
      if (result.xSizeThreshold.session !== path.basename(directory) ||
          result.xSizeThreshold.diagnostic !== 'x-descriptor-threshold' ||
          !result.xSizeThreshold.cleanedUp)
        throw Error('X descriptor threshold or cleanup did not complete.');
    } else if (canaryOnly && directLength) {
      result.directLength = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/direct-length-current.json')));
      if (result.directLength.session !== path.basename(directory) ||
          result.directLength.diagnostic !== 'direct-path-length' ||
          !result.directLength.cleanedUp)
        throw Error('Direct-length diagnostic or cleanup did not complete.');
    } else if (canaryOnly && markerFirstSeam) {
      result.markerFirstSeam = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/marker-first-seam-current.json')));
      if (result.markerFirstSeam.session !== path.basename(directory) ||
          result.markerFirstSeam.diagnostic !== 'marker-first-seam' ||
          !result.markerFirstSeam.cleanedUp)
        throw Error('First-seam diagnostic or cleanup did not complete.');
    } else if (canaryOnly && markerAssembly) {
      result.markerAssembly = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/marker-assembly-current.json')));
      if (result.markerAssembly.session !== path.basename(directory) ||
          result.markerAssembly.diagnostic !== 'marker-assembly' ||
          !result.markerAssembly.cleanedUp)
        throw Error('Marker assembly diagnostic or cleanup did not complete.');
    } else if (canaryOnly && markerBoundary) {
      result.markerBoundary = JSON.parse(await fs.readFile(path.join(directory,
        'switch2/marker-boundary-current.json')));
      if (result.markerBoundary.session !== path.basename(directory) ||
          result.markerBoundary.diagnostic !== 'marker-boundary' ||
          !result.markerBoundary.cleanedUp)
        throw Error('Marker boundary diagnostic or cleanup did not complete.');
    } else if (canaryOnly) {
      result.canary = await readCanaryOutcome(directory);
      if (!result.canary.verified || result.canary.checkpoint !== 'repeated-positive-canary' ||
          result.canary.session !== path.basename(directory) || !result.canary.cleanedUp)
        throw Error('Positive canary verification or cleanup did not complete.');
    } else {
      result.fs = JSON.parse(await fs.readFile(path.join(directory, 'switch2/fs-execution-current.json')));
      if (!result.fs.verified || !result.fs.restored ||
          (rpcMode ? !result.fs.retainedEndpoint?.ready || !result.fs.cleanup?.deferred :
            !result.fs.cleanup?.cleanedUp))
        throw Error('FS execution, restoration, or endpoint state did not verify.');
    }
    if (dumpFirmware) {
      result.firmwareDump = JSON.parse(await fs.readFile(path.join(dumpDirectory, 'firmware-dump.json')));
      if (!result.firmwareDump.complete || result.firmwareDump.entries.length !== result.firmwareDump.inventory.total)
        throw Error('The system-code dump did not finish.');
    }
    if (splitMiB) result.splitMiBVerified = true;
    else if (oneMiBRetry) result.oneMiBVerified = true;
    else if (writeSizeOnly) result.writeSizeVerified = true;
    else if (canaryOnly && earlyPositive) result.earlyPositiveDiagnostic = true;
    else if (canaryOnly && holeTiming) result.holeTimingDiagnostic = true;
    else if (canaryOnly && singlePositive) result.singlePositiveDiagnostic = true;
    else if (canaryOnly && twoXDirect) result.twoXDirectDiagnostic = true;
    else if (canaryOnly && xSizeThreshold) result.xSizeThresholdDiagnostic = true;
    else if (canaryOnly && directLength) result.directLengthDiagnostic = true;
    else if (canaryOnly && markerFirstSeam) result.markerFirstSeamDiagnostic = true;
    else if (canaryOnly && markerAssembly) result.markerAssemblyDiagnostic = true;
    else if (canaryOnly && markerBoundary) result.markerBoundaryDiagnostic = true;
    else if (canaryOnly) result.canaryVerified = true;
    else if (geometryOnly) result.geometryMeasured = true;
    else result.verified = true;
    if (rpcMode) {
      result.rpc = {mode: 'held', state: 'listening', opened: new Date().toISOString()};
      await save(path.join(directory, 'result.json'), result);
      console.log(`4/4 verified. ${target.displayName} RPC and FS memory endpoint remain live while this process and the app stay open.`);
      console.log('Run folder: ' + directory);
      console.log('Check it locally: node engine/rpc.cjs ' + directory + ' status');
      console.log(`Stop with Ctrl-C; do not close ${target.displayName} until finished.`);
      const reason = await waitForRpcStop(native.connection, process, engine.finished);
      result.rpc = {...result.rpc, state: 'closed', reason, closed: new Date().toISOString()};
      if (reason === 'engine-exited') throw Error('The held FS endpoint exited unexpectedly.');
      checkEngine(await engine.release());
      result.fs = JSON.parse(await fs.readFile(path.join(directory, 'switch2/fs-execution-current.json')));
      if (!result.fs.cleanup?.cleanedUp) throw Error('Held FS resources did not clean up.');
      if (reason === 'disconnected') throw Error('Held RPC disconnected; do not replay an uncertain native request.');
    }
  } catch (error) {
    if (error.message === 'The FS endpoint exited before the held session was ready.') {
      try {
        const pipeline = JSON.parse(await fs.readFile(path.join(directory, 'switch2/pipeline.json')));
        if (pipeline.error) error = Error(pipeline.error.split('\n')[0]);
      } catch { /* The run log remains available if no pipeline report exists. */ }
    }
    result.error = error.message; failure = error;
  }
  finally {
    if (engine && rpcMode) {
      try {checkEngine(await engine.release());}
      catch (error) {(result.cleanupErrors ||= []).push({name: 'FS endpoint', error: error.message}); failure ||= error;}
    }
    for (const [name, close] of [['bridge', () => bridge?.close()], ['connection', () => native?.stop()]]) {
      try {await close();}
      catch (error) {(result.cleanupErrors ||= []).push({name, error: error.message}); failure ||= error;}
    }
    result.completed = new Date().toISOString();
    await save(path.join(directory, 'result.json'), result);
  }
  if (failure) throw Error(failure.message + '\nDetails: ' + directory);
  if (splitMiB) {
    console.log('Gravity Circuit 1 MiB file creation and two separate 512 KiB write commits verified; owned scratch removed.');
    console.log('Run folder: ' + directory);
    return result;
  }
  if (oneMiBRetry) {
    console.log(`Gravity Circuit one ${retrySize / 0x100000} MiB save write and owned scratch cleanup verified.`);
    console.log('Run folder: ' + directory);
    return result;
  }
  if (writeSizeOnly) {
    console.log(`Gravity Circuit durable save writes verified through ${maxWriteSize / 1024} KiB.`);
    console.log('Run folder: ' + directory);
    return result;
  }
  if (geometryOnly) {
    console.log(`Gravity Circuit geometry measured: ${result.geometry.pinningAllocationBytes} bytes per pinning storage.`);
    console.log('Run folder: ' + directory);
    return result;
  }
  if (canaryOnly) {
    if (earlyPositive) {
      console.log((validParentPositive ? 'Valid-parent one-byte positive diagnostic' :
        firstXPositive ? 'First-X positive diagnostic' : 'Early positive diagnostic') +
        ' completed: ' + result.earlyPositive.status +
        (firstXPositive ? ' at offset 0x' + result.earlyPositive.offset.toString(16) : '') +
        '. Full FS access was not established.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (holeTiming) {
      console.log('Hole timing diagnostic completed: ' + result.holeTiming.status +
        '. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (singlePositive) {
      console.log('Single-positive diagnostic completed: ' + result.singlePositive.status +
        '. FS access was not established.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (twoXDirect) {
      console.log(result.twoXDirect.status === 'transport-rejected-two-x' ?
        'Two-X GetEntryType packet rejected at transport (0xCE01); path parsing was not measured. Resources cleaned up.' :
        'Two-X direct path comparison completed and resources cleaned up. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (xSizeThreshold) {
      console.log('X descriptor threshold completed and resources cleaned up. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (directLength) {
      console.log('Direct-length diagnostic completed and resources cleaned up. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (markerFirstSeam) {
      console.log('First-seam diagnostic completed and resources cleaned up. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (markerAssembly) {
      console.log('Marker assembly diagnostic completed and resources cleaned up. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    if (markerBoundary) {
      console.log('Marker boundary diagnostic completed and resources cleaned up. FS access was not attempted.');
      console.log('Run folder: ' + directory);
      return result;
    }
    console.log('Positive canary verified and resources cleaned up. FS access was not attempted.');
    console.log('Run folder: ' + directory);
    return result;
  }
  if (appOnly) {
    if (result.app?.parentPathProbe?.verified === true &&
        result.app.parentPathProbe.cleanedUp === true)
      console.log(result.app.parentPathProbe.longForwardEnabled === true ?
        'Gravity Circuit 0x800 forward-path FS lookup diagnostic completed; owned scratch and native resources cleaned up. Full FS access was not established.' :
        'Gravity Circuit short-path FS lookup diagnostic completed; owned scratch and native resources cleaned up. Full FS access was not established.');
    else console.log('Gravity Circuit application checks completed. FS access was not attempted.');
    console.log('Run folder: ' + directory);
    return result;
  }
  console.log('FS execution verified. Original instructions restored and scratch cleaned up.');
  if (dumpFirmware) console.log('System-program CodeFS dump: ' +
    path.join(dumpDirectory, 'firmware-dump.json'));
  console.log('Restart the console when finished.');
  return result;
}

module.exports = {main, addresses, chooseHost, connectCommand, parseArguments, sourceDigest,
  prepareRunRoot, prepareDumpDirectory,
  startEngine, checkEngine, readCanaryOutcome, waitForRpcStop};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
