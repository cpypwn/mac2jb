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
// Enumeration uses ns: (the installed-application list) because fs:srv's
// save-data info reader is refused in this context: commands 60, 61 and 68 all
// answer 0x320002 on every save-data space, while 62 (cache storage) works. See
// tools/probe-info-reader.cjs for that evidence.
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
  const batchIndex = argv.indexOf('--batch');
  const batch = batchIndex >= 0 ? Math.max(1, Number(argv[batchIndex + 1])) : 1;
  if (batchIndex >= 0) argv.splice(batchIndex, 2);
  argv = argv.filter(a => a !== '--cache');
  const [runDirectory, outputDirectory, forcedUid] = argv;
  if (!runDirectory || !outputDirectory) {
    console.error('usage: node pull-all.cjs <run-directory> <output-directory> [uid-hex] [--cache]');
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
  for (const appId of queue) {
    const folder = path.join(output, titles.slug(appId));
    console.log(`\nnext: ${titles.label(appId)} -> ${folder}`);
    let pulled = false, exitCode = 0, absent = false;
    for (const uid of (uids.length ? uids : [''])) {
      const args = [run, appId, folder];
      if (uid) args.push(uid);
      const result = spawnSync(process.execPath, [path.join(TOOLS, 'save-pull-root.cjs'), ...args],
        {capture: true, encoding: 'utf8'});
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      exitCode = result.status;
      if (result.status === 0) { pulled = true; break; }
      // "no save filesystem opened" is a benign absence, not a dropped session.
      if ((result.stderr || '').includes('No save filesystem opened')) absent = true;
    }
    if (pulled) {
      progress.done.push(appId);
      console.log(`pulled ${progress.done.length}/${apps.length}`);
    } else {
      progress.absent.push(appId);
      console.log('no save data for this application (0x7d402 for every account/space/type)');
    }
    await fsp.writeFile(progressFile, JSON.stringify(progress, null, 2) + '\n');
    if (!pulled && !absent && exitCode !== 0) {
      console.log('stopping the batch: that failure is the one that can take the host down');
      break;
    }
  }
  const left = apps.length - progress.done.length - progress.absent.length;
  console.log(left === 0
    ? 'done: restart the console once more if --cache is still to collect'
    : `restart the console, then run again for the next of ${left} remaining`);
  if (wantCache) {
    console.log('--cache: cache storage is enumerable (fs:srv cmd 62) but not yet pullable;');
    console.log('   run tools/probe-info-reader.cjs to see the one archive it reports.');
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
