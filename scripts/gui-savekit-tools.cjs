#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tools = path.join(root, 'vendor/ns2-savekit/tools');
const uidPattern = /^[a-f0-9]{32}$/;
const titlePattern = /^[a-f0-9]{16}$/;
const spaces = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser',
  100: 'ProperSystem', 101: 'SafeMode', 102: 'ProperUser'};
const types = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary',
  5: 'Cache', 6: 'SystemBcat', 7: 'StreamPlay'};

function emit(type, fields = {}) {
  process.stdout.write('MAC2JB_SAVEKIT ' + JSON.stringify({type, ...fields}) + '\n');
}
function check(ok, message) { if (!ok) throw Error(message); }
async function shaFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function titleId(value) {
  const id = typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : '';
  check(titlePattern.test(id), 'Use a 16-digit hexadecimal program ID.');
  return id;
}
function uid(value) {
  const id = typeof value === 'string' ? value.toLowerCase() : '';
  check(uidPattern.test(id), 'Choose a 32-digit hexadecimal account ID.');
  return id;
}
function archive(value) {
  if (value === undefined) return {space: 1, type: 1, rank: 0, index: 0, staticId: 0};
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid save archive options.');
  const keys = ['space', 'type', 'rank', 'index', 'staticId'];
  check(Object.keys(value).every(key => keys.includes(key)), 'Unknown save archive option.');
  const defaults = {space: 1, type: 1, rank: 0, index: 0, staticId: 0};
  const result = {...defaults, ...value};
  for (const [name, limit] of [['space', 255], ['type', 7], ['rank', 1],
    ['index', 65535], ['staticId', Number.MAX_SAFE_INTEGER]])
    check(Number.isSafeInteger(result[name]) && result[name] >= 0 && result[name] <= limit,
      'Invalid save archive ' + name + '.');
  return result;
}
function archiveArgs(options) {
  return ['--space', String(options.space), '--type', String(options.type),
    '--rank', String(options.rank), '--index', String(options.index),
    '--static-id', String(options.staticId)];
}
function selectedArchiveArgs(options, all = false) {
  if (!all) return archiveArgs(options);
  const names = {space: '--space', type: '--type', rank: '--rank',
    index: '--index', staticId: '--static-id'};
  return Object.entries(options ?? {}).flatMap(([name, number]) => [names[name], String(number)]);
}
function request(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid savekit request.');
  const actions = new Set(['accounts', 'titles', 'inventory', 'inspect', 'backup', 'write',
    'restore', 'delete', 'verify', 'filetime']);
  check(actions.has(value.action), 'Unsupported savekit action.');
  const fields = {
    accounts: ['action'], titles: ['action'], inventory: ['action'],
    inspect: ['action', 'titleId', 'uid', 'archive', 'all'],
    backup: ['action', 'titleId', 'uid', 'archive', 'all'],
    filetime: ['action', 'titleId', 'uid', 'archive'],
    write: ['action', 'titleId', 'uid', 'sourceFolder', 'allowReplace'],
    restore: ['action', 'titleId', 'uid', 'archive', 'sourceFolder', 'confirmRestore'],
    delete: ['action', 'titleId', 'uid', 'fileName', 'confirmDelete'],
    verify: ['action', 'titleId', 'uid', 'expectedFolder', 'archive']
  };
  check(Object.keys(value).every(key => fields[value.action].includes(key)),
    'Unknown field in savekit request.');
  const parsed = {action: value.action};
  if (!['accounts', 'titles', 'inventory'].includes(value.action)) {
    parsed.titleId = titleId(value.titleId);
    parsed.uid = uid(value.uid);
  }
  if (['inspect', 'backup', 'filetime'].includes(value.action)) {
    parsed.archive = value.all === true ? archive(value.archive ?? {}) : archive(value.archive);
    parsed.archiveSelection = value.all === true ? value.archive ?? {} : parsed.archive;
    check(value.all === undefined || typeof value.all === 'boolean', 'Invalid all-archives option.');
    parsed.all = value.all === true;
    check(!parsed.all || value.action !== 'filetime', 'Timestamp probes need one archive.');
  }
  if (value.action === 'write') {
    check(typeof value.sourceFolder === 'string' && path.isAbsolute(value.sourceFolder),
      'Choose an absolute local save folder.');
    check(value.allowReplace === undefined || typeof value.allowReplace === 'boolean',
      'Invalid replacement option.');
    parsed.sourceFolder = value.sourceFolder;
    parsed.allowReplace = value.allowReplace === true;
  }
  if (value.action === 'restore') {
    check(typeof value.sourceFolder === 'string' && path.isAbsolute(value.sourceFolder),
      'Choose an absolute verified save backup folder.');
    check(value.confirmRestore === true, 'Confirm that you want to restore this save.');
    parsed.sourceFolder = value.sourceFolder;
    parsed.archive = archive(value.archive);
    check([1, 3].includes(parsed.archive.type) && parsed.archive.rank === 0 &&
      parsed.archive.index === 0 && parsed.archive.staticId === 0,
      'Restore currently supports Account or Device saves with rank 0, index 0 and static ID 0 only.');
  }
  if (value.action === 'delete') {
    check(safeRootName(value.fileName), 'Choose one file at the save root to delete.');
    check(value.confirmDelete === true, 'Confirm that you want to delete this save file.');
    parsed.fileName = value.fileName;
  }
  if (value.action === 'verify') {
    check(typeof value.expectedFolder === 'string' && path.isAbsolute(value.expectedFolder),
      'Choose an absolute backup folder to compare.');
    parsed.expectedFolder = value.expectedFolder;
    parsed.archive = archive(value.archive);
  }
  return parsed;
}

