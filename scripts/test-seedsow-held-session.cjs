'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const noraTitle = '010012900d38a000';
const otherTitle = '0100b4b00f9f6000';
const account = 'a'.repeat(32);

function fixture(t, mode = '--seedsow-save', options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-seedsow-held-')));
  const scripts = path.join(root, 'scripts');
  const host = path.join(root, 'vendor/ns2-savekit-host-fixture');
  const run = path.join(host, 'runs/switch2-test');
  const backup = path.join(root, 'seedsow-backups/demo-fixture');
  const exportPath = path.join(root, 'savekit-exports/nora-fixture');
  fs.mkdirSync(scripts, {recursive: true});
  fs.mkdirSync(run, {recursive: true, mode: 0o700});
  fs.mkdirSync(backup, {recursive: true, mode: 0o700});
  fs.mkdirSync(exportPath, {recursive: true, mode: 0o700});
  if (options.existingEditor) {
    fs.writeFileSync(path.join(backup, 'ssedit1.lua'), 'editor');
    fs.writeFileSync(path.join(backup, 'sed01.asb'), 'editor');
  }

  for (const name of ['gui-host.cjs', 'usb-controllers.cjs', 'gui-session.cjs', 'homebrew-reentry.cjs'])
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  fs.writeFileSync(path.join(scripts, 'host-profiles.cjs'), `
    const profile = {id: ${JSON.stringify(options.hostId || 'kurumuz')}, supportsHeldRPC: true,
      supportsSaveKit: true, supportsNativeHBLauncher: true,
      startPort: 39380, startArgumentCount: 5};
    exports.selectedProfile = () => profile;
    exports.profileById = () => profile;
    exports.profiles = [profile];
    exports.incompatibleLegacyStartHint = () => false;
    exports.validStartCommand = () => true;
  `);
  fs.writeFileSync(path.join(scripts, 'prepare-seedsow-host.cjs'), `
    const path = require('node:path');
    exports.prepare = root => path.join(root, 'vendor/ns2-savekit-host-fixture');
    exports.supported = new Set(['kurumuz', 'cellenseres', 'astral']);
  `);
  fs.writeFileSync(path.join(host, 'run.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '../..');
    const run = path.join(__dirname, 'runs/switch2-test');
    const result = {
      verified: true,
      fs: {verified: true, restored: true,
        retainedEndpoint: {ready: true, session: 'switch2-test'},
        cleanup: {deferred: true, donor: {cleanedUp: true}}},
      rpc: {mode: 'held', state: 'listening'}
    };
    const save = () => fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(result), {mode: 0o600});
    fs.writeFileSync(path.join(root, 'runner-pid'), String(process.pid));
    fs.writeFileSync(path.join(run, 'connection.json'), JSON.stringify({port: 12345,
      addresses: {session: 'switch2-test', target: 'switch2'}}), {mode: 0o600});
    save();
    console.log('V=START(39380,127,0,0,1)');
    console.log('Run folder: ' + run);
    console.log(${JSON.stringify(require('./gui-session.cjs').heldMessage)});
    process.on('SIGTERM', () => {
      result.rpc.state = 'closed';
      result.fs.cleanup = {cleanedUp: true};
      result.completed = new Date().toISOString();
      save();
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(path.join(host, 'rpc.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    exports.request = async () => {
      const afterSave = fs.existsSync(path.join(__dirname, '../../install-invocations'));
      if (afterSave && ${Boolean(options.rpcStatusThrowsAfterSave)})
        throw Error('Fixture status probe is unavailable after the save');
      if (${Boolean(options.rpcStatusThrowsAfterTool)} &&
          fs.existsSync(path.join(__dirname, '../../tool-write-completed')))
        throw Error('Fixture status probe is unavailable after the SaveKit write');
      return {ready: ${!options.rpcUnavailableAfterSave} || !afterSave};
    };
  `);
  fs.writeFileSync(path.join(scripts, 'gui-savekit.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '..');
    const game = process.argv[3] === '--artemis' ? process.argv[4] :
      process.argv[3] === '--balatro' ? 'balatro' : undefined;
    const variant = process.argv[3] === '--balatro' ? process.argv[4] : undefined;
    const backup = game ? path.join(root,
      game === 'balatro' ? 'balatro-backups' : 'artemis-backups', game + '-fixture') :
      path.join(root, 'seedsow-backups/demo-fixture');
    fs.mkdirSync(backup, {recursive: true});
    fs.appendFileSync(path.join(root, 'install-invocations'), 'install\\n');
    if (process.argv[3] && !game) fs.writeFileSync(path.join(root, 'custom-editor-source'), process.argv[3]);
    if (game) fs.writeFileSync(path.join(root, 'artemis-game'), game);
    if (game === 'seedsow' && process.argv[5])
      fs.writeFileSync(path.join(root, 'artemis-variant'), process.argv[5]);
    if (process.argv[3] === '--editor-pro')
      fs.writeFileSync(path.join(root, 'editor-pro-selected'), 'yes');
    if (variant) fs.writeFileSync(path.join(root, 'balatro-variant'), variant);
    const installCount = fs.readFileSync(path.join(root, 'install-invocations'), 'utf8').trim().split('\\n').length;
    const emit = (type, fields) => console.log('MAC2JB_SAVEKIT ' + JSON.stringify({type, ...fields,
      ...(game ? {game} : {})}));
    const install = () => {
      emit('backup', {backupPath: backup, message: 'Original save backed up'});
      const present = new Set(fs.readdirSync(backup));
      if (${Boolean(options.existingEditor)}) {
        if (!present.has('ssedit1.lua') || !present.has('sed01.asb')) process.exit(4);
        emit('skipped', {backupPath: backup, files: 273, message: 'Seedsow editor already present; no files were changed'});
      } else {
        emit('progress', {stage: 'writing', message: 'Writing the fixture save'});
        emit('complete', {backupPath: backup, files: variant ?
          (variant === 'showcase' ? 21 : 20) : ${Number(options.writtenFiles || 273)},
          message: 'Save installed'});
      }
    };
    if (${Boolean(options.absentSave)}) {
      emit('progress', {stage: 'backup', message: 'Backing up the selected demo save'});
      emit('failed', {reason: 'save-absent',
        message: 'Demo has no save data yet. Launch it, create a save, close it fully, then retry.'});
      process.exitCode = 1;
    } else if ((${Boolean(options.artemisCheckFailure)} && game) ||
        (${Boolean(options.secondArtemisFailure)} && game && installCount === 2)) {
      emit('progress', {stage: 'checking', message: 'Checking pinned launcher download'});
      emit('failed', {message: 'The pinned launcher download is unavailable'});
      process.exitCode = 1;
    } else if (${Boolean(options.secondArtemisAfterBackupFailure)} && game && installCount === 2) {
      emit('backup', {backupPath: backup, message: 'Original save backed up'});
      emit('failed', {backupPath: backup, message: 'The second save writer stopped'});
      process.exitCode = 1;
    } else if (${Boolean(options.fullGamePreflightFailure)} && game === 'seedsow' &&
        process.argv[5] === 'full') {
      emit('progress', {stage: 'backup', message: 'Checking full-game save'});
      emit('backup', {backupPath: backup, message: 'Original save backed up'});
      emit('failed', {backupPath: backup, reason: 'save-preflight',
        message: 'The full-game autosave is incompatible; no write started'});
      process.exitCode = 1;
    } else if (${Boolean(options.balatroUnchangedWriteFailure)} && game === 'balatro') {
      emit('backup', {backupPath: backup, message: 'Original save backed up'});
      emit('progress', {stage: 'writing', message: 'Writing Balatro save'});
      emit('failed', {backupPath: backup, reason: 'save-unchanged',
        message: 'Balatro save write failed; original files verified unchanged'});
      process.exitCode = 1;
    } else if (${Boolean(options.balatroUnverifiedWriteFailure)} && game === 'balatro') {
      emit('backup', {backupPath: backup, message: 'Original save backed up'});
      emit('progress', {stage: 'writing', message: 'Writing Balatro save'});
      emit('failed', {backupPath: backup, reason: 'save-unchanged',
        message: 'The writer claimed an unchanged save without a verified comparison'});
      process.exitCode = 2;
    } else if (${Boolean(options.multipleUsers)}) {
      emit('choose-user', {users: ${JSON.stringify([account, 'b'.repeat(32)])}, message: 'Choose account'});
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', data => {
        const selected = JSON.parse(data.trim());
        if (selected.action !== 'select-user' || !${JSON.stringify([account, 'b'.repeat(32)])}.includes(selected.uid)) process.exit(5);
        fs.writeFileSync(path.join(root, 'selected-user'), selected.uid);
        install();
        process.stdin.destroy();
      });
    } else install();
  `);
  fs.writeFileSync(path.join(scripts, 'gui-savekit-tools.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '..');
    exports.request = value => ({...value, archiveSelection: value.archive ?? {}});
    if (require.main === module) {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const value = JSON.parse(input);
        fs.appendFileSync(path.join(root, 'tool-invocations'), JSON.stringify(value) + '\\n');
        const emit = (type, fields) => console.log('MAC2JB_SAVEKIT ' + JSON.stringify({type, ...fields}));
        if (value.action === 'titles') {
          if (${Boolean(options.titleUnsafeFailure)}) {
            emit('failed', {message: 'Title-name lookup did not confirm cleanup', unsafe: true});
            process.exit(1);
          }
          emit('titles', {titles: ${JSON.stringify([noraTitle, otherTitle])},
            writable: [${JSON.stringify(noraTitle)}], message: '2 titles found'});
          emit('complete', {action: 'titles', message: 'Title list ready'});
          return;
        }
        if (value.action === 'accounts') {
          emit('accounts', {users: [${JSON.stringify(account)}], message: '1 account found'});
          emit('complete', {action: 'accounts', message: 'Account list ready'});
          return;
        }
        if (value.action === 'write') {
          const attempts = fs.readFileSync(path.join(root, 'tool-invocations'), 'utf8')
            .trim().split('\\n').map(JSON.parse).filter(item => item.action === 'write').length;
          const backupPath = path.join(root, 'savekit-exports/write-backup-' + attempts);
          fs.mkdirSync(backupPath, {recursive: true});
          emit('backup', {backupPath, files: 1, bytes: 4, message: 'Original save backed up and verified'});
          if (${Boolean(options.preWriteFailure)} && attempts === 1) {
            emit('failed', {backupPath, safeToContinue: true,
              message: 'The selected local save folder is invalid; no writer started'});
            process.exit(1);
          }
          if (${Boolean(options.postWriteFailure)} && attempts === 1) {
            emit('failed', {backupPath, message: 'The save writer stopped after starting'});
            process.exit(1);
          }
          emit('complete', {action: 'write', backupPath, files: 1,
            message: 'Save write committed and verified'});
          fs.writeFileSync(path.join(root, 'tool-write-completed'), 'yes');
          return;
        }
        if (value.action !== 'backup' || !/^[a-f0-9]{16}$/.test(value.titleId)) process.exit(3);
        const backupPath = path.join(root, 'savekit-exports/nora-fixture');
        emit('backup', {backupPath, files: 1, bytes: 4, message: 'Game save backup verified'});
        emit('complete', {action: 'backup', backupPath, files: 1, bytes: 4, message: 'Game save backup complete'});
      });
    }
  `);
  fs.writeFileSync(path.join(scripts, 'gui-mintbrew.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '..');
    fs.writeFileSync(path.join(root, 'mintbrew-launched'), 'yes');
    const emit = type => console.log('MAC2JB_HOMEBREW ' + JSON.stringify({type, message: 'fixture ' + type}));
    emit('started'); emit('running');
    process.on('SIGTERM', () => { emit('stopped'); process.exit(0); });
    setInterval(() => {}, 1000);
  `);

  const child = spawn(process.execPath,
    [path.join(scripts, 'gui-host.cjs'), 'host', '127.0.0.1', '--post-run-options', mode],
    {detached: true, stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', error = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => error += chunk);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, output, error}));
  });
  t.after(async () => {
    for (const file of [path.join(root, 'runner-pid')]) {
      try { process.kill(-Number(fs.readFileSync(file, 'utf8')), 'SIGKILL'); } catch {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(root, {recursive: true, force: true});
  });
  const events = () => {
    const end = output.lastIndexOf('\n');
    return end < 0 ? [] : output.slice(0, end).split('\n').filter(Boolean).map(JSON.parse);
  };
  async function wait(type, count = 1) {
    const deadline = Date.now() + 5000;
    while (events().filter(event => event.type === type).length < count) {
      assert.equal(child.exitCode, null, output + error);
      assert.ok(Date.now() < deadline, 'Missing ' + type + '\n' + output + error);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return events().filter(event => event.type === type).at(-1);
  }
  return {root, child, done, events, wait,
    send: value => child.stdin.write(JSON.stringify(value) + '\n')};
}

for (const hostId of ['kurumuz', 'cellenseres', 'astral']) test(
  hostId + ' Seedsow install keeps rpc held for further verified save actions',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save', {hostId});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save'});
  await session.wait('savekit-complete');
  await session.wait('savekit-ready');
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  assert.equal(session.child.exitCode, null);

  session.send({action: 'savekit-tool', request: {action: 'titles'}});
  const titles = await session.wait('savekit-tool-titles');
  assert.deepEqual(titles.titles, [noraTitle, otherTitle]);
  await session.wait('savekit-tool-complete');
  session.send({action: 'savekit-tool', request: {action: 'accounts'}});
  const accounts = await session.wait('savekit-tool-accounts');
  assert.deepEqual(accounts.users, [account]);
  await session.wait('savekit-tool-complete', 2);

  const request = {action: 'backup', titleId: otherTitle, uid: account, all: true};
  session.send({action: 'savekit-tool', request});
  await session.wait('savekit-tool-complete', 3);
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);

  session.send({action: 'savekit-tool', request});
  await session.wait('savekit-tool-complete', 4);
  session.send({action: 'savekit-tool', request: {
    action: 'write', titleId: noraTitle, uid: account, sourceFolder: '/tmp/fixture'
  }});
  await session.wait('savekit-tool-complete', 5);
  session.send({action: 'launch-mintbrew'});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root, 'mintbrew-launched')), false);
  const invocations = fs.readFileSync(path.join(session.root, 'tool-invocations'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(invocations.map(item => item.action), ['titles', 'accounts', 'backup', 'backup', 'write']);
  assert.deepEqual(invocations[2], request);

  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done');
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  assert.equal(fs.existsSync(path.join(session.root, 'mintbrew-launched')), true);

  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(session.events().some(event => event.type === 'verified'), true);
  const report = JSON.parse(fs.readFileSync(path.join(session.root,
    'vendor/ns2-savekit-host-fixture/runs/switch2-test/result.json'), 'utf8'));
  assert.equal(report.rpc.state, 'closed');
  assert.equal(report.fs.cleanup.cleanedUp, true);
  assert.equal(fs.readFileSync(path.join(session.root, 'install-invocations'), 'utf8'), 'install\n');
});

