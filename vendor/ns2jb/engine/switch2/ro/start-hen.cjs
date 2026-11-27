const {runPath} = require('../../shared/paths.cjs');
// Start clean kaiHEN through the mapped native bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const frontend = require('./nro.cjs');
const thread = require('./sdk-thread.cjs');
const {check, live} = require('../app/session.cjs');
const {connect} = require('../tools/fs-memory.cjs');
const {exportHandle} = require('./export-handle.cjs');
const {code: sdkThread} = require('../app/worker.cjs');

const {makeBootstrapImage} = require('./bootstrap-image.cjs');

async function main(imagePath, bootstrapPath, gameMainPath, programs = [], adapters = {}) {
  // Adapters are used only by the offline integration simulator. The ordinary
  // hardware path keeps the original implementations as its defaults.
  const activeLive = adapters.live || live;
  const activeCheck = adapters.check || check;
  const activeConnect = adapters.connect || connect;
  const activeExportHandle = adapters.exportHandle || exportHandle;
  const activeRunPath = adapters.runPath || runPath;
  const activeEnv = adapters.env || process.env;
  const activeThreadExecute = adapters.threadExecute || thread.execute;
  const activeFrontendMain = adapters.frontendMain ||
    (options => frontend.main(options, adapters.frontendAdapters));
  const activeMakeBootstrapImage = adapters.makeBootstrapImage || makeBootstrapImage;
  const readRecord = adapters.readRecord ||
    (suffix => JSON.parse(fs.readFileSync(activeRunPath('switch2', 'ro', activeLive.session + suffix))));
  const text = fs.readFileSync(bootstrapPath);
  const memory = await activeConnect();
  const read = readRecord;
  const bound = read('-bound-sessions.json');
  const root = read('-loader-root-copy.json');
  const layout = read('-layout.json');
  const event = read('-gate-event.json');
  const row = bound.rows.find(item => item.domain === root.targetDomain);
  const state = await memory.request({command: 'root-native-info'});
  activeCheck(state.worker?.joined && state.donor?.ready && row, 'Current setup is not idle');
  const shell = state.services.find(item => item.name === 'pm:shell');
  const monitor = state.services.find(item => item.name === 'pm:dmnt');
  activeCheck(shell && monitor, 'Required PM sessions are missing');
  activeCheck(state.notifiers.length === 1, 'Owned FS notifier is missing');
  const notifierProof = read('-notifier-proof.json');
  activeCheck(notifierProof.identityVerified && notifierProof.session === activeLive.session &&
    notifierProof.report === memory.reportFile &&
    Number.isSafeInteger(notifierProof.E) && Number.isSafeInteger(notifierProof.B),
    'FS native allocator proof is not from this boot');
  activeCheck(await memory.pointer(notifierProof.E + 8) === notifierProof.B &&
    await memory.u32(notifierProof.E + 16) === 1,
    'Owned FS notifier changed after its identity proof');
  console.log('FS notifier qualified; exporting Loader handle');
  const exported = await activeExportHandle(memory, row.receive, 'Native launch Loader readiness');
  console.log('Exporting FS process handle');
  const fsProcess = await activeExportHandle(memory, 0xffff8001, 'Native RO reader FS process');
  const current = adapters.currentAcquisition ||
    JSON.parse(fs.readFileSync(activeRunPath('switch2', 'current-acquisition.json')));
  const report = JSON.parse(fs.readFileSync(current.report));
  const channel = report.retainedMemory;
  const args = Buffer.alloc(432);
  args.writeUInt32LE(report.retained.candidateHandle, 0);
  args.writeBigInt64LE(BigInt(channel.dataOffset), 8);
  args.writeBigInt64LE(BigInt(channel.dataEntryOffset + 0x20), 16);
  const gate = [row.address, Number(Buffer.from(row.raw, 'hex').readBigUInt64LE()),
    row.domain, row.metadata, row.request, ...bound.waiters];
  gate.forEach((value, index) => args.writeBigUInt64LE(BigInt(value), 24 + index * 8));
  state.apiWorkers.forEach((worker, index) => args.writeUInt32LE(worker.handle, 120 + index * 4));
  [row.receive, row.wait, event.sourceHandle, exported.handle, event.read, event.write]
    .forEach((value, index) => args.writeUInt32LE(value, 148 + index * 4));
  const donor = read('-filesystem-types.json').rows.find(item => item.name === 'donor');
  const mount = [layout.table, root.targetDomain, (root.targetEntry - layout.table) / 0x30 + 1,
    donor.entry, donor.object, donor.metadata, donor.vptr, 0x040000000000003an];
  mount.forEach((value, index) => args.writeBigUInt64LE(BigInt(value), 176 + index * 8));
  args.writeUInt32LE(shell.handle, 240);
  args.writeBigUInt64LE(0x040000000000003an, 248);
  args.writeUInt32LE(0x14, 256);
  args.writeUInt8(3, 260);
  args.writeUInt32LE(monitor.handle, 244);
  const activeSdkThread = adapters.sdkThread || sdkThread;
  for (const [index, name] of ['create', 'tryWait', 'join'].entries())
    args.writeBigUInt64LE(BigInt(activeLive.sdk + activeSdkThread[name].offset), 264 + index * 8);
  args.writeUInt32LE(shell.sm, 288);
  const acquisition = JSON.parse(fs.readFileSync(memory.reportFile));
  const fsRoot = acquisition.ownedRoot.clones[0];
  const packagePath = '@Sdcard:/kaihen/bin/hen/exefs.nsp';
  args.writeUInt32LE(fsRoot, 296);
  args.write(packagePath, 300, 'utf8');
  args.writeUInt32LE(fsProcess.handle, 396);
  args.writeUInt32LE(state.notifiers[0], 400);
  args.writeUInt32LE(root.copy.handle, 404);
  let joined = false;
  try {
    let stagedMenu = null;
    if (activeEnv.HBMENU_NRO) {
      console.log('Staging hbmenu.nro');
      stagedMenu = await memory.request({command: 'root-native-file-stage',
        root: fsRoot, target: '/hbmenu.nro', source: activeEnv.HBMENU_NRO});
    }
    console.log('Staging game loader');
    const stagedGame = await memory.request({command: 'root-native-file-stage',
      root: fsRoot, target: '/kaihen/bin/game/main', source: gameMainPath});
    const stagedPrograms = [];
    for (const program of programs) {
      console.log(`Staging ${program.target}`);
      stagedPrograms.push(await memory.request({command: 'root-native-file-stage',
        root: fsRoot, target: program.target, source: program.source}));
    }
    console.log('Staging HEN');
    const staged = await memory.request({command: 'root-native-file-stage',
      root: fsRoot, target: '/kaihen/bin/hen/main', source: imagePath});
    console.log('Starting native bootstrap');
    const image = activeMakeBootstrapImage(text);
    const launched = await activeFrontendMain({
      label: 'hen-startup',
      filename: 'hen-startup.json',
      image,
      async execute(session, entry, record, save) {
        args.writeUInt32LE(record.handle, 292);
        record.staged = staged;
        record.stagedGame = stagedGame;
        record.stagedPrograms = stagedPrograms;
        record.stagedMenu = stagedMenu;
        record.package = '@Sdcard:/kaihen/bin/hen/exefs.nsp';
        const result = await activeThreadExecute(session, entry, record, save, {
          waitMs: 60000,
          async prepare(session, address) {
            record.argumentsAddress = address;
            await save();
            await session.write(address, args);
          },
          async verify(session, address, record) {
            joined = true;
            const out = await session.readOwned(address + 408, 24);
            record.operation = out.readUInt32LE(0);
            record.result = out.readUInt32LE(4);
            record.pid = out.readBigUInt64LE(8).toString();
            record.gateRestoreResult = out.readUInt32LE(16);
            record.channelRestoreResult = out.readUInt32LE(20);
            // Bootstrap can transfer a receipt-pending Loader restore to
            // kaiHEN after publishing the original wait and signalling
            // the park event. HEN then owns the eventual acknowledgement.
            record.gateRestorePending = record.operation === 10 &&
              record.gateRestoreResult === 0xea01;
            await save();
            activeCheck(!record.result &&
              (!record.gateRestoreResult || record.gateRestorePending) &&
              !record.channelRestoreResult &&
              record.operation === 10,
              `Startup operation ${record.operation} failed: 0x${record.result.toString(16)}`);

          },
        });
        return result;
      },
    });
    const record = JSON.parse(fs.readFileSync(launched.file));
    return {pid: record.pid, file: launched.file};
  } finally {
    if (joined) {
      await memory.request({command: 'root-native-close-handle', handle: exported.handle});
      await memory.request({command: 'root-native-close-handle', handle: fsProcess.handle});
    }
  }
}
module.exports = {main};
