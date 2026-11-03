#!/usr/bin/env node
'use strict';
// Install alula's upstream Artemis Launcher into a supported Artemis save.
//
//   node tools/artemis-launcher.cjs stage   --title <id> --backup <dir> [--out <dir>] [--source <dir>]
//   node tools/artemis-launcher.cjs plan    --title <id> --backup <dir> [--source <dir>]
//   node tools/artemis-launcher.cjs install <run> --title <id> [--uid <hex>] [--backup <dir>] --confirm
//   node tools/artemis-launcher.cjs verify  <run> --title <id> [--uid <hex>] [--backup <dir>]
//   node tools/artemis-launcher.cjs restore <run> --title <id> [--uid <hex>] --backup <dir> \
//        --confirm-restore [--dry-run] [--adopt-legacy]
//
// This is a *separate* installer from `inject-launcher.sh`, which installs this
// repository's own ns2jb launcher. Both write the same boot trigger
// (`save9999.dat`), so only one can own it at a time; nothing here changes the
// existing option.
//
// What it does, in order:
//   1. obtains alula's pinned source revision (cache, or download-on-demand) and
//      verifies every file it uses against a recorded sha256;
//   2. builds the save9999.dat boot trigger by retargeting the *game's own*
//      suspend save at the upstream `inject.iet` - the game's container version
//      is kept, so an old upstream save file is never written over a newer one;
//   3. stages the upstream files plus that trigger in a marked build directory
//      under <repo>/staging (or the OS temp dir), then promotes it atomically.
//      A failed build never deletes the previous staged payload;
//   4. validates the backup's manifest, every file hash, the trigger and the
//      full program/account identity before anything is written;
//   5. writes a local installation receipt (full account uid, backup manifest
//      hash, upstream commit, installed hashes) before the console write;
//   6. writes through `save-write-stage.cjs` (one transaction, hash verified),
//      pulls the save again, and checks it against the manifest;
//   7. `restore` is receipt-driven: it refuses to delete a file whose live
//      bytes differ from what this installer recorded. Installs made before
//      receipts existed take a conservative `--adopt-legacy` path that requires
//      live bytes to match the pinned upstream release exactly.
//
// Exit codes (the toolkit's contract):
//   0  done and verified
//   2  bad usage / missing authorization flag
//   3  SESSION LOST - the console stopped answering
//   4  NO LIVE HOST - the run folder has no live memory socket
//   5  unsupported title (not one of the two demos upstream supports)
//   6  missing prerequisite - no backup, invalid backup, no upstream source
//   7  conflict - a file would be overwritten, deleted or was modified
//   8  verification failed
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const {validateBackup, describeBackup} = require('./lib/artemis-backup.cjs');
const staging = require('./lib/artemis-staging.cjs');
const receipts = require('./lib/artemis-receipt.cjs');
const {EXIT: DELETE_EXIT, isGone} = require('./lib/delete-result.cjs');

const TOOLS = __dirname;
const REPO = path.resolve(TOOLS, '..');
const UPSTREAM_REPO = 'https://github.com/alula/switch-artemis-launcher';
const UPSTREAM_COMMIT = 'b9e6de82934dfda1f2c6219aaf305ed980a3d1ba';
const UPSTREAM_TAG = 'v1';
const UPSTREAM_TARBALL = '1eed750f8eedffd73d9556ffd4d7b90b11e02f2ded6896c83fb224ad6b3ac1f1';

// Every upstream byte this installer copies. `common/save9999.dat`, `saveg.dat`
// and `system.dat` are deliberately absent: the first is rebuilt from the game's
// own save, and the other two are the upstream author's own game state, which is
// not ours to overwrite. Verify a revision by these hashes, not by a tarball:
// GitHub regenerates tarballs, but these files are the actual payload.
const UPSTREAM_FILES = {
  'common/inject.iet': 'bf79a739584de93d1569523a8a87e7ef8ce65edcf073b5d2ba37453c4085ada4',
  'common/inject.lua': 'fcc6b5877084df15b45dfbd8c955ee4f802add7030f1c98f3006794f8949a08b',
  'common/http.lua': '2985b8f7040fc40c7e2c18e5cf857c3c5d14c0b9d081ef0a1a8742eab6f026a1',
  'common/exploita.lua': 'a84bb1230b2edd73f469afd5aba69b3ca191e6c25b444cf93d23342b64d6af18',
  'common/proggy.ttf': '527d2a443ce051f93f7e77b855609722b8cb220a9f104b4aa037be5c90b71324',
  'seedsow_save/core.lua': '54d25862dc0d796985ebe69f34a345df16671c97372d67062769d28c293d4ed6',
  'nora2_save/core.lua': 'bf83da2fbf9753f5a7a98df852938eae0ee7d26dda240991aad08e5ebd810505',
};

// The demo titles upstream supports. The full games are not supported upstream,
// so they are refused here instead of being written with a payload for a demo.
const TITLES = {
  '010042d022aea000': {
    name: 'Seedsow Lullaby (demo)',
    slug: 'Seedsow-Lullaby-demo',
    overlay: 'seedsow_save',
  },
  '010012900d38a000': {
    name: 'Nora to Oujo to Noraneko Heart 2 (demo)',
    slug: 'Nora-2-demo',
    overlay: 'nora2_save',
  },
};

const LAUNCHER_FILES = ['core.lua', 'exploita.lua', 'http.lua', 'inject.iet',
  'inject.lua', 'proggy.ttf'];
const TRIGGER = 'save9999.dat';
// Update files upstream's inject.iet would load instead of the originals. Not
// ours, never deleted, but worth reporting during a restore.
const UPDATE_FILES = ['core2.lua', 'http2.lua', 'inject2.lua'];

const EXIT = {ok: 0, usage: 2, sessionLost: 3, noHost: 4, unsupported: 5,
  prereq: 6, conflict: 7, verify: 8};

class Failure extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || [];
  }
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = async file => sha256(await fsp.readFile(file));
const exists = file => fs.existsSync(file);

function note(lines) {
  for (const line of lines) console.error(line);
}

// ---------------------------------------------------------------- arguments --
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {command, _: []};
  const takesValue = new Set(['title', 'uid', 'backup', 'out', 'source', 'staging', 'snapshot']);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const name = token.slice(2);
    if (['confirm', 'confirm-restore', 'confirm-migration', 'dry-run', 'json',
      'adopt-legacy'].includes(name)) {
      options[name] = true;
      continue;
    }
    if (!takesValue.has(name)) throw new Failure(EXIT.usage, 'unknown option --' + name);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new Failure(EXIT.usage, '--' + name + ' needs a value');
    }
    options[name] = value;
  }
  return options;
}

function titleFor(id) {
  const key = String(id || '').toLowerCase().replace(/^0x/, '');
  const found = TITLES[key];
  if (!found) {
    throw new Failure(EXIT.unsupported, 'unsupported title ' + (id || '(none)') +
      ' - upstream supports only ' + Object.keys(TITLES).join(', '));
  }
  return {id: key, ...found};
}

function normalizeUid(value) {
  const hex = String(value || '').replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

function uidFor(options, title) {
  if (options.uid) {
    const hex = normalizeUid(options.uid);
    if (!hex) throw new Failure(EXIT.usage, '--uid must be 32 hex chars');
    return hex;
  }
  // Local, gitignored config. Never a compiled-in account id.
  try {
    const config = JSON.parse(fs.readFileSync(path.join(REPO, 'config/uids.json'), 'utf8'));
    const found = normalizeUid(config[title.id]);
    if (found) return found;
  } catch { /* no local config */ }
  throw new Failure(EXIT.usage, '--uid is required (or add ' + title.id +
    ' to config/uids.json locally)');
}

// restore may omit --uid when exactly one receipt exists for the title.
async function uidForRestore(options, title) {
  if (options.uid) return uidFor(options, title);
  const found = await receiptsForTitle(title.id);
  if (found.length === 1) {
    console.log('using the account from the installation receipt: ' +
      found[0].account.uid.slice(0, 8) + '…');
    return found[0].account.uid;
  }
  return uidFor(options, title);
}

async function receiptsForTitle(titleId) {
  let names;
  try {
    names = await fsp.readdir(receipts.receiptDir());
  } catch { return []; }
  const found = [];
  const seen = new Set();
  for (const name of names) {
    if (!name.startsWith(titleId + '-') || !name.endsWith('.json')) continue;
    try {
      const receipt = JSON.parse(await fsp.readFile(path.join(receipts.receiptDir(), name), 'utf8'));
      if (!receipt.title || receipt.title.id !== titleId) continue;
      const uid = receipt.account && receipt.account.uid;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      found.push(receipt);
    } catch { /* unreadable receipts are not a match */ }
  }
  return found;
}

// ----------------------------------------------------------------- upstream --
// Where pulled backups and verification pulls live. ARTEMIS_SAVES keeps tests
// and sandboxes out of the checkout; the default matches the other tools.
function savesRoot() {
  return process.env.ARTEMIS_SAVES || path.join(REPO, 'saves');
}

function cacheRoot() {
  // ARTEMIS_CACHE keeps the download cache somewhere writable on locked-down
  // setups; the default is the same XDG-ish path the editor fetch uses.
  return process.env.ARTEMIS_CACHE ||
    path.join(os.homedir(), '.cache', 'ns2-savekit', 'artemis-launcher');
}

function pinnedFor(title) {
  const wanted = {[title.overlay + '/core.lua']: UPSTREAM_FILES[title.overlay + '/core.lua']};
  for (const name of ['common/inject.iet', 'common/inject.lua', 'common/http.lua',
    'common/exploita.lua', 'common/proggy.ttf']) {
    wanted[name] = UPSTREAM_FILES[name];
  }
  return wanted;
}

// The reproducible bytes of the launcher set, keyed by save path. This is what
// the legacy restore compares live files against, and what a receipt records.
function expectedHashes(title) {
  const out = {};
  for (const name of LAUNCHER_FILES) {
    out['/' + name] = name === 'core.lua'
      ? UPSTREAM_FILES[title.overlay + '/core.lua']
      : UPSTREAM_FILES['common/' + name];
  }
  return out;
}

async function verifyUpstream(directory, pinned = UPSTREAM_FILES) {
  const problems = [];
  for (const [name, want] of Object.entries(pinned)) {
    const file = path.join(directory, name);
    let bytes;
    try {
      bytes = await fsp.readFile(file);
    } catch {
      problems.push('missing ' + name);
      continue;
    }
    if (!want) { problems.push('no pinned hash for ' + name); continue; }
    const got = sha256(bytes);
    if (got !== want) problems.push(name + ' sha256 ' + got.slice(0, 16) + '… != ' + want.slice(0, 16) + '…');
  }
  return problems;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options});
}

