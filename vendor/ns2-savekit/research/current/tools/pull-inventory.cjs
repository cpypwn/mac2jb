#!/usr/bin/env node
// Pull save archives from a save-inventory JSON, without NCM or titledb.
//
//   node pull-inventory.cjs <run-directory> <output-directory>
//        [--inventory PATH] [--space N] [--type N ...] [--all-types]
//        [--only ID ...] [--limit N] [--dry-run]
//
// The inventory already knows the exact archive identity (space, type, uid,
// application id), so no application list, no attribute sweep and no per-title
// probing is needed. This is the NCM-independent pull path.
//
// BATCHES BY DEFAULT (up to 5). Finding an archive in the inventory does not make
// opening it cheaper, but one boot has taken six opens without a wedge
// (docs/RESULTS.md), so the default is a small batch. It stops at the first
// session loss, and --limit 0 pulls every pending archive. Progress lives in
// <output>/inventory-progress.json, so after a reboot the next run continues with
// the next archive instead of starting over.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const titles = require('./lib/titles.cjs');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');
const TYPES = {1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary', 5: 'Cache'};

function take(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    out.push(argv[i + 1]);
    argv.splice(i, 2);
    i--;
  }
  return out;
}

function newestInventory() {
  const dir = path.join(ROOT, 'saves');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^inventory-.*\.json$/.test(f)); } catch { /* none */ }
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files.at(-1));
}