async function runTool(name, args, timeoutMs = 300000) {
  check(['save-pull-root.cjs', 'save-write-stage.cjs', 'save-delete-root.cjs', 'list-apps.cjs',
    'save-inventory.cjs',
    'savekit-title-names.cjs'].includes(name),
    'Unsupported savekit tool.');
  const script = name === 'savekit-title-names.cjs' ? path.join(root, 'scripts', name) : path.join(tools, name);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args],
      {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let stdout = '', stderr = '', exceeded = false, timedOut = false, interrupted = false;
    let forceTimer;
    const signalGroup = signal => {
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') process.stderr.write('savekit child stop: ' + error.message + '\n');
      }
    };
    const stopGroup = () => {
      signalGroup('SIGTERM');
      forceTimer ??= setTimeout(() => signalGroup('SIGKILL'), 3000);
      forceTimer.unref();
    };
    const onSignal = () => {interrupted = true; stopGroup();};
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        if (channel === 'stdout') stdout += chunk;
        else stderr += chunk;
        process.stderr.write(chunk);
        if (stdout.length + stderr.length > 16 * 1024 * 1024) {
          exceeded = true; stopGroup();
        }
      });
    }
    const timer = setTimeout(() => {timedOut = true; stopGroup();}, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    };
    child.once('error', error => {cleanup(); reject(error);});
    child.once('close', (code, signal) => {
      cleanup();
      if (interrupted) reject(Error(name + ' was interrupted. Check the live save before retrying.'));
      else if (timedOut) reject(Error(name + ' timed out. Restart the console before retrying.'));
      else if (exceeded) reject(Error(name + ' produced too much output.'));
      else resolve({code, signal, stdout, stderr});
    });
  });
}

function parseTitleNames(output, titles) {
  const prefix = 'MAC2JB_TITLE_NAMES ';
  const records = output.split('\n').filter(line => line.startsWith(prefix));
  check(records.length === 1 && Buffer.byteLength(records[0]) <= 512 * 1024,
    'Title-name lookup did not confirm its result and cleanup.');
  let value;
  try {value = JSON.parse(records[0].slice(prefix.length));}
  catch {throw Error('Title-name lookup returned invalid JSON.');}
  check(value && value.cleanupConfirmed === true && Array.isArray(value.titles) &&
    value.titles.length <= 2048, 'Title-name lookup did not confirm native cleanup.');
  const allowed = new Set(titles);
  const names = {};
  for (const entry of value.titles) {
    check(entry && typeof entry.titleId === 'string' && titlePattern.test(entry.titleId) &&
      allowed.has(entry.titleId) && typeof entry.name === 'string' &&
      Buffer.byteLength(entry.name) >= 1 && Buffer.byteLength(entry.name) <= 160 &&
      !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(entry.name) &&
      names[entry.titleId] === undefined,
    'Title-name lookup returned an invalid game label.');
    names[entry.titleId] = entry.name;
  }
  return names;
}

