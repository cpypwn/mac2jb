'use strict';
// Title id -> game name, from the community titledb.
//
// One US.en.json download fills config/titledb-cache.json (~1.4 MB for 29k
// names); the cache is then reused offline for a week. Upstream has no smaller
// name file - this is a 90 MB JSON document (~26 MB over the wire) - so the
// first run needs network access for full coverage. blawar/titledb is a Switch 1
// catalogue, so a Switch 2 title id is never in it. Titles titledb cannot name
// (Switch 2, demos/trials, some new releases) fall back to config/titles.json and
// config/titles.local.json; anything still unknown is shown as an id and
// kit/inventory print a stub.
const fs = require('node:fs');
const path = require('node:path');

const CACHE = path.join(__dirname, '..', '..', 'config', 'titledb-cache.json');
const URL = 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json';
// The old 20 s deadline aborted mid-download on anything slower than ~10 Mbit/s,
// which then looked exactly like "titledb has no name for this title".
const FETCH_TIMEOUT_MS = Number(process.env.NS2_TITLEDB_TIMEOUT_MS) || 300000;

let map = null;

function load() {
  if (map) return map;
  map = {};
  try {
    map = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch { /* no cache yet */ }
  return map;
}

// The cache is good for a week; only the first run (or a stale cache) fetches.
// Returns false when the fetch failed; a cache that already exists is still
// used, so an offline run keeps the names from the last successful fetch.
async function refresh(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const stat = fs.statSync(CACHE);
    if (Date.now() - stat.mtimeMs < maxAgeMs) return true;
  } catch { /* no cache: fetch */ }
  console.error('titledb: fetching title names (first run or a stale cache; ' +
    '~26 MB over the wire)');
  try {
    const response = await fetch(URL, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if (!response.ok) return false;
    const data = await response.json();
    const compact = {};
    for (const [key, entry] of Object.entries(data)) {
      const name = entry && entry.name;
      // The map is keyed by NSU id; the application id is inside the entry.
      const id = String((entry && (entry.id || entry.app_id)) || key);
      if (typeof name === 'string' && name && /^[0-9a-f]{16}$/i.test(id)) {
        compact[id.toLowerCase()] = name;
      }
    }
    if (Object.keys(compact).length < 100) return false;
    fs.mkdirSync(path.dirname(CACHE), {recursive: true});
    fs.writeFileSync(CACHE, JSON.stringify(compact));
    map = compact;
    return true;
  } catch {
    return false;
  }
}

// True when at least one title can be named; the kit warns when it cannot.
function available() {
  const known = Object.keys(load()).length;
  const local = Object.keys(localNames()).length;
  const consoleNames = Object.keys(deviceNames()).length;
  return known + local + consoleNames > 0;
}

let overrides = null;

function localNames() {
  if (overrides) return overrides;
  overrides = {};
  try {
    const read = name => {
      try {
        return JSON.parse(fs.readFileSync(
          path.join(__dirname, '..', '..', 'config', name), 'utf8'));
      } catch { return {}; }
    };
    // titles.json ships a template; titles.local.json holds this console's ids.
    const local = read('titles.local.json');
    const config = {...read('titles.json'), ...local,
      names: {...(read('titles.json').names || {}), ...(local.names || {})}};
    for (const entry of config.names ? Object.entries(config.names) : []) {
      overrides[String(entry[0]).toLowerCase()] = entry[1];
    }
    for (const entry of config.write || []) {
      if (entry.name) overrides[String(entry.id).toLowerCase()] = entry.name;
    }
  } catch { /* no local names */ }
  return overrides;
}

// Names read from the console's own control data (tools/list-apps.cjs), cached
// because they cost one session read per title and never change. This is the
// only layer that can name a Switch 2 title, and it is gitignored like uids.json.
const DEVICE_CACHE = path.join(__dirname, '..', '..', 'config', 'titles.nacp.json');
let device = null;

function deviceNames() {
  if (device) return device;
  device = {};
  try { device = JSON.parse(fs.readFileSync(DEVICE_CACHE, 'utf8')); } catch { /* none yet */ }
  return device;
}

// True when the cache changed; false when there was nothing new to write.
function rememberDeviceNames(names) {
  const fresh = Object.entries(names || {})
    .filter(([id, value]) => typeof value === 'string' && value &&
      deviceNames()[String(id).toLowerCase()] !== value);
  if (!fresh.length) return false;
  const merged = {...deviceNames()};
  for (const [id, value] of fresh) merged[String(id).toLowerCase()] = value;
  try {
    fs.mkdirSync(path.dirname(DEVICE_CACHE), {recursive: true});
    fs.writeFileSync(DEVICE_CACHE, JSON.stringify(merged, null, 2) + '\n');
    device = merged;
    return true;
  } catch {
    return false;
  }
}

// True when the console has already named this id. Callers hold ids with and
// without the 0x prefix, so one spelling is used for the lookup.
function hasDeviceName(id) {
  return Boolean(deviceNames()[String(id).toLowerCase().replace(/^0x/, '')]);
}

function name(id) {
  // ids arrive both ways (0x0100..., 0100...); one spelling for every layer.
  const key = String(id).toLowerCase().replace(/^0x/, '');
  // Local names win (a curated name beats a machine one); the console names what
  // titledb cannot (Switch 2); titledb names the rest.
  return localNames()[key] || deviceNames()[key] || load()[key] || null;
}

// Ids no layer can name. Demos/trials have no app id in titledb, and new or
// eShop-only releases can be absent; callers print these so a partial list is
// not mistaken for a broken one.
function unnamed(ids) {
  return [...new Set(ids.map(String))].filter(id => !name(id));
}

// A copy-paste skeleton for config/titles.local.json covering those ids.
function namesStub(ids) {
  const names = {};
  for (const id of ids) names[String(id).toLowerCase()] = '<name>';
  return JSON.stringify({names});
}

function label(id) {
  const found = name(id);
  return found ? found + '  (' + id + ')' : id;
}

// Filesystem-safe folder name: the game's own name, not its title id.
function slug(id) {
  const title = name(id) || String(id);
  const clean = title.replace(/[\u2122\u00ae]/g, '')   // (TM) / (R) signs
    .replace(/[\u00e9\u00e8]/gi, 'e')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')          // strip accents: Pokémon -> Pokemon
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/(^|-)TM(?=-|$)/gi, '$1')       // trademark sign from NFKD
    .replace(/-R$/i, '')
    .replace(/-TM-/g, '-').replace(/-TM$/i, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  // A name that is mostly non-latin script (プチコン4 -> "4") makes a useless
  // folder, so those keep the id: the save still has a stable, findable home.
  if (!clean || clean.replace(/[^A-Za-z0-9]/g, '').length < 3) return String(id).toLowerCase();
  return clean;
}

module.exports = {refresh, name, label, slug, available, unnamed, namesStub, deviceNames,
  hasDeviceName, rememberDeviceNames, cachePath: CACHE, deviceCachePath: DEVICE_CACHE};