async function obtainUpstream(title, options) {
  // 1. an explicit checkout the caller already trusts enough to let us verify
  if (options.source) {
    const dir = path.resolve(options.source);
    const problems = await verifyUpstream(dir, pinnedFor(title));
    if (problems.length) {
      throw new Failure(EXIT.prereq, '--source does not match the pinned revision:',
        problems.map(p => '  ' + p));
    }
    return dir;
  }
  // 2. the verified cache
  const cached = path.join(cacheRoot(), UPSTREAM_COMMIT);
  if (exists(cached)) {
    const problems = await verifyUpstream(cached, pinnedFor(title));
    if (!problems.length) return cached;
  }
  // 3. download-on-demand, then verify every file we will use
  try {
    await fsp.mkdir(path.dirname(cached), {recursive: true});
  } catch (error) {
    throw new Failure(EXIT.prereq, 'cannot create the download cache: ' + path.dirname(cached), [
      '  ' + error.message,
      '  set ARTEMIS_CACHE to a writable directory, or pass --source with a verified checkout',
    ]);
  }
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-launcher-'));
  const tarball = path.join(work, 'upstream.tar.gz');
  const url = 'https://codeload.github.com/alula/switch-artemis-launcher/tar.gz/' + UPSTREAM_COMMIT;
  const fetched = run('curl', ['-fsSL', '--max-time', '120', '-o', tarball, url]);
  if (fetched.status !== 0) {
    throw new Failure(EXIT.prereq, 'could not download the pinned upstream revision ' +
      UPSTREAM_COMMIT + ' and no verified cache exists', [
      '  url: ' + url,
      '  ' + String(fetched.stderr || fetched.error || '').trim().slice(0, 200),
      '  offline? point --source at a verified checkout of ' + UPSTREAM_REPO,
    ]);
  }
  const tarballSha = await fileSha(tarball);
  if (tarballSha !== UPSTREAM_TARBALL) {
    note(['note: tarball sha256 ' + tarballSha.slice(0, 16) + '… differs from the recorded ' +
      UPSTREAM_TARBALL.slice(0, 16) + '… (GitHub may regenerate archives);',
    '      the per-file hashes below still decide whether this revision is accepted.']);
  }
  const extracted = path.join(work, 'src');
  await fsp.mkdir(extracted);
  const untar = run('tar', ['-xzf', tarball, '-C', extracted, '--strip-components=1']);
  if (untar.status !== 0) {
    throw new Failure(EXIT.prereq, 'could not unpack the upstream tarball',
      [String(untar.stderr || '').trim().slice(0, 300)]);
  }
  const problems = await verifyUpstream(extracted, pinnedFor(title));
  if (problems.length) {
    throw new Failure(EXIT.prereq, 'downloaded revision ' + UPSTREAM_COMMIT +
      ' does not match the pinned hashes', problems.map(p => '  ' + p));
  }
  await fsp.rm(cached, {recursive: true, force: true});
  try {
    await fsp.rename(extracted, cached);
  } catch {
    // A cross-device rename fails; copy instead, then verify again.
    await fsp.cp(extracted, cached, {recursive: true});
  }
  const proof = await verifyUpstream(cached, pinnedFor(title));
  if (proof.length) throw new Failure(EXIT.prereq, 'cached copy failed verification', proof);
  return cached;
}

// ------------------------------------------------------------------- backup --
async function loadBackup(directory, title, options = {}) {
  const checked = await validateBackup(directory, {
    trigger: TRIGGER,
    requireIdentity: options.requireIdentity === true,
    titleId: title.id,
    uid: options.uid,
  });
  if (!checked.ok) {
    throw new Failure(EXIT.prereq, 'backup failed validation: ' + (checked.dir || directory),
      checked.problems.map(p => '  ' + p));
  }
  return checked;
}

async function pullSnapshot(session, title, uid, directory, label) {
  await fsp.mkdir(path.dirname(directory), {recursive: true});
  const child = runStep('save-pull-root.cjs',
    [session, title.id, directory, uid, '--space', '1', '--type', '1']);
  if (child.status !== 0) {
    throw new Failure(EXIT.prereq, 'the ' + label + ' pull did not complete',
      [String(child.stderr || child.stdout || '').trim().slice(0, 400)]);
  }
  const backup = await validateBackup(directory, {
    trigger: TRIGGER, requireIdentity: true, titleId: title.id, uid,
  });
  if (!backup.ok) {
    throw new Failure(EXIT.prereq, 'the ' + label + ' pull failed validation: ' + directory,
      backup.problems.map(p => '  ' + p));
  }
  return backup;
}

// ------------------------------------------------------------------ staging --
async function retargetSave(input, output) {
  const script = path.join(TOOLS, 'artemis-save.py');
  const built = run('python3', [script, 'launch', input, 'inject.iet', output]);
  if (built.status !== 0) {
    throw new Failure(EXIT.prereq, 'could not build the boot trigger from the backup',
      [String(built.stderr || built.stdout || '').trim().slice(0, 400)]);
  }
  const shown = run('python3', [script, 'show', output]);
  const text = String(shown.stdout || '');
  const scriptLine = /script='([^']+)'/.exec(text);
  const versionLine = /BOWS v(\d+)/.exec(text);
  if (!scriptLine || scriptLine[1] !== 'save:/inject.iet') {
    throw new Failure(EXIT.verify, 'retargeted save9999.dat does not point at save:/inject.iet',
      [text.slice(0, 300)]);
  }
  if (!versionLine || !['1002', '1003'].includes(versionLine[1])) {
    throw new Failure(EXIT.unsupported, 'unsupported save container version: ' +
      (versionLine ? versionLine[1] : 'unknown'));
  }
  return {version: versionLine[1]};
}

function stageDirFor(title, options) {
  return path.resolve(options.out || options.staging ||
    path.join(REPO, 'staging', 'alula-artemis', title.id));
}

async function fillBuild({title, upstream, backup, build, retarget = retargetSave}) {
  for (const name of LAUNCHER_FILES) {
    const from = name === 'core.lua'
      ? path.join(upstream, title.overlay, 'core.lua')
      : path.join(upstream, 'common', name);
    await fsp.copyFile(from, path.join(build, name));
  }
  return retarget(path.join(backup.dir, TRIGGER), path.join(build, TRIGGER));
}

// Older installer versions staged without a marker. They may be adopted only
// when the directory contains exactly the expected file set, every launcher file
// matches the pinned release, and the trigger parses as our retarget. Adoption
// writes the marker; it never deletes or overwrites anything.
async function verifyLegacyStaging(directory, title, options = {}) {
  const expected = options.expected || expectedHashes(title);
  const checkTrigger = options.checkTrigger || (async file => {
    const shown = run('python3', [path.join(TOOLS, 'artemis-save.py'), 'show', file]);
    if (shown.status !== 0) return {ok: false, why: 'save9999.dat is not a readable BOWS container'};
    const text = String(shown.stdout || '');
    const script = /script='([^']+)'/.exec(text);
    const version = /BOWS v(\d+)/.exec(text);
    if (!script || script[1] !== 'save:/inject.iet') {
      return {ok: false, why: 'save9999.dat does not point at save:/inject.iet'};
    }
    if (!version || !['1002', '1003'].includes(version[1])) {
      return {ok: false, why: 'save9999.dat has an unsupported container version'};
    }
    return {ok: true};
  });
  const problems = [];
  const allowed = new Set([...LAUNCHER_FILES, TRIGGER, 'manifest.json']);
  for (const entry of await fsp.readdir(directory, {withFileTypes: true})) {
    if (!entry.isFile()) { problems.push(entry.name + ' is not a regular file'); continue; }
    if (!allowed.has(entry.name)) problems.push('unexpected file ' + entry.name);
  }
  for (const [p, want] of Object.entries(expected)) {
    try {
      const bytes = await fsp.readFile(path.join(directory, p.slice(1)));
      if (sha256(bytes) !== want) problems.push(p + ' does not match the pinned release');
    } catch {
      problems.push('missing ' + p);
    }
  }
  const trigger = path.join(directory, TRIGGER);
  if (exists(trigger)) {
    const verdict = await checkTrigger(trigger);
    if (!verdict.ok) problems.push(verdict.why);
  } else {
    problems.push('missing /' + TRIGGER);
  }
  return {ok: problems.length === 0, problems};
}