async function main() {
  let argv = process.argv.slice(2);
  const inventoryAt = take(argv, '--inventory')[0] || newestInventory();
  const space = Number(take(argv, '--space')[0] ?? 1);
  const types = take(argv, '--type').map(Number);
  const allTypes = argv.includes('--all-types');
  argv = argv.filter(a => a !== '--all-types');
  const limitAt = take(argv, '--limit')[0];
  // Batch by default: multiple opens per boot are proven on hardware. 0 = all.
  const limit = limitAt === undefined ? 5 : Math.max(0, Number(limitAt) || 0);
  const only = take(argv, '--only').map(String);
  const dryRun = argv.includes('--dry-run');
  argv = argv.filter(a => a !== '--dry-run');
  const [runDirectory, outputDirectory] = argv;
  if (!runDirectory || !outputDirectory) {
    console.error('usage: node pull-inventory.cjs <run-directory> <output-directory> ' +
      '[--inventory PATH] [--space N] [--type N ...] [--all-types] [--only ID ...] ' +
      '[--limit N (0 = all; default 5)] [--dry-run]');
    process.exit(2);
  }
  if (!inventoryAt) {
    console.error('no inventory JSON found; run tools/save-inventory.cjs --json <path> first');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const output = path.resolve(outputDirectory);
  const inventory = JSON.parse(await fsp.readFile(inventoryAt, 'utf8'));
  const wanted = allTypes ? [1, 2, 3, 4, 5] : (types.length ? types : [1]);
  const entries = (inventory.entries || []).filter(e =>
    Number(e.space) === space && wanted.includes(Number(e.type)) &&
    BigInt(e.applicationId) !== 0n &&
    (!only.length || only.includes(String(e.id)) ||
      only.includes(e.applicationId) || only.includes(e.applicationId.replace(/^0x/i, ''))));
  entries.sort((a, b) => Number(a.size) - Number(b.size));

  await fsp.mkdir(output, {recursive: true});
  const progressFile = path.join(output, 'inventory-progress.json');
  let progress = {done: [], absent: [], failed: []};
  try { progress = JSON.parse(await fsp.readFile(progressFile, 'utf8')); } catch { /* first run */ }
  progress.done ||= []; progress.absent ||= []; progress.failed ||= [];
  const key = e => `${e.space}:${e.type}:${e.uid}:${e.applicationId}:${e.id}`;
  const pending = entries.filter(e =>
    !progress.done.includes(key(e)) && !progress.absent.includes(key(e)));

  console.log(`inventory: ${inventoryAt}`);
  console.log(`${entries.length} archive(s) in space ${space} ` +
    `(${wanted.map(t => TYPES[t] || t).join(', ')}); ${pending.length} pending`);
  if (!pending.length) {
    console.log('nothing pending - every matching archive has a result');
    return;
  }
  const queue = limit > 0 ? pending.slice(0, limit) : pending;
  if (dryRun) {
    for (const e of queue) {
      console.log(`  would pull ${e.applicationId} ${TYPES[e.type] || e.type} ` +
        `uid=${e.uid.slice(0, 16)} id=${e.id} size=${e.size} -> ${folderFor(e)}`);
    }
    return;
  }

  let pulled = 0, empty = 0, absent = 0, lost = false;
  for (const entry of queue) {
    const folder = path.join(output, folderFor(entry));
    const args = [path.join(TOOLS, 'save-pull-root.cjs'), run, entry.applicationId, folder];
    if (BigInt('0x' + entry.uid) !== 0n) args.push(entry.uid);
    args.push('--space', String(entry.space), '--type', String(entry.type));
    // Cache is the one type whose index is commonly non-zero. Only trust the
    // decoded rank/index there until the other types are verified.
    if (Number(entry.type) === 5) {
      if (Number(entry.rank)) args.push('--rank', String(entry.rank));
      if (Number(entry.index)) args.push('--index', String(entry.index));
    }
    console.log(`\npulling ${titles.label(entry.applicationId)} ` +
      `${TYPES[entry.type] || entry.type} ${entry.size} bytes -> ${folder}`);
    const result = spawnSync(process.execPath, args,
      {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    const out = (result.stdout || '').trim();
    const err = (result.stderr || '').trim();
    const combined = out + '\n' + err;
    if (out) console.log(out.split('\n').slice(-4).join('\n'));
    if (err) console.log(err.split('\n').slice(-4).join('\n'));

    // save-pull-root prints its "done:" line on stderr, not stdout.
    if (result.status === 0 && /^done:/m.test(combined)) {
      const files = Number((combined.match(/done:\s*(\d+)\s*files/) || [])[1] || 0);
      pulled++;
      if (files === 0) {
        empty++;
        console.log('empty archive: the save exists but has no files (recorded)');
      }
      progress.done.push(key(entry));
      progress.failed = progress.failed.filter(f => f.key !== key(entry));
    } else if (Number(entry.type) !== 5 && /0xe02\b|TargetLocked/i.test(combined)) {
      // The app hosting the exploit holds its own save (SmileBASIC 4 here), so
      // the read-only open returns TargetLocked. It is not absent; retry after a
      // host change.
      fail(progress, key(entry), 'save locked by the running application (0xe02)');
      console.log('save is locked by the running app (0xe02); recorded for a retry');
    } else if (/No save filesystem opened|0x7d402/i.test(combined)) {
      if (Number(entry.type) === 5) {
        // The index listed the archive, so a Cache miss is an attribute problem
        // (rank/index), not an absent archive. Do not mark it absent.
        fail(progress, key(entry), 'cache open missed at the decoded rank/index');
        console.log('cache archive exists but did not open; recorded for a retry');
      } else {
        absent++;
        progress.absent.push(key(entry));
        console.log('no save filesystem for this entry (recorded absent)');
      }
    } else if (/SESSION LOST|timed out|closed the session|not ready|ECONNREFUSED/i.test(combined)) {
      fail(progress, key(entry), 'session lost');
      lost = true;
      console.log('session lost - stopping so the console can be restarted');
    } else {
      fail(progress, key(entry), (err || out).slice(0, 300));
      console.log('pull failed for this entry; recorded for a retry');
    }
    await fsp.writeFile(progressFile, JSON.stringify(progress, null, 2) + '\n');
    if (lost) break;
  }

  const left = pending.length - pulled - absent;
  console.log(`\n${pulled} pulled this run${empty ? ` (${empty} empty)` : ''}; ` +
    `${Math.max(0, left)} still pending.`);
  console.log(lost
    ? 'Reboot the console, acquire a new session, then run this command again.'
    : 'Default batch is up to 5 per run; --limit 0 pulls every pending archive.');
}

// Keep one row per archive; a retry must replace the previous failure, not add.
function fail(progress, key, error) {
  progress.failed = progress.failed.filter(f => f.key !== key);
  progress.failed.push({key, error, at: new Date().toISOString()});
}

function folderFor(entry) {
  return `${titles.slug(entry.applicationId)}-space${entry.space}-type${entry.type}-id${entry.id}`;
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