for (const mode of ['--seedsow-save', '--savekit-tools']) for (const game of ['seedsow', 'nora']) test(
  mode + ' ' + game + ' Artemis launcher install keeps its title-specific backup and permits homebrew',
  {timeout: 15000}, async t => {
  const session = fixture(t, mode);
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-artemis-save', game: 'wrong'});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
  session.send({action: 'install-artemis-save', game});
  const backup = await session.wait('savekit-backup');
  assert.equal(backup.game, game);
  assert.match(backup.backupPath, new RegExp('/artemis-backups/' + game + '-'));
  const complete = await session.wait('savekit-complete');
  assert.equal(complete.game, game);
  assert.equal((await session.wait('savekit-ready')).game, game);
  assert.equal(fs.readFileSync(path.join(session.root, 'artemis-game'), 'utf8'), game);
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  assert.equal(fs.existsSync(path.join(session.root, 'mintbrew-launched')), true);
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.match(session.events().find(event => event.type === 'verified').message,
    new RegExp((game === 'seedsow' ? 'Seedsow Lullaby' : 'Nora Princess 2') +
      ' launcher installed and verified'));
});

test('held RPC routes Seedsow full-game install to the full-game worker',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools');
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-artemis-save', game: 'nora', variant: 'full'});
  await session.wait('action-rejected');
  session.send({action: 'install-artemis-save', game: 'seedsow', variant: 'full'});
  await session.wait('savekit-ready');
  assert.equal(fs.readFileSync(path.join(session.root, 'artemis-variant'), 'utf8'), 'full');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.match(session.events().find(event => event.type === 'verified').message, /full game/);
});