// Build in a marked sibling, then promote. On any failure only the build
// directory is removed; a previously staged payload stays exactly as it was.
async function stageTo({title, upstream, backup, outDir, retarget = retargetSave, repo = REPO,
  legacyStage = null}) {
  const target = await staging.assertSafeTarget(outDir, {titleId: title.id, repo,
    adopt: legacyStage || (dir => verifyLegacyStaging(dir, title))});
  const build = await staging.beginBuild(target, title.id);
  try {
    const built = await fillBuild({title, upstream, backup, build, retarget});
    return {target, build, built};
  } catch (error) {
    await staging.discardBuild(build);
    throw error;
  }
}

// Manifest `local` paths are relative to the manifest's directory. save-write-
// stage is run with cwd = the staging directory, so the manifest stays portable
// and does not capture a machine-specific absolute path.
async function buildManifest({title, outDir, backup, expected = expectedHashes(title)}) {
  const names = (await fsp.readdir(outDir))
    .filter(name => name !== 'manifest.json' && !name.startsWith('.'))
    .sort();
  const files = [];
  const conflicts = [];
  for (const name of names) {
    const local = path.join(outDir, name);
    const bytes = await fsp.readFile(local);
    const replace = backup.names.has('/' + name);
    if (replace && name !== TRIGGER) {
      // Re-installing over a previous install is allowed only when the live
      // bytes are exactly the pinned release: then the file is ours, not a
      // user's edited script. Anything else is a conflict.
      const before = backup.entries.find(entry => entry.path === '/' + name);
      if (!before || before.sha256 !== expected['/' + name]) {
        conflicts.push({name: '/' + name,
          reason: 'already exists in this save with bytes that are not the pinned release'});
        continue;
      }
    }
    files.push({path: '/' + name, local: name, size: bytes.length,
      sha256: sha256(bytes), replace});
  }
  if (!files.some(file => file.path === '/' + TRIGGER)) {
    throw new Failure(EXIT.prereq, 'staging has no ' + TRIGGER);
  }
  const manifest = {
    purpose: 'install alula Artemis Launcher into ' + title.name + ' (' + title.id + ')',
    title: title.name,
    programId: title.id,
    upstream: {
      repo: UPSTREAM_REPO,
      commit: UPSTREAM_COMMIT,
      tag: UPSTREAM_TAG,
      overlay: title.overlay,
    },
    backup: path.resolve(backup.dir),
    backupManifestSha256: backup.manifestSha256,
    generatedBy: 'tools/artemis-launcher.cjs',
    files,
  };
  return {manifest, conflicts, files};
}

async function writeManifest(directory, manifest) {
  await fsp.writeFile(path.join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n');
}

async function stageAndPlan({title, backup, options}) {
  const upstream = await obtainUpstream(title, options);
  const outDir = stageDirFor(title, options);
  const {target, build} = await stageTo({title, upstream, backup, outDir});
  // Build failure already discarded the build dir. From here on a failure must
  // discard the build only, never the promoted target.
  try {
    const plan = await buildManifest({title, outDir: build, backup});
    await writeManifest(build, plan.manifest);
    await staging.promoteBuild(build, target, title.id);
    return {target, plan};
  } catch (error) {
    await staging.discardBuild(build);
    throw error;
  }
}

// ------------------------------------------------------------- console work --
function childExit(result) {
  const text = String(result.stderr || '') + String(result.stdout || '');
  if (/ENOENT.*memory\.sock/i.test(text)) return EXIT.noHost;
  if (/transport (?:failed )?0xf601/i.test(text)) return EXIT.sessionLost;
  return null;
}

function runStep(script, args, options = {}) {
  const child = run(process.execPath, [path.join(TOOLS, script), ...args], options);
  const lost = childExit(child);
  if (lost === EXIT.noHost) throw new Failure(EXIT.noHost, 'NO LIVE HOST: ' + script);
  if (lost === EXIT.sessionLost) throw new Failure(EXIT.sessionLost, 'SESSION LOST: ' + script);
  return child;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

async function newestBackup(title, uid) {
  const base = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8));
  if (!exists(base)) return null;
  const entries = (await fsp.readdir(base, {withFileTypes: true}))
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(base, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of entries) {
    const checked = await validateBackup(dir, {
      trigger: TRIGGER, requireIdentity: true, titleId: title.id, uid,
    });
    if (checked.ok) return dir;
  }
  return null;
}

// ------------------------------------------------------------------ records --
// One immutable ORIGINAL record is the rollback baseline; every install after
// the first is a TRANSACTION and never replaces it.
function installedEntries({plan, backup}) {
  const before = new Map(backup.entries.map(entry => [entry.path, entry]));
  return plan.files.map(file => {
    const entry = {path: file.path, sha256: file.sha256, size: file.size,
      kind: file.replace ? 'replace' : 'add'};
    if (file.replace) {
      const prior = before.get(file.path);
      entry.originalSha256 = prior.sha256;
      entry.originalSize = prior.size;
    }
    return entry;
  });
}

function originalRecord({title, uid, backup, plan}) {
  const trigger = backup.entries.find(entry => entry.path === '/' + TRIGGER);
  return {
    version: receipts.VERSION,
    kind: receipts.KIND_ORIGINAL,
    status: 'original',
    origin: 'install',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: {id: title.id, name: title.name},
    account: {uid},
    upstream: {repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT, tag: UPSTREAM_TAG},
    backup: {
      path: path.resolve(backup.dir),
      manifestSha256: backup.manifestSha256,
      entries: backup.entries.length,
      bytes: backup.bytes,
      triggerSha256: trigger.sha256,
      identity: backup.identity,
      identitySource: 'pull',
    },
    installed: installedEntries({plan, backup}),
    postInstallVerified: false,
  };
}

// A pre-install baseline must not already contain this launcher: a backup taken
// after an install is a verification snapshot, not an original state. Accepting
// it would silently move the rollback baseline forward.
function preinstallProblems(backup, title, expected = expectedHashes(title)) {
  const problems = [];
  for (const [p, want] of Object.entries(expected)) {
    const entry = backup.entries.find(e => e.path === p);
    if (entry && entry.sha256 === want) {
      problems.push(p + ' is already the installed payload in this backup');
    }
  }
  return problems;
}

function liveMatchesFiles(live, files) {
  const map = new Map(live.entries.map(entry => [entry.path, entry.sha256]));
  return files.every(file => map.get(file.path) === file.sha256);
}

// What would install do with this original record and live state?
function installMode(original, live, plan) {
  if (!original) return 'first';
  return liveMatchesFiles(live, plan.files) ? 'noop' : 'update';
}

async function originalDigest(title, uid) {
  return receipts.sha256(await fsp.readFile(receipts.originalPath(title.id, uid)));
}

async function ensureOriginal(title, uid) {
  const existing = await receipts.readOriginal(title.id, uid);
  if (existing) return existing;
  const legacy = await receipts.readReceipt(title.id, uid);
  if (!legacy) return null;
  const adopted = receipts.adoptLegacyReceipt(legacy, {launcherFiles: LAUNCHER_FILES});
  if (adopted.problems.length) {
    throw new Failure(EXIT.prereq, 'the legacy receipt cannot be adopted as an original baseline',
      adopted.problems.map(p => '  ' + p));
  }
  await receipts.writeImmutable(receipts.originalPath(title.id, uid), adopted.record);
  console.log('adopted the legacy receipt as the immutable original baseline');
  return adopted.record;
}

function transactionRecord({title, uid, original, originalSha, live, plan}) {
  return {
    version: receipts.VERSION,
    kind: receipts.KIND_TRANSACTION,
    id: receipts.transactionId(),
    status: 'installing',
    origin: 'update',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: {id: title.id, name: title.name},
    account: {uid},
    upstream: {repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT, tag: UPSTREAM_TAG},
    originalSha256: originalSha,
    originalPath: receipts.originalPath(title.id, uid),
    preState: {
      source: 'pull',
      dir: path.resolve(live.dir),
      manifestSha256: live.manifestSha256,
      entries: live.entries.length,
      files: live.entries.map(entry => ({path: entry.path, size: entry.size,
        sha256: entry.sha256})),
    },
    installed: installedEntries({plan, backup: live}),
    progress: {trigger: 'pending', deleted: []},
  };
}

