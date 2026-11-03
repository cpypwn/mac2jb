#!/usr/bin/env node
'use strict';
// ns2-savekit: guided, interactive front end for the tools in this directory.
//
// It does not reimplement anything: every action shells out to the proven
// scripts (list-apps, find-save-uid, save-pull-root, save-write-stage,
// save-delete-root) so the safety rails - whitelist, required backup, verified
// replaces, one transaction per write - stay exactly where they were tested.
//
//   node kit.cjs [run-directory]
//
// With no argument it picks the newest run folder that has a promoted root.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const titles = require('./lib/titles.cjs');
const ALLOWED = new Set();
try {
  for (const name of ['titles.json', 'titles.local.json']) {
    const extra = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', name), 'utf8'));
    for (const entry of extra.write || []) ALLOWED.add(String(entry.id).toLowerCase());
  }
} catch { /* allowlist file is optional */ }

const TOOLS = __dirname;
const REPO = path.resolve(TOOLS, '..');
let namesNoted = false;
const NOTICE = [
  'Writes are the only dangerous operation and they are fenced: disposable titles',
  'only, a backup is required, existing files are replaced only when the live bytes',
  'still match that backup, everything goes down in one commit and is hashed back.',
  'Several save operations run fine in one session; restart only if one fails.',
].join('\n');

function quote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
}
// Print the exact command an action runs, so it can be copied and re-run by hand
// (and so nothing happens that the user cannot see).
function echoCommand(command) {
  console.log('\n$ ' + command);
}
// The console can stop answering mid-session (transport 0xf601). Say so in one
// line instead of letting a wall of failures look like a bug in the save logic.
const SESSION_LOST = /transport (?:failed )?(0xf601|62977)/i;
const NO_HOST = /ENOENT.*memory\.sock/i;
function checkLost(result) {
  const text = (result.stderr || '') + (result.stdout || '') + (result.message || '');
  if (NO_HOST.test(text)) {
    console.log('\nNO LIVE HOST - start node ~/ns2jb-rpc/run.cjs --rpc <mac-ip> and use its run folder.');
    process.exit(4);
  }
  if (SESSION_LOST.test(text)) {
    console.log('\nSESSION LOST - the console stopped answering.');
    console.log('Close SmileBASIC, reopen it, run the bootstrap, start a new host, retry.');
    console.log('The save was not changed.');
    process.exit(3);
  }
  return result;
}

function run(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], {
    encoding: 'utf8',
    // --list-only prints one line per file, and the "listed N files" line that
    // proves a probe worked comes last. The default 1 MiB cap would truncate a
    // large save and make a real save look like a broken probe.
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  const combined = (result.stdout || '') + (result.stderr || '');
  return checkLost({
    ok: result.status === 0,
    out: combined,
    stdout: result.stdout || '',
  });
}

function findRuns() {
  const home = process.env.HOME || '';
  const bases = [
    process.env.NS2_RUNS,                                  // explicit override
    path.join(process.cwd(), 'runs'),                       // ./runs
    path.join(REPO, '..', 'ns2jb-rpc', 'runs'),             // sibling checkout
    path.join(REPO, '..', 'ns2jb', 'runs'),                 // sibling upstream
    path.join(home, 'ns2jb-rpc', 'runs'),
    path.join(home, 'ns2jb', 'runs'),
  ].filter(Boolean);
  const candidates = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      const proof = path.join(dir, 'switch2', 'ro', 'root', 'current-root.json');
      if (fs.existsSync(proof)) {
        candidates.push({dir, when: fs.statSync(proof).mtimeMs});
      }
    }
  }
  return candidates.sort((a, b) => b.when - a.when).map(entry => entry.dir);
}