test('a full-game save mismatch after backup keeps verified held RPC available',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {fullGamePreflightFailure: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-artemis-save', game: 'seedsow', variant: 'full'});
  await session.wait('savekit-recoverable');
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('held RPC routes the bundled Pro editor without a local source',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools');
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save', variant: 'pro', sourcePath: '/tmp/other.zip'});
  await session.wait('action-rejected');
  session.send({action: 'install-seedsow-save', variant: 'pro'});
  await session.wait('savekit-ready');
  assert.equal(fs.readFileSync(path.join(session.root, 'editor-pro-selected'), 'utf8'), 'yes');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.match(session.events().find(event => event.type === 'verified').message, /Editor Pro/);
});

for (const variant of ['upstream', 'showcase']) test(
  `Balatro ${variant} save keeps its verified backup and held RPC available`,
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save');
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'install-balatro-save', variant: 'wrong'});
    await session.wait('action-rejected');
    assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
    session.send({action: 'install-balatro-save', variant});
    const backup = await session.wait('savekit-backup');
    assert.equal(backup.game, 'balatro');
    assert.match(backup.backupPath, /\/balatro-backups\/balatro-/);
    const complete = await session.wait('savekit-complete');
    assert.equal(complete.game, 'balatro');
    assert.equal(complete.files, variant === 'showcase' ? 21 : 20);
    assert.equal((await session.wait('savekit-ready')).game, 'balatro');
    assert.equal(fs.readFileSync(path.join(session.root, 'balatro-variant'), 'utf8'), variant);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
  });