// ------------------------------------------------------------------- install --
async function install(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'install needs a run directory');
  const uid = uidFor(options, title);
  // Authorization is checked before anything is pulled or staged: an install
  // without --confirm must not even create a backup directory.
  if (!options['dry-run'] && !options.confirm) {
    throw new Failure(EXIT.usage,
      'refusing to write without --confirm (this is the explicit write authorization); ' +
      'use the plan/dry-run command to inspect the plan first');
  }
  const runTag = stamp();
  // A dry run must not write local state either, so it reads (and, for a legacy
  // single receipt, previews) without adopting anything.
  const original = options['dry-run']
    ? ((await receipts.readOriginal(title.id, uid)) ||
       (await receipts.readReceipt(title.id, uid)))
    : await ensureOriginal(title, uid);

  let backupDir = options.backup ? path.resolve(options.backup) : null;
  if (!backupDir && !original) {
    backupDir = await newestBackup(title, uid);
    if (backupDir) console.log('using the existing validated backup: ' + backupDir);
  }

  if (options['dry-run']) {
    const source = backupDir || (original && original.backup.path);
    if (!source) {
      throw new Failure(EXIT.prereq,
        'dry run needs a local backup (--backup); nothing was pulled or written');
    }
    const backup = await loadBackup(source, title, {requireIdentity: true, uid});
    const {plan} = await stageAndPlan({title, backup, options});
    printPlan(title, backup, plan);
    console.log('\ndry run: nothing was pulled and nothing was written to the console.');
    if (original) console.log('rollback baseline: ' + receipts.originalPath(title.id, uid));
    return EXIT.ok;
  }

  if (!original) {
    // -------- first installation: the backup becomes the immutable baseline
    if (!backupDir) {
      const target = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8),
        runTag + '-artemis-backup');
      console.log('no backup yet: pulling one into ' + target);
      backupDir = (await pullSnapshot(session, title, uid, target, 'backup')).dir;
    }
    const backup = await loadBackup(backupDir, title, {requireIdentity: true, uid});
    const baseline = preinstallProblems(backup, title);
    if (baseline.length) {
      throw new Failure(EXIT.conflict,
        'this backup already contains the Artemis payload, so it is a post-install ' +
        'snapshot, not a pre-install baseline', baseline.concat([
          '  refusing to move the rollback baseline forward',
          '  if the payload is already on the console, use migrate-legacy instead',
        ]));
    }
    const {plan, target} = await stageAndPlan({title, backup, options});
    printPlan(title, backup, plan);
    if (plan.conflicts.length) {
      throw new Failure(EXIT.conflict, 'refusing to overwrite files this installer does not own',
        plan.conflicts.map(c => '  ' + c.name + ': ' + c.reason));
    }
    // Written before the console write: if the write is interrupted, the
    // baseline still describes the true pre-install state.
    const record = originalRecord({title, uid, backup, plan});
    const recordFile = receipts.originalPath(title.id, uid);
    await receipts.writeImmutable(recordFile, record);
    console.log('\noriginal baseline: ' + recordFile);

    console.log('\nwriting in one transaction (save-write-stage.cjs)');
    const written = runStep('save-write-stage.cjs',
      [session, title.id, uid, backup.dir, path.join(target, 'manifest.json')],
      {stdio: 'inherit', cwd: target});
    if (written.status !== 0) {
      throw new Failure(written.status === 3 ? EXIT.sessionLost : EXIT.verify,
        'the write did not complete; the original baseline and the backup at ' +
        backup.dir + ' are intact');
    }
    const verifyDir = path.join(path.dirname(backup.dir), runTag + '-artemis-verify');
    console.log('\nverifying by pulling the save again into ' + verifyDir);
    await pullSnapshot(session, title, uid, verifyDir, 'verification');
    const compared = runStep('verify-save-manifest.cjs',
      [verifyDir, path.join(target, 'manifest.json')]);
    if (compared.status !== 0) {
      throw new Failure(EXIT.verify, 'the pulled save does not match the manifest; ' +
        'the original baseline is unchanged');
    }
    console.log('installed and verified: ' + target);
    console.log('original baseline: ' + recordFile);
    console.log('rollback: node tools/artemis-launcher.cjs restore ' + session +
      ' --title ' + title.id + ' --uid ' + uid + ' --confirm-restore');
    return EXIT.ok;
  }

  // -------- reinstall/update: original stays immutable
  const originalProblems = receipts.validateOriginal(original, {
    titleId: title.id, uid, commit: UPSTREAM_COMMIT,
    launcherFiles: LAUNCHER_FILES, trigger: TRIGGER,
  });
  if (originalProblems.length) {
    throw new Failure(EXIT.prereq, 'the original baseline failed validation',
      originalProblems.map(p => '  ' + p));
  }
  const liveDir = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8),
    runTag + '-artemis-presstate');
  console.log('reading the live save before staging (read-only)');
  const live = await pullSnapshot(session, title, uid, liveDir, 'pre-state');
  const {plan, target} = await stageAndPlan({title, backup: live, options});
  printPlan(title, live, plan);
  if (plan.conflicts.length) {
    throw new Failure(EXIT.conflict, 'refusing to overwrite files this installer does not own',
      plan.conflicts.map(c => '  ' + c.name + ': ' + c.reason));
  }
  if (installMode(original, live, plan) === 'noop') {
    // Nothing to write. Verify the existing bytes rather than manufacturing a
    // transaction or touching the baseline.
    const checked = runStep('verify-save-manifest.cjs',
      [live.dir, path.join(target, 'manifest.json')]);
    if (checked.status !== 0) {
      throw new Failure(EXIT.verify, 'the live save matches the plan but the manifest check failed');
    }
    console.log('\nalready installed: every staged file matches the live save; ' +
      'no write and no transaction were made.');
    console.log('original baseline: ' + receipts.originalPath(title.id, uid) + ' (unchanged)');
    return EXIT.ok;
  }
  const originalSha = await originalDigest(title, uid);
  const tx = transactionRecord({title, uid, original, originalSha, live, plan});
  const txFile = await receipts.writeTransaction(tx);
  console.log('\nupdate transaction: ' + txFile);
  console.log('original baseline: ' + receipts.originalPath(title.id, uid) + ' (unchanged)');

  console.log('\nwriting in one transaction (save-write-stage.cjs)');
  const written = runStep('save-write-stage.cjs',
    [session, title.id, uid, live.dir, path.join(target, 'manifest.json')],
    {stdio: 'inherit', cwd: target});
  if (written.status !== 0) {
    tx.status = 'install-failed';
    tx.error = 'save-write-stage exited ' + written.status;
    tx.updatedAt = new Date().toISOString();
    await receipts.writeTransaction(tx);
    throw new Failure(written.status === 3 ? EXIT.sessionLost : EXIT.verify,
      'the update did not complete; the original baseline is unchanged');
  }
  const verifyDir = path.join(path.dirname(live.dir), runTag + '-artemis-verify');
  console.log('\nverifying by pulling the save again into ' + verifyDir);
  await pullSnapshot(session, title, uid, verifyDir, 'verification');
  const compared = runStep('verify-save-manifest.cjs',
    [verifyDir, path.join(target, 'manifest.json')]);
  if (compared.status !== 0) {
    tx.status = 'install-failed';
    tx.error = 'post-install pull did not match the manifest';
    tx.updatedAt = new Date().toISOString();
    await receipts.writeTransaction(tx);
    throw new Failure(EXIT.verify, 'the pulled save does not match the manifest; ' +
      'the original baseline is unchanged');
  }
  tx.status = 'installed';
  tx.verified = true;
  tx.updatedAt = new Date().toISOString();
  await receipts.writeTransaction(tx);
  console.log('updated and verified: ' + target);
  console.log('original baseline: ' + receipts.originalPath(title.id, uid) + ' (unchanged)');
  return EXIT.ok;
}

function printPlan(title, backup, plan) {
  const replaces = plan.files.filter(file => file.replace);
  const adds = plan.files.filter(file => !file.replace);
  console.log('\n' + title.name + ' (' + title.id + ')');
  console.log('backup: ' + backup.dir + '  (' + describeBackup(backup) + ')');
  console.log('add    ' + adds.length + ' file(s), replace ' + replaces.length + ' file(s)');
  for (const file of plan.files) {
    console.log('  ' + (file.replace ? 'replace' : 'add    ') + ' ' +
      file.path.padEnd(16) + String(file.size).padStart(8) + '  ' + file.sha256.slice(0, 16));
  }
  if (plan.conflicts.length) {
    console.log('CONFLICTS');
    for (const conflict of plan.conflicts) {
      console.log('  ' + conflict.name + ': ' + conflict.reason);
    }
  }
}

// ------------------------------------------------------------------- restore --
function emptyAnalysis() {
  return {problems: [], missing: [], modified: [], unexpected: [], updates: [],
    deleted: [], trigger: null};
}

