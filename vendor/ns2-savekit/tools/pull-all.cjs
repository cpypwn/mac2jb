#!/usr/bin/env node
// Pull one save archive per session, for every installed application.
//
//   node pull-all.cjs <run-directory> <output-directory> [uid-hex] [--batch N] [--cache]
//
// --batch N tries up to N archives in one boot instead of one. Opening a save
// filesystem is what crashes the host, so a batch stops at the first failure and
// the progress file keeps whatever succeeded: a batch can only ever save you
// reboots, never lose an archive.
//
// Enumeration uses ns: (the installed-application list). That list is not the
// whole store: a cartridge title can vanish from it while its save stays in
// system memory. The save-data info reader DOES work on the promoted root (see
// save-inventory.cjs); this tool predates it and only pulls the installed set.
// To include cartridge-only saves, run save-inventory.cjs first and pull the
// app ids it lists.
//
// Saving one archive per boot is deliberate: opening a save filesystem is the
// operation that crashes the host often enough that a single boot is the safe
// unit. Progress lives in <output-directory>/progress.json, so a restart
// continues with the next application instead of starting over.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const titles = require('./lib/titles.cjs');

const TOOLS = __dirname;

function runTool(script, args) {
  return spawnSync(process.execPath, [path.join(TOOLS, script), ...args], {encoding: 'utf8'});
}

function installedApplications(run) {
  const result = runTool('list-apps.cjs', [run]);
  const ids = [...(result.stdout || '').matchAll(/0x([0-9a-f]{16})/g)].map(m => m[1]);
  return [...new Set(ids)];
}

function accountUids(run) {
  const result = runTool('save-pull-root.cjs', [run, '0000000000000000', '.', '--list-uids']);
  return [...new Set((result.stdout || '').split('\n').map(s => s.trim())
    .filter(s => /^[0-9a-f]{32}$/i.test(s)))];
}

async function main() {
  let argv = process.argv.slice(2);
  const wantCache = argv.includes('--cache');
  // Targeted first open: the pull tool's space/type sweep is up to 60 opens and is
  // what wedges a session, so try one combination first and only sweep if it finds
  // nothing. The indexes must be re-found after each splice (computing both up front
  // made --type read the wrong element and the pull fail with "--type needs a number").
  const take = name => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv.splice(at, 2)[1] : null;
  };
  const onlySpace = take('--space');
  const onlyType = take('--type');
  const batchIndex = argv.indexOf('--batch');
  const batch = batchIndex >= 0 ? Math.max(1, Number(argv[batchIndex + 1])) : 1;
  if (batchIndex >= 0) argv.splice(batchIndex, 2);
  argv = argv.filter(a => a !== '--cache');
  const [runDirectory, outputDirectory, forcedUid] = argv;
  if (!runDirectory || !outputDirectory) {
    console.error('usage: node pull-all.cjs <run-directory> <output-directory> [uid-hex] ' +
      '[--batch N] [--space N --type N] [--cache]');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const output = path.resolve(outputDirectory);
  await fsp.mkdir(output, {recursive: true});
  const progressFile = path.join(output, 'progress.json');
  let progress = {done: [], absent: []};
  try { progress = JSON.parse(await fsp.readFile(progressFile, 'utf8')); } catch { /* first run */ }
  progress.done ||= [];
  progress.absent ||= [];

  const apps = installedApplications(run);
  if (apps.length === 0) throw Error('no installed applications listed - is the session live?');
  const uids = forcedUid ? [forcedUid] : accountUids(run);
  await titles.refresh();
  console.log(`${apps.length} installed applications, ${uids.length} account uid(s)`);

  const pending = apps.filter(id => !progress.done.includes(id) && !progress.absent.includes(id));
  if (pending.length === 0) {
    console.log('every application has been handled; nothing left to pull');
    return;
  }
  const queue = pending.slice(0, batch);
  console.log(batch === 1
    ? 'one archive this session; restart the console afterwards'
    : `batch mode: up to ${batch} archives this session, stopping at the first failure`);
  const targeted = [onlySpace ?? '1', onlyType ?? '1'];
  for (const appId of queue) {
    const folder = path.join(output, titles.slug(appId));
    console.log(`\nnext: ${titles.label(appId)} -> ${folder}`);
    let pulled = false, combination = null, absent = false, lost = false;
    // Attempt 1: the targeted combination. Attempt 2: let the pull tool sweep, which
    // discovers titles whose save is not User/Account (SmileBASIC retail keeps a Device
    // save, and the title hosting the exploit answers 0xe02 because it holds the save).
    // Record whichever combination opened, because that is the generalisation question.
    for (const attempt of [[...targeted], null]) {
      for (const uid of (uids.length ? uids : [''])) {
        const args = [run, appId, folder];
        if (uid) args.push(uid);
        if (attempt) args.push('--space', attempt[0], '--type', attempt[1]);
        const result = spawnSync(process.execPath, [path.join(TOOLS, 'save-pull-root.cjs'), ...args],
          {capture: true, encoding: 'utf8'});
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        const err = result.stderr || '';
        const mounted = err.match(/mounted (space=\S+ type=\S+)/);
        if (result.status === 0 && !/^listed /m.test(result.stdout || '')) {
          pulled = true;
          combination = mounted ? mounted[1] : 'unknown';
          break;
        }
        // A dropped session is the only thing worth stopping for: it is the failure that
        // takes the host down. "No save data" is a benign absence and the batch
        // continues; anything else is treated as a real error for this title only.
        if (/SESSION LOST|timed out|closed the session|not ready/i.test(err)) { lost = true; break; }
        absent = /No save filesystem opened|0x7d402/.test(err);
        if (!absent) break;
      }
      if (pulled || lost || !absent) break;
      absent = false;                          // try the sweep for this title
    }
    if (pulled) {
      progress.done.push(appId);
      (progress.combinations ||= {})[appId] = combination || 'unknown';
      console.log(`pulled ${progress.done.length}/${apps.length} (${combination})`);
    } else if (lost) {
      console.log('session lost - stopping so the console can be restarted');
    } else {
      progress.absent.push(appId);
      console.log('no save data for this application (0x7d402 on every space/type tried)');
    }
    await fsp.writeFile(progressFile, JSON.stringify(progress, null, 2) + '\n');
    if (lost) break;
  }
  const left = apps.length - progress.done.length - progress.absent.length;
  console.log(left === 0
    ? 'done: restart the console once more if --cache is still to collect'
    : `restart the console, then run again for the next of ${left} remaining`);
  if (wantCache) {
    console.log('--cache: cache storage is enumerable (fs:srv cmd 62) but not yet pullable;');
    console.log("   run ns2-console's tools/probe-info-reader.cjs to see the one archive it reports.");
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
