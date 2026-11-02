#!/usr/bin/env node
'use strict';
const path = require('node:path');

const storages = [
  {id: 4, name: 'BuiltInUser'},
  {id: 5, name: 'SdCard', inactive: 0x21005},
  {id: 2, name: 'GameCard', inactive: 0x20a05}
];

function check(ok, message) { if (!ok) throw Error(message); }

async function listApplications(memory, handle) {
  const titles = new Set();
  const counts = [];
  const inactive = [];
  for (const storage of storages) {
    let listed;
    try {
      listed = await memory.request({command: 'root-native-ncm-list-system',
        handle, storage: storage.id, metaType: 0x80, installType: 0});
    } catch (error) {
      const failed = /^NCM metadata database (\d+) open failed: 0x([0-9a-f]+)$/.exec(error.message);
      if (storage.inactive && failed && Number(failed[1]) === storage.id &&
          Number.parseInt(failed[2], 16) === storage.inactive) {
        inactive.push(storage.name);
        continue;
      }
      throw error;
    }
    check(listed && listed.complete === true && Number.isSafeInteger(listed.total) &&
      listed.total >= 0 && listed.total <= 1024 && listed.written === listed.total &&
      Array.isArray(listed.keys) && listed.keys.length === listed.total,
    'The ' + storage.name + ' application inventory is incomplete.');
    for (const key of listed.keys) {
      check(key && typeof key.id === 'string' && /^0x[0-9a-f]{16}$/.test(key.id),
        'The ' + storage.name + ' application inventory has an invalid title ID.');
      titles.add(key.id);
    }
    counts.push({name: storage.name, records: listed.total});
  }
  return {titles: [...titles].sort(), counts, inactive};
}

async function main() {
  const [runDirectory] = process.argv.slice(2);
  if (!runDirectory) { console.error('usage: node list-apps.cjs <run-directory>'); process.exit(2); }
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  // Load the run's own endpoint client so the memory socket path/protocol match.
  const {connect: runConnect} = require(path.join(engine, 'tools/fs-memory.cjs'));
  const memory = await runConnect();
  const info = await memory.request({command: 'root-native-info'});
  const sm = info.services?.find(item => item.name === 'pm:shell')?.sm;
  if (!sm) throw Error('The run has no borrowed initialized SM client');
  const ncm = await memory.request({command: 'root-native-sm-service', handle: sm, name: 'ncm'});
  if (ncm.transport || ncm.result || !ncm.moves?.length)
    throw Error('ncm lookup failed: transport=' + ncm.transport + ' result=' + ncm.result);
  const handle = ncm.moves[0];
  try {
    const inventory = await listApplications(memory, handle);
    console.error(inventory.titles.length + ' unique installed applications from ' +
      inventory.counts.map(item => item.name + '=' + item.records).join(', ') +
      (inventory.inactive.length ? '; inactive: ' + inventory.inactive.join(', ') : ''));
    for (const title of inventory.titles) console.log(title);
  } finally {
    await memory.request({command: 'root-native-close-handle', handle}).catch(() => {});
  }
}

module.exports = {listApplications};
if (require.main === module)
  main().catch(error => { console.error('FAILED:', error.message); process.exitCode = 1; });
