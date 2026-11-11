#!/usr/bin/env node
'use strict';
// A pinned, add-only save integration. Payload code is downloaded, never bundled.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const releaseModule = require('./lib/balatro-release.cjs');
const {sha256, normalizeUid, plainPath, loadBackup, compareFiles} = require('./lib/balatro-backup.cjs');

const check = (condition, message) => { if (!condition) throw Error(message); };
const RECEIPT_KIND = 'ns2-savekit/balatro-launcher-install';
const DEFAULT_STATE = path.join(os.homedir(), '.local', 'state', 'ns2-savekit', 'balatro-launcher');

function parseArgs(argv) {
  const args = [...argv];
  const action = args.shift();
  const options = {action};
  if (args[0] && !args[0].startsWith('--')) options.run = args.shift();
  const flags = new Set(['confirm', 'confirm-restore', 'dry-run']);
  const values = new Set(['title', 'uid', 'archive', 'out', 'backup', 'receipt', 'state-dir']);
  while (args.length) {
    const text = args.shift();
    check(text.startsWith('--'), 'Unexpected argument: ' + text);
    const key = text.slice(2);
    check(!(key in options), 'Repeated option: ' + text);
    if (flags.has(key)) options[key] = true;
    else {
      check(values.has(key), 'Unknown option: ' + text);
      check(args[0] && !args[0].startsWith('--'), text + ' requires a value');
      options[key] = args.shift();
    }
  }
  check(['stage', 'plan', 'install', 'verify', 'restore'].includes(action),
    'usage: balatro-launcher.cjs <stage|plan|install|verify|restore> [run] [options]');
  return options;
}

async function runStep(script, args, options = {}) {
  console.log('$ node ' + script + ' ' + args.map(value => JSON.stringify(value)).join(' '));
  const child = spawnSync(process.execPath, [path.join(__dirname, script), ...args],
    {stdio: 'inherit', ...options});
  check(!child.error && child.status === 0,
    script + ' failed (' + (child.error?.message || 'exit ' + child.status) + '); keep the printed backups and receipt');
}

function assertFreshBaseline(backup, installPaths) {
  const owned = new Set(installPaths);
  for (const entry of backup.entries) {
    const filename = entry.path;
    check(!owned.has(filename) &&
      !['/.lovegame', '/.lovegame/bl', '/.lovegame/workers'].includes(filename) &&
      !filename.startsWith('/.lovegame/bl/') && !filename.startsWith('/.lovegame/workers/') &&
      !(filename.startsWith('/.lovegame/') && filename.toLowerCase().endsWith('.lua')),
    'Launcher or script collision at ' + filename + '; restore the previous installation before installing');
  }
}