// Compare a pulled snapshot with what the receipt says this installer wrote.
// A file that differs is never deleted: the user may have edited it.
function analyzeReceiptState({live, receipt, backup, title}) {
  const out = emptyAnalysis();
  const liveMap = new Map(live.entries.map(entry => [entry.path, entry]));
  const installed = new Map(receipt.installed.map(entry => [entry.path, entry]));
  const deleted = new Set((receipt.progress && receipt.progress.deleted) || []);
  const triggerDone = receipt.progress && receipt.progress.trigger === 'done';

  const trigger = installed.get('/' + TRIGGER);
  const liveTrigger = liveMap.get('/' + TRIGGER);
  const backupTrigger = backup.entries.find(e => e.path === '/' + TRIGGER).sha256;
  const expectedTrigger = triggerDone ? backupTrigger : trigger.sha256;
  // An interrupted restore can land between the trigger write and the receipt
  // update. While status is `restoring`, the backup's trigger is also an
  // acceptable live state; restore repairs the progress marker.
  const acceptable = new Set([expectedTrigger]);
  if (receipt.status === 'restoring') acceptable.add(backupTrigger);
  if (!liveTrigger) {
    out.missing.push('/' + TRIGGER);
    out.problems.push('/' + TRIGGER + ' is missing from the live save');
  } else if (!acceptable.has(liveTrigger.sha256)) {
    out.modified.push('/' + TRIGGER);
    out.problems.push('/' + TRIGGER + ' live sha256 ' + liveTrigger.sha256.slice(0, 16) +
      '… differs from the expected ' + expectedTrigger.slice(0, 16) + '…');
  }
  out.trigger = liveTrigger ? liveTrigger.sha256 : null;
  out.triggerAlreadyRestored = !!(liveTrigger && liveTrigger.sha256 === backupTrigger);

  for (const entry of receipt.installed) {
    if (entry.path === '/' + TRIGGER) continue;
    const liveEntry = liveMap.get(entry.path);
    if (deleted.has(entry.path)) {
      if (liveEntry) {
        out.problems.push(entry.path + ' was recorded as removed but is still present');
      } else {
        out.deleted.push(entry.path);
      }
      continue;
    }
    if (!liveEntry) {
      // The same crash window exists between a successful delete and its
      // receipt update: while restoring, an absent add file is already done.
      if (receipt.status === 'restoring' && entry.kind === 'add') {
        out.deleted.push(entry.path);
      } else {
        out.missing.push(entry.path);
        out.problems.push(entry.path + ' is missing');
      }
    } else if (liveEntry.sha256 !== entry.sha256) {
      out.modified.push(entry.path);
      out.problems.push(entry.path + ' was modified after installation (live ' +
        liveEntry.sha256.slice(0, 16) + '… != installed ' + entry.sha256.slice(0, 16) + '…)');
    }
    if (entry.kind === 'replace') {
      const before = backup.entries.find(e => e.path === entry.path);
      if (!before || before.sha256 !== entry.originalSha256) {
        out.problems.push('receipt original hash for ' + entry.path +
          ' does not match the backup');
      }
    }
  }

  // Files in the launcher namespace that this receipt does not own. Another
  // installation or a user file: never delete, refuse and report.
  const owned = new Set(receipt.installed.map(entry => entry.path));
  for (const name of [...LAUNCHER_FILES, TRIGGER]) {
    const p = '/' + name;
    if (owned.has(p)) continue;
    if (liveMap.has(p)) {
      out.unexpected.push(p);
      out.problems.push(p + ' is present but not owned by this receipt');
    }
  }
  for (const name of UPDATE_FILES) {
    if (liveMap.has('/' + name)) out.updates.push('/' + name);
  }
  return out;
}

function printAnalysis(analysis) {
  console.log('preflight: ' + (analysis.problems.length ? 'REFUSED' : 'ok'));
  for (const problem of analysis.problems) console.log('  problem: ' + problem);
  for (const path of analysis.deleted) console.log('  already removed: ' + path);
  if (analysis.updates.length) {
    console.log('  note: update file(s) present and left alone: ' + analysis.updates.join(', '));
  }
}

// The expected post-rollback state, as a pure check so it can be tested
// offline: the trigger is the backup's, and every file this install added is
// gone. Anything else in the save is out of scope.
function postRestoreProblems({post, receipt, backup}) {
  const postMap = new Map(post.entries.map(entry => [entry.path, entry]));
  const failures = [];
  const postTrigger = postMap.get('/' + TRIGGER);
  if (!postTrigger || postTrigger.sha256 !== receipt.backup.triggerSha256) {
    failures.push(TRIGGER + ' does not match the backup after restore');
  }
  for (const entry of receipt.installed) {
    if (entry.kind !== 'add') continue;
    if (postMap.has(entry.path)) failures.push(entry.path + ' is still present');
  }
  return failures;
}

function requireRestoreAuthorization(options) {
  if (!options['confirm-restore']) {
    throw new Failure(EXIT.usage,
      'refusing to restore without --confirm-restore (this overwrites live save data)');
  }
}

function candidateStates(original, transactions) {
  const states = [{name: 'original install', files: original.installed}];
  for (const tx of transactions) {
    if (Array.isArray(tx.installed) && tx.installed.length) {
      states.push({name: 'transaction ' + tx.id, files: tx.installed});
    }
    if (tx.preState && Array.isArray(tx.preState.files) && tx.preState.files.length) {
      states.push({name: 'pre-state ' + tx.id, files: tx.preState.files});
    }
  }
  return states;
}

const LAUNCHER_PATHS = [...LAUNCHER_FILES.map(name => '/' + name), '/' + TRIGGER];

function stateMatchesLive(live, files) {
  const liveMap = new Map(live.entries.map(entry => [entry.path, entry.sha256]));
  const stateMap = new Map(files.map(entry => [entry.path, entry.sha256]));
  return LAUNCHER_PATHS.every(p => (liveMap.get(p) || null) === (stateMap.get(p) || null));
}

// The pre-install target: launcher files that were not in the original backup
// are removed; the trigger is restored from it.
function restoreTarget(original, backup) {
  // Ownership comes from the original record: only files it added are removed.
  // A file that replaced something pre-existing is not silently deleted.
  const deletePaths = original.installed
    .filter(entry => entry.kind === 'add')
    .map(entry => entry.path);
  return {deletePaths, triggerSha256: original.backup.triggerSha256};
}

function analyzeRestore({live, expectedFiles, original, progress, deletePaths}) {
  const out = {problems: [], missing: [], modified: [], unexpected: [], deleted: [],
    triggerAlreadyRestored: false};
  const liveMap = new Map(live.entries.map(entry => [entry.path, entry.sha256]));
  const expectedMap = new Map(expectedFiles.map(entry => [entry.path, entry.sha256]));
  const deleted = new Set((progress && progress.deleted) || []);
  const triggerExpected = progress && progress.trigger === 'done'
    ? original.backup.triggerSha256
    : expectedMap.get('/' + TRIGGER);
  const acceptable = new Set([triggerExpected]);
  if (progress && progress.trigger === 'done') acceptable.add(original.backup.triggerSha256);

  const liveTrigger = liveMap.get('/' + TRIGGER);
  if (!liveTrigger) {
    out.missing.push('/' + TRIGGER);
    out.problems.push('/' + TRIGGER + ' is missing from the live save');
  } else if (!acceptable.has(liveTrigger)) {
    out.modified.push('/' + TRIGGER);
    out.problems.push('/' + TRIGGER + ' matches neither the installed nor the restored trigger');
  }
  out.triggerAlreadyRestored = liveTrigger === original.backup.triggerSha256;

  for (const p of deletePaths) {
    const liveEntry = liveMap.get(p);
    if (deleted.has(p)) {
      if (liveEntry) out.problems.push(p + ' was recorded as removed but is still present');
      else out.deleted.push(p);
      continue;
    }
    if (!liveEntry) {
      // A crash between a successful delete and its record update leaves the
      // file absent without progress; while restoring that is already done.
      if (progress && progress.trigger === 'done') out.deleted.push(p);
      else {
        out.missing.push(p);
        out.problems.push(p + ' is missing from the live save');
      }
      continue;
    }
    const want = expectedMap.get(p);
    if (want && liveEntry !== want) {
      out.modified.push(p);
      out.problems.push(p + ' was modified after installation (live ' +
        liveEntry.slice(0, 16) + '… != installed ' + want.slice(0, 16) + '…)');
    }
  }

  for (const [p, want] of expectedMap) {
    if (p === '/' + TRIGGER || deletePaths.includes(p)) continue;
    const liveEntry = liveMap.get(p);
    if (!liveEntry) { out.missing.push(p); out.problems.push(p + ' is missing'); }
    else if (liveEntry !== want) {
      out.modified.push(p);
      out.problems.push(p + ' was modified after installation');
    }
  }

  for (const p of LAUNCHER_PATHS) {
    if (expectedMap.has(p) || deletePaths.includes(p)) continue;
    if (liveMap.has(p)) {
      out.unexpected.push(p);
      out.problems.push(p + ' is present but not part of this installation');
    }
  }
  for (const name of UPDATE_FILES) {
    if (liveMap.has('/' + name)) {
      out.unexpected.push('/' + name + ' (upstream update file, left alone)');
    }
  }
  return out;
}

function printRestoreAnalysis(analysis) {
  console.log('preflight: ' + (analysis.problems.length ? 'REFUSED' : 'ok'));
  for (const problem of analysis.problems) console.log('  problem: ' + problem);
  for (const path of analysis.deleted) console.log('  already removed: ' + path);
  const updates = analysis.unexpected.filter(p => /update file/.test(p));
  if (updates.length) console.log('  note: ' + updates.join(', '));
}

