#!/usr/bin/env node
// List installed applications through the borrowed FS SM client + NCM.
//   node list-apps.cjs <run-directory> [--no-names]
// Read-only: NCM content-meta database enumeration over every storage that has a
// database (BuiltInUser, SdCard, GameCard), then the console's own name for each
// title it has not named before. A name never fails the listing: if the console
// will not give one, the id is printed on its own.
const path = require('node:path');
const fsp = require('node:fs/promises');
const {collect} = require('./lib/app-storages.cjs');
const consoleNames = require('./lib/console-names.cjs');
const contentNames = require('./lib/content-names.cjs');
const titles = require('./lib/titles.cjs');

const NAMES_BYTES = 0x80000;   // owned memory for the name read (buffer at +0x10000)

// The console's own names for ids the cache has never seen. Two reads, both
// proven in ouncecake: the ns control-data reader first, then the title's control
// NCA for whatever the reader refused. Anything that fails is a missing name.
async function readNames(context, ids) {
  const {engine, run, note, sm, ncm, storages} = context;
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const {packet} = require(path.join(run, 'shared/ipc.cjs'));
  const read = file => fsp.readFile(path.join(engine, file), 'utf8').then(JSON.parse);
  const proof = await read('ro/root/current-root.json');
  const current = await read('current-acquisition.json');
  if (proof.session !== current.session || proof.pid !== 1 || !proof.rootHandle)
    throw Error('this run has no promoted fsp-srv root (expected pid 1)');
  const s = new Session('title-names-' + Date.now(), NAMES_BYTES);
  s.record = async () => {};
  await s.initialize();
  try {
    const root = await domain.send(s, 'Clone held promoted FS root', proof.rootHandle,
      domain.wire.control(2)).then(reply => domain.oneHandle(reply));
    const names = await consoleNames.read(s, ids, {note, sm});
    const rest = ids.filter(id => !names[String(id).toLowerCase().replace(/^0x/, '')]);
    if (rest.length) {
      const content = await contentNames.readTitles({s, domain, filesystem, root, ncm, packet,
        ids: rest, storages, note});
      Object.assign(names, content);
    }
    return names;
  } finally {
    await s.cleanup().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--no-names']);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) throw Error('unknown option ' + arg);
  }
  const [runDirectory] = argv.filter(arg => !arg.startsWith('--'));
  if (!runDirectory) {
    console.error('usage: node list-apps.cjs <run-directory> [--no-names]');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  // Load the run's own endpoint client so the memory socket path/protocol match.
  const {connect: runConnect} = require(path.join(engine, 'tools/fs-memory.cjs'));
  const memory = await runConnect();
  const info = await memory.request({command: 'root-native-info'});
  const sm = info.services?.find(item => item.sm)?.sm;
  const shell = info.services?.find(item => item.name === 'pm:shell')?.sm;
  if (!shell) throw Error('The run has no borrowed initialized SM client');
  const ncm = await memory.request({command: 'root-native-sm-service', handle: shell, name: 'ncm'});
  if (ncm.transport || ncm.result || !ncm.moves?.length)
    throw Error('ncm lookup failed: transport=' + ncm.transport + ' result=' + ncm.result);
  const handle = ncm.moves[0];
  const note = text => console.error(text);
  try {
    const {ids, storages} = await collect(storage => memory.request({
      command: 'root-native-ncm-list-system', handle, storage, metaType: 0x80, installType: 0,
    }), {note});
    // No database at all is a tool problem, not an empty console: "no titles"
    // would otherwise send the caller looking for a missing SD card.
    if (ids.length === 0)
      throw Error('NCM listed no installed applications on any storage ' +
        '(BuiltInUser, SdCard, GameCard)');
    for (const id of ids) console.log(id);
    console.error(`${ids.length} installed applications`);
    if (argv.includes('--no-names')) return;
    // Only ids the console has not already named: the cache makes the second
    // listing (and every other tool) free of the read.
    const missing = ids.filter(id => !titles.hasDeviceName(id));
    if (missing.length === 0) return;
    const storageOf = {};
    for (const storage of storages)
      for (const id of storage.ids) if (!(id in storageOf)) storageOf[id] = storage.id;
    const names = await readNames({engine, run, note, sm, ncm: handle, storages: storageOf},
      missing).catch(error => {
      note('names: ' + error.message);
      return {};
    });
    const count = Object.keys(names).length;
    titles.rememberDeviceNames(names);
    console.error(`names: ${count} of ${missing.length} new titles named from the console` +
      (count < missing.length ? ' (the rest keep their id)' : ''));
  } finally {
    await memory.request({command: 'root-native-close-handle', handle}).catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
