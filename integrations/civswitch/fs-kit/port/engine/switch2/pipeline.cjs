const fs = require('node:fs/promises');
const path = require('node:path');
const {a, request} = require('../shared/rpc.cjs');
const {run} = require('../shared/stages.cjs');
const {connect, encodeU64} = require('./tools/fs-memory.cjs');
const runtime = require('./ro/runtime.cjs');
const {read, save, local, hash} = runtime;
const {loadTarget, programId, required} = require('../shared/target.cjs');
const target = loadTarget();
// PROCESS-ESCAPE-PLAN stage A (opt-in): per-boot launch title override.
const launchTitle = () => process.env.NS2_LAUNCH_TITLE || programId(target);
const check = (ok, message) => {if (!ok) throw Error(message);};

async function main() {
  const flags = process.argv.slice(2);
  check(flags.length <= 4 && flags.every(flag =>
    ['--dump-firmware', '--hold-rpc', '--app-only', '--canary-only', '--geometry-only',
      '--write-size-only', '--one-mib-retry', '--split-mib'].includes(flag)) &&
    new Set(flags).size === flags.length,
  'Usage: pipeline.cjs [--app-only|--write-size-only|--one-mib-retry|--split-mib|--geometry-only|--canary-only] [--dump-firmware] [--hold-rpc]');
  const dumpFirmware = flags.includes('--dump-firmware');
  const holdRpc = flags.includes('--hold-rpc');
  const appOnly = flags.includes('--app-only');
  const canaryOnly = flags.includes('--canary-only');
  const extentLadder = process.env.NS2_EXTENT_LADDER === '1';
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
  const parentPathSemantics = process.env.NS2_GC_PARENT_PATH_SEMANTICS === '1';
  const twoParentSemantics = process.env.NS2_GC_TWO_PARENT_SEMANTICS === '1';
  const longForwardSemantics = process.env.NS2_GC_LONG_FORWARD_SEMANTICS === '1';
  const geometryOnly = flags.includes('--geometry-only');
  const writeSizeOnly = flags.includes('--write-size-only');
  const oneMiBRetry = flags.includes('--one-mib-retry');
  const splitMiB = flags.includes('--split-mib');
  const retrySize = oneMiBRetry ?
    require('./app/one-mib-transaction.cjs').parseOneShotSize(process.env.NS2_ONE_SHOT_SIZE) : null;
  check(!holdRpc || typeof process.send === 'function', 'Held FS mode requires runner IPC');
  check(!appOnly || !dumpFirmware && !holdRpc, 'App-only mode cannot run FS stages');
  check(!canaryOnly || !appOnly && !dumpFirmware && !holdRpc,
    'Canary-only mode cannot be combined with other modes');
  check(!extentLadder || canaryOnly && target.name === 'gravcirc',
    'Extent ladder requires Gravity Circuit canary-only mode');
  check(!markerBoundary || canaryOnly && !extentLadder && target.name === 'gravcirc',
    'Marker boundary requires Gravity Circuit canary-only mode');
  check(!markerMatchedAbsent || markerBoundary,
    'Matched absent path requires the marker boundary diagnostic');
  check(!markerAssembly || markerBoundary && markerMatchedAbsent,
    'Marker assembly requires matched absent boundary mode');
  check(!markerFirstDescriptor || canaryOnly && !extentLadder && !markerBoundary &&
    !markerAssembly && !markerFirstSeam && target.name === 'gravcirc',
  'First-descriptor diagnostic requires Gravity Circuit canary-only mode');
  check(!markerFirstSeam || canaryOnly && !extentLadder && !markerBoundary &&
    !markerAssembly && !markerFirstDescriptor && !directLength && !xSizeThreshold &&
    target.name === 'gravcirc',
  'First-seam diagnostic requires Gravity Circuit canary-only mode');
  check(!directLength || canaryOnly && !extentLadder && !markerBoundary &&
    !markerAssembly && !markerFirstDescriptor && !markerFirstSeam && target.name === 'gravcirc',
  'Direct-length diagnostic requires Gravity Circuit canary-only mode');
  check(!xSizeThreshold || canaryOnly && !extentLadder && !markerBoundary &&
    !markerAssembly && !markerFirstDescriptor && !markerFirstSeam && !directLength && target.name === 'gravcirc',
  'X descriptor threshold requires Gravity Circuit canary-only mode');
  check(!twoXDirect || canaryOnly && !extentLadder && !markerBoundary &&
    !markerAssembly && !markerFirstDescriptor && !markerFirstSeam && !directLength &&
    !xSizeThreshold && target.name === 'gravcirc',
  'Two-X direct diagnostic requires Gravity Circuit canary-only mode');
  check(!singlePositive || canaryOnly && !extentLadder && !markerBoundary &&
    !markerMatchedAbsent && !markerAssembly && !markerFirstDescriptor && !markerFirstSeam &&
    !directLength && !xSizeThreshold && !twoXDirect && target.name === 'gravcirc',
  'Single-positive diagnostic requires unmodified Gravity Circuit canary-only mode');
  check(!holeTiming || canaryOnly && !extentLadder && !markerBoundary &&
    !markerMatchedAbsent && !markerAssembly && !markerFirstDescriptor && !markerFirstSeam &&
    !directLength && !xSizeThreshold && !twoXDirect && !singlePositive && !earlyPositive &&
    target.name === 'gravcirc' && !process.env.NS2_POSITIVE_FILL_SEGMENT,
  'Hole timing diagnostic requires unmodified Gravity Circuit canary-only mode');
  check(!earlyPositive || canaryOnly && !extentLadder && !markerBoundary &&
    !markerMatchedAbsent && !markerAssembly && !markerFirstDescriptor && !markerFirstSeam &&
    !directLength && !xSizeThreshold && !twoXDirect && !singlePositive && !holeTiming &&
    target.name === 'gravcirc' && !process.env.NS2_POSITIVE_FILL_SEGMENT,
  'Early positive diagnostic requires unmodified Gravity Circuit canary-only mode');
  check(!firstXPositive || earlyPositive && canaryOnly && target.name === 'gravcirc',
    'First-X positive diagnostic requires Gravity Circuit early-positive canary-only mode');
  check(!validParentPositive || firstXPositive &&
    process.env.NS2_GC_FIRST_X_SLASH_SPLIT === '1' &&
    process.env.NS2_GC_FIRST_X_TERMINATED === '1' &&
    process.env.NS2_GC_FIRST_X_TAIL_SPACING === '1' &&
    process.env.NS2_GC_FIRST_X_EDGE_OFFSET !== '1',
  'Valid-parent positive requires the bounded 0x700 first-X mode');
  check(!parentPathSemantics || appOnly && target.name === 'gravcirc' &&
    process.env.NS2_WRITE_SIZE_PROBE !== '1' && process.env.NS2_APP_STORAGE_PROBE !== '1' &&
    process.env.NS2_GC_PINNING_PROBE !== '1',
  'Short parent-path diagnostic requires Gravity Circuit app-only mode without other probes');
  check(!twoParentSemantics || parentPathSemantics,
    'Two-parent path control requires the short parent-path diagnostic');
  check(!longForwardSemantics || twoParentSemantics,
    'Long forward-path control requires matched two-parent controls');
  check(!geometryOnly || !appOnly && !canaryOnly && !dumpFirmware && !holdRpc,
    'Geometry-only mode cannot be combined with other modes');
  check(!writeSizeOnly || !appOnly && !canaryOnly && !geometryOnly && !dumpFirmware && !holdRpc &&
    target.name === 'gravcirc', 'Write-size-only mode requires Gravity Circuit and no other mode');
  check(!oneMiBRetry || !appOnly && !canaryOnly && !geometryOnly && !writeSizeOnly && !splitMiB &&
    !dumpFirmware && !holdRpc && target.name === 'gravcirc',
  'One-MiB retry requires Gravity Circuit and no other mode');
  check(!splitMiB || !appOnly && !canaryOnly && !geometryOnly && !writeSizeOnly &&
    !oneMiBRetry && !dumpFirmware && !holdRpc && target.name === 'gravcirc',
  'Split-MiB probe requires Gravity Circuit and no other mode');
  if (canaryOnly && target.name === 'gravcirc') {
    require('../shared/target.cjs').assertCanarySupported(target);
    require('./memory/geometry-proof.cjs').requireGeometryProof(
      target, process.env.NS2_GC_GEOMETRY_PROOF);
  }
  if (earlyPositive)
    require('./memory/timing-proof.cjs').requireTimingProof(target, process.env.NS2_GC_RECEIVE_TIMING_REPORT);
  const maxWriteSize = writeSizeOnly ?
    require('./app/write-size-transaction.cjs').selectedGeometrySizes(process.env.NS2_WRITE_SIZE_MAX, true).at(-1) : null;
  check(!writeSizeOnly || maxWriteSize <= 0x80000,
    'Write-size-only mode must stop at or before 512 KiB');
  if (canaryOnly) process.env.NS2_CANARY_ONLY = '1';
  else delete process.env.NS2_CANARY_ONLY;
  if (geometryOnly || writeSizeOnly) process.env.NS2_GEOMETRY_ONLY = '1';
  else delete process.env.NS2_GEOMETRY_ONLY;
  if (writeSizeOnly) process.env.NS2_WRITE_SIZE_ONLY = '1';
  else delete process.env.NS2_WRITE_SIZE_ONLY;
  const file = path.join(__dirname, 'pipeline.json');
  const record = {session: a.session, started: new Date().toISOString(), stages: []};
  await fs.writeFile(file, JSON.stringify(record) + '\n', {flag: 'wx', mode: 0o600});
  async function progress(step, message) {
    console.log(message);
    if (target.name === 'gravcirc') await request({command: 'progress', step});
  }
  async function stage(name, action) {
    console.log(name);
    const row = {name, started: new Date().toISOString(), status: 'running'};
    record.stages.push(row); await save(file, record);
    try {
      row.result = await action(); row.status = 'complete';
      return row.result;
    } catch (error) {row.status = 'failed'; row.error = error.stack; throw error;}
    finally {row.finished = new Date().toISOString(); await save(file, record);}
  }
  const script = (folder, name, args = [], timeout) =>
    stage(folder + '/' + name, () => run(path.join(__dirname, folder), name, args, timeout));
  let acquisition;
  try {
    await progress(1, '1/4 Checking the console');
    await script('app', 'map');
    await script('app', 'inspect-mounts');
    if (appOnly) {
      const app = await script('app', 'qualify');
      check(app.verified && app.cleanedUp, 'Application worker qualification failed');
      let writeSizeProbe = null;
      let storageProbe = null;
      let pinningProbe = null;
      let parentPathProbe = null;
      if (parentPathSemantics) {
        parentPathProbe = await script('app', 'probe-parent-path');
        check(require('./app/probe-parent-path.cjs').assess(parentPathProbe) &&
          parentPathProbe.session === a.session,
        'Owned short parent-path controls or cleanup did not verify');
        await save(path.join(__dirname, 'parent-path-current.json'), parentPathProbe);
      }
      if (process.env.NS2_WRITE_SIZE_PROBE === '1') {
        writeSizeProbe = await script('app', 'probe-write-size');
        check(writeSizeProbe.verified, 'Save write-size probe failed');
      }
      if (process.env.NS2_APP_STORAGE_PROBE === '1') {
        check(target.name === 'gravcirc', 'Storage probe requires Gravity Circuit');
        storageProbe = await script('app', 'probe-storage');
        check(storageProbe?.target === 'gravcirc' && storageProbe.session === a.session &&
          storageProbe.probe?.storage?.length === 2 && !storageProbe.error &&
          !storageProbe.cleanupError, 'Gravity Circuit storage probe did not complete');
      }
      if (process.env.NS2_GC_PINNING_PROBE === '1') {
        check(target.name === 'gravcirc', 'Pinning probe requires Gravity Circuit');
        pinningProbe = await script('memory', 'probe-pinning-allocation');
        check(pinningProbe?.verified === true && pinningProbe.cleanedUp === true &&
          pinningProbe.session === a.session && pinningProbe.saveWrites === 0 &&
          pinningProbe.raceWorkers === 0, 'Gravity Circuit pinning probe did not verify');
      }
      const result = {verified: true, cleanup: {cleanedUp: app.cleanedUp &&
        (writeSizeProbe ? writeSizeProbe.cleanedUp : true) &&
        (storageProbe ? !storageProbe.cleanupError : true) &&
        (pinningProbe ? pinningProbe.cleanedUp : true) &&
        (parentPathProbe ? parentPathProbe.cleanedUp : true)}, qualification: app,
        writeSizeProbe, storageProbe, pinningProbe, parentPathProbe,
        completed: new Date().toISOString()};
      await save(path.join(__dirname, 'app-qualification-current.json'), result);
      record.verified = true; record.result = result;
      return;
    }
    if (!geometryOnly && !writeSizeOnly && !oneMiBRetry && !splitMiB) {
      const cleanup = await stage('Remove exploit scratch from prior launches',
        () => require('./cleanup-scratch.cjs').main());
      check(require('./cleanup-scratch.cjs').verifiesScratchCleanup(cleanup),
        'Prior exploit scratch cleanup did not verify');
    }
    const app = await script('app', 'qualify');
    check(app.verified && app.cleanedUp, 'Application worker qualification failed');
    if (oneMiBRetry) {
      const probe = await script('app', 'probe-one-mib');
      check(require('./app/one-mib-transaction.cjs').verifiesOneMiBRetry(probe, target.name, retrySize),
        'One MiB Gravity Circuit save write or owned scratch cleanup did not verify');
      const result = {...probe, completed: new Date().toISOString()};
      await save(path.join(__dirname, 'one-mib-current.json'), result);
      record.oneMiBVerified = true;
      record.result = result;
      return;
    }
    if (splitMiB) {
      const probe = await script('app', 'probe-one-mib', ['--split']);
      check(require('./app/split-mib-transaction.cjs').verifiesSplitMiB(probe, target.name),
        'Split one MiB Gravity Circuit save write or owned scratch cleanup did not verify');
      const result = {...probe, completed: new Date().toISOString()};
      await save(path.join(__dirname, 'split-mib-current.json'), result);
      record.splitMiBVerified = true;
      record.result = result;
      return;
    }
    if (writeSizeOnly) {
      const write = await script('app', 'probe-write-size');
      check(require('./app/write-size-transaction.cjs').verifiesBoundedWrite(write, target.name, maxWriteSize),
        'Bounded Gravity Circuit save write did not verify and clean up');
      const result = {...write, mode: 'write-size-only', completed: new Date().toISOString()};
      await save(path.join(__dirname, 'write-size-current.json'), result);
      record.writeSizeVerified = true;
      record.result = result;
      return;
    }
    if (geometryOnly) {
      const write = await script('app', 'probe-write-size');
      check(require('./app/write-size-transaction.cjs').verifiesGeometryWrite(write, target.name),
        `${target.displayName} save did not verify a ${target.name === 'gravcirc' ? '512 KiB' : '8 MiB'} owned scratch write`);
      await progress(6, '2/4 Measuring FS canary geometry');
      const geometry = await stage('Owned save allocation geometry', async () => {
        const report = await run(path.join(__dirname, 'memory'), 'probe-reserved-gap', [], 30 * 60 * 1000);
        return require('./memory/geometry-checkpoint.cjs').verifyGeometryReport(report, a.session);
      });
      const result = {...geometry, target: target.name, sdkSha256: target.sdkSha256,
        writeSizeProbe: write, started: record.started,
        completed: new Date().toISOString()};
      await save(path.join(__dirname, 'geometry-current.json'), result);
      record.geometryMeasured = true;
      record.result = result;
      return;
    }
    if (process.env.NS2_APP_SD_PROBE === '1') {
      // Diagnostic only: a probe failure must never abort an otherwise good chain.
      try {record.appSdProbeEarly = await script('app', 'sd-probe', ['early']);}
      catch (error) {record.appSdProbeEarly = {error: error.message};}
    }
    if (canaryOnly) {
      await progress(5, validParentPositive ? '2/4 Testing valid-parent canary placement' :
        firstXPositive ? '2/4 Testing first-X canary placement' :
        earlyPositive ? '2/4 Testing fresh canary timing' :
        holeTiming ? '2/4 Measuring owned receive timing' :
        singlePositive ? '2/4 Testing one owned canary' :
        twoXDirect ? '2/4 Comparing path descriptors' :
        xSizeThreshold ? '2/4 Comparing X descriptor sizes' :
        directLength ? '2/4 Comparing direct path lengths' :
        markerFirstSeam ? '2/4 Comparing path seam' :
        markerFirstDescriptor ? '2/4 Comparing first-descriptor paths' :
        markerAssembly ? '2/4 Comparing marker path assembly' :
        markerBoundary ? '2/4 Measuring marker boundary' :
        extentLadder ? '2/4 Measuring path extent' : '2/4 Verifying FS canary');
      const checkpoint = await stage(validParentPositive ? 'Bounded valid-parent canary diagnostic' :
        firstXPositive ? 'Bounded first-X canary diagnostic' :
        earlyPositive ? 'Bounded early positive diagnostic' :
        holeTiming ? 'Bounded receive timing diagnostic' :
        singlePositive ? 'Bounded single-positive diagnostic' :
        twoXDirect ? 'Bounded two-X path diagnostic' :
        xSizeThreshold ? 'Bounded X descriptor threshold' :
        directLength ? 'Bounded direct-length diagnostic' :
        markerFirstSeam ? 'Bounded first-seam diagnostic' :
        markerFirstDescriptor ? 'Bounded first-descriptor diagnostic' :
        markerAssembly ? 'Bounded marker assembly diagnostic' :
        markerBoundary ? 'Bounded marker boundary diagnostic' :
        extentLadder ? 'Bounded path extent diagnostic' : 'Repeated positive canary marker', async () => {
        const report = await run(path.join(__dirname, 'memory'), 'probe-reserved-gap', [],
          90 * 60 * 1000, {cooperative: true, graceMs: 15 * 60 * 1000});
        check(report, 'Canary probe produced no report');
        return earlyPositive ? require('./memory/early-positive.cjs').verifyReport(report, a.session) :
          holeTiming ? require('./memory/hole-timing.cjs').verifyReport(report, a.session) :
          singlePositive ? require('./memory/single-positive.cjs').verifyReport(report, a.session) :
          twoXDirect ? require('./memory/two-x-direct.cjs').verifyReport(report, a.session) :
          xSizeThreshold ? require('./memory/x-size-threshold.cjs').verifyReport(report, a.session) :
          directLength ? require('./memory/direct-length.cjs').verifyReport(report, a.session) :
          markerFirstSeam ? require('./memory/marker-first-seam.cjs').verifyReport(report, a.session) :
          markerFirstDescriptor ? require('./memory/marker-first-descriptor.cjs').verifyReport(report, a.session) :
          markerAssembly ? require('./memory/marker-assembly.cjs').verifyReport(report, a.session) :
          markerBoundary ? require('./memory/marker-boundary.cjs').verifyReport(report, a.session) :
          extentLadder ? require('./memory/extent-ladder.cjs').verifyReport(report, a.session) :
          require('./memory/canary-checkpoint.cjs').verifyCanaryReport(report, a.session);
      });
      const result = {...checkpoint, started: record.started, completed: new Date().toISOString()};
      await save(path.join(__dirname, earlyPositive ? 'early-positive-current.json' :
        holeTiming ? 'hole-timing-current.json' :
        singlePositive ? 'single-positive-current.json' :
        twoXDirect ? 'two-x-direct-current.json' :
        xSizeThreshold ? 'x-size-threshold-current.json' :
        directLength ? 'direct-length-current.json' :
        markerFirstSeam ? 'marker-first-seam-current.json' :
        markerFirstDescriptor ? 'marker-first-descriptor-current.json' :
        markerAssembly ? 'marker-assembly-current.json' :
        markerBoundary ? 'marker-boundary-current.json' :
        extentLadder ? 'extent-ladder-current.json' : 'canary-current.json'), result);
      if (earlyPositive) record.earlyPositiveDiagnostic = true;
      else if (holeTiming) record.holeTimingDiagnostic = true;
      else if (singlePositive) record.singlePositiveDiagnostic = true;
      else if (twoXDirect) record.twoXDirectDiagnostic = true;
      else if (xSizeThreshold) record.xSizeThresholdDiagnostic = true;
      else if (directLength) record.directLengthDiagnostic = true;
      else if (markerFirstSeam) record.markerFirstSeamDiagnostic = true;
      else if (markerFirstDescriptor) record.markerFirstDescriptorDiagnostic = true;
      else if (markerAssembly) record.markerAssemblyDiagnostic = true;
      else if (markerBoundary) record.markerBoundaryDiagnostic = true;
      else if (extentLadder) record.extentLadderDiagnostic = true;
      else record.canaryVerified = true;
      record.result = result;
      return;
    }
    await progress(2, '2/4 Acquiring FS memory');
    await stage('FS read, write and restoration', async () => {
      acquisition = await require('./acquire.cjs').start();
      return {report: acquisition.report, proof: acquisition.proof};
    });
    await progress(3, '3/4 Starting the native helper');
    const captured = await read(acquisition.report);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const captureBytes = required(target.retainedCaptureBytes, `${target.name} retained capture size`);
    if (!captured.retainedMemory?.captures?.some(c => c.length === captureBytes))
      await script('retained', 'find-metadata', [acquisition.supervisorReport]);
    await script('ro', 'install-retained');
    await stage('FS layout', () => require('./ro/layout.cjs').main());
    await stage('Owned FS root', () => require('./ro/objects.cjs').main('root'));
    await stage('Owned FS notifier', () => require('./ro/objects.cjs').main('notifier'));
    const layout = await read(local(a.session, '-layout.json'));
    const smOffset = required(target.smServiceOffset, `${target.name} SM service offset`);
    await script('ro', 'test-sm', [String(layout.sdk + smOffset)]);
    await script('ro', 'copy-loader-root', [String(layout.target.entry)]);
    await script('ro', 'prepare-workers');
    const donor = await stage('RO payload and current console policy', async () => {
      const memory = await connect(), sm = await read(local(a.session, '-sm-proof.json'));
      const monitor = await memory.request({command: 'root-native-sm-service', handle: sm.export.handle, name: 'pm:dmnt'});
      check(!monitor.result && !monitor.transport, 'PM monitor did not open');
      const loader = await read(local(a.session, '-loader-root-copy.json'));
      const code = await memory.request({command: 'root-native-code-open', handle: loader.copy.handle, title: launchTitle()});
      check(!code.result, 'Native RO CodeFS did not open');
      for (const name of ['main.npdm', 'main'])
        await memory.request({command: 'root-native-file-capture', handle: code.handle, name});
      const result = await memory.request({command: 'root-native-donor-prepare'});
      check(result.ready && result.files.every(item => item.verified), 'The payload files did not verify');
      return result;
    });
    await script('ro', 'bind-sessions');
    await script('ro', 'prepare-event');
    const gate = await script('ro', 'test-gate');
    check(gate.verified && gate.restored, 'The native request gate did not qualify');
    const launch = await script('ro', 'launch', [], 300000);
    check(launch.imageAccepted && launch.restored && launch.pid, 'PM did not accept the payload');
    // PROCESS-ESCAPE-PLAN stage A (opt-in, NS2_LAUNCH_EXPERIMENT=1): observe the new
    // process identity and stop BEFORE runtime.activate. No original process is
    // terminated and Loader objects stay swapped; a console reboot is required after.
    if (process.env.NS2_LAUNCH_EXPERIMENT === '1') {
      record.experiment = await stage('Launch experiment (observe, never terminate)', async () => {
        const memory = await connect();
        const info = await memory.request({command: 'root-native-info'});
        const monitor = info.services?.find(x => x.name === 'pm:dmnt')?.handle;
        check(monitor, 'PM monitor session is missing (experiment)');
        const title = launchTitle();
        const ipc = (id, hex) => memory.request({command: 'root-native-ipc', handle: monitor, id, hex});
        const identity = await ipc(7, encodeU64(BigInt(launch.pid)).toString('hex'));
        const identified = !identity.result && identity.hex &&
          Buffer.from(identity.hex, 'hex').readBigUInt64LE() === BigInt(title);
        const start = process.env.NS2_LAUNCH_START === '1'
          ? await ipc(1, encodeU64(BigInt(launch.pid)).toString('hex')) : {skipped: 'NS2_LAUNCH_START!=1'};
        return {title, pid: launch.pid, identity: {...identity, identified}, start,
          note: 'PROCESS-ESCAPE-PLAN stage A: original processes are left untouched; console reboot required afterwards'};
      });
      record.verified = false;
      await save(path.join(__dirname, 'experiment-current.json'),
        {experiment: true, session: a.session, launch: launch.file, result: record.experiment, started: record.started});
      return;
    }
    const activation = await stage('Start RO payload', () => runtime.activate(launch.file));
    const proof = await stage('RO instruction challenges', () => runtime.probe(activation.pid));
    const handoff = await stage('Restore Loader session', () => runtime.handoff());
    const payload = donor.files.find(item => item.name === 'main');
    check(payload.sha256 === hash(await fs.readFile(path.join(__dirname, 'ro/payload/main'))), 'Payload changed during launch');
    await save(runtime.executionFile, {verified: true, session: a.session, report: acquisition.report,
      pid: proof.pid, programId: programId(target).slice(2), payloadSha256: payload.sha256,
      proof: proof.file, launch: launch.file, identity: activation.file, handoff: handoff.file});
    await progress(4, '4/4 Running the FS demo');
    await script('process', 'bind-notifier');
    const mapping = await script('process', 'qualify');
    check(mapping.verified && mapping.cleanup?.finished, 'Native process mapping did not qualify and clean up');
    const execution = await stage('FS instruction challenges', () => require('./process/fs-execute.cjs').main());
    check(execution.verified && execution.restored, 'FS execution or restoration did not verify');
    if (process.env.NS2_APP_SD_PROBE === '1') {
      // Second anchor test: the stock application process again, now after the
      // RO payload restored the loader session (4/4). Diagnostic only.
      try {record.appSdProbeLate = await script('app', 'sd-probe', ['late']);}
      catch (error) {record.appSdProbeLate = {error: error.message};}
    }
    if (dumpFirmware) {
      console.log('Firmware: beginning read-only system-program CodeFS capture');
      record.firmwareDump = await stage('Enumerate and capture installed system code',
        () => require('./firmware-dump.cjs').main(execution.file));
    }
    const donorCleanup = await stage('Remove RO donor files', async () => {
      const memory = await connect();
      const donor = await memory.request({command: 'root-native-donor-cleanup'});
      check(donor.cleanedUp, 'Donor files did not clean up');
      return donor;
    });
    if (holdRpc) {
      const held = {...execution, cleanup: {deferred: true, donor: donorCleanup},
        retainedEndpoint: {ready: true, session: a.session, socketPath: acquisition.socketPath},
        started: record.started};
      await save(path.join(__dirname, 'fs-execution-current.json'), held);
      record.hold = {state: 'ready', started: new Date().toISOString()};
      await save(file, record);
      const release = require('./hold.cjs').waitForRelease();
      process.send({type: 'held-ready', session: a.session});
      const reason = await release;
      record.hold = {...record.hold, state: 'releasing', reason, released: new Date().toISOString()};
      await save(file, record);
    }
    const cleanup = await stage('Release FS resources', async () =>
      ({...await acquisition.retire(), donor: donorCleanup}));
    const result = {...execution, cleanup, started: record.started, completed: new Date().toISOString()};
    await save(path.join(__dirname, 'fs-execution-current.json'), result);
    record.verified = true; record.result = result;
  } catch (error) {
    record.error = error.stack;
    if (acquisition) {
      try {
        const latest = await read(acquisition.report);
        // Before promotion, the acquisition still owns its original restoration
        // path. Later failures may have native state that needs a console reboot.
        if (!latest.nativeRo && !latest.retainedMemory?.promoted)
          record.failureCleanup = await acquisition.retire();
        else await acquisition.abandon();
      } catch (cleanupError) {
        record.cleanupError = cleanupError.stack;
        await acquisition.abandon();
      }
    }
    throw error;
  } finally {record.finished = new Date().toISOString(); await save(file, record);}
}

module.exports = {main};
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
