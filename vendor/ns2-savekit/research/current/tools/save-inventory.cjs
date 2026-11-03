#!/usr/bin/env node
// Enumerate every save-data archive the console's FS knows about, through the
// promoted (pid=1) fsp-srv root. No titledb, no NCM application list, no
// per-title probing: the console's own save-data index is the source.
//
//   node save-inventory.cjs <run-directory> [--space N ...] [--json PATH] [--names]
//
// Read-only: opens SaveDataInfoReader handles (fs cmd 61, one per space) and
// reads pages of SaveDataInfo records. It never opens a save filesystem, never
// writes to the console and never commits.
//
// Why the promoted root: fs:srv validates the caller's program id for save
// access. The exploit's cached root session has pid=1, so the reader opens and
// returns every archive in the space. A fresh fsp-srv session gets 0x320002 or
// 0x2ee002 instead - that is what the old probe-info-reader.cjs measured and
// why the kit wrongly concluded the reader was unavailable.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser',
  100: 'ProperSystem', 101: 'SafeMode', 102: 'ProperUser'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary',
  5: 'Cache', 6: 'SystemBcat', 7: 'StreamPlay'};
const STRIDE = 0x60;          // sizeof(SaveDataInfo) on this build
const SLOTS = 64;             // records per read
const MAX_PAGES = 64;         // 4096 records is far beyond any real console
const code = v => '0x' + (Number(v) & 0x3fffff).toString(16);

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

function parseEntry(entry) {
  return {
    id: entry.readBigUInt64LE(0).toString(),
    space: entry[8],
    type: entry[9],
    // Candidate SaveDataInfo offsets for the fields the open call also needs.
    // Account archives read rank=0/index=0; a Cache archive is where a non-zero
    // index shows up, so keep them in the JSON for the puller.
    rank: entry[0x0a],
    index: entry.readUInt32LE(0x0c),
    uid: entry.subarray(0x10, 0x20).toString('hex'),
    applicationId: '0x' + entry.readBigUInt64LE(0x28).toString(16).padStart(16, '0'),
    size: entry.readBigUInt64LE(0x30).toString(),
  };
}

async function enumerateSpace(s, root, domain, space) {
  let opened;
  try {
    opened = await s.ipc(`open reader space=${space}`, root, 61, Buffer.from([space]));
  } catch (error) {
    return {space, error: 'threw ' + error.message, entries: []};
  }
  const result = Number(opened.canonicalResult ?? opened.result ?? -1) & 0x3fffff;
  if (result !== 0 || !opened.moves || opened.moves.length !== 1)
    return {space, error: code(result) + ' moves=' + (opened.moves ? opened.moves.length : 0),
      entries: []};
  const reader = domain.oneHandle(opened);
  const entries = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const at = s.base + 0x8000;
      await s.write(at, Buffer.alloc(STRIDE * SLOTS));
      const reply = await s.ipc('ReadSaveDataInfo', reader, 0, Buffer.alloc(0),
        {receive: [{address: at, size: STRIDE * SLOTS, mode: 0}]});
      const readResult = Number(reply.canonicalResult ?? reply.result ?? -1) & 0x3fffff;
      if (readResult !== 0) throw Error('read ' + code(readResult));
      const count = reply.data && reply.data.length >= 8 ? Number(reply.data.readBigUInt64LE()) : 0;
      if (count <= 0) break;
      const bytes = await s.read(at, STRIDE * Math.min(count, SLOTS));
      for (let i = 0; i < Math.min(count, SLOTS); i++)
        entries.push(parseEntry(bytes.subarray(i * STRIDE, (i + 1) * STRIDE)));
      if (count < SLOTS) break;
    }
  } catch (error) {
    return {space, error: error.message, entries};
  } finally {
    await s.close(reader).catch(() => {});
  }
  return {space, entries};
}

function loadNames() {
  const names = new Map();
  for (const file of ['titledb-cache.json', 'titles.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8'));
      if (file === 'titles.json') {
        for (const [id, name] of Object.entries(data.names || {}))
          names.set(id.toLowerCase(), name);
      } else {
        for (const [id, name] of Object.entries(data)) names.set(id.toLowerCase(), name);
      }
    } catch { /* names are a convenience, never a dependency */ }
  }
  return names;
}

async function main() {
  let argv = process.argv.slice(2);
  const take = name => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== name) continue;
      out.push(argv[i + 1]);
      argv.splice(i, 2);
      i--;
    }
    return out;
  };
  const spacesArg = take('--space');
  const jsonAt = take('--json')[0] || null;
  const wantNames = argv.includes('--names');
  argv = argv.filter(a => a !== '--names');
  const [runDirectory] = argv;
  if (!runDirectory) {
    console.error('usage: node save-inventory.cjs <run-directory> ' +
      '[--space N ...] [--json PATH] [--names]');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fsp.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fsp.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle)
    throw Error('The run has no promoted fsp-srv root (expected pid 1)');
  const root = rootProof.rootHandle;
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-inventory-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  const spaces = spacesArg.length ? spacesArg.map(Number) : [0, 1, 2, 3, 4];
  const names = wantNames ? loadNames() : new Map();
  const report = {at: new Date().toISOString(), run, rootPid: rootProof.pid, spaces: {}, entries: []};
  try {
    for (const space of spaces) {
      const found = await enumerateSpace(s, root, domain, space);
      report.spaces[space] = {name: SPACES[space] ?? String(space), error: found.error || null,
        count: found.entries.length};
      for (const entry of found.entries) report.entries.push({...entry, space: entry.space ?? space});
      const label = `${SPACES[space] ?? space} (${space})`;
      console.log(`\n${label}: ${found.error ? 'ERROR ' + found.error : found.entries.length + ' archive(s)'}`);
      for (const entry of found.entries) {
        const app = BigInt(entry.applicationId) === 0n ? '-' : entry.applicationId;
        const name = app === '-' ? '' :
          names.get(entry.applicationId.replace(/^0x/, '').toLowerCase()) || '';
        console.log(`  id=${String(entry.id).padStart(3)} ${String(TYPES[entry.type] ?? entry.type).padEnd(9)} ` +
          `app=${app.padEnd(18)} uid=${entry.uid.slice(0, 16)} ` +
          `size=${String(entry.size).padStart(10)}${name ? '  ' + name : ''}`);
      }
    }
  } finally {
    await s.cleanup().catch(() => {});
  }

  if (jsonAt) {
    const target = path.resolve(jsonAt);
    await fsp.mkdir(path.dirname(target), {recursive: true});
    await fsp.writeFile(target, JSON.stringify(report, null, 2) + '\n');
    console.log(`\ninventory -> ${target}`);
  }
  console.log(`\nTOTAL ${report.entries.length} archive(s) across ${spaces.length} space(s)`);
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