async function validRun(runDirectory) {
  check(typeof runDirectory === 'string' && path.isAbsolute(runDirectory),
    'Choose a verified held RPC run.');
  const run = await fsp.realpath(runDirectory);
  const civ = /\/civswitch-fs-[a-f0-9]{16}\/port\/engine\/runs\/switch2-[A-Za-z0-9_-]+$/.test(run);
  const artemis = /\/artemis-fs-[a-f0-9]{16}\/port\/engine\/runs\/switch2-[A-Za-z0-9_-]+$/.test(run);
  if (civ || artemis) {
    if (civ) await require('./prepare-civswitch-savekit.cjs').verifyPreparedRun(null, run);
    else await require('./prepare-artemis-fs.cjs').verifyPreparedRun(null, run);
    await require('./gui-dump.cjs').verifiedSession(run);
    if (process.env.MAC2JB_ATTACHED_RUN_MANIFEST)
      await require('./rpc-attachment.cjs').validateManifest(root, run);
    return run;
  }
  const vendor = await fsp.realpath(path.join(root, 'vendor'));
  const relative = path.relative(vendor, run).split(path.sep);
  check(relative.length === 3 && /^ns2-savekit-host-[A-Za-z0-9]+$/.test(relative[0]) &&
    relative[1] === 'runs' && /^switch2-[A-Za-z0-9_-]+$/.test(relative[2]),
    'SaveKit tools need this session’s patched SaveKit host run.');
  const info = await fsp.lstat(run);
  check(info.isDirectory() && !info.isSymbolicLink(), 'The RPC run folder is invalid.');
  return run;
}

