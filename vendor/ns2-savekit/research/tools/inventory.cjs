#!/usr/bin/env node
// Which titles have save data, for which accounts, and how big.
//
//   node inventory.cjs <run-directory> [uid-hex ...]
//
// Probes every installed application against every account with a read-only
// listing. Nothing is downloaded and nothing is written. Sorted by size, because
// the directory API gives names and sizes but no timestamps: the save-extra-data
// command that carries them needs a save id from the save-info reader, which this
// context is denied (see RESULTS.md).
//
// Failures name the half that failed (applications or accounts) and pass the
// child's own stderr through: the common causes (unpatched engine, stale run
// folder, no live host) are invisible in the child's stdout.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const titles = require('./lib/titles.cjs');

const TOOLS = __dirname;
const run = (script, args) => spawnSync(process.execPath, [path.join(TOOLS, script), ...args],
  {encoding: 'utf8'});

// Map the error text the children emit to the fix, not to the console. Keep in
// step with docs/PATCHED-ENGINE.md.
function hint(text) {
  if (/ncm-system-programs|EEXIST/.test(text))
    return 'the ns2jb engine is unpatched - run patches/apply.sh, then start a new run (docs/PATCHED-ENGINE.md)';
  if (/ListAllUsers/.test(text) && /0xf601/.test(text))
    return 'the engine is missing the CMIF pointer-descriptor patch - run patches/apply.sh, then start a new run (docs/PATCHED-ENGINE.md)';
  if (/current-root\.json|promoted fsp-srv root/.test(text))
    return 'this folder is not a held 4/4 run - use the run folder the live run.cjs printed';
  if (/ECONNREFUSED|memory\.sock|NO LIVE HOST/i.test(text))
    return 'the run folder has no live host - start run.cjs and use the folder it prints';
  return null;
}

function reportFailure(what, command, result) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const detail = output.split('\n').map(line => line.trim()).filter(Boolean).slice(-3);
  const exit = Number.isInteger(result.status) && result.status !== 0 ? ` (exit ${result.status})` : '';
  console.error(`\ncould not list ${what}${exit}:`);
  if (result.error) console.error('  ' + result.error.message);
  for (const line of detail) console.error('  ' + line);
  if (!detail.length && !result.error) console.error('  (no output)');
  const advice = hint(output + ' ' + (result.error ? result.error.message : ''));
  if (advice) console.error('  hint: ' + advice);
  console.error('  rerun: ' + command);
}

function applications(session) {
  const result = run('list-apps.cjs', [session]);
  const ids = [...new Set([...(result.stdout || '').matchAll(/0x([0-9a-f]{16})/g)].map(m => m[1]))];
  if (ids.length === 0)
    reportFailure('installed applications', 'node tools/list-apps.cjs ' + JSON.stringify(session), result);
  return ids;
}

function accounts(session) {
  const result = run('save-pull-root.cjs', [session, '0000000000000000', '.', '--list-uids']);
  const uids = [...new Set((result.stdout || '').split('\n').map(s => s.trim())
    .filter(s => /^[0-9a-f]{32}$/i.test(s)))];
  if (uids.length === 0)
    reportFailure('accounts', 'node tools/save-pull-root.cjs ' + JSON.stringify(session) +
      ' 0000000000000000 . --list-uids', result);
  return uids;
}

// Writability is a policy list, not something the console reports: config/
// titles.local.json (this console) plus the titles.json template.
function writable() {
  const ids = new Set();
  for (const name of ['titles.json', 'titles.local.json']) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'config', name), 'utf8'));
      for (const entry of config.write || []) ids.add(String(entry.id).toLowerCase());
    } catch { /* optional */ }
  }
  return ids;
}

function main() {
  const [session, ...uidArgs] = process.argv.slice(2);
  if (!session) {
    console.error('usage: node inventory.cjs <run-directory> [uid-hex ...]');
    process.exit(2);
  }
  const apps = applications(session);
  if (apps.length === 0) {
    console.error('\ninventory needs the installed-application list; fix the failure above and retry.');
    process.exit(1);
  }
  const uids = uidArgs.length ? uidArgs : accounts(session);
  if (uids.length === 0) {
    console.error('\ninventory needs an account uid; fix the failure above, or pass one explicitly:');
    console.error('  node tools/inventory.cjs ' + JSON.stringify(session) + ' <uid>');
    process.exit(1);
  }
  const allowed = writable();
  titles.refresh().then(refreshed => {
    const rows = [];
    for (const appId of apps) {
      for (let i = 0; i < uids.length; i++) {
        const result = run('save-pull-root.cjs', [session, appId, '.', uids[i], '--list-only']);
        const match = /listed (\d+) files, (\d+) bytes/.exec(result.stdout || '');
        if (!match) continue;
        rows.push({
          game: titles.name(appId) || appId,
          id: appId,
          user: i + 1,
          uid: uids[i],
          files: Number(match[1]),
          bytes: Number(match[2]),
          writable: allowed.has(appId.toLowerCase()),
          state: Number(match[1]) === 0 ? 'empty' : (Number(match[1]) < 3 ? 'sparse' : 'ok'),
        });
      }
    }
    if (rows.length === 0) {
      console.log('no save data found for any installed application');
      return;
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    const wide = Math.max(...rows.map(r => r.game.length));
    console.log('  game'.padEnd(wide + 2) + '  user  files      size  state  id');
    console.log('  ' + '-'.repeat(wide) + '  ----  -----  --------  -----  ----------------');
    for (const row of rows) {
      console.log((row.writable ? '✔ ' : '  ') + row.game.padEnd(wide) + '  ' + String(row.user).padStart(4) + '  ' +
        String(row.files).padStart(5) + '  ' + (row.bytes / 1048576).toFixed(1).padStart(6) + 'M  ' +
        row.state.padEnd(5) + '  ' + row.id);
    }
    const total = rows.reduce((sum, row) => sum + row.bytes, 0);
    console.log(`\n${rows.length} save archives, ${(total / 1048576).toFixed(1)} MiB total`);
    console.log('✔ = the id is in config/titles.local.json, so it may be written to');
    // A partial list looks like a bug unless the gap is named and actionable.
    const ids = [...new Set(rows.map(row => row.id))];
    const unnamed = titles.unnamed(ids);
    if (unnamed.length) {
      console.log(`\nnote: ${unnamed.length} of ${ids.length} titles ` +
        `${unnamed.length === 1 ? 'has' : 'have'} no name - demos/trials and some`);
      console.log('new releases are not in titledb.');
      if (!refreshed) console.log('(titledb could not be fetched - connect once with network access for names)');
      console.log('add them to config/titles.local.json (keep any existing entries):');
      console.log('  ' + titles.namesStub(unnamed));
    }
  });
}

main();