test('Balatro without an existing save remains a recoverable held RPC action',
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save', {absentSave: true});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'install-balatro-save', variant: 'showcase'});
    const recoverable = await session.wait('savekit-recoverable');
    assert.equal(recoverable.game, 'balatro');
    assert.match(recoverable.message, /create a save/);
    assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
  });

test('Balatro write failure with a verified unchanged save keeps held RPC usable',
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save', {balatroUnchangedWriteFailure: true});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'install-balatro-save', variant: 'showcase'});
    await session.wait('savekit-backup');
    const recoverable = await session.wait('savekit-recoverable');
    assert.equal(recoverable.game, 'balatro');
    assert.match(recoverable.message, /verified unchanged/);
    assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
  });

test('Balatro write failure without an unchanged-save proof closes held RPC',
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save', {balatroUnverifiedWriteFailure: true});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'install-balatro-save', variant: 'showcase'});
    await session.wait('savekit-failed');
    await session.wait('rpc-finishing');
    const result = await session.done;
    assert.notEqual(result.code, 0);
  });

test('Artemis download failure before save access keeps verified RPC available',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save', {artemisCheckFailure: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-artemis-save', game: 'nora'});
  const recoverable = await session.wait('savekit-recoverable');
  assert.equal(recoverable.game, 'nora');
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  assert.equal(session.events().some(event => event.type === 'savekit-backup'), false);
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