function safeSavePath(value) {
  check(typeof value === 'string' && value.startsWith('/') && !value.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(value) && value === path.posix.normalize(value) &&
    value.split('/').slice(1).every(part => part && part !== '.' && part !== '..'),
    'The save manifest contains an unsafe path.');
  return value.slice(1);
}
function safeRootName(name) {
  return typeof name === 'string' && name !== '.' && name !== '..' &&
    !name.includes('/') && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name) &&
    Buffer.byteLength(name, 'utf8') < 0x301;
}
function validateArchive(manifest, expected = {}) {
  const {titleId: expectedTitle, uid: expectedUid, selection = {}, trustedStaticId = 0} = expected;
  const id = manifest.titleId ?? manifest.programId;
  check(titlePattern.test(id) && (!expectedTitle || id === expectedTitle),
  'The pulled save belongs to a different program ID.');
  const selected = manifest.selection ?? {uid: manifest.uid, space: manifest.space,
    type: manifest.type, rank: manifest.rank, index: manifest.index,
    staticId: trustedStaticId};
  check(selected && typeof selected === 'object' && !Array.isArray(selected) &&
    Number.isInteger(selected.space) && Number.isInteger(selected.type) &&
    Number.isInteger(selected.rank) && Number.isInteger(selected.index) &&
    Number.isSafeInteger(selected.staticId) && uidPattern.test(selected.uid),
  'The pulled save has incomplete archive identity.');
  if (Object.hasOwn(manifest, 'programId') && Object.hasOwn(manifest, 'titleId'))
    check(manifest.programId === manifest.titleId,
      'The pulled save has conflicting program IDs.');
  for (const key of ['uid', 'space', 'type', 'rank', 'index'])
    if (Object.hasOwn(manifest, key))
      check(manifest[key] === selected[key],
        'The pulled save has conflicting ' + key + ' fields.');
  for (const [key, number] of Object.entries(selection))
    check(selected[key] === number, 'The pulled save differs from the selected ' + key + '.');
  if (expectedUid) check(selected.uid === expectedUid ||
    selected.uid === '0'.repeat(32), 'The pulled save belongs to another account.');
  const archiveLabel = `space=${spaces[selected.space] ?? selected.space} ` +
    `type=${types[selected.type] ?? selected.type} rank=${selected.rank} ` +
    `index=${selected.index} uid=${selected.uid.slice(0, 16)}`;
  check(manifest.archive === archiveLabel, 'The archive identity differs from its manifest.');
  return {titleId: id, selection: selected};
}
async function verifyPull(directory, expected = {}) {
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const identity = validateArchive(manifest, expected);
  check(manifest.partial !== true && (!manifest.failed || manifest.failed.length === 0) &&
    Array.isArray(manifest.entries) && manifest.entries.length === manifest.files &&
    manifest.files >= 0 && manifest.files <= 65536 && typeof manifest.archive === 'string',
    'The pulled save has an incomplete manifest.');
  const canonical = await fsp.realpath(directory);
  let bytesTotal = 0;
  const seen = new Set();
  for (const entry of manifest.entries) {
    const relative = safeSavePath(entry.path);
    check(!seen.has(relative), 'The save manifest repeats a file: ' + relative);
    seen.add(relative);
    const file = path.join(directory, relative);
    const info = await fsp.lstat(file);
    const resolved = await fsp.realpath(file);
    check(info.isFile() && !info.isSymbolicLink() && resolved.startsWith(canonical + path.sep) &&
      info.size === entry.size && Number.isSafeInteger(entry.size) && entry.size >= 0,
      'The pulled save contains an invalid file: ' + relative);
    check(await shaFile(file) === entry.sha256,
      'The pulled save failed SHA-256 verification: ' + relative);
    bytesTotal += info.size;
  }
  check(bytesTotal === manifest.bytes, 'The pulled save byte count differs from its manifest.');
  const actual = [];
  async function walk(folder, prefix = '') {
    for (const item of await fsp.readdir(folder, {withFileTypes: true})) {
      const name = prefix ? prefix + '/' + item.name : item.name;
      if (item.isDirectory()) await walk(path.join(folder, item.name), name);
      else {
        check(item.isFile() && !item.isSymbolicLink(), 'The save export contains a link or special file.');
        if (name !== 'manifest.json') actual.push(name);
      }
    }
  }
  await walk(directory);
  check(actual.length === seen.size && actual.every(name => seen.has(name)),
    'The save export contains files missing from its manifest.');
  return {...manifest, ...identity};
}
async function privateFolder(prefix) {
  const parent = path.join(root, 'savekit-exports');
  await fsp.mkdir(parent, {recursive: true, mode: 0o700});
  const info = await fsp.lstat(parent);
  check(info.isDirectory() && !info.isSymbolicLink(), 'The save export folder is not private.');
  await fsp.chmod(parent, 0o700);
  return fsp.mkdtemp(path.join(parent, prefix));
}
async function pull(run, value, all = false) {
  const folder = await privateFolder(value.titleId + '-' + value.uid.slice(0, 8) + '-');
  try {
    const args = [run, value.titleId, folder, value.uid,
      ...selectedArchiveArgs(value.archiveSelection ?? value.archive ?? archive(undefined), all),
      ...(all ? ['--all'] : [])];
    const result = await runTool('save-pull-root.cjs', args, 600000);
    check(result.code === 0 && !result.signal, 'The save pull did not finish. Keep the partial export and restart the console.');
    if (!all) {
      const manifest = await verifyPull(folder, {titleId: value.titleId, uid: value.uid,
        selection: value.archive ?? archive(undefined),
        trustedStaticId: value.archive?.staticId ?? 0});
      return {folder, files: manifest.files, bytes: manifest.bytes, manifests: [manifest]};
    }
    const subdirs = (await fsp.readdir(folder, {withFileTypes: true})).filter(item => item.isDirectory());
    check(subdirs.length > 0 && subdirs.length <= 256, 'No matching save archive was exported.');
    const manifests = [];
    for (const item of subdirs) manifests.push(await verifyPull(path.join(folder, item.name),
      {titleId: value.titleId, uid: value.uid, selection: value.archiveSelection,
        trustedStaticId: value.archive?.staticId ?? 0}));
    return {folder, files: manifests.reduce((n, item) => n + item.files, 0),
      bytes: manifests.reduce((n, item) => n + item.bytes, 0), manifests};
  } catch (error) {
    error.backupPath = folder;
    throw error;
  }
}

async function stageFiles(sourceFolder, stage) {
  const sourceInfo = await fsp.lstat(sourceFolder);
  check(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(),
    'Choose a regular folder of save files.');
  const source = await fsp.realpath(sourceFolder);
  const files = [];
  let total = 0;
  async function walk(folder, prefix = '') {
    for (const entry of (await fsp.readdir(folder, {withFileTypes: true}))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name;
      if (name === '.DS_Store' || name === '.nx_save_meta.bin' || name.startsWith('._') ||
          (!prefix && name === 'manifest.json')) continue;
      check(safeRootName(name), 'The source contains an unsafe name: ' + name);
      const relative = prefix ? prefix + '/' + name : name;
      safeSavePath('/' + relative);
      check(Buffer.byteLength('/' + relative, 'utf8') < 0x301,
        'The source contains a path that is too long: ' + relative);
      const file = path.join(folder, name);
      const info = await fsp.lstat(file);
      check(!info.isSymbolicLink(), 'The source contains a symbolic link: ' + relative);
      if (info.isDirectory()) {
        await walk(file, relative);
        continue;
      }
      check(info.isFile() && info.size <= 64 * 1024 * 1024,
        'The source contains an unsupported file: ' + relative);
      total += info.size;
      check(total <= 256 * 1024 * 1024 && files.length < 2048,
        'The selected save folder is too large for a single write.');
      const target = path.join(stage, relative);
      await fsp.mkdir(path.dirname(target), {recursive: true});
      await fsp.copyFile(file, target, fs.constants.COPYFILE_EXCL);
      files.push({name: relative, path: target, sha256: await shaFile(target)});
    }
  }
  await walk(source);
  check(files.length > 0, 'The selected folder contains no save files.');
  return files;
}

