'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const vm = require('node:vm');
const {Readable} = require('node:stream');
const {execFileSync} = require('node:child_process');
const {create, transcodeArgs, safeDiagnostic} = require('./server.cjs');
const {build} = require('./package.cjs');
const {readConfig, installToken, readInstallState, writeInstallState, installClient,
  installedChecksum, prepareBridgeClient, superviseBridge, createActivityLog, BRIDGE_PORT, PREFIX} = require('./run.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const mediaPackage = path.join(projectRoot, 'integrations/jellyfin/0.0.1/jellyfin-civswitch.civapp');

test('Stremio package contains a persistent client and CivHomebrew media scripts', async () => {
  const installToken = 'f'.repeat(48);
  const {item, bytes} = await build({projectRoot, installToken, initialAddress: '10.0.0.42:39384'});
  assert.equal(item.format, 'civswitch-app');
  assert.equal(item.id, 'civ-stremio');
  const icon = Buffer.from(item.icon.replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
  assert.ok(bytes.length < 32 * 1024 * 1024);
  assert.equal(item.scripts.at(-1).name, 'app.js');
  assert.equal(item.scripts.at(-2).source, `window.CivStremioConfig=${JSON.stringify({
    token: installToken, initialAddress: '10.0.0.42:39384', icon: item.icon
  })};`);
  assert.doesNotMatch(item.scripts.at(-2).source, /5678/);
  assert.match(item.scripts.at(-1).source, /save:\/civhomebrew\/stremio-settings\.json/);
  assert.doesNotMatch(bytes.toString(), /Bearer HEADERSECRET|ADDONSECRET/);
});

test('Stremio package checksum matches CivHomebrew installed-manifest format', () => {
  const item = {format: 'civswitch-app', version: 1, id: 'test-app', name: 'Test',
    metadata: {author: 'cpypwn', release: '1.0.0', api: 1, description: 'fixture'},
    scripts: [{name: 'app.js', source: 'window.test="✓";'}], icon: ''};
  assert.equal(installedChecksum(item), '7665c961');
});

test('FFmpeg input validates URL and headers before launching', () => {
  assert.throws(() => transcodeArgs({url: 'file:///private/secret'}));
  assert.throws(() => transcodeArgs({url: 'https://user:pass@example.com/video'}));
  assert.throws(() => transcodeArgs({url: 'https://example.com/video', headers: {Authorization: 'Bearer x\r\nInjected: yes'}}));
  const args = transcodeArgs({url: 'https://example.com/video', headers: {Authorization: 'Bearer safe'}}, 12);
  assert.ok(args.includes('libx264') && args.includes('libopus'));
  for (const flag of ['-reconnect', '-reconnect_on_network_error', '-reconnect_streamed',
    '-reconnect_delay_max', '-reconnect_max_retries']) assert.ok(args.indexOf(flag) < args.indexOf('-i'));
  assert.equal(args[args.indexOf('-reconnect_max_retries') + 1], '2');
  assert.ok(!args.includes('-reconnect_at_eof'));
  assert.deepEqual(args.slice(-3), ['-live', '1', 'pipe:1']);
  const compact = transcodeArgs({url: 'https://example.com/video'}, 0, '360p', 2);
  assert.ok(compact.includes('0:2'));
  assert.ok(compact.some(arg => arg.includes('scale=640:360:')));
  assert.throws(() => transcodeArgs({url: 'https://example.com/video'}, 0, '1080p'), /video output/);
});

test('playback diagnostics redact stream addresses and session tokens', () => {
  const token = 'a'.repeat(48);
  const detail = safeDiagnostic(`Failed https://example.test/video?secret=123 ${token}\nAuthorization: Bearer private`);
  assert.equal(detail, 'Failed [url] [session] Authorization: Bearer [redacted]');
});

test('runner reads account settings only from bounded stdin and emits structured records', async () => {
  const config = {addonUrls: ['https://example.com/manifest.json'], libraryItems: [{_id: 'movie:1'}]};
  assert.deepEqual(await readConfig(Readable.from([Buffer.from(JSON.stringify(config))])), config);
  await assert.rejects(readConfig(Readable.from([Buffer.alloc(1025)]), 1024), /size limit/);
  await assert.rejects(readConfig(Readable.from([Buffer.from('{')])), /Invalid Stremio account settings/);
  assert.equal(PREFIX, 'MAC2JB_CIV_STREMIO ');
  assert.equal(BRIDGE_PORT, 39384);
  const selfTest = execFileSync(process.execPath, [path.join(__dirname, 'run.cjs'), '--self-test', projectRoot],
    {encoding: 'utf8'});
  assert.match(selfTest, /MAC2JB_CIV_STREMIO \{"type":"ready"/);
});

test('CivHomebrew app status starts a fresh bridge on every load and releases its port on exit', async () => {
  const abort = new AbortController();
  const state = {mode: 'launcher', app: null, closed: false};
  const events = [], callbacks = [];
  let desiredPort = 0, opens = 0, closes = 0;
  const waitFor = async condition => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Timed out waiting for Stremio bridge state');
  };
  const run = superviseBridge({signal: abort.signal, pollMs: 10,
    getStatus: async () => ({state: {...state}}),
    openBridge: async ({onClientClose}) => {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(desiredPort, '127.0.0.1', resolve);
      });
      desiredPort = server.address().port;
      callbacks.push(onClientClose);
      opens++;
      return {host: '127.0.0.1', port: desiredPort, async close() {
        closes++;
        await new Promise(resolve => server.close(resolve));
      }};
    }, onEvent: (type, data) => events.push({type, data})});
  try {
    state.mode = 'app'; state.app = 'civ-stremio';
    await waitFor(() => opens === 1);
    callbacks[0]();
    await waitFor(() => closes === 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(opens, 1, 'close signal must not restart the same app instance');
    state.mode = 'launcher'; state.app = null;
    await new Promise(resolve => setTimeout(resolve, 40));
    state.mode = 'app'; state.app = 'civ-stremio';
    await waitFor(() => opens === 2);
    state.mode = 'launcher'; state.app = null;
    await waitFor(() => closes === 2);
    state.mode = 'app'; state.app = 'civ-stremio';
    await waitFor(() => opens === 3);
    assert.ok(events.some(entry => entry.type === 'bridge-closed'));
    assert.equal(events.filter(entry => entry.type === 'bridge-ready').length, 3);
  } finally {
    abort.abort();
    await run;
  }
  assert.equal(closes, 3);
});

test('Stremio waits for the launcher before refreshing an old package', async () => {
  const abort = new AbortController();
  const state = {mode: 'app', app: 'civ-stremio', closed: false, busy: false};
  const events = [];
  let refreshed = 0;
  const run = superviseBridge({signal: abort.signal, pollMs: 5,
    getStatus: async () => ({state: {...state}}),
    openBridge: async () => ({host: '127.0.0.1', port: 39384, async close() {}}),
    refreshWhenReady: async () => { refreshed++; },
    onEvent: (type, detail) => events.push({type, detail})});
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(refreshed, 0);
    state.mode = 'launcher'; state.app = null;
    for (let index = 0; index < 100 && !refreshed; index++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(refreshed, 1);
    assert.ok(events.some(event => event.type === 'installed' &&
      event.detail.message === 'Stremio updated in CivHomebrew'));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(refreshed, 1);
  } finally {
    abort.abort();
    await run;
  }
});

test('catalog installation is personalized before the Mac bridge starts', async () => {
  const abort = new AbortController();
  const state = {mode: 'launcher', app: null, closed: false, busy: false};
  let present = false, ready = false, opens = 0, refreshes = 0;
  const run = superviseBridge({signal: abort.signal, pollMs: 5, refreshIntervalMs: 10,
    watchForInstall: true, isReady: () => ready,
    getStatus: async () => ({state: {...state}}),
    refreshWhenReady: async () => {
      refreshes++;
      if (!present) return false;
      ready = true;
      return {installed: true};
    },
    openBridge: async () => { opens++; return {host: '127.0.0.1', port: 39384, async close() {}}; }});
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(refreshes > 1);
    assert.equal(opens, 0);
    state.mode = 'app'; state.app = 'civ-stremio';
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(opens, 0);
    state.mode = 'launcher'; state.app = null; present = true;
    for (let index = 0; index < 100 && !ready; index++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ready, true);
    state.mode = 'app'; state.app = 'civ-stremio';
    for (let index = 0; index < 100 && !opens; index++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(opens, 1);
  } finally {
    abort.abort();
    await run;
  }
});

test('bridge releases its port when the owning Mac app exits', async () => {
  const abort = new AbortController();
  let ownerAlive = true, closes = 0, port = 0;
  const events = [];
  const run = superviseBridge({signal: abort.signal, pollMs: 5,
    ownerAlive: () => ownerAlive,
    getStatus: async () => ({state: {mode: 'app', app: 'civ-stremio', closed: false}}),
    openBridge: async () => {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      port = server.address().port;
      return {host: '127.0.0.1', port, async close() {
        closes++;
        await new Promise(resolve => server.close(resolve));
      }};
    }, onEvent: type => events.push(type)});
  try {
    for (let attempt = 0; attempt < 100 && !port; attempt++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(port, 'the bridge must open before its owner exits');
    ownerAlive = false;
    await Promise.race([run, new Promise((_, reject) =>
      setTimeout(() => reject(Error('Orphaned Stremio bridge stayed open')), 1000))]);
    assert.equal(closes, 1);
    assert.ok(events.includes('bridge-closed'));
    const replacement = net.createServer();
    await new Promise((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(port, '127.0.0.1', resolve);
    });
    await new Promise(resolve => replacement.close(resolve));
  } finally {
    ownerAlive = false;
    abort.abort();
    await run;
  }
});

test('Mac bridge accepts an authenticated Switch app exit notification', async t => {
  let closed = 0;
  const player = {playback: {position: 0, paused: false},
    async init() { return true; }, close() {},
    getMenuModel() { return {view: 'catalog', cards: []}; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false, createController: () => player,
    onClientClose: () => { closed++; }});
  t.after(() => session.close());
  const wrong = await fetch(`http://127.0.0.1:${session.port}/invalid/client-close`, {method: 'POST'});
  assert.equal(wrong.status, 404);
  assert.equal(closed, 0);
  const response = await fetch(session.origin + '/client-close', {method: 'POST'});
  assert.equal(response.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('Mac bridge applies a catalog filter and returns the refreshed menu', async t => {
  const filters = [];
  const player = {playback: {position: 0, paused: false},
    async init() { return true; }, close() {},
    getMenuModel() { return {view: 'catalogFilters', filter: filters.at(-1) || null}; },
    setCatalogFilter(name, value) { filters.push({name, value}); return name === 'search'; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false, createController: () => player});
  t.after(() => session.close());
  const reply = await fetch(session.origin + '/catalog-filter', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'search', value: 'Dune'})});
  assert.equal(reply.status, 200);
  assert.deepEqual((await reply.json()).model.filter, {name: 'search', value: 'Dune'});
  const rejected = await fetch(session.origin + '/catalog-filter', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'other', value: 'x'})});
  assert.equal(rejected.status, 400);
});