for (const game of [undefined, 'seedsow', 'nora']) test(
  `${game || 'editor'} missing demo save leaves held RPC available for another choice`,
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save',
      {absentSave: true, rpcStatusThrowsAfterSave: true});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send(game ? {action: 'install-artemis-save', game} : {action: 'install-seedsow-save'});
    const recoverable = await session.wait('savekit-recoverable');
    assert.equal(recoverable.game, game);
    assert.match(recoverable.message, /create a save/);
    assert.equal(session.events().some(event =>
      ['savekit-complete', 'savekit-failed', 'rpc-finishing'].includes(event.type)), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
  });

test('two Artemis saves use separate workers and keep held RPC available', {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save');
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-artemis-save', game: 'seedsow'});
  await session.wait('savekit-ready');
  session.send({action: 'install-artemis-save', game: 'nora'});
  await session.wait('savekit-ready', 2);
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  assert.equal(fs.readFileSync(path.join(session.root, 'install-invocations'), 'utf8'), 'install\ninstall\n');
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('a failed second Artemis writer cannot inherit the first install success',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save', {secondArtemisAfterBackupFailure: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-artemis-save', game: 'seedsow'});
  await session.wait('savekit-ready');
  session.send({action: 'install-artemis-save', game: 'nora'});
  await session.wait('savekit-failed');
  await session.wait('rpc-finishing');
  const result = await session.done;
  assert.notEqual(result.code, 0);
  assert.equal(session.events().filter(event => event.type === 'savekit-ready').length, 1);
});