async function stageRestoredFiles(sourceFolder, stage, manifest) {
  check(manifest.entries.length > 0 && manifest.entries.length <= 2048,
    'The selected backup has too many files for one restore.');
  let total = 0;
  const files = [];
  for (const entry of manifest.entries) {
    const relative = safeSavePath(entry.path);
    check(entry.size <= 64 * 1024 * 1024, 'The selected backup has a file larger than 64 MiB.');
    total += entry.size;
    check(total <= 256 * 1024 * 1024, 'The selected backup is too large for one restore.');
    const target = path.join(stage, relative);
    await fsp.mkdir(path.dirname(target), {recursive: true});
    await fsp.copyFile(path.join(sourceFolder, relative), target, fs.constants.COPYFILE_EXCL);
    check(await shaFile(target) === entry.sha256,
      'The selected backup changed while preparing the restore: ' + entry.path);
    files.push({path: entry.path, local: target, sha256: entry.sha256, size: entry.size});
  }
  return files;
}

function parseListing(output, all) {
  const entries = [], archives = [];
  let archive = null;
  for (const line of output.split('\n')) {
    const heading = /^archive (space=.*)$/.exec(line);
    if (heading) {archive = heading[1]; continue;}
    const file = /^(\s*\d+|\s*<dir>)\s+(\/.*)$/.exec(line);
    if (file) {
      entries.push({path: file[2], size: file[1].trim() === '<dir>'
        ? null : Number(file[1]), ...(all ? {archive} : {})});
      continue;
    }
    const total = /^listed (\d+) files, (\d+) bytes/.exec(line);
    if (total) archives.push({archive, files: Number(total[1]), bytes: Number(total[2])});
  }
  check(archives.length > 0 && (!all || archives.every(item => item.archive)),
    'The save inspection returned no complete archive listing.');
  return {entries, archives, files: archives.reduce((n, item) => n + item.files, 0),
    bytes: archives.reduce((n, item) => n + item.bytes, 0)};
}

function parseInventory(report) {
  check(report && report.rootPid === 1 && Array.isArray(report.entries) &&
    report.entries.length <= 32768 && report.spaces && typeof report.spaces === 'object',
  'The save archive inventory is incomplete.');
  const entries = report.entries.map(entry => {
    check(entry && typeof entry.id === 'string' && /^\d{1,20}$/.test(entry.id) &&
      typeof entry.applicationId === 'string' && /^0x[a-f0-9]{16}$/.test(entry.applicationId) &&
      uidPattern.test(entry.uid) && Number.isInteger(entry.space) && entry.space >= 0 && entry.space <= 255 &&
      Number.isInteger(entry.type) && entry.type >= 0 && entry.type <= 255 &&
      Number.isInteger(entry.rank) && entry.rank >= 0 && entry.rank <= 1 &&
      Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index <= 65535 &&
      typeof entry.size === 'string' && /^\d{1,20}$/.test(entry.size),
    'The save archive inventory contains an invalid record.');
    return {id: entry.id, titleId: entry.applicationId.slice(2), uid: entry.uid,
      space: entry.space, type: entry.type, rank: entry.rank, index: entry.index,
      size: entry.size};
  });
  const failedSpaces = Object.values(report.spaces).filter(space => space?.error).length;
  return {entries, failedSpaces};
}