test('Switch X closes video, text filters open the keyboard, and exit signals the Mac bridge', async () => {
  class Element {
    constructor() { this.style = {}; this.children = []; this.listeners = {}; this.parentNode = null; }
    get firstChild() { return this.children[0] || null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    setAttribute() {}
    focus() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
    removeEventListener(name) { delete this.listeners[name]; }
    getBoundingClientRect() { return {left: 0, top: 0, width: 1280, height: 720}; }
    querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  }
  const requests = [];
  let playing = true, input, filterPending = false, catalogMode = false, detailsMode = false;
  let catalogBackdrop = true;
  const inputValues = ['drama', null];
  const model = () => detailsMode ? {view: 'details', isPlaying: false,
    footer: '↑/↓ Browse  L/R Tabs  A Open  B Back  ← Menu  X Refresh',
    hero: {id: 'movie:1', title: 'Test movie', poster: 'https://images.example.test/poster.jpg'},
    rows: [{index: 0, selected: true, label: 'Play'}], selected: 0, selectedIndex: 0,
    navigation: {sidebar: [], rows: [{index: 0, focused: true}]}} : catalogMode ? {view: 'catalog', isPlaying: false,
    footer: '←/→ Titles  ↑ Catalogs  L/R Tabs  A Open  B Menu  X Filters  Y Next catalog',
    hero: {id: 'movie:1', title: 'Test movie', poster: 'https://images.example.test/poster.jpg',
      ...(catalogBackdrop ? {background: 'https://images.example.test/backdrop.jpg'} : {})},
    cards: [{index: 0, title: 'A very long movie title that must not change card width',
      poster: 'https://images.example.test/poster.jpg'}, {index: 1, title: 'Short'}],
    navigation: {sidebar: [], tabs: [], cards: [{index: 0, focused: true}, {index: 1, focused: false}]}} :
    playing ? {view: 'playing', isPlaying: true, title: 'Test movie',
    playbackOverlay: {visible: true, mode: 'controls', controls: [{label: 'Pause'}]}} :
    {view: filterPending ? 'catalogFilters' : 'sources', isPlaying: false, rows: [],
      filterInput: filterPending ? {name: 'search', label: 'Search', value: '', required: true} : null,
      navigation: {sidebar: [], rows: []}};
  const window = new Element();
  Object.assign(window, {innerWidth: 1280, innerHeight: 720,
    CivStremioConfig: {token: 'e'.repeat(48), initialAddress: '127.0.0.1:39384', icon: 'data:image/png;base64,AA=='},
    JellyfinNativeHttp: {available: true, bridge() {}, create: () => async (url, method, _headers, body) => {
      const route = new URL(url).pathname.split('/').at(-1);
      requests.push({route, method, body});
      if (route === 'button') {
        if (JSON.parse(body).button === 'stopPlayback') playing = false;
        if (JSON.parse(body).button === 'a') filterPending = true;
      }
      if (route === 'catalog-filter') filterPending = false;
      return {status: 200, body: JSON.stringify(route === 'state' ? {model: model(), playback: playing ? {
        revision: 1, url: 'http://127.0.0.1/test', position: 0, duration: 30, paused: false
      } : null} : {ok: true})};
    }},
    JellyfinNativePlayer: {create: () => ({stats: () => ({seconds: 0, paused: false}), async stop() {}})},
    CivKeyboard: {create: () => ({edit: async () => inputValues.shift(), cancel() {}})},
    engine: {on(name, fn) { assert.equal(name, 'InputAction'); input = fn; return {clear() {}}; }}});
  const document = {body: new Element(), createElement: () => new Element(),
    documentElement: {clientWidth: 1280, clientHeight: 720}};
  const source = await fs.readFile(path.join(__dirname, 'app.js'), 'utf8');
  const app = vm.runInNewContext(source, {window, document, URL, navigator: {}, setInterval,
    clearInterval, Date, Promise, JSON, Math, Number, String, Error, Map, Set, BigInt, unescape,
    encodeURIComponent, decodeURIComponent, console});
  try {
    for (let i = 0; i < 20 && !requests.some(item => item.route === 'state'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 15));
    input('menu', 0);
    for (let i = 0; i < 20 && !requests.some(item => item.route === 'button'); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.parse(requests.find(item => item.route === 'button').body).button, 'stopPlayback');
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const expected of ['drama', null]) {
      input('a', 0);
      for (let i = 0; i < 30 && requests.filter(item => item.route === 'catalog-filter').length <
        (expected === 'drama' ? 1 : 2); i++) await new Promise(resolve => setTimeout(resolve, 5));
      const sent = requests.filter(item => item.route === 'catalog-filter').at(-1);
      assert.deepEqual(JSON.parse(sent.body), {name: 'search', value: expected});
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    catalogMode = true;
    const beforeCatalog = requests.filter(item => item.route === 'button').length;
    input('r', 0);
    for (let i = 0; i < 30 && requests.filter(item => item.route === 'button').length === beforeCatalog; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    const longTitle = document.body.querySelectorAll().find(item =>
      item.textContent === 'A very long movie title that must not change card width');
    const shortTitle = document.body.querySelectorAll().find(item => item.textContent === 'Short');
    assert.ok(longTitle && shortTitle);
    assert.equal(longTitle.parentNode.style.width, shortTitle.parentNode.style.width);
    assert.match(longTitle.parentNode.style.flex, /^0 0 \d+px$/);
    assert.equal(longTitle.parentNode.style.alignItems, 'center');
    const firstPoster = longTitle.parentNode.children[0];
    const secondPoster = shortTitle.parentNode.children[0];
    assert.equal(firstPoster.style.width, secondPoster.style.width);
    assert.equal(firstPoster.style.height, secondPoster.style.height);
    const artwork = firstPoster.children.find(item => item.style.objectFit);
    assert.equal(artwork.style.objectFit, 'contain');
    assert.equal(artwork.style.objectPosition, 'center center');
    const footer = document.body.querySelectorAll().find(item =>
      item.style.borderTop === '1px solid rgba(143,240,193,.3)');
    assert.equal(footer.children[0].style.display, 'flex');
    assert.equal(footer.children[0].style.flexDirection, 'row');
    assert.equal(footer.children[0].style.gridTemplateColumns, undefined);
    assert.equal(footer.children[0].children.length, 3);
    assert.deepEqual(footer.children[0].children.map(item =>
      item.children.map(child => child.textContent).join(' ')),
    ['L/R Switch tabs', 'A Open title', 'B Open menu']);
    assert.deepEqual(footer.children[1].children.map(item => item.textContent),
      ['Hold B / −', 'Return to CivHomebrew']);
    const hero = document.body.querySelectorAll().find(item =>
      item.style.border === '1px solid rgba(143,240,193,.19)');
    assert.equal(hero.children.find(item => item.style.opacity === '.82')?.style.height, 'auto');
    catalogBackdrop = false;
    const beforeWithoutBackdrop = requests.filter(item => item.route === 'button').length;
    input('r', 0);
    for (let i = 0; i < 30 && requests.filter(item => item.route === 'button').length === beforeWithoutBackdrop; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(hero.children.some(item => item.style.opacity === '.82'), false);
    detailsMode = true;
    const beforeDetails = requests.filter(item => item.route === 'button').length;
    input('r', 0);
    for (let i = 0; i < 30 && requests.filter(item => item.route === 'button').length === beforeDetails; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(footer.children[0].children.length, 2);
    assert.deepEqual(footer.children[0].children.map(item =>
      item.children.map(child => child.textContent).join(' ')), ['A Play', 'B Back to titles']);
    const beforeBack = requests.filter(item => item.route === 'button').length;
    input('b', 0);
    input('b', 1);
    for (let i = 0; i < 30 && requests.filter(item => item.route === 'button').length === beforeBack; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.parse(requests.filter(item => item.route === 'button').at(-1).body).button, 'b');
    assert.ok(!requests.some(item => item.route === 'client-close'));
    input('minus', 0);
    input('minus', 1);
    assert.ok(!requests.some(item => item.route === 'client-close'));
    input('minus', 0);
    await new Promise(resolve => setTimeout(resolve, 670));
    input('minus', 3);
    await app;
    assert.ok(requests.some(item => item.route === 'client-close' && item.method === 'POST'));
    const closeCount = requests.filter(item => item.route === 'client-close').length;
    const second = vm.runInNewContext(source, {window, document, URL, navigator: {}, setInterval,
      clearInterval, Date, Promise, JSON, Math, Number, String, Error, Map, Set, BigInt, unescape,
      encodeURIComponent, decodeURIComponent, console});
    for (let i = 0; i < 30 && document.body.querySelectorAll().length === 0; i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    input('b', 0);
    await new Promise(resolve => setTimeout(resolve, 670));
    input('b', 1);
    await second;
    assert.equal(requests.filter(item => item.route === 'client-close').length, closeCount + 1);
  } finally { await window.__civswitchApp?.close(); }
});

test('Mac bridge install token survives restarts and is private on disk', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'civ-stremio-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'settings', 'token');
  const first = await installToken(file);
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(await installToken(file), first);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const stateFile = path.join(directory, 'settings', 'install-state.json');
  const state = {initialAddress: '10.0.0.42:39384', digest: 'a'.repeat(64), checksum: 'b'.repeat(8)};
  await writeInstallState(stateFile, state);
  assert.deepEqual(await readInstallState(stateFile), state);
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
});

test('persistent Stremio activity log is private, redacted, and bounded', async t => {
  const support = await fs.mkdtemp(path.join(os.tmpdir(), 'civ-stremio-log-'));
  t.after(() => fs.rm(support, {recursive: true, force: true}));
  const log = await createActivityLog(support);
  await log.write('error', `Source https://example.test/video?key=SECRET token=${'a'.repeat(48)} Authorization: Bearer PRIVATE`);
  const first = await fs.readFile(log.file, 'utf8');
  assert.match(first, /\[url\]/);
  assert.doesNotMatch(first, /SECRET|PRIVATE|a{48}/);
  for (let i = 0; i < 600; i++) await log.write('activity', 'x'.repeat(490));
  await log.close();
  const contents = await fs.readFile(log.file, 'utf8');
  assert.ok((await fs.stat(log.file)).size <= 256 * 1024);
  assert.equal((await fs.stat(log.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(log.file))).mode & 0o777, 0o700);
  assert.doesNotMatch(contents, /SECRET|PRIVATE|a{48}/);
});

test('Stremio installs from the launcher without opening the Mac bridge or app', async t => {
  const support = await fs.mkdtemp(path.join(os.tmpdir(), 'civ-stremio-install-'));
  t.after(() => fs.rm(support, {recursive: true, force: true}));
  const requests = [];
  let entries = [];
  let macAddress = '10.0.0.5';
  const options = {projectRoot, consoleIP: '10.0.0.42', support,
    localAddress: async () => macAddress,
    probe: async () => ({state: {busy: false, closed: false, mode: 'launcher'}, entries}),
    request: async (_address, operation) => {
      requests.push(operation);
      entries = [{id: operation.package.id, checksum: installedChecksum(operation.package)}];
      return {entry: entries[0]};
    }};
  const installed = await installClient(options);
  assert.equal(installed.installed, true);
  assert.deepEqual(requests.map(request => request.op), ['install']);
  assert.equal(requests[0].package.id, 'civ-stremio');
  assert.deepEqual(await readInstallState(path.join(support, 'civ-stremio-install-state.json')),
    {initialAddress: '10.0.0.5:39384',
      digest: crypto.createHash('sha256').update(installed.bytes).digest('hex'), checksum: installedChecksum(installed.item)});
  assert.equal((await installClient(options)).installed, false);
  assert.equal(requests.length, 1);
  macAddress = '10.0.0.6';
  assert.equal((await installClient(options)).installed, true);
  assert.equal(requests.length, 2);
  assert.equal((await readInstallState(path.join(support, 'civ-stremio-install-state.json'))).initialAddress,
    '10.0.0.6:39384');
  await assert.rejects(installClient({...options, probe: async () => ({
    state: {busy: false, closed: false, mode: 'app'}, entries
  })}), /Return to the CivHomebrew launcher/);
});

test('Mac bridge can start after installation without launching the Switch app', async t => {
  const support = await fs.mkdtemp(path.join(os.tmpdir(), 'civ-stremio-bridge-'));
  t.after(() => fs.rm(support, {recursive: true, force: true}));
  const requests = [];
  let entries = [], mode = 'launcher', macAddress = '10.0.0.5';
  const options = {projectRoot, consoleIP: '10.0.0.42', support,
    localAddress: async () => macAddress,
    probe: async () => ({state: {busy: false, closed: false, mode, app: 'civ-stremio'}, entries}),
    request: async (_address, operation) => {
      requests.push(operation);
      entries = [{id: operation.package.id, checksum: installedChecksum(operation.package)}];
      return {entry: entries[0]};
    }};
  assert.equal(await prepareBridgeClient(options), null);
  const installed = await prepareBridgeClient({...options, install: true});
  assert.equal(installed.installed, true);
  assert.deepEqual(requests.map(operation => operation.op), ['install']);
  assert.equal((await prepareBridgeClient(options)).installed, false);
  mode = 'app';
  assert.equal((await prepareBridgeClient(options)).installed, false);
  assert.deepEqual(requests.map(operation => operation.op), ['install']);
  macAddress = '10.0.0.6';
  assert.equal((await prepareBridgeClient(options)).pendingUpdate, true);
  assert.deepEqual(requests.map(operation => operation.op), ['install']);
  mode = 'launcher';
  assert.equal((await prepareBridgeClient(options)).installed, true);
  assert.deepEqual(requests.map(operation => operation.op), ['install', 'install']);
});

test('Stremio refreshes an old Switch package without a local install marker', async t => {
  const support = await fs.mkdtemp(path.join(os.tmpdir(), 'civ-stremio-refresh-'));
  t.after(() => fs.rm(support, {recursive: true, force: true}));
  const requests = [];
  let entries = [{id: 'civ-stremio', checksum: '00000000'}];
  const options = {projectRoot, consoleIP: '10.0.0.42', support,
    localAddress: async () => '10.0.0.5',
    probe: async () => ({state: {busy: false, closed: false, mode: 'launcher'}, entries}),
    request: async (_address, operation) => {
      requests.push(operation);
      entries = [{id: operation.package.id, checksum: installedChecksum(operation.package)}];
      return {entry: entries[0]};
    }};
  const refreshed = await prepareBridgeClient(options);
  assert.equal(refreshed.installed, true);
  assert.equal(requests.length, 1);
  const state = await readInstallState(path.join(support, 'civ-stremio-install-state.json'));
  assert.equal(state.checksum, entries[0].checksum);
  await fs.rm(path.join(support, 'civ-stremio-install-state.json'));
  assert.equal((await prepareBridgeClient(options)).installed, false);
  assert.equal(requests.length, 1);
  assert.equal((await readInstallState(path.join(support, 'civ-stremio-install-state.json'))).checksum,
    entries[0].checksum);
});

test('Mac bridge sends account progress and routes touch to the existing playback controller', async t => {
  let callbacks, touches = 0;
  const updates = [];
  const player = {playback: {position: 0, paused: false},
    async init() { return true; }, close() {}, setMediaTracks() {}, tickOverlay() {},
    updatePlayback(next) { Object.assign(this.playback, next); },
    getMenuModel() { return {view: 'playing', isPlaying: true, playback: this.playback}; },
    async handleTouch() { touches++; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false,
    createController: options => { callbacks = options.callbacks; return player; },
    probe: async () => ({duration: 120, audioTrackId: 1,
      audioTracks: [{id: 1, label: 'English', language: 'en'}]}),
    onAccountProgress: update => updates.push(update)});
  t.after(() => session.close());
  await callbacks.play({url: 'https://example.com/movie',
    libraryInfo: {itemId: 'tt12345', videoId: 'tt12345', type: 'movie', name: 'Test movie'}});
  assert.equal(updates[0].itemId, 'tt12345');
  assert.equal(updates[0].sequence, 1);
  assert.equal(updates[0].ended, false);
  const response = await fetch(session.origin + '/touch', {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({phase: 'tap', x: 300, y: 500})});
  assert.equal(response.status, 200);
  assert.equal(touches, 1);
  await callbacks.pause();
  assert.equal(updates.at(-1).paused, true);
  assert.equal(updates.at(-1).reason, 'pause');
  player.playback.position = 77;
  await callbacks.seek(10);
  assert.equal(session.state.selected.position, 87);
  assert.equal(updates.at(-1).position, 87);
});

test('Mac bridge serves bounded artwork only for the current Stremio view', async t => {
  const bytes = await fs.readFile(path.join(__dirname, 'icon.png'));
  const artwork = 'https://images.example.test/poster.png';
  let downloads = 0;
  const player = {playback: {position: 0, paused: false},
    async init() { return true; }, close() {},
    getMenuModel() { return {view: 'catalog', hero: {poster: artwork}, cards: []}; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false, createController: () => player,
    fetchArtwork: async url => {
      assert.equal(url, artwork); downloads++;
      return new Response(bytes, {headers: {'content-type': 'image/png'}});
    }});
  t.after(() => session.close());
  const route = '/artwork?url=' + encodeURIComponent(artwork);
  for (let i = 0; i < 2; i++) {
    const reply = await fetch(session.origin + route);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await reply.arrayBuffer()), bytes);
  }
  const nativeReply = await fetch(session.origin + '/artwork-data?url=' + encodeURIComponent(artwork));
  assert.equal(nativeReply.status, 200);
  assert.equal((await nativeReply.json()).data, `data:image/png;base64,${bytes.toString('base64')}`);
  assert.equal(downloads, 1);
  assert.equal((await fetch(session.origin + '/artwork?url=' +
    encodeURIComponent('http://127.0.0.1/private'))).status, 404);
  assert.equal((await fetch(session.origin + '/artwork-data?url=' +
    encodeURIComponent('http://127.0.0.1/private'))).status, 404);
  assert.equal((await fetch('http://127.0.0.1:' + session.port + '/wrong' + route)).status, 404);
});

test('Mac bridge serves artwork from the last delivered view after selection changes', async t => {
  const bytes = await fs.readFile(path.join(__dirname, 'icon.png'));
  const backdrop = 'https://images.example.test/backdrop.png';
  let selected = true;
  const player = {playback: {position: 0, paused: false}, async init() { return true; }, close() {},
    getMenuModel() { return {view: 'catalog', hero: selected ? {background: backdrop} : null, cards: []}; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false, createController: () => player,
    fetchArtwork: async () => new Response(bytes, {headers: {'content-type': 'image/png'}})});
  t.after(() => session.close());
  assert.equal((await fetch(session.origin + '/state')).status, 200);
  selected = false;
  const reply = await fetch(session.origin + '/artwork-data?url=' + encodeURIComponent(backdrop));
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).data, `data:image/png;base64,${bytes.toString('base64')}`);
  assert.equal((await fetch(session.origin + '/artwork-data?url=' +
    encodeURIComponent('https://images.example.test/unseen.png'))).status, 404);
});