test('SaveKit writes use fresh backups and can resume after Done in one held session',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools');
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'start-savekit'});
  await session.wait('savekit-selected');
  for (let index = 1; index <= 2; index++) {
    session.send({action: 'savekit-tool', request: {
      action: 'write', titleId: noraTitle, uid: account, sourceFolder: '/tmp/fixture'
    }});
    const completed = await session.wait('savekit-tool-complete', index);
    assert.equal(completed.backupPath, path.join(session.root, 'savekit-exports/write-backup-' + index));
  }
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done');
  session.send({action: 'start-savekit'});
  await session.wait('savekit-selected', 2);
  session.send({action: 'savekit-tool', request: {
    action: 'write', titleId: noraTitle, uid: account, sourceFolder: '/tmp/fixture'
  }});
  const repeated = await session.wait('savekit-tool-complete', 3);
  assert.equal(repeated.backupPath, path.join(session.root, 'savekit-exports/write-backup-3'));
  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done', 2);
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('verified SaveKit write and Done return to homebrew without status probes',
  {timeout: 15000}, async t => {
    const session = fixture(t, '--savekit-tools', {rpcStatusThrowsAfterTool: true});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'start-savekit'});
    await session.wait('savekit-selected');
    session.send({action: 'savekit-tool', request: {
      action: 'write', titleId: noraTitle, uid: account, sourceFolder: '/tmp/fixture'
    }});
    await session.wait('savekit-tool-complete');
    session.send({action: 'finish-savekit'});
    await session.wait('savekit-done');
    assert.equal(session.events().some(event =>
      ['savekit-tool-failed', 'action-rejected', 'rpc-finishing'].includes(event.type)), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
  });

test('pre-writer SaveKit rejection keeps RPC and permits another write',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {preWriteFailure: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'start-savekit'});
  await session.wait('savekit-selected');
  const request = {action: 'write', titleId: noraTitle, uid: account, sourceFolder: '/tmp/fixture'};
  session.send({action: 'savekit-tool', request});
  const failed = await session.wait('savekit-tool-failed');
  assert.equal(failed.safeToContinue, true);
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  session.send({action: 'savekit-tool', request});
  await session.wait('savekit-tool-complete');
  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('a SaveKit writer failure after starting remains terminal', {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {postWriteFailure: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'start-savekit'});
  await session.wait('savekit-selected');
  session.send({action: 'savekit-tool', request: {
    action: 'write', titleId: noraTitle, uid: account, sourceFolder: '/tmp/fixture'
  }});
  const failed = await session.wait('savekit-tool-failed');
  assert.equal(failed.safeToContinue, false);
  await session.wait('rpc-finishing');
  const result = await session.done;
  assert.notEqual(result.code, 0);
});

test('unconfirmed title-name cleanup stops held RPC before another save action', {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save', {titleUnsafeFailure: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save'});
  await session.wait('savekit-ready');
  session.send({action: 'savekit-tool', request: {action: 'titles'}});
  const failed = await session.wait('savekit-tool-failed');
  assert.match(failed.message, /did not confirm cleanup/);
  await session.wait('rpc-finishing');
  const result = await session.done;
  assert.notEqual(result.code, 0);
  const invocations = fs.readFileSync(path.join(session.root, 'tool-invocations'), 'utf8').trim().split('\n');
  assert.equal(invocations.length, 1);
  assert.equal(JSON.parse(invocations[0]).action, 'titles');
});

