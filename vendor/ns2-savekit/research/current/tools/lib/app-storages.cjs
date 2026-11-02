'use strict';
// Which NCM storages to ask for the installed-application list.
//
// Installed content lives in one content-meta database per storage, and asking
// only BuiltInUser (4) lists the titles on the internal NAND: a console whose
// games are installed on the SD card read as 18 titles instead of ~40 (issue #1,
// "might be only seeing internal storage not sd card"). SdCard is 5, GameCard 2.
//
// A storage with no database - no SD card, no game card in the slot - is absent,
// not an error: it is reported and skipped, so a console with neither still
// lists what it has. The same application id can be recorded in more than one
// database (the patch on the SD card, the base on the NAND), so ids are deduped
// in first-seen order.
const STORAGES = [
  {id: 4, label: 'BuiltInUser'},
  {id: 5, label: 'SdCard'},
  {id: 2, label: 'GameCard'},
];

// `list(storageId)` resolves with the engine's reply
// ({total, written, keys: [{id, ...}]}) and rejects when the database will not
// open. `note(text)` receives one line per storage, for the caller to print.
async function collect(list, options = {}) {
  const note = options.note || (() => {});
  const ids = [];
  const seen = new Set();
  const storages = [];
  for (const storage of STORAGES) {
    let reply;
    try {
      reply = await list(storage.id);
    } catch (error) {
      storages.push({...storage, error: error.message, ids: []});
      note(`${storage.label}: no database, skipped (${error.message})`);
      continue;
    }
    if (!reply || !Array.isArray(reply.keys)) {
      storages.push({...storage, error: 'no key list in the reply', ids: []});
      note(`${storage.label}: the reply held no key list, skipped`);
      continue;
    }
    const fresh = [];
    for (const key of reply.keys) {
      const id = String(key.id).toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      fresh.push(id);
    }
    const total = Number(reply.total ?? reply.keys.length);
    const written = Number(reply.written ?? reply.keys.length);
    const complete = reply.complete ?? total === written;
    storages.push({...storage, total, written, complete, ids: fresh});
    note(`${storage.label}: ${fresh.length} applications` +
      (fresh.length === reply.keys.length ? '' :
        ` (${reply.keys.length} records, ${fresh.length} new)`));
    if (!complete)
      note(`${storage.label}: the engine returned ${written} of ${total} records - ` +
        'the list is truncated');
  }
  return {ids, storages};
}

module.exports = {STORAGES, collect};