test('Mac bridge accepts a larger poster after CDN redirects within the native response budget', async t => {
  const poster = 'https://images.example.test/first';
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(1200 * 1024)]);
  const visited = [];
  const player = {playback: {position: 0, paused: false}, async init() { return true; }, close() {},
    getMenuModel() { return {view: 'catalog', cards: [{poster}]}; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false, createController: () => player,
    fetchArtwork: async url => {
      visited.push(url);
      if (visited.length < 4) return new Response(null, {status: 302,
        headers: {location: `https://images.example.test/redirect-${visited.length}`}});
      return new Response(bytes, {headers: {'content-type': 'image/png'}});
    }});
  t.after(() => session.close());
  const reply = await fetch(session.origin + '/artwork-data?url=' + encodeURIComponent(poster));
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).data, `data:image/png;base64,${bytes.toString('base64')}`);
  assert.equal(visited.length, 4);
});

test('Mac bridge resizes a large backdrop for the native image client', {skip: process.platform !== 'darwin'}, async t => {
  const backdrop = 'https://images.example.test/large-backdrop.png';
  const bytes = execFileSync('python3', ['-c', `
import binascii, os, struct, sys, zlib
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data))
width, height = 1024, 768
rows = b''.join(b'\\0' + os.urandom(width * 3) for _ in range(height))
sys.stdout.buffer.write(b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
`], {maxBuffer: 4 * 1024 * 1024});
  assert.ok(bytes.length > 1.4 * 1024 * 1024);
  const player = {playback: {position: 0, paused: false}, async init() { return true; }, close() {},
    getMenuModel() { return {view: 'catalog', hero: {background: backdrop}, cards: []}; }};
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1',
    allowLoopback: true, includeSample: false, createController: () => player,
    fetchArtwork: async () => new Response(bytes, {headers: {'content-type': 'image/png'}})});
  t.after(() => session.close());
  const reply = await fetch(session.origin + '/artwork-data?url=' + encodeURIComponent(backdrop));
  assert.equal(reply.status, 200);
  const image = (await reply.json()).data;
  assert.match(image, /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.from(image.split(',')[1], 'base64').length < 1.4 * 1024 * 1024);
});