for (const hostId of ['kurumuz', 'cellenseres', 'astral']) test(
  hostId + ' host-only held rpc accepts savekit without installing seedsow',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {hostId});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  const request = {action: 'backup', titleId: noraTitle, uid: account, all: true};
  session.send({action: 'savekit-tool', request});
  await session.wait('savekit-tool-complete');
  assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done');
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(session.events().some(event => event.type === 'verified'), true);
});

for (const hostId of ['kurumuz', 'cellenseres', 'astral']) test(
  hostId + ' host-only held rpc installs Seedsow then returns to homebrew',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {hostId});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save'});
  await session.wait('savekit-complete');
  await session.wait('savekit-ready');
  assert.equal(session.child.exitCode, null);
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  session.send({action: 'install-seedsow-save'});
  await session.wait('savekit-ready', 2);
  session.send({action: 'savekit-tool', request: {
    action: 'backup', titleId: noraTitle, uid: account, all: true
  }});
  await session.wait('savekit-tool-complete');
  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done');
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  assert.equal(fs.readFileSync(path.join(session.root, 'mintbrew-launched'), 'utf8'), 'yes');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(fs.readFileSync(path.join(session.root, 'install-invocations'), 'utf8'), 'install\ninstall\n');
});

test('host-only held rpc can select SaveKit instead of installing Seedsow',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools');
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'start-savekit'});
  await session.wait('savekit-selected');
  session.send({action: 'install-seedsow-save'});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
  session.send({action: 'savekit-tool', request: {action: 'titles'}});
  await session.wait('savekit-tool-complete');
  session.send({action: 'finish-savekit'});
  await session.wait('savekit-done');
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('host-only held rpc passes a custom Seedsow save to the worker',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {hostId: 'cellenseres'});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save', sourcePath: 'relative.zip'});
  await session.wait('action-rejected');
  const source = '/Users/test/Custom Seedsow Editor.zip';
  session.send({action: 'install-seedsow-save', sourcePath: source});
  await session.wait('savekit-ready');
  assert.equal(fs.readFileSync(path.join(session.root, 'custom-editor-source'), 'utf8'), source);
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('host-only Seedsow install selects the requested account before writing',
  {timeout: 15000}, async t => {
  const session = fixture(t, '--savekit-tools', {multipleUsers: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save'});
  const prompt = await session.wait('savekit-choose-user');
  assert.deepEqual(prompt.users, [account, 'b'.repeat(32)]);
  session.send({action: 'select-seedsow-user', uid: 'c'.repeat(32)});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root, 'selected-user')), false);
  const selected = 'b'.repeat(32);
  session.send({action: 'select-seedsow-user', uid: selected});
  await session.wait('savekit-ready');
  assert.equal(fs.readFileSync(path.join(session.root, 'selected-user'), 'utf8'), selected);
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

test('upstream Seedsow editor write keeps rpc held for Nora export', {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save');
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save'});
  const update = await session.wait('savekit-complete');
  assert.equal(update.files, 273);
  await session.wait('savekit-ready');
  assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
  session.send({action: 'savekit-tool', request: {
    action: 'backup', titleId: noraTitle, uid: account, all: true
  }});
  await session.wait('savekit-tool-complete');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
});

for (const existingEditor of [false, true]) test(
  (existingEditor ? 'skipped' : 'written') + ' Seedsow save allows MintBrew in the same held session',
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save', {existingEditor});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'install-seedsow-save'});
    await session.wait(existingEditor ? 'savekit-skipped' : 'savekit-complete');
    await session.wait('savekit-ready');
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    assert.equal(fs.readFileSync(path.join(session.root, 'mintbrew-launched'), 'utf8'), 'yes');
    assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('action-rejected');
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
    assert.equal(session.events().some(event => event.type === 'verified'), true);
  });