async function execute(runDirectory, raw, emitEvent = emit) {
  const value = request(raw);
  const run = await validRun(runDirectory);
  if (value.action === 'accounts') {
    emitEvent('progress', {stage: 'accounts', message: 'Listing console accounts'});
    const result = await runTool('save-pull-root.cjs',
      [run, '0000000000000000', '.', '--list-uids']);
    check(result.code === 0 && !result.signal, 'Could not list console accounts.');
    const users = [...new Set(result.stdout.split('\n').map(line => line.trim().toLowerCase())
      .filter(line => uidPattern.test(line)))];
    check(users.length > 0 && users.length <= 8, 'No console accounts were returned.');
    emitEvent('accounts', {users, message: users.length + ' console account(s) found'});
    emitEvent('complete', {action: value.action, message: 'Account list ready'});
    return;
  }
  if (value.action === 'restore') {
    let source;
    try {
      source = await verifyPull(value.sourceFolder, {titleId: value.titleId,
        uid: value.uid, selection: value.archive});
      check(source.selection.uid === value.uid,
        'The selected backup belongs to another account. No save was written.');
    } catch (error) {
      if (!error.unsafe) error.safeToContinue = true;
      throw error;
    }
    const stage = await fsp.mkdtemp(path.join(root, 'savekit-stage-'));
    let backupPath, localPreflight = true;
    try {
      emitEvent('progress', {stage: 'staging', message: 'Checking the verified restore source'});
      const files = await stageRestoredFiles(value.sourceFolder, stage, source);
      emitEvent('progress', {stage: 'backup', message: 'Backing up the current live save'});
      localPreflight = false;
      const saved = await pull(run, value);
      backupPath = saved.folder;
      localPreflight = true;
      check(saved.manifests[0].selection.uid === value.uid,
        'The selected account save was not mounted. No save was written.');
      emitEvent('backup', {titleId: value.titleId, uid: value.uid, backupPath,
        files: saved.files, bytes: saved.bytes,
        message: 'Current save backed up and verified'});
      const present = new Set(saved.manifests[0].entries.map(entry => entry.path));
      const manifestPath = path.join(stage, 'restore.json');
      await fsp.writeFile(manifestPath, JSON.stringify({files: files.map(file => ({
        path: file.path, local: file.local, replace: present.has(file.path)
      }))}, null, 2) + '\n', {mode: 0o600});
      emitEvent('progress', {stage: 'restoring', message: 'Restoring save files and checking committed bytes'});
      localPreflight = false;
      const result = await runTool('save-write-stage.cjs',
        [run, value.titleId, value.uid, backupPath, manifestPath,
          '--space', String(value.archive.space), '--type', String(value.archive.type),
          '--restore', '--confirm-restore'], 1800000);
      check(result.code === 0 && !result.signal &&
        result.stdout.includes('verified ' + files.length + ' written files after commit'),
      'The restore was not fully verified. Keep the current-save backup and restart the console.');
      emitEvent('progress', {stage: 'verify', message: 'Pulling the result to verify restored file hashes'});
      const readBack = await pull(run, value);
      const readHashes = new Map(readBack.manifests[0].entries.map(entry => [entry.path, entry.sha256]));
      check(files.every(file => readHashes.get(file.path) === file.sha256),
        'The read-back save differs from the restore source. Keep the current-save backup.');
      emitEvent('complete', {action: value.action, titleId: value.titleId, uid: value.uid,
        backupPath, files: files.length,
        message: 'Restore verified by a fresh pull; the previous save backup was kept'});
    } catch (error) {
      if (backupPath) error.backupPath = backupPath;
      if (localPreflight && !error.unsafe) error.safeToContinue = true;
      throw error;
    } finally { await fsp.rm(stage, {recursive: true, force: true}); }
    return;
  }
  if (value.action === 'inventory') {
    const folder = await privateFolder('inventory-');
    const reportPath = path.join(folder, 'inventory.json');
    emitEvent('progress', {stage: 'inventory', message: 'Reading the console save archive index'});
    const result = await runTool('save-inventory.cjs', [run, '--json', reportPath], 600000);
    check(result.code === 0 && !result.signal, 'Could not read the save archive inventory.');
    const {entries, failedSpaces} = parseInventory(JSON.parse(await fsp.readFile(reportPath, 'utf8')));
    emitEvent('inventory', {inventory: entries.slice(0, 256), inventoryTotal: entries.length,
      truncated: entries.length > 256, failedSpaces, reportPath,
      message: entries.length + ' save archive(s) found' +
        (failedSpaces ? '; ' + failedSpaces + ' storage space(s) could not be read' : '')});
    emitEvent('complete', {action: value.action, message: 'Save archive inventory ready'});
    return;
  }
  if (value.action === 'titles') {
    emitEvent('progress', {stage: 'titles', message: 'Listing installed applications'});
    const result = await runTool('list-apps.cjs', [run]);
    check(result.code === 0 && !result.signal, 'Could not list installed applications.');
    const titles = [...new Set(result.stdout.split('\n').map(line => line.trim().replace(/^0x/i, '').toLowerCase())
      .filter(line => titlePattern.test(line)))];
    check(titles.length > 0 && titles.length <= 2048, 'No installed application IDs were returned.');
    emitEvent('progress', {stage: 'title-names', message: 'Reading installed game names'});
    let names;
    try {
      const named = await runTool('savekit-title-names.cjs', [run]);
      check(named.code === 0 && !named.signal,
        'Title-name lookup stopped without confirmed native cleanup.');
      names = parseTitleNames(named.stdout, titles);
    } catch (error) {
      error.unsafe = true;
      throw error;
    }
    emitEvent('titles', {titles, names,
      message: titles.length + ' installed application(s) found'});
    emitEvent('complete', {action: value.action, message: 'Installed title list ready'});
    return;
  }
  if (value.action === 'inspect' || value.action === 'filetime') {
    emitEvent('progress', {stage: value.action, message: value.action === 'inspect'
      ? 'Listing save files without copying them' : 'Reading save timestamp metadata'});
    const args = [run, value.titleId, '.', value.uid,
      ...selectedArchiveArgs(value.archiveSelection, value.all),
      ...(value.action === 'inspect' ? ['--list-only', ...(value.all ? ['--all'] : [])] : ['--filetime'])];
    const result = await runTool('save-pull-root.cjs', args, 600000);
    check(result.code === 0 && !result.signal, 'The read-only save inspection failed.');
    if (value.action === 'inspect') {
      if (!value.all) check(result.stderr.includes('uid=' + value.uid.slice(0, 16)),
        'The save listing belongs to a different account than selected.');
      const listing = parseListing(result.stdout, value.all);
      emitEvent('listing', {titleId: value.titleId, uid: value.uid,
        entries: listing.entries.slice(0, 256), truncated: listing.entries.length > 256,
        archives: listing.archives.slice(0, 256),
        files: listing.files, bytes: listing.bytes,
        message: 'Read-only save listing complete'});
    }
    emitEvent('complete', {action: value.action, titleId: value.titleId, uid: value.uid,
      message: value.action === 'inspect' ? 'Save file list ready' : 'Save timestamp probe complete'});
    return;
  }
  if (value.action === 'backup') {
    emitEvent('progress', {stage: 'backup', message: 'Exporting and verifying the selected save'});
    const saved = await pull(run, value, value.all);
    emitEvent('backup', {titleId: value.titleId, uid: value.uid,
      backupPath: saved.folder, files: saved.files, bytes: saved.bytes,
      message: 'Save export verified by SHA-256'});
    emitEvent('complete', {action: value.action, titleId: value.titleId, uid: value.uid,
      backupPath: saved.folder, files: saved.files, bytes: saved.bytes,
      message: 'Save backup complete'});
    return;
  }
  if (value.action === 'write') {
    const stage = await fsp.mkdtemp(path.join(root, 'savekit-stage-'));
    let backupPath, localPreflight = true;
    try {
      emitEvent('progress', {stage: 'staging', message: 'Checking the selected local save files'});
      const files = await stageFiles(value.sourceFolder, stage);
      emitEvent('progress', {stage: 'backup', message: 'Backing up the live save before writing'});
      localPreflight = false;
      const saved = await pull(run, value);
      backupPath = saved.folder;
      localPreflight = true;
      check(saved.manifests[0].selection.uid === value.uid,
        'The selected account save was not mounted. No save was written.');
      emitEvent('backup', {titleId: value.titleId, uid: value.uid,
        backupPath, files: saved.files, bytes: saved.bytes,
        message: 'Original save backed up and verified'});
      const present = new Set(saved.manifests[0].entries.map(item => item.path));
      const replacements = files.filter(file => present.has('/' + file.name));
      check(value.allowReplace || replacements.length === 0,
        'The selected folder would replace existing save files. Enable replacement explicitly.');
      const manifest = {title: value.titleId, backup: backupPath,
        files: files.map(file => ({path: '/' + file.name, local: file.path,
          ...(present.has('/' + file.name) ? {replace: true} : {})}))};
      const manifestPath = path.join(stage, 'manifest.json');
      await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
      emitEvent('progress', {stage: 'writing', message: 'Writing and verifying the save; keep RPC open'});
      localPreflight = false;
      const result = await runTool('save-write-stage.cjs',
        [run, value.titleId, value.uid, backupPath, manifestPath], 1800000);
      check(result.code === 0 && !result.signal &&
        result.stdout.includes('verified ' + files.length + ' written files after commit'),
        'Save writing was not fully verified. Keep the backup and restart the console.');
      emitEvent('complete', {action: value.action, titleId: value.titleId, uid: value.uid,
        backupPath, files: files.length, replaced: replacements.length,
        message: 'Save write committed and verified; keep the original backup'});
    } catch (error) {
      if (backupPath) error.backupPath = backupPath;
      if (localPreflight && !error.unsafe) error.safeToContinue = true;
      throw error;
    } finally { await fsp.rm(stage, {recursive: true, force: true}); }
    return;
  }
  if (value.action === 'delete') {
    emitEvent('progress', {stage: 'backup', message: 'Backing up the live save before deleting a file'});
    const saved = await pull(run, value);
    const backupPath = saved.folder;
    let localPreflight = true;
    try {
      check(saved.manifests[0].selection.uid === value.uid,
        'The selected account save was not mounted. No file was deleted.');
      emitEvent('backup', {titleId: value.titleId, uid: value.uid,
        backupPath, files: saved.files, bytes: saved.bytes,
        message: 'Original save backed up and verified'});
      check(saved.manifests[0].entries.some(entry => entry.path === '/' + value.fileName),
        'The selected file is not in the live save. No file was deleted.');
      emitEvent('progress', {stage: 'deleting', message: 'Deleting one save file and verifying the commit'});
      localPreflight = false;
      const result = await runTool('save-delete-root.cjs',
        [run, value.titleId, value.uid, '/' + value.fileName, backupPath], 600000);
      check(result.code === 0 && !result.signal &&
        result.stdout.includes('verified deleted /' + value.fileName + ' after commit'),
        'Save deletion was not fully verified. Keep the backup and restart the console.');
      emitEvent('complete', {action: value.action, titleId: value.titleId, uid: value.uid,
        backupPath, files: 1, message: 'One save file deleted and verified; keep the original backup'});
    } catch (error) {
      error.backupPath = backupPath;
      if (localPreflight && !error.unsafe) error.safeToContinue = true;
      throw error;
    }
    return;
  }
  if (value.action === 'verify') {
    const expected = await verifyPull(value.expectedFolder, {titleId: value.titleId,
      uid: value.uid, selection: value.archive});
    emitEvent('progress', {stage: 'verify', message: 'Pulling the live save to compare it with the backup'});
    const live = await pull(run, value);
    const expectedHashes = new Map(expected.entries.map(entry => [entry.path, entry.sha256]));
    const liveHashes = new Map(live.manifests[0].entries.map(entry => [entry.path, entry.sha256]));
    check(expectedHashes.size === liveHashes.size && [...expectedHashes].every(([name, hash]) =>
      liveHashes.get(name) === hash),
    'The live save differs from the selected backup. The comparison export was kept at ' + live.folder);
    emitEvent('complete', {action: value.action, titleId: value.titleId, uid: value.uid,
      backupPath: live.folder, files: expectedHashes.size,
      message: 'The live save matches the selected backup by SHA-256'});
  }
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    check(size <= 8192, 'The savekit request is too large.');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8').trim();
  check(input && !input.includes('\n'), 'Send exactly one savekit request.');
  return JSON.parse(input);
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') {
    check(request({action: 'write', titleId: '010012900d38a000', uid: '1'.repeat(32),
      sourceFolder: '/tmp/test'}).titleId === '010012900d38a000', 'Savekit validation failed.');
    console.log('Savekit developer request validation passed without RPC.');
    return;
  }
  check(args.length === 1, 'Usage: gui-savekit-tools.cjs <patched-run-directory>');
  await execute(args[0], await readRequest());
}

module.exports = {request, archive, archiveArgs, selectedArchiveArgs, validRun,
  validateArchive, verifyPull, stageFiles, stageRestoredFiles, parseListing, parseInventory,
  parseTitleNames, execute};
if (require.main === module)
  main().catch(error => {emit('failed', {message: String(error.message).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 512),
    ...(error.unsafe ? {unsafe: true} : {}),
    ...(error.safeToContinue ? {safeToContinue: true} : {}),
    ...(error.backupPath ? {backupPath: error.backupPath} : {})}); process.exitCode = 1;});