test('Mac bridge navigates the existing Stremio catalog and streams playable H.264/Opus packets', async t => {
  const session = await create({projectRoot, consoleIP: '127.0.0.1', host: '127.0.0.1', allowLoopback: true});
  t.after(() => session.close());
  const request = async (route, body) => {
    const reply = await fetch(session.origin + route, body === undefined ? {} : {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
    });
    assert.equal(reply.status, 200);
    return reply.json();
  };
  assert.equal((await request('/state')).model.view, 'catalog');
  for (const view of ['details', 'sources', 'playing']) {
    await request('/button', {button: 'a'});
    assert.equal((await request('/state')).model.view, view);
  }
  const playing = await request('/state');
  assert.ok(playing.playback.url.startsWith(session.origin + '/stream?'));
  assert.doesNotMatch(JSON.stringify(playing), /127\.0\.0\.1:\d+\/[0-9a-f]{48}\/sample\.mp4/);
  const response = await fetch(playing.playback.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/x-matroska');
  const reference = JSON.parse(await fs.readFile(mediaPackage, 'utf8'));
  const sandbox = {window: {}, Uint8Array, DataView, TextDecoder, Error, Math, Number, BigInt};
  vm.runInNewContext(reference.scripts.find(script => script.name === 'matroska.js').source, sandbox);
  let tracks, video = 0, audio = 0;
  const demux = sandbox.window.JellyfinMatroska.create({cancel: {cancelled: false},
    onTracks: result => { tracks = result; },
    onPacket: packet => { if (packet.kind === 'video') video++; else audio++; }});
  for await (const chunk of response.body) await demux.push(new Uint8Array(chunk));
  await demux.finish();
  assert.equal(tracks.video.width, 1280);
  assert.equal(tracks.video.height, 720);
  assert.ok(tracks.audio);
  assert.ok(video >= 30 && audio >= 30);
  await request('/button', {button: 'x'});
  await request('/button', {button: 'stopPlayback'});
  assert.equal((await request('/state')).model.view, 'sources');
  const wrongToken = await fetch('http://127.0.0.1:' + session.port + '/bad/state');
  assert.equal(wrongToken.status, 404);
});