test('verified Seedsow write returns to homebrew without a post-write status probe',
  {timeout: 15000}, async t => {
    const session = fixture(t, '--seedsow-save', {rpcStatusThrowsAfterSave: true});
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'install-seedsow-save'});
    await session.wait('savekit-complete');
    await session.wait('savekit-ready');
    assert.equal(session.events().some(event => event.type === 'savekit-failed'), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
    assert.equal(fs.existsSync(path.join(session.root, 'mintbrew-launched')), true);
  });

test('held jailbreak offers MintBrew before any Seedsow save operation', {timeout: 15000}, async t => {
  const session = fixture(t);
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
  session.send({action: 'launch-mintbrew'});
  await session.wait('homebrew-running');
  assert.equal(fs.readFileSync(path.join(session.root, 'mintbrew-launched'), 'utf8'), 'yes');
  session.send({action: 'install-seedsow-save'});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
  session.send({action: 'finish'});
  assert.equal((await session.done).code, 0);
});

test('selected Seedsow editor source reaches the save worker after held RPC', {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save', {writtenFiles: 3});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save', sourcePath: 'relative.zip'});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
  const source = '/Users/test/Custom Seedsow Editor.zip';
  session.send({action: 'install-seedsow-save', sourcePath: source});
  const complete = await session.wait('savekit-complete');
  assert.equal(complete.files, 3);
  await session.wait('savekit-ready');
  assert.equal(fs.readFileSync(path.join(session.root, 'custom-editor-source'), 'utf8'), source);
  session.send({action: 'finish'});
  assert.equal((await session.done).code, 0);
});

test('held jailbreak can choose SaveKit instead of installing a Seedsow save',
  {timeout: 15000}, async t => {
    const session = fixture(t);
    await session.wait('post-run-ready');
    session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
    await session.wait('rpc-held');
    session.send({action: 'start-savekit'});
    await session.wait('savekit-selected');
    session.send({action: 'install-seedsow-save'});
    await session.wait('action-rejected');
    const request = {action: 'backup', titleId: noraTitle, uid: account, all: false};
    session.send({action: 'savekit-tool', request});
    await session.wait('savekit-tool-complete');
    assert.equal(fs.existsSync(path.join(session.root, 'install-invocations')), false);
    session.send({action: 'finish-savekit'});
    await session.wait('savekit-done');
    assert.equal(session.events().some(event => event.type === 'rpc-finishing'), false);
    session.send({action: 'launch-mintbrew'});
    await session.wait('homebrew-running');
    assert.equal(fs.existsSync(path.join(session.root, 'mintbrew-launched')), true);
    session.send({action: 'finish'});
    const result = await session.done;
    assert.equal(result.code, 0, result.output + result.error);
  });

test('existing Seedsow editor skips the write and keeps rpc held for Nora export', {timeout: 15000}, async t => {
  const session = fixture(t, '--seedsow-save', {existingEditor: true});
  await session.wait('post-run-ready');
  session.send({action: 'post-run', keepRPC: true, dumpFirmware: false});
  await session.wait('rpc-held');
  session.send({action: 'install-seedsow-save'});
  const skipped = await session.wait('savekit-skipped');
  assert.match(skipped.backupPath, /seedsow-backups\/demo-fixture$/);
  assert.equal(skipped.files, 273);
  await session.wait('savekit-ready');
  assert.equal(session.events().some(event => ['savekit-complete', 'savekit-failed', 'rpc-finishing'].includes(event.type)), false);
  assert.equal(session.child.exitCode, null);

  const request = {action: 'backup', titleId: noraTitle, uid: account, all: true};
  session.send({action: 'savekit-tool', request});
  await session.wait('savekit-tool-complete');
  session.send({action: 'finish'});
  const result = await session.done;
  assert.equal(result.code, 0, result.output + result.error);
  assert.equal(session.events().some(event => event.type === 'verified'), true);
  const report = JSON.parse(fs.readFileSync(path.join(session.root,
    'vendor/ns2-savekit-host-fixture/runs/switch2-test/result.json'), 'utf8'));
  assert.equal(report.rpc.state, 'closed');
  assert.equal(report.fs.cleanup.cleanedUp, true);
});