// Stage the backup's boot trigger beside a manifest whose `local` is relative,
// then invoke the writer with that directory as its working directory. The
// writer reads `entry.local` with fs.readFile, so without the cwd it would
// resolve the name against the operator's directory; passing it explicitly is
// what makes restoration independent of where the CLI was started.
async function stageTriggerForRestore({backupDir, work, title}) {
  const source = path.join(backupDir, TRIGGER);
  const bytes = await fsp.readFile(source);
  await fsp.copyFile(source, path.join(work, TRIGGER));
  const manifest = {
    purpose: 'restore the boot trigger for ' + title.name,
    files: [{path: '/' + TRIGGER, local: TRIGGER, size: bytes.length,
      sha256: sha256(bytes), replace: true}],
  };
  const manifestPath = path.join(work, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return {manifest, manifestPath, bytes};
}

async function writeRestoreTrigger({session, title, uid, backupDir, work, run = runStep}) {
  try {
    const staged = await stageTriggerForRestore({backupDir, work, title});
    return run('save-write-stage.cjs',
      [session, title.id, uid, backupDir, staged.manifestPath,
        '--restore', '--confirm-restore'],
      {stdio: 'inherit', cwd: work});
  } finally {
    await fsp.rm(work, {recursive: true, force: true}).catch(() => {});
  }
}

// A migrated installation keeps its pre-identity backup untouched: the
// immutable original record carries the identity and provenance instead. This
// helper accepts that narrow case only, and never weakens the modern path.
// `retarget` is injectable so the provenance check can be tested offline.
async function loadOriginalBackupForRestore(original, title, uid, options = {}) {
  const retarget = options.retarget || retargetSave;
  const problems = [];
  const migrated = original.origin === 'migrated-legacy';
  const checked = await validateBackup(original.backup.path, {
    trigger: TRIGGER,
    // Modern backups must carry full identity. A migrated legacy backup does
    // not, and is accepted only through the attestation checks below.
    requireIdentity: !migrated,
    titleId: title.id,
    uid,
  });
  if (!checked.ok) return {ok: false, problems: checked.problems};

  if (!original.title || original.title.id !== title.id) {
    problems.push('original record is for another title');
  }
  if (!original.account || original.account.uid !== uid) {
    problems.push('original record is for another account');
  }
  if (checked.manifestSha256 !== original.backup.manifestSha256) {
    problems.push('the backup manifest changed since the original record was written');
  }
  const triggerEntry = checked.entries.find(entry => entry.path === '/' + TRIGGER);
  if (!triggerEntry || triggerEntry.sha256 !== original.backup.triggerSha256) {
    problems.push('the backup trigger does not match the original record');
  }

  // Recompute the deterministic transform rather than trusting the record.
  let expectedTrigger = null;
  if (triggerEntry) {
    let work = null;
    try {
      work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-restore-check-'));
      const out = path.join(work, TRIGGER);
      await retarget(path.join(checked.dir, TRIGGER), out);
      expectedTrigger = await fileSha(out);
    } catch (error) {
      problems.push('could not recompute the expected trigger: ' + error.message);
    } finally {
      if (work) await fsp.rm(work, {recursive: true, force: true}).catch(() => {});
    }
  }
  const installedTrigger = original.installed.find(e => e.path === '/' + TRIGGER);
  if (!installedTrigger) problems.push('original record has no boot trigger entry');
  else if (expectedTrigger && installedTrigger.sha256 !== expectedTrigger) {
    problems.push('the installed trigger in the original record does not match the ' +
      'deterministic transformation of the original trigger');
  }

  // The installed payload must be exactly the pinned release.
  for (const [p, want] of Object.entries(expectedHashes(title))) {
    const entry = original.installed.find(e => e.path === p);
    if (!entry) problems.push('original record is missing ' + p);
    else if (entry.sha256 !== want) problems.push(p + ' in the original record does not match ' +
      'the pinned release');
  }

  if (migrated) {
    const att = original.attestation;
    if (!att || att.kind !== 'ns2-savekit/artemis-launcher-migration') {
      problems.push('migrated record has no migration attestation');
    } else {
      if (!att.originalBackup || att.originalBackup.manifestSha256 !== original.backup.manifestSha256) {
        problems.push('attestation does not name this original backup manifest');
      }
      if (!att.originalBackup || att.originalBackup.triggerSha256 !== original.backup.triggerSha256) {
        problems.push('attestation does not name this original trigger');
      }
      if (!Array.isArray(att.identityEvidence) || att.identityEvidence.length === 0) {
        problems.push('attestation has no identity evidence');
      }
      if (!/^[0-9a-f]{64}$/.test(String(att.installedSnapshot && att.installedSnapshot.manifestSha256 || ''))) {
        problems.push('attestation has no installed-snapshot manifest hash');
      }
      if (att.pinnedUpstream !== UPSTREAM_COMMIT) {
        problems.push('attestation was made for a different upstream revision');
      }
      if (expectedTrigger && att.verifiedTriggerSha256 !== expectedTrigger) {
        problems.push('attestation trigger hash does not match the recomputed trigger');
      }
    }
    if (!original.backup.identitySource) problems.push('migrated record has no identity source');
  } else if (!checked.identity ||
      checked.identity.programId !== title.id || checked.identity.uid !== uid) {
    problems.push('backup identity does not match the requested title/account');
  }

  if (problems.length) return {ok: false, problems};
  return {ok: true, backup: checked, expectedTrigger, problems: []};
}

// Rollback to the state before the FIRST install. The immutable original record
// supplies the backup and trigger; transaction records only describe the live
// state that is allowed to be removed.
async function restoreFromOriginal({options, title, session, uid, original}) {
  const problems = receipts.validateOriginal(original, {
    titleId: title.id, uid, commit: UPSTREAM_COMMIT,
    launcherFiles: LAUNCHER_FILES, trigger: TRIGGER,
  });
  if (problems.length) {
    throw new Failure(EXIT.prereq, 'the original installation record failed validation',
      problems.map(p => '  ' + p));
  }
  const loaded = await loadOriginalBackupForRestore(original, title, uid);
  if (!loaded.ok) {
    throw new Failure(EXIT.prereq, 'the original backup failed restore validation',
      loaded.problems.map(p => '  ' + p));
  }
  const backup = loaded.backup;
  const target = restoreTarget(original, backup);
  const transactions = await receipts.listTransactions(title.id, uid);
  const latest = transactions.length ? transactions[transactions.length - 1] : null;
  const resuming = !!(latest && latest.origin === 'restore' && latest.status === 'restoring');

  const runTag = stamp();
  const preDir = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8),
    runTag + '-restore-preflight');
  console.log('reading the live save before touching it (read-only)');
  const live = await pullSnapshot(session, title, uid, preDir, 'preflight');

  const liveMapNow = new Map(live.entries.map(entry => [entry.path, entry.sha256]));
  const alreadyRestored = liveMapNow.get('/' + TRIGGER) === original.backup.triggerSha256 &&
    target.deletePaths.every(p => !liveMapNow.has(p));
  if (alreadyRestored) {
    console.log('already at the pre-install state: the original trigger is present and every ' +
      'file the first install added is absent.');
    console.log('original baseline kept: ' + receipts.originalPath(title.id, uid));
    return EXIT.ok;
  }

  let expectedFiles;
  let progress;
  if (resuming) {
    expectedFiles = latest.restoreFrom;
    progress = latest.progress;
    console.log('resuming restore transaction ' + latest.id);
  } else {
    const match = candidateStates(original, transactions)
      .find(state => stateMatchesLive(live, state.files));
    if (!match) {
      const rows = candidateStates(original, transactions).map(state => {
        const map = new Map(live.entries.map(entry => [entry.path, entry.sha256]));
        return '  ' + state.name + ': ' +
          state.files.filter(f => map.get(f.path) !== f.sha256).map(f => f.path).join(', ');
      });
      throw new Failure(EXIT.conflict,
        'the live save matches no recorded installation state; refusing to restore',
        rows.concat(['  (modified files are never deleted)']));
    }
    expectedFiles = match.files;
    progress = {trigger: 'pending', deleted: []};
  }

  const analysis = analyzeRestore({live, expectedFiles, original, progress,
    deletePaths: target.deletePaths});
  printRestoreAnalysis(analysis);
  if (analysis.problems.length) {
    throw new Failure(EXIT.conflict,
      'refusing to restore: the live save does not match the recorded installation',
      analysis.problems.map(p => '  ' + p));
  }
  if (options['dry-run']) {
    console.log('\ndry run: preflight passed; nothing was changed.');
    console.log('target: pre-install state from ' + backup.dir +
      ' (trigger restored, ' + target.deletePaths.length + ' added file(s) removed)');
    return EXIT.ok;
  }
  requireRestoreAuthorization(options);

  let tx = resuming ? latest : null;
  if (!tx) {
    tx = {
      version: receipts.VERSION,
      kind: receipts.KIND_TRANSACTION,
      id: receipts.transactionId(),
      status: 'restoring',
      origin: 'restore',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: {id: title.id, name: title.name},
      account: {uid},
      upstream: {repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT, tag: UPSTREAM_TAG},
      originalSha256: await originalDigest(title, uid),
      originalPath: receipts.originalPath(title.id, uid),
      preState: {
        source: 'pull',
        dir: path.resolve(live.dir),
        manifestSha256: live.manifestSha256,
        entries: live.entries.length,
        files: live.entries.map(entry => ({path: entry.path, size: entry.size,
          sha256: entry.sha256})),
      },
      restoreFrom: expectedFiles,
      installed: [],
      progress: {trigger: 'pending', deleted: []},
    };
    await receipts.writeTransaction(tx);
    console.log('restore transaction: ' + receipts.transactionPath(title.id, uid, tx.id));
  }
  if (analysis.triggerAlreadyRestored && tx.progress.trigger !== 'done') {
    tx.progress.trigger = 'done';
  }
  tx.status = 'restoring';
  tx.updatedAt = new Date().toISOString();
  await receipts.writeTransaction(tx);

  if (tx.progress.trigger !== 'done') {
    console.log('1/3 restoring ' + TRIGGER + ' from the original backup');
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-restore-'));
    const written = await writeRestoreTrigger({session, title, uid,
      backupDir: backup.dir, work});
    if (written.status !== 0) {
      tx.status = 'restore-failed';
      tx.error = 'boot trigger restore failed';
      tx.updatedAt = new Date().toISOString();
      await receipts.writeTransaction(tx);
      throw new Failure(EXIT.verify, 'the boot trigger was not restored');
    }
    tx.progress.trigger = 'done';
    tx.updatedAt = new Date().toISOString();
    await receipts.writeTransaction(tx);
  } else {
    console.log('1/3 trigger already restored by an earlier attempt');
  }

  console.log('2/3 removing only the launcher files the first install added');
  for (const path of target.deletePaths) {
    if (tx.progress.deleted.includes(path)) continue;
    const deleted = runStep('save-delete-root.cjs', [session, title.id, uid, path]);
    if (!isGone(deleted.status)) {
      tx.status = 'restore-failed';
      tx.error = 'could not remove ' + path + ' (exit ' + deleted.status + ')';
      tx.updatedAt = new Date().toISOString();
      await receipts.writeTransaction(tx);
      throw new Failure(EXIT.verify, 'could not remove ' + path +
        ' (exit ' + deleted.status + '); the trigger is restored, the game boots normally. ' +
        'Re-run restore to resume.');
    }
    if (deleted.status === DELETE_EXIT.notFound) console.log('  ' + path + ' was already absent');
    tx.progress.deleted.push(path);
    tx.updatedAt = new Date().toISOString();
    await receipts.writeTransaction(tx);
  }

  console.log('3/3 verifying the restored save');
  const postDir = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8),
    runTag + '-restore-verify');
  const post = await pullSnapshot(session, title, uid, postDir, 'post-restore');
  const failures = postRestoreProblems({
    post,
    receipt: {backup: {triggerSha256: original.backup.triggerSha256},
      installed: target.deletePaths.map(path => ({path, kind: 'add'}))},
    backup,
  });
  if (failures.length) {
    tx.status = 'restore-failed';
    tx.error = failures.join('; ');
    tx.updatedAt = new Date().toISOString();
    await receipts.writeTransaction(tx);
    throw new Failure(EXIT.verify, 'post-restore verification failed',
      failures.map(f => '  ' + f));
  }
  tx.status = 'restored';
  tx.updatedAt = new Date().toISOString();
  tx.restoredAt = tx.updatedAt;
  await receipts.writeTransaction(tx);
  console.log('restored and verified: trigger matches the original backup; ' +
    target.deletePaths.length + ' launcher file(s) removed.');
  console.log('original baseline kept: ' + receipts.originalPath(title.id, uid));
  return EXIT.ok;
}