function createLauncher({release = releaseModule, run = runStep, log = console.log} = {}) {
  const {CONFIG, TITLE_ID, INSTALL_PATHS} = release;
  const expected = CONFIG.files.map(({path: filename, size, sha256: hash}) =>
    ({path: filename, size, sha256: hash}));
  const owned = new Set(INSTALL_PATHS);
  const checkedBackup = (directory, uid) => loadBackup(directory, {titleId: TITLE_ID, uid});

  function identity(options, requireUid = true) {
    check(!options.title || options.title.toLowerCase().replace(/^0x/, '') === TITLE_ID,
      'Only Balatro Switch 1 edition ' + TITLE_ID + ' is supported; native Switch 2 is excluded');
    return requireUid ? normalizeUid(options.uid) : options.uid ? normalizeUid(options.uid) : null;
  }

  async function workDirectory(options, uid, purpose, protectedDirectories = []) {
    const parent = path.join(path.resolve(options['state-dir'] || DEFAULT_STATE), TITLE_ID, uid);
    for (const directory of protectedDirectories) {
      const relative = path.relative(path.resolve(directory), parent);
      check(relative !== '' && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)),
        'Operation state must be outside backup directories: ' + parent);
    }
    await plainPath(parent, {allowMissing: true});
    await fs.mkdir(parent, {recursive: true, mode: 0o700});
    await plainPath(parent, {kind: 'directory'});
    return fs.mkdtemp(path.join(parent, purpose + '-'));
  }

  async function pull(runDirectory, uid, directory) {
    await run('save-pull-root.cjs', [path.resolve(runDirectory), TITLE_ID, directory, uid,
      '--space', '1', '--type', '1']);
    return checkedBackup(directory, uid);
  }

  async function readReceipt(filename, uid) {
    check(filename, '--receipt is required; use the receipt printed before installation');
    const receiptPath = await plainPath(filename, {kind: 'file'});
    const raw = await fs.readFile(receiptPath);
    const receipt = JSON.parse(raw.toString('utf8'));
    check(receipt?.kind === RECEIPT_KIND && receipt.version === 1 &&
      receipt.programId === TITLE_ID && receipt.uid === uid && receipt.space === 1 && receipt.type === 1,
    'Receipt identity or format does not match this account/title');
    check(receipt.upstream?.sha256 === CONFIG.upstream.sha256 && receipt.upstream?.commit === CONFIG.upstream.commit,
      'Receipt does not describe the pinned Balatro release');
    check(JSON.stringify(receipt.files) === JSON.stringify(expected), 'Receipt file ownership differs from the pinned release');
    check(typeof receipt.baseline?.directory === 'string' && path.isAbsolute(receipt.baseline.directory),
      'Receipt has no absolute baseline directory');
    const baseline = await checkedBackup(receipt.baseline.directory, uid);
    check(baseline.manifestSha256 === receipt.baseline.manifestSha256,
      'The original baseline manifest changed; refusing to trust this receipt');
    assertFreshBaseline(baseline, INSTALL_PATHS);
    return {receipt, receiptPath, baseline, receiptSha256: sha256(raw)};
  }

  async function stage(options) {
    identity(options, false);
    check(options.out, 'stage requires --out pointing to a new directory');
    const parent = path.dirname(path.resolve(options.out));
    await plainPath(parent, {allowMissing: true});
    await fs.mkdir(parent, {recursive: true});
    const archive = await release.obtainArchive({archive: options.archive});
    const result = await release.stageArchive(archive, path.resolve(options.out));
    const manifest = {programId: TITLE_ID, upstream: CONFIG.upstream,
      generatedBy: 'tools/balatro-launcher.cjs', files: result.files};
    await fs.writeFile(path.join(result.directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    log('Staged ' + result.files.length + ' launcher files in ' + result.directory);
    log('No console operation was performed. JKSV metadata is excluded.');
    return {...result, manifest};
  }

  async function plan(options) {
    const uid = identity(options, false);
    check(options.backup, 'plan and install --dry-run require --backup with a complete pull');
    const backup = await checkedBackup(options.backup, uid);
    assertFreshBaseline(backup, INSTALL_PATHS);
    log('Balatro Switch 1 edition ' + TITLE_ID + '; upstream ' + CONFIG.upstream.tag + ' / ' + CONFIG.buildId);
    log('Add ' + expected.length + ' launcher files; preserve all ' + backup.entries.length + ' existing save files.');
    log('Balatro will boot into the Lua launcher instead of gameplay.');
    for (const entry of expected) log('  add ' + entry.path + ' (' + entry.size + ' bytes)');
    log('Plan only: no download or console operation was performed.');
    return {backup, files: expected};
  }

  async function install(options) {
    const uid = identity(options);
    if (options['dry-run']) return plan({...options, uid});
    check(options.confirm, 'install requires --confirm after reviewing the plan');
    check(options.run, 'install requires a live run directory');
    const supplied = options.backup ? await checkedBackup(options.backup, uid) : null;
    if (supplied) assertFreshBaseline(supplied, INSTALL_PATHS);
    const archive = await release.obtainArchive({archive: options.archive});
    const work = await workDirectory(options, uid, 'install', supplied ? [supplied.dir] : []);
    const staged = await release.stageArchive(archive, path.join(work, 'payload'));
    const before = await pull(options.run, uid, path.join(work, 'before'));
    assertFreshBaseline(before, INSTALL_PATHS);
    if (supplied) {
      const problems = compareFiles(supplied.entries, before);
      check(!problems.length && supplied.entries.length === before.entries.length,
        'The live save differs from --backup; take a new backup before installing');
    }
    // The immutable record exists before the first write, including failed or
    // interrupted writes. Reinstallation cannot replace the original baseline.
    const receipt = {kind: RECEIPT_KIND, version: 1, programId: TITLE_ID, uid, space: 1, type: 1,
      createdAt: new Date().toISOString(), upstream: CONFIG.upstream,
      baseline: {directory: before.dir, manifestSha256: before.manifestSha256}, files: expected};
    const receiptPath = path.join(work, 'receipt.json');
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    const manifestPath = path.join(work, 'write-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({programId: TITLE_ID, uid, space: 1, type: 1,
      files: staged.files}, null, 2) + '\n', {flag: 'wx'});
    log('Original backup: ' + before.dir);
    log('Keep this rollback receipt: ' + receiptPath);
    await run('save-write-stage.cjs', [path.resolve(options.run), TITLE_ID, uid, before.dir, manifestPath,
      '--space', '1', '--type', '1'], {cwd: staged.directory});
    const post = await pull(options.run, uid, path.join(work, 'after'));
    const problems = compareFiles([...before.entries, ...expected], post);
    check(!problems.length, 'Install verification failed: ' + problems.join('; '));
    log('Installed and verified ' + expected.length + ' files; existing gameplay files are preserved.');
    log('Fully relaunch the Switch 1 edition of Balatro; expected launcher build ' + CONFIG.buildId + '.');
    log('Rollback: node tools/balatro-launcher.cjs restore <run> --uid ' + uid +
      ' --receipt ' + JSON.stringify(receiptPath) + ' --confirm-restore');
    return {receiptPath, before, post, work};
  }

  async function verify(options) {
    const uid = identity(options);
    check(options.run, 'verify requires a live run directory');
    const record = await readReceipt(options.receipt, uid);
    const work = await workDirectory(options, uid, 'verify', [record.baseline.dir]);
    const current = await pull(options.run, uid, path.join(work, 'snapshot'));
    const problems = compareFiles([...record.baseline.entries, ...expected], current);
    check(!problems.length, 'Verification failed: ' + problems.join('; '));
    log('Verified pinned launcher files and all original gameplay files.');
    return {current, work};
  }

  async function restore(options) {
    const uid = identity(options);
    const record = await readReceipt(options.receipt, uid);
    if (!options['dry-run']) {
      check(options['confirm-restore'], 'restore requires --confirm-restore');
      check(options.run, 'restore requires a live run directory');
    } else check(options.backup, 'restore --dry-run requires --backup with a current complete pull');
    const work = options['dry-run'] ? null : await workDirectory(options, uid, 'restore', [record.baseline.dir]);
    const before = options['dry-run'] ? await checkedBackup(options.backup, uid)
      : await pull(options.run, uid, path.join(work, 'before'));
    const files = before.entries.filter(entry => owned.has(entry.path));
    const preserved = before.entries.filter(entry => !owned.has(entry.path));
    log('Remove ' + files.length + ' receipt-owned launcher files; preserve ' + preserved.length + ' other files.');
    for (const entry of files) log('  remove ' + entry.path);
    if (options['dry-run']) {
      log('Plan only: no console operation was performed.');
      return {files, preserved};
    }
    // Even modified launcher files are saved before removal. Unknown runtime,
    // FTP-created and gameplay files are never included in the delete plan.
    const manifest = {programId: TITLE_ID, uid, space: 1, type: 1,
      receipt: record.receiptPath, receiptSha256: record.receiptSha256,
      backup: before.dir, backupManifestSha256: before.manifestSha256, files};
    const manifestPath = path.join(work, 'remove-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    log('Pre-restore backup: ' + before.dir);
    log('Recovery plan: ' + manifestPath);
    if (files.length) await run('balatro-remove.cjs', [path.resolve(options.run), uid, manifestPath, '--confirm']);
    const post = await pull(options.run, uid, path.join(work, 'after'));
    const problems = compareFiles(preserved, post, {absent: INSTALL_PATHS});
    check(!problems.length, 'Rollback verification failed: ' + problems.join('; '));
    log('Launcher removed and gameplay entry points restored; other save files and logs were preserved.');
    return {before, post, work, removed: files.length};
  }

  return {stage, plan, install, verify, restore, readReceipt};
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  return createLauncher()[options.action](options);
}

if (require.main === module) main().catch(error => { console.error('FAILED:', error.message); process.exitCode = 1; });
module.exports = {parseArgs, assertFreshBaseline, createLauncher, main, RECEIPT_KIND};