const rl = readline.createInterface({input: process.stdin, output: process.stdout});
let closed = false;
rl.on('close', () => { closed = true; });
// Lines are queued, not awaited one at a time: a piped script delivers every
// answer before the first question is printed, and rl.question would drop them.
const pending = [];
const waiting = [];
rl.on('line', line => {
  if (waiting.length) waiting.shift()(line);
  else pending.push(line);
});
function ask(question) {
  process.stdout.write(question);
  if (pending.length) return Promise.resolve(pending.shift().trim());
  if (closed) return Promise.resolve('');
  return new Promise(resolve => waiting.push(line => resolve(line.trim())));
}
async function askDefault(question, fallback) {
  const answer = await ask(`${question}${fallback ? ` [${fallback}]` : ''}: `);
  return answer === '' ? fallback : answer;
}
async function choose(question, options) {
  console.log('\n' + question);
  options.forEach((option, index) => console.log(`  ${index + 1}) ${option.label}`));
  for (;;) {
    const answer = await ask(`Number 1-${options.length} (blank = back): `);
    if (answer === '') return null;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
    console.log('  not a listed number');
  }
}
async function confirm(question) {
  const answer = (await ask(`${question} [y/N]: `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

// Operations are counted for the exit summary only; repeated ones are normal.
let opsThisSession = 0;
function saveOpDone() {
  opsThisSession += 1;
}

function heading(text) {
  console.log('\n' + text + '\n' + '-'.repeat(text.length));
}

async function pickSession() {
  const runs = findRuns();
  if (runs.length === 0) {
    console.log('No run folder with a promoted root was found.');
    console.log('Start the exploit first:  node run.cjs --rpc <computer-ip>');
    return null;
  }
  const chosen = await choose('Which session?', [
    {label: 'newest: ' + path.basename(runs[0]), value: runs[0]},
    ...runs.slice(1, 7).map(dir => ({label: path.basename(dir) + '   ' + dir, value: dir})),
  ]);
  return chosen ? chosen.value : null;
}

async function titleRows(session) {
  const result = run('list-apps.cjs', [session]);
  if (!result.ok) {
    console.log(result.out.trim());
    return [];
  }
  const ids = [...result.out.matchAll(/0x([0-9a-f]{16})/g)].map(match => match[1]);
  const refreshed = await titles.refresh();
  if (!titles.available()) {
    console.log('note: no title names available (titledb could not be fetched and');
    console.log('config/titles.json has no names for these ids) - showing ids only.');
    console.log('Connect once with network access, or add names to config/titles.json.');
  }
  // A partial list looks like a bug unless the gap is named. Say it once; this
  // runs every time the title list is rebuilt.
  const unnamed = titles.unnamed(ids);
  if (unnamed.length && !namesNoted) {
    namesNoted = true;
    console.log(`\nnote: ${unnamed.length} of ${ids.length} titles ` +
      `${unnamed.length === 1 ? 'has' : 'have'} no name - demos/trials and some`);
    console.log('new releases are not in titledb.');
    if (!refreshed) console.log('(titledb could not be fetched - connect once with network access for names)');
    console.log('add them to config/titles.local.json (keep any existing entries):');
    console.log('  ' + titles.namesStub(unnamed));
  }
  return ids.map(id => ({
    id,
    label: (ALLOWED.has(id.toLowerCase()) ? '✔ ' : '  ') + titles.label(id),
  }));
}

async function pickTitle(session) {
  const rows = await titleRows(session);
  if (rows.length === 0) {
    console.log('No installed applications were listed.');
    return null;
  }
  const chosen = await choose('Which title?  (✔ = write-allowed)', rows);
  return chosen ? chosen.value : null;
}

const UID_CACHE = path.join(__dirname, '..', 'config', 'uids.json');
function uidCache() {
  try { return JSON.parse(fs.readFileSync(UID_CACHE, 'utf8')); } catch { return {}; }
}
function rememberUid(title, uid) {
  const map = uidCache();
  map[title.toLowerCase()] = uid;
  try {
    fs.mkdirSync(path.dirname(UID_CACHE), {recursive: true});
    fs.writeFileSync(UID_CACHE, JSON.stringify(map, null, 2) + '\n');
  } catch { /* cache is a convenience */ }
}

// The console has a handful of users; address them by slot (1, 2, 3) rather than
// by 32 hex characters. The uid is only needed to open the archive, so the mapping
// is cached per title once chosen.
function accountSlots(session) {
  const result = run('save-pull-root.cjs', [session, '0000000000000000', '.', '--list-uids']);
  return [...new Set((result.stdout || '').split('\n').map(line => line.trim())
    .filter(line => /^[0-9a-f]{32}$/i.test(line)))];
}

const LISTED_LINE = /listed \d+ files/;
const OPEN_RESULT = /->\s*(0x[0-9a-f]+)/gi;
const MOUNTED_LINE = /mounted space=(\S+) type=(\S+) rank=(\d+) index=(\d+) uid=([0-9a-f]{16})/i;

// One read-only open of a single archive shape.
//
// The listing line is the proof that the archive really opened. A published
// save-pull-root.cjs treated every *known* flag as if it had been passed, so a
// --list-only call printed the account uids, exited 0 and listed nothing. That
// "successful" probe was read as "no save" for every title (issue #2), so a
// probe that does not list is now inconclusive - never evidence of absence.
function probeShape(session, title, uid, space, type) {
  const result = run('save-pull-root.cjs', [session, title, '.', uid, '--list-only',
    '--space', String(space), '--type', String(type)]);
  saveOpDone();
  const out = result.out || '';
  const mounted = MOUNTED_LINE.exec(out);
  return {
    ok: Boolean(result.ok && LISTED_LINE.test(out) && mounted),
    out,
    archive: mounted ? {
      space: mounted[1],
      type: mounted[2],
      rank: Number(mounted[3]),
      index: Number(mounted[4]),
      uid: mounted[5].toLowerCase(),
    } : null,
  };
}

function describeArchive(archive) {
  return `space=${archive.space} type=${archive.type}` +
    (archive.rank ? ` rank=${archive.rank}` : '') +
    (archive.index ? ` index=${archive.index}` : '');
}

// Which accounts actually have an archive for this title? A read-only listing
// answers that, so the prompt only offers users that can be downloaded and is
// skipped entirely when there is exactly one.
//
// A normal title keeps one Account archive per user, so probe exactly that shape
// for one account, one space at a time. The puller's own sweep is up to 20 opens
// per account and a long sweep is what wedges the console (docs/RESULTS.md); it
// used to run once per account here, before any save had been found. Two
// targeted probes (User then SdUser) are at most four opens.
// A User/Account probe also matches the common uid-0 archive. That archive is
// shared by every user, so it is reported separately rather than as this
// account's save.
function probeAccountSave(session, title, uid) {
  const attempts = [];
  let shared = null;
  for (const space of [1, 4]) {
    const probe = probeShape(session, title, uid, space, 1);
    attempts.push(probe);
    if (!probe.ok) continue;
    if (probe.archive.uid === uid.slice(0, 16).toLowerCase()) {
      return {found: probe, shared: null, attempts};
    }
    shared ||= probe;
  }
  return {found: null, shared, attempts};
}

// The other archives a title can own - Device, Bcat, Cache, Temporary - all use
// uid 0 (the zero attribute). They are not per-account, so scan them once per
// title rather than once per user. This is what finds titles like Sports Resort,
// whose only archive is User/Device.
const SHARED_TYPES = [3, 2, 5, 4];
function probeSharedSave(session, title, uid) {
  const attempts = [];
  for (const space of [1, 4]) {
    for (const type of SHARED_TYPES) {
      const probe = probeShape(session, title, uid, space, type);
      attempts.push(probe);
      if (probe.ok) return {found: probe, attempts};
    }
  }
  return {found: null, attempts};
}

// What the failed probes actually said. 0x7d402 is the console's "no save
// data". Anything else - 0xe02 when the running title holds the save, a timeout,
// or no answer at all - must not be reported as an absent save.
function probeVerdict(attempts) {
  const codes = [];
  let silent = 0;
  for (const attempt of attempts) {
    const found = [...(attempt.out || '').matchAll(OPEN_RESULT)].map(match => match[1].toLowerCase());
    if (found.length) codes.push(...found);
    else if ((attempt.out || '').trim()) silent += 1;
  }
  const distinct = [...new Set(codes)];
  return {distinct, silent,
    absent: codes.length > 0 && silent === 0 && distinct.every(code => code === '0x7d402')};
}

function explainNoSave(title, attempts) {
  const verdict = probeVerdict(attempts);
  if (verdict.absent) {
    console.log('\nno save data for this title on any account (0x7d402) - nothing to pull.');
    console.log('A title has no archive until it has run once: launch it, close it fully');
    console.log('(Home -> X -> Close), then retry in a new session.');
    return;
  }
  console.log('\ncould not tell whether ' + titles.label(title) + ' has save data:');
  if (verdict.distinct.length) {
    console.log('  the console answered ' + verdict.distinct.join(', ') +
      ' instead of opening an archive.');
  }
  if (verdict.silent) {
    console.log('  ' + verdict.silent + ' probe(s) exited without listing anything. A probe');
    console.log('  that never listed is a tool problem, not an absent save; the published');
    console.log('  save-pull-root.cjs used to do exactly this (issue #2).');
    const failed = attempts.map(attempt => attempt.out || '').join('\n').split('\n')
      .map(line => line.trim()).filter(line => /^FAILED:/.test(line)).pop();
    if (failed) console.log('  ' + failed);
  }
  if (verdict.distinct.includes('0xe02')) {
    console.log('  hint: 0xe02 means the running title holds its save - close it fully');
    console.log('        (Home -> X -> Close), then retry.');
  } else if (verdict.silent) {
    console.log('  hint: update the tools, or apply patches/apply.sh and start a new run.');
  }
  console.log('  the save was not touched.');
}

async function pickUid(session, title) {
  const cache = uidCache();
  const slots = accountSlots(session);
  if (slots.length === 0) {
    console.log('Could not list the console\'s users; enter the uid by hand once.');
    const typed = await askDefault('account uid (32 hex chars)');
    if (!typed) return null;
    rememberUid(title, typed);
    return typed;
  }

  // One targeted probe per account. Only when no account has its own archive
  // does the shared (Device/Bcat/Cache/Temporary) scan run, so an empty account
  // costs two probes (up to four opens) instead of a 20-open sweep.
  const found = [];
  const attempts = [];
  let shared = null;
  for (let i = 0; i < slots.length; i++) {
    const probe = probeAccountSave(session, title, slots[i]);
    attempts.push(...probe.attempts);
    if (probe.found) found.push({index: i + 1, uid: slots[i]});
    else if (probe.shared && !shared) shared = probe.shared;
  }

  if (found.length === 0) {
    if (!shared) {
      const scan = probeSharedSave(session, title, slots[0]);
      attempts.push(...scan.attempts);
      shared = scan.found;
    }
    if (shared) {
      console.log('\nsave found: ' + describeArchive(shared.archive) +
        ' - a shared archive, not tied to one account');
      rememberUid(title, slots[0]);
      return slots[0];
    }
    explainNoSave(title, attempts);
    return null;
  }
  if (found.length === 1) {
    const uid = found[0].uid;
    console.log('\nsave found for user ' + found[0].index + ' (' + uid.slice(0, 8) + '…' + uid.slice(-4) + ')');
    rememberUid(title, uid);
    return uid;
  }
  const options = found.map(entry => ({
    label: 'user ' + entry.index + '   ' + entry.uid.slice(0, 8) + '…' + entry.uid.slice(-4),
    value: entry.uid,
  }));
  options.push({label: 'all of the above (one folder per user)', value: 'all'});
  const cached = cache[title.toLowerCase()];
  if (cached && found.some(entry => entry.uid === cached)) {
    console.log('\nsaves found for ' + found.length + ' users; last used: ' + cached);
  } else {
    console.log('\nsaves found for ' + found.length + ' users');
  }
  const chosen = await choose('Which save do you want?', options);
  const uid = chosen ? chosen.value : found[0].uid;
  if (uid !== 'all') rememberUid(title, uid);
  return uid;
}

async function doBackup(session, title, uid) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  if (uid === 'all') {
    const slots = accountSlots(session);
    const made = [];
    for (let i = 0; i < slots.length; i++) {
      const dir = path.join(REPO, 'saves', titles.slug(title),
        'user-' + slots[i].slice(0, 8), stamp);
      console.log(`\nuser ${i + 1} of ${slots.length}: probing first (read-only listing)`);
      // Probe: a listing that succeeds proves this account has an archive here,
      // so only accounts that actually have one get pulled. Targeted, because
      // "all" is chosen from accounts that already listed, and the sweep is the
      // expensive part that wedges a session.
      const probe = probeAccountSave(session, title, slots[i]);
      if (!probe.found) {
        console.log('  no save for this user - skipped');
        continue;
      }
      echoCommand('node tools/save-pull-root.cjs ' + [session, title, dir, slots[i]].map(quote).join(' '));
      const result = run('save-pull-root.cjs', [session, title, dir, slots[i]], {stdio: 'inherit'});
      if (result.ok) made.push(dir);
      else console.log('  pull failed (the session may have dropped)');
      saveOpDone();
    }
    return made[0] || null;
  }
  // saves/<Game>/<user>/<timestamp> - no prompt, and every pull is kept.
  const userTag = 'user-' + uid.slice(0, 8);
  const dir = path.join(REPO, 'saves', titles.slug(title), userTag, stamp);
  console.log('pulling into ' + path.relative(REPO, dir));
  const pullArgs = [session, title, dir, uid];
  echoCommand('node tools/save-pull-root.cjs ' + pullArgs.map(quote).join(' '));
  const result = run('save-pull-root.cjs', pullArgs, {stdio: 'inherit'});
  if (!result.ok) {
    console.log('\npull failed - see the message above');
    return null;
  }
  console.log('\nbackup: ' + dir);
  saveOpDone();
  return dir;
}

async function writeFiles(session, title, uid, backup, manifest) {
  if (!manifest || !fs.existsSync(manifest)) {
    console.log('no such manifest: ' + manifest);
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  heading('about to write ' + parsed.files.length + ' file(s) into ' + title);
  for (const file of parsed.files) {
    console.log(`  ${file.path}${file.replace ? '   (replace, verified)' : '   (add)'}`);
  }
  if (!(await confirm('Proceed? This commits one transaction'))) return;
  const writeArgs = [session, title, uid, backup, manifest];
  echoCommand('node tools/save-write-stage.cjs ' + writeArgs.map(quote).join(' '));
  const result = run('save-write-stage.cjs', writeArgs, {stdio: 'inherit'});
  console.log(result.ok ? '\ncommitted' : '\nwrite failed - see the message above');
  saveOpDone();
  if (result.ok) console.log('\nDone. Option 7 verifies it against the console.');
}

async function writeManifest(session, title, uid, backup) {
  const manifest = await askDefault('Manifest to write (built with build-editor-manifest.py or build-untethered.sh)');
  if (!manifest) return;
  await writeFiles(session, title, uid, backup, manifest);
}

async function doDelete(session, title, uid) {
  const target = await askDefault('File to delete at the save root (e.g. /save9999.dat)');
  if (!target) return;
  if (!(await confirm('Delete ' + target + ' from ' + title))) return;
  const deleteArgs = [session, title, uid, target];
  echoCommand('node tools/save-delete-root.cjs ' + deleteArgs.map(quote).join(' '));
  const result = run('save-delete-root.cjs', deleteArgs, {stdio: 'inherit'});
  console.log(result.ok ? '\ndeleted' : '\ndelete failed');
  saveOpDone();
}

async function installLauncher(session, title, uid, backup) {
  if (!backup) {
    console.log('No backup yet: pulling one now (the launcher is built from it).');
    backup = await doBackup(session, title, uid);
    if (!backup) return;
  }
  const editor = fs.existsSync(path.join(backup, 'ssedit1.lua')) ||
                 fs.existsSync(path.join(backup, 'sed01.asb'));
  if (!editor) {
    console.log('note: the Seedsow Lua Editor is not in this save. The launcher still works');
    console.log('(the stub falls back to ns2jb.lua), but for on-console authoring install the');
    console.log('editor FIRST (option 5), then this - its install rewrites slot 4.');
  }
  const out = path.join(REPO, 'staging', path.basename(backup));
  echoCommand('tools/build-untethered.sh ' + quote(backup) + ' ' + quote(out));
  const built = spawnSync('/bin/sh', [path.join(TOOLS, 'build-untethered.sh'), backup, out], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, path.join(out, 'manifest.json'));
}

async function installEditor(session, title, uid, backup) {
  if (!backup) {
    console.log('No backup yet: pulling one now, then writing the editor save.');
    backup = await doBackup(session, title, uid);
    if (!backup) return;
  }
  if (fs.existsSync(path.join(backup, 'ns2jb.asb'))) {
    console.log('note: payload files are already installed. The editor install rewrites slot 4,');
    console.log('so the stub would then run the editor example - re-run the payload install');
    console.log('(option 4) after this to claim slot 4 again.');
  }
  const cache = path.join(require('node:os').homedir(), '.cache', 'ns2-savekit', 'seedsow-editor');
  const source = await askDefault('Directory with the editor save (blank = fetch it for me)', cache);
  const present = fs.existsSync(source) && fs.readdirSync(source).some(n => !n.startsWith('.'));
  if (!present) {
    console.log('\nno editor save at ' + source + ' - fetching the official release (0BSD):');
    echoCommand('tools/fetch-editor-save.sh ' + quote(source));
    const fetched = spawnSync('/bin/sh', [path.join(TOOLS, 'fetch-editor-save.sh'), source],
      {encoding: 'utf8', stdio: 'inherit'});
    if (fetched.status !== 0) {
      console.log('fetch failed - check the network, or point the action at a directory you already have.');
      return;
    }
  }
  const manifest = path.join(REPO, 'staging', 'editor-manifest.json');
  fs.mkdirSync(path.dirname(manifest), {recursive: true});
  const built = spawnSync('python3', [path.join(TOOLS, 'build-editor-manifest.py'), source, backup, manifest], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, manifest);
}

async function verifyAgainst(session, title, uid, backup) {

  // Compare against the newest backup this tool made for the same game and user.
  const root = path.join(REPO, 'saves', titles.slug(title), 'user-' + uid.slice(0, 8));
  const staged = fs.existsSync(root)
    ? path.join(root, fs.readdirSync(root).sort().filter(name => fs.statSync(path.join(root, name)).isDirectory()).pop() || '')
    : '';
  console.log('verifying against ' + (staged || '(no backup yet)'));
  if (!staged || !fs.existsSync(staged)) {
    console.log('no such directory: ' + staged);
    return;
  }
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'verify-'));
  const pullArgs = [session, title, temp, uid];
  echoCommand('node tools/save-pull-root.cjs ' + pullArgs.map(quote).join(' '));
  const pulled = run('save-pull-root.cjs', pullArgs, {stdio: 'inherit'});
  if (!pulled.ok) {
    console.log('\npull failed - retry, and restart the console if it keeps failing.');
    return;
  }
  saveOpDone();
  let ok = 0, bad = 0;
  for (const name of fs.readdirSync(staged)) {
    const local = path.join(staged, name);
    if (!fs.statSync(local).isFile()) continue;
    const remote = path.join(temp, name);
    if (!fs.existsSync(remote)) { console.log('  missing in save: ' + name); bad++; continue; }
    const same = fs.readFileSync(local).equals(fs.readFileSync(remote));
    console.log('  ' + (same ? 'ok      ' : 'DIFFERS ') + name);
    same ? ok++ : bad++;
  }
  console.log(`\nverify: ${ok} matching, ${bad} differing or missing`);
}

async function replaceFromDirectory(session, title, uid, backup) {
  if (!backup) {
    console.log('Back this save up first (option 2): the write checks live bytes against it.');
    return;
  }
  const source = await askDefault('Directory holding the files to install (e.g. a save backup or /tmp/seed)');
  if (!source || !fs.existsSync(source)) {
    console.log('no such directory: ' + source);
    return;
  }
  const manifest = path.join(REPO, 'staging', path.basename(source) + '-manifest.json');
  fs.mkdirSync(path.dirname(manifest), {recursive: true});
  echoCommand('python3 tools/build-editor-manifest.py ' + quote(source) + ' ' + quote(backup) +
    ' ' + quote(manifest));
  const built = spawnSync('python3',
    [path.join(TOOLS, 'build-editor-manifest.py'), source, backup, manifest], {encoding: 'utf8'});
  console.log((built.stdout || '') + (built.stderr || ''));
  if (built.status !== 0) return;
  await writeFiles(session, title, uid, backup, manifest);
}

// Artemis saves are recognised by their own file names, which the listing has
// already shown once: system.dat/saveg.dat (BOWX/BOWG) plus the slot files.
const ARTEMIS_FILES = /\/(system\.dat|saveg\.dat|save[0-9]{4}\.dat)$/im;

// 'all' only makes sense for a backup. Any other action needs one account, so it
// resolves to the first account that actually has a save - never to the literal
// string 'all', which used to be passed to the puller as if it were a uid.
async function resolveOne(session, title, uid) {
  if (uid !== 'all') return uid;
  const slots = accountSlots(session);
  for (const slot of slots) {
    const probe = probeAccountSave(session, title, slot);
    if (probe.found) {
      console.log('using user ' + slot.slice(0, 8) + '…' + slot.slice(-4) + ' for this action');
      return slot;
    }
  }
  if (slots.length) {
    const scan = probeSharedSave(session, title, slots[0]);
    if (scan.found) {
      console.log('using the shared ' + describeArchive(scan.found.archive) + ' archive');
      return slots[0];
    }
  }
  return slots[0];
}

async function titleLoop(session, title, uid) {
  let backup = null;
  let artemis = false;
  {
    // 'all' is not a uid: look for the first account that actually has a save.
    // Using slot 1 blindly hid the Artemis actions when that account was empty.
    const candidates = uid === 'all' ? accountSlots(session) : [uid];
    let listing = '';
    let common = '';
    for (const candidate of candidates) {
      if (!candidate) continue;
      const account = probeAccountSave(session, title, candidate);
      if (account.found) {
        listing = account.found.out;
        break;
      }
      common ||= (account.shared || {}).out || '';
    }
    if (!listing) listing = common;
    if (!listing && candidates.some(Boolean)) {
      const scan = probeSharedSave(session, title, candidates.find(Boolean));
      if (scan.found) listing = scan.found.out;
    }
    artemis = ARTEMIS_FILES.test(listing);
  }
  for (;;) {
    const items = [
      {label: 'List files in this save (read-only)      [save op]', value: 'list'},
      {label: 'Save: back this save up                     [save op]', value: 'backup'},
      {label: 'Replace: write files from a directory        [save op]', value: 'replace'},
    ];
    if (artemis) {
      items.push(
        {label: 'Install payload files (Artemis launcher)     [save op]', value: 'launcher'},
        {label: 'Install the Seedsow Lua Editor save          [save op]', value: 'editor'});
    }
    items.push(
      {label: 'Delete a file (optional)                     [save op]', value: 'delete'},
      {label: 'Verify: compare the save with what we wrote  [save op]', value: 'verify'},
      {label: 'Back to the title list', value: 'back'});
    const task = await choose(titles.label(title) +
      (artemis ? '\n  Artemis save detected' : '\n  no Artemis files in this save') +
      '\n  (each entry opens the save once; several in a row usually work - restart if one fails)', items);
    if (closed || !task || task.value === 'back') return;
    if (uid === 'all' && task.value !== 'backup') {
      const resolved = await resolveOne(session, title, uid);
      if (!resolved) return;
      uid = resolved;
    }
    if (task.value === 'list') {
      const listArgs = [session, title, '.', uid, '--list-only'];
      echoCommand('node tools/save-pull-root.cjs ' + listArgs.map(quote).join(' '));
      const listed = run('save-pull-root.cjs', listArgs, {stdio: 'inherit'});
      if (!listed.ok) {
        console.log('\nlisting failed - retry, or restart the console if it keeps failing.');
      } else {
        saveOpDone();
      }
    } else if (task.value === 'backup') {
      const dir = await doBackup(session, title, uid);
      if (dir) backup = dir;
    } else if (task.value === 'replace') {
      await replaceFromDirectory(session, title, uid, backup);
    } else if (task.value === 'launcher') {
      await installLauncher(session, title, uid, backup);
    } else if (task.value === 'editor') {
      await installEditor(session, title, uid, backup);
    } else if (task.value === 'delete') {
      await doDelete(session, title, uid);
    } else if (task.value === 'verify') {
      await verifyAgainst(session, title, uid, backup);
    }
  }
}

async function main() {
  console.log('ns2-savekit - guided save data access for Switch 2');
  console.log(NOTICE + '\n');
  const explicit = process.argv[2];
  let session = explicit ? path.resolve(explicit) : await pickSession();
  if (!session) return;
  console.log('session: ' + session + '\n');

  for (;;) {
    const rows = await titleRows(session);
    if (rows.length === 0) {
      console.log('no titles listed - is the session still live?');
      console.log('check with: node rpc.cjs ' + session + ' status');
      break;
    }
    heading(rows.length + ' installed applications  (✔ = write-allowed)');
    rows.forEach((row, index) => console.log('  [' + (index + 1) + '] ' + row.label));
    const picked = await ask('\nNumber 1-' + rows.length +
      '  (i = save inventory, blank = quit): ');
    if (closed || picked === '') break;
    if (picked.toLowerCase() === 'i') {
      // The inventory is the read-only overview: every archive, every account,
      // with size and state, before anything is pulled.
      echoCommand('node tools/inventory.cjs ' + quote(session));
      run('inventory.cjs', [session], {stdio: 'inherit'});
      continue;
    }
    const index = Number(picked) - 1;
    if (!Number.isInteger(index) || !rows[index]) {
      console.log('  not a listed number');
      continue;
    }
    const title = rows[index].id;
    const uid = await pickUid(session, title);
    if (!uid) continue;
    await titleLoop(session, title, uid);
  }
  rl.close();
  console.log('\ndone (' + opsThisSession + ' save operation(s)). Keep SmileBASIC open while a session is held.');
}

main().catch(error => {
  rl.close();
  console.error('FAILED: ' + error.message);
  process.exitCode = 1;
});