// Installs made before records existed, with no original baseline. Ownership is
// established from pinned content only (never from a fabricated record).
async function restoreLegacy({options, title, session, uid, backup}) {
  if (!options['adopt-legacy']) {
    throw new Failure(EXIT.usage,
      'no original installation record exists for this save. Automatic cleanup is refused ' +
      'because nothing records which files this installer wrote. Run migrate-legacy first, ' +
      'or pass --adopt-legacy to establish ownership from the pinned release.', [
      '  record: ' + receipts.originalPath(title.id, uid),
      '  migration: node tools/artemis-launcher.cjs migrate-legacy --title ' + title.id +
        ' --uid ' + uid + ' --backup <original-backup> --snapshot <installed-snapshot>',
    ]);
  }
  if (!backup.identity) {
    throw new Failure(EXIT.prereq, 'backup does not record the full program id and account uid; ' +
      'identity cannot be established, so a destructive cleanup is refused');
  }
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-legacy-'));
  const expected = path.join(work, TRIGGER);
  await retargetSave(path.join(backup.dir, TRIGGER), expected);
  const expectedTrigger = await fileSha(expected);
  await fsp.rm(work, {recursive: true, force: true});

  const runTag = stamp();
  const preDir = path.join(path.dirname(backup.dir), runTag + '-legacy-preflight');
  console.log('legacy installation (no record): reading the live save read-only');
  const live = await pullSnapshot(session, title, uid, preDir, 'preflight');
  const liveMap = new Map(live.entries.map(entry => [entry.path, entry]));
  const pinned = expectedHashes(title);
  const problems = [];
  const liveTrigger = liveMap.get('/' + TRIGGER);
  const originalTrigger = backup.entries.find(e => e.path === '/' + TRIGGER).sha256;
  const triggerDone = liveTrigger && liveTrigger.sha256 === originalTrigger;
  const triggerOurs = liveTrigger && liveTrigger.sha256 === expectedTrigger;
  if (!triggerDone && !triggerOurs) {
    problems.push('/' + TRIGGER + ' matches neither the original backup nor the ' +
      'deterministic retarget of it');
  }
  for (const [p, want] of Object.entries(pinned)) {
    const entry = liveMap.get(p);
    if (entry && entry.sha256 !== want) problems.push(p + ' differs from the pinned release');
  }
  printRestoreAnalysis({problems, missing: [], modified: [], unexpected: [], deleted: []});
  if (problems.length) {
    throw new Failure(EXIT.conflict, 'refusing the legacy cleanup: ownership is not established',
      problems.map(p => '  ' + p));
  }
  if (options['dry-run']) {
    console.log('\ndry run: legacy preflight passed; nothing was changed.');
    return EXIT.ok;
  }
  requireRestoreAuthorization(options);
  if (!triggerDone) {
    console.log('1/3 restoring ' + TRIGGER + ' from the original backup');
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-legacy-restore-'));
    const written = await writeRestoreTrigger({session, title, uid,
      backupDir: backup.dir, work: stage});
    if (written.status !== 0) throw new Failure(EXIT.verify, 'the boot trigger was not restored');
  } else {
    console.log('1/3 trigger already restored');
  }
  console.log('2/3 removing the pinned launcher files');
  const removed = [];
  for (const name of LAUNCHER_FILES) {
    const p = '/' + name;
    if (!liveMap.has(p)) continue;
    const deleted = runStep('save-delete-root.cjs', [session, title.id, uid, p]);
    if (!isGone(deleted.status)) {
      throw new Failure(EXIT.verify, 'could not remove ' + p + ' (exit ' + deleted.status +
        '); re-run with --adopt-legacy to resume');
    }
    removed.push(p);
  }
  console.log('3/3 verifying the restored save');
  const postDir = path.join(path.dirname(backup.dir), runTag + '-legacy-verify');
  const post = await pullSnapshot(session, title, uid, postDir, 'post-restore');
  const postMap = new Map(post.entries.map(entry => [entry.path, entry]));
  const failures = [];
  const postTrigger = postMap.get('/' + TRIGGER);
  if (!postTrigger || postTrigger.sha256 !== originalTrigger) {
    failures.push(TRIGGER + ' does not match the backup after restore');
  }
  for (const p of removed) if (postMap.has(p)) failures.push(p + ' is still present');
  if (failures.length) {
    throw new Failure(EXIT.verify, 'post-restore verification failed',
      failures.map(f => '  ' + f));
  }
  console.log('legacy restore verified: ' + TRIGGER + ' matches the backup; ' +
    removed.length + ' launcher file(s) removed; no record was created.');
  return EXIT.ok;
}

async function restore(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'restore needs a run directory');
  const uid = await uidForRestore(options, title);
  const original = await ensureOriginal(title, uid);
  if (original) {
    if (options.backup && path.resolve(options.backup) !== path.resolve(original.backup.path)) {
      throw new Failure(EXIT.prereq, '--backup is not the original rollback baseline (' +
        path.resolve(original.backup.path) + '); refusing to substitute a later snapshot');
    }
    return restoreFromOriginal({options, title, session, uid, original});
  }
  const backupDir = options.backup
    ? path.resolve(options.backup)
    : (await receiptsForTitle(title.id))[0]?.backup?.path;
  if (!backupDir) {
    throw new Failure(EXIT.prereq, 'a backup directory is required (--backup); no record exists');
  }
  const backup = await loadBackup(backupDir, title, {requireIdentity: true, uid});
  return restoreLegacy({options, title, session, uid, backup});
}

// ------------------------------------------------------------------ migration --
// A pre-receipt installation can be adopted without inventing data: the
// original backup supplies the rollback state, a read-only snapshot supplies
// the installed bytes, and identity comes from a full-uid snapshot or the
// local config. The original backup is never modified.
// Pure provenance check for legacy migration, so it can be tested without a
// console or real upstream bytes.
function buildMigrationRecord({title, uid, originalBackup, snapshot, pinned,
  expectedTrigger, identityEvidence, now = new Date().toISOString()}) {
  const problems = [];
  if (!identityEvidence || !identityEvidence.length) {
    problems.push('no independently verified account identity evidence');
  }
  const triggerOriginal = originalBackup.entries.find(e => e.path === '/' + TRIGGER);
  if (!triggerOriginal) problems.push('original backup has no boot trigger');
  for (const [p, want] of Object.entries(pinned)) {
    const entry = snapshot.entries.find(e => e.path === p);
    if (!entry) problems.push('installed snapshot is missing ' + p);
    else if (entry.sha256 !== want) problems.push(p + ' does not match the pinned release');
  }
  const triggerEntry = snapshot.entries.find(e => e.path === '/' + TRIGGER);
  if (!triggerEntry) problems.push('installed snapshot is missing the boot trigger');
  else if (triggerEntry.sha256 !== expectedTrigger) {
    problems.push('the installed trigger is not the deterministic retarget of the original backup');
  }
  if (problems.length) return {problems};
  const installed = LAUNCHER_FILES.map(name => {
    const entry = snapshot.entries.find(e => e.path === '/' + name);
    return {path: '/' + name, sha256: entry.sha256, size: entry.size, kind: 'add'};
  });
  installed.push({path: '/' + TRIGGER, sha256: triggerEntry.sha256, size: triggerEntry.size,
    kind: 'replace', originalSha256: triggerOriginal.sha256,
    originalSize: triggerOriginal.size});
  return {problems: [], record: {
    version: receipts.VERSION,
    kind: receipts.KIND_ORIGINAL,
    status: 'original',
    origin: 'migrated-legacy',
    createdAt: now,
    updatedAt: now,
    title: {id: title.id, name: title.name},
    account: {uid},
    upstream: {repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT, tag: UPSTREAM_TAG},
    backup: {
      path: path.resolve(originalBackup.dir),
      manifestSha256: originalBackup.manifestSha256,
      entries: originalBackup.entries.length,
      bytes: originalBackup.bytes,
      triggerSha256: triggerOriginal.sha256,
      identity: {programId: title.id, uid},
      identitySource: identityEvidence.join('+'),
      originalHadIdentity: false,
    },
    installed,
    attestation: {
      kind: 'ns2-savekit/artemis-launcher-migration',
      migratedAt: now,
      originalBackup: {
        path: path.resolve(originalBackup.dir),
        manifestSha256: originalBackup.manifestSha256,
        triggerSha256: triggerOriginal.sha256,
        identityRecorded: false,
      },
      installedSnapshot: {
        manifestSha256: snapshot.manifestSha256,
        entries: snapshot.entries.length,
        identityRecorded: false,
      },
      identityEvidence,
      pinnedUpstream: UPSTREAM_COMMIT,
      triggerTransformation: 'artemis-save.py launch <original save9999.dat> inject.iet',
      verifiedTriggerSha256: expectedTrigger,
      note: 'The original backup is referenced, not modified. No post-install snapshot is used ' +
        'as the rollback baseline.',
    },
  }};
}

async function migrateLegacy(options) {
  const title = titleFor(options.title);
  const uid = uidFor(options, title);
  if (!options['confirm-migration']) {
    throw new Failure(EXIT.usage,
      'migrate-legacy writes an immutable local record; pass --confirm-migration');
  }
  if (await receipts.readOriginal(title.id, uid)) {
    throw new Failure(EXIT.prereq, 'an original record already exists for this title/account; ' +
      'migration is only for pre-record installs');
  }
  if (!options.backup) throw new Failure(EXIT.usage, 'migrate-legacy needs --backup (the original)');
  const originalBackup = await loadBackup(options.backup, title, {requireIdentity: false});
  if (originalBackup.identity) {
    throw new Failure(EXIT.prereq, 'this backup already carries full identity; run install ' +
      'instead of migration');
  }
  let snapshot;
  if (options._[0]) {
    const dir = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8),
      stamp() + '-migration-snapshot');
    console.log('reading the installed save once (read-only)');
    snapshot = await pullSnapshot(path.resolve(options._[0]), title, uid, dir, 'migration');
  } else if (options.snapshot) {
    snapshot = await loadBackup(options.snapshot, title, {requireIdentity: false});
    if (snapshot.identity && snapshot.identity.uid !== uid) {
      throw new Failure(EXIT.prereq, 'snapshot is for a different account');
    }
  } else {
    throw new Failure(EXIT.prereq,
      'migration needs a read-only snapshot of the installed save: pass a run directory ' +
      'or --snapshot <pull>');
  }
  const identity = [];
  if (snapshot.identity && snapshot.identity.uid === uid) identity.push('live snapshot');
  try {
    const config = JSON.parse(await fsp.readFile(path.join(REPO, 'config/uids.json'), 'utf8'));
    if (normalizeUid(config[title.id]) === uid) identity.push('config/uids.json');
  } catch { /* no local config */ }

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-migrate-'));
  const expectedTriggerFile = path.join(work, TRIGGER);
  await retargetSave(path.join(originalBackup.dir, TRIGGER), expectedTriggerFile);
  const expectedTrigger = await fileSha(expectedTriggerFile);
  await fsp.rm(work, {recursive: true, force: true});

  const built = buildMigrationRecord({title, uid, originalBackup, snapshot,
    pinned: expectedHashes(title), expectedTrigger, identityEvidence: identity});
  if (built.problems.length) {
    throw new Failure(EXIT.prereq, 'migration refuses: provenance is not established',
      built.problems.map(p => '  ' + p));
  }
  const file = await receipts.writeImmutable(receipts.originalPath(title.id, uid), built.record);
  console.log('migration attestation written: ' + file);
  console.log('rollback baseline: ' + path.resolve(originalBackup.dir) +
    ' (pre-install, unchanged)');
  console.log('identity evidence: ' + identity.join(', '));
  console.log('installed payload verified against pinned ' + UPSTREAM_COMMIT.slice(0, 12) +
    ' and the deterministic trigger transformation.');
  return EXIT.ok;
}

// -------------------------------------------------------------------- verify --
async function verify(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'verify needs a run directory');
  const uid = uidFor(options, title);
  const backup = await loadBackup(options.backup, title, {requireIdentity: true, uid});
  const {plan} = await stageAndPlan({title, backup, options});
  const verifyDir = path.join(path.dirname(backup.dir), 'verify-' + Date.now());
  await pullSnapshot(session, title, uid, verifyDir, 'verification');
  const checked = runStep('verify-save-manifest.cjs',
    [verifyDir, path.join(stageDirFor(title, options), 'manifest.json')]);
  if (checked.status !== 0) throw new Failure(EXIT.verify, 'the save does not match the manifest');
  console.log('verified: ' + stageDirFor(title, options) + ' (' + plan.files.length + ' files)');
  return EXIT.ok;
}

async function stage(options) {
  const title = titleFor(options.title);
  if (!options.backup) throw new Failure(EXIT.usage, 'stage needs --backup');
  const backup = await loadBackup(options.backup, title, {triggerOnly: true});
  const {plan, target} = await stageAndPlan({title, backup, options});
  printPlan(title, backup, plan);
  if (plan.conflicts.length) {
    throw new Failure(EXIT.conflict, 'conflicts in staging', plan.conflicts.map(c => '  ' + c.name));
  }
  console.log('\nstaged: ' + path.join(target, 'manifest.json'));
  return EXIT.ok;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case 'stage': return stage(options);
    case 'plan': return stage(options);
    case 'install': return install(options);
    case 'verify': return verify(options);
    case 'restore': return restore(options);
    case 'migrate-legacy': return migrateLegacy(options);
    default:
      throw new Failure(EXIT.usage, 'usage: artemis-launcher.cjs <stage|plan|install|verify|restore> ...');
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(error => {
    if (error instanceof Failure) {
      console.error('FAILED: ' + error.message);
      note(error.extra || []);
      process.exit(error.code);
    }
    if (error && error.code === 'EUNSAFE') {
      console.error('FAILED: ' + error.message);
      process.exit(EXIT.prereq);
    }
    console.error('FAILED: ' + (error && error.stack || error));
    process.exit(1);
  });
}

module.exports = {
  EXIT, Failure, TITLES, UPSTREAM_COMMIT, UPSTREAM_FILES, LAUNCHER_FILES, TRIGGER,
  UPDATE_FILES, parseArgs, titleFor, pinnedFor, expectedHashes, verifyUpstream,
  buildManifest, writeManifest, analyzeReceiptState, analyzeRestore, postRestoreProblems,
  candidateStates, restoreTarget, stateMatchesLive, preinstallProblems, installMode,
  installedEntries,
  originalRecord, transactionRecord, buildMigrationRecord, verifyLegacyStaging,
  loadOriginalBackupForRestore, retargetSave, stageTriggerForRestore, writeRestoreTrigger,
  loadBackup, stageDirFor, stageTo, stageAndPlan,
};
