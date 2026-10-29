'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createController, renderMenu} = require('./controller.cjs');
const {SourcePreferences} = require('./source-preferences.cjs');

async function selectDetailsAction(controller, action) {
  const index = controller.getMenuModel().actions.findIndex(entry => entry.action === action);
  assert.ok(index >= 0, `Missing details action: ${action}`);
  controller.selected = index;
  return controller.handleButton('a');
}

async function fixture(t, callbacks = {}) {
  const requests = [], calls = [], logs = [];
  let failCatalog = false;
  const instance = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture'); requests.push(url.pathname);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/manifest.json') response.end(JSON.stringify({id: 'fixture', name: 'Fixture', types: ['series'],
      resources: ['catalog', 'meta', 'stream'], catalogs: [{id: 'top', name: 'Shows', type: 'series'}]}));
    else if (url.pathname.startsWith('/catalog/')) {
      if (failCatalog) response.writeHead(502).end('{}');
      else response.end(JSON.stringify({metas: Array.from({length: 11}, (_, index) => ({id: `show:${index}`, type: 'series', name: `Show ${index}`}))}));
    } else if (url.pathname.startsWith('/meta/')) response.end(JSON.stringify({meta: {id: 'show:0', type: 'series', name: 'Show 0',
      description: 'A real series metadata fixture.', videos: [{id: 'show:0:1:1', title: 'Pilot', season: 1, episode: 1}]}}));
    else if (url.pathname.startsWith('/stream/')) response.end(JSON.stringify({streams: [{name: 'Torrent source', infoHash: 'unsupported'},
      {name: 'Direct HLS', url: `http://127.0.0.1:${instance.address().port}/video.m3u8?token=STREAMSECRET`,
        behaviorHints: {proxyHeaders: {request: {Authorization: 'Bearer HEADERSECRET'}}}}]}));
    else response.writeHead(404).end('{}');
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  const defaults = Object.fromEntries(['play', 'pause', 'seek', 'seekTo', 'stop'].map(name => [name, async value => {calls.push({name, value});}]));
  const controller = createController({addonUrls: [`http://127.0.0.1:${instance.address().port}/manifest.json?apiKey=ADDONSECRET`],
    callbacks: {...defaults, ...callbacks}, onLog: value => logs.push(value)});
  assert.equal(await controller.init(), true);
  return {controller, calls, logs, requests, failCatalog: () => {failCatalog = true;}};
}

test('catalog, series episodes and sources lead to actual playback callbacks and controls', async t => {
  const {controller, calls, logs, requests} = await fixture(t);
  assert.equal(controller.getMenuModel().count, 11);
  assert.equal(controller.getMenuModel().rows.length, 4);
  for (let index = 0; index < 10; index++) await controller.handleButton('right');
  assert.equal(controller.getMenuModel().offset, 8);
  assert.equal(controller.getMenuModel().rows.at(-1).label, 'Show 10');
  for (let index = 0; index < 10; index++) await controller.handleButton('left');
  await controller.handleButton('a'); assert.equal(controller.getMenuModel().view, 'details');
  await selectDetailsAction(controller, 'watch'); assert.equal(controller.getMenuModel().view, 'seasons');
  assert.equal(controller.getMenuModel().rows[0].label, 'Season 1');
  await controller.handleButton('a'); assert.equal(controller.getMenuModel().view, 'episodes');
  assert.match(controller.getMenuModel().rows[0].label, /S01E01.*Pilot/);
  await controller.handleButton('a'); assert.equal(controller.getMenuModel().view, 'sources');
  await controller.handleButton('a');
  assert.match(controller.getMenuModel().message, /Torrent sources/); assert.equal(calls.length, 0);
  await controller.handleButton('down'); await controller.handleButton('a');
  assert.equal(controller.getMenuModel().isPlaying, true);
  assert.equal(calls[0].name, 'play'); assert.match(calls[0].value.url, /video\.m3u8/);
  assert.equal(calls[0].value.headers.Authorization, 'Bearer HEADERSECRET');
  assert.equal(calls[0].value.meta.videoId, 'show:0:1:1');
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  await controller.handleButton('a'); assert.equal(controller.playback.paused, true);
  await controller.handleButton('right'); await controller.handleButton('left');
  await controller.handleButton('zr'); await controller.handleButton('zl');
  assert.equal(await controller.handleButton('down'), false);
  assert.equal(await controller.handleButton('up'), false);
  controller.setPlaybackInfo({position: 65, duration: 600, paused: false});
  assert.equal(controller.getMenuModel().subtitle, 'Playing · 1:05 / 10:00');
  assert.doesNotMatch(controller.getMenuModel().footer, /Vol/);
  await controller.handleButton('b'); assert.equal(controller.getMenuModel().view, 'playing');
  await controller.handleButton('b'); assert.equal(controller.getMenuModel().view, 'sources');
  assert.deepEqual(calls.slice(1).map(call => [call.name, call.value]), [['pause', undefined], ['seek', 10], ['seek', -10], ['stop', undefined]]);
  await controller.handleButton('b'); assert.equal(controller.getMenuModel().view, 'episodes');
  await controller.handleButton('b'); await controller.handleButton('b'); await controller.handleButton('b'); await controller.handleButton('b');
  assert.equal(controller.getMenuModel().navigation.focus.area, 'sidebar');
  await controller.handleButton('down'); await controller.handleButton('down'); await controller.handleButton('a');
  assert.equal(controller.getMenuModel().view, 'catalogs');
  assert.ok(requests.some(route => /stream\/series\/show%3A0%3A1%3A1\.json/.test(route)));
  assert.ok(logs.every(message => !/ADDONSECRET|STREAMSECRET|HEADERSECRET/.test(message)));
});

test('network failure stays visible and stale playback start cannot override an asynchronous failure', async t => {
  let finishPlay, started;
  const entered = new Promise(resolve => {started = resolve;});
  const {controller, failCatalog} = await fixture(t, {play: async () => {started(); await new Promise(resolve => {finishPlay = resolve;});}});
  await controller.handleButton('a'); await selectDetailsAction(controller, 'watch'); await controller.handleButton('a'); await controller.handleButton('a'); await controller.handleButton('down');
  const playing = controller.handleButton('a'); await entered;
  controller.playbackFailed('Decoder could not open https://user:secret@example.invalid/path?token=SECRET');
  finishPlay(); await playing;
  assert.equal(controller.getMenuModel().view, 'sources'); assert.equal(controller.getMenuModel().isPlaying, false);
  assert.match(controller.getMenuModel().message, /Decoder could not open/);
  assert.equal(controller.getMenuModel().message.includes('SECRET'), false);
  await controller.handleButton('b'); await controller.handleButton('b'); await controller.handleButton('b'); await controller.handleButton('b');
  failCatalog(); await controller.handleButton('x');
  assert.match(controller.getMenuModel().message, /HTTP 502/);
});

test('menu renderer produces a complete opaque frame with visible selection and bounded rows', async t => {
  const bundled = path.resolve(__dirname, '../.build-gui/homebrew');
  const python = process.env.STREMIO_TEST_PYTHON || (fs.existsSync(path.join(bundled, 'python/bin/python3')) ? path.join(bundled, 'python/bin/python3') : 'python3');
  const fontPath = process.env.STREMIO_TEST_FONT || (fs.existsSync(path.join(bundled, 'fonts/DejaVuSans.ttf')) ? path.join(bundled, 'fonts/DejaVuSans.ttf') : '');
  if (spawnSync(python, ['-c', 'from PIL import Image'], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}}).status !== 0) {
    t.skip('The portable Python/Pillow runtime is required for raster verification.'); return;
  }
  const model = {title: 'Stremio compatible · alpha', subtitle: 'Fixture catalog',
    rows: Array.from({length: 8}, (_, index) => ({label: `Movie ${index}`, detail: '2026'})), selected: 4,
    message: 'A source failed; select another source.', footer: 'A Select  B Back  X Refresh  Y Catalog'};
  const bytes = await renderMenu(model, {python, fontPath});
  assert.equal(bytes.length, 1280 * 720 * 4);
  assert.ok(bytes.every((value, index) => index % 4 !== 3 || value === 255));
  const firstSelected = await renderMenu({...model, selected: 0}, {python, fontPath});
  assert.notDeepEqual(bytes, firstSelected);
});

test('closing the controller aborts pending addon networking and stops menu updates', async t => {
  let catalogStarted;
  const started = new Promise(resolve => {catalogStarted = resolve;});
  const instance = http.createServer((request, response) => {
    if (request.url === '/manifest.json') response.end(JSON.stringify({id: 'fixture', types: ['movie'], resources: ['catalog'],
      catalogs: [{id: 'slow', type: 'movie'}]}));
    else catalogStarted(); // A deliberately uncompleted real HTTP response.
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {instance.closeAllConnections(); instance.close(resolve);}));
  let updates = 0;
  const controller = createController({addonUrls: [`http://127.0.0.1:${instance.address().port}/manifest.json`],
    onChange: () => {updates++;}});
  const pending = controller.init(); await started;
  const atClose = updates, before = performance.now(); controller.close();
  assert.equal(await pending, false);
  assert.ok(performance.now() - before < 1000);
  assert.equal(updates, atClose);
  assert.equal(await controller.handleButton('a'), false);
});

test('TV metadata programme lists do not change channel stream IDs', async () => {
  const calls = [];
  const controller = createController({callbacks: {play: async source => {calls.push(source);}}});
  controller.view = 'details';
  controller.meta = {id: 'channel:1', type: 'tv', name: 'Fixture TV', description: '', releaseInfo: '',
    videos: [{id: 'programme:1', title: 'Now'}, {id: 'programme:2', title: 'Next'}]};
  controller.addons.streams = async (type, id) => {
    assert.equal(type, 'tv'); assert.equal(id, 'channel:1');
    return [{label: 'HTTP', addonName: 'Fixture', playable: true, url: 'https://media.example.invalid/live.m3u8', headers: {}}];
  };
  assert.equal(controller.getMenuModel().rows[0].label, 'Choose a stream');
  await controller.handleButton('a'); assert.equal(controller.view, 'sources');
  await controller.handleButton('a');
  assert.equal(calls[0].meta.videoId, 'channel:1');
  controller.close();
});

function visualMeta(index) {
  return {id: `show:${index}`, type: 'series', name: `Show ${index}`, releaseInfo: '2026',
    poster: `https://images.example.invalid/poster-${index}.jpg`,
    background: 'https://images.example.invalid/background.jpg', logo: 'https://images.example.invalid/logo.png',
    description: 'A rich metadata fixture. '.repeat(20), genres: ['Drama', 'Mystery'], runtime: '45 min', imdbRating: '8.2',
    videos: [{id: `show:${index}:1:1`, title: 'First episode', season: 1, episode: 1, released: '2026-10-01'},
      {id: `show:${index}:1:2`, title: 'Second episode', season: 1, episode: 2, released: '2026-10-08'}]};
}

async function visualFixture({libraryItems = [], callbacks = {}} = {}) {
  const requests = [], calls = [];
  const controller = createController({addonUrls: ['https://addon.example.invalid/manifest.json'], libraryItems,
    callbacks: {play: async source => {calls.push(source);}, stop: async () => {}, ...callbacks}, fetchImpl: async url => {
      const pathname = new URL(url).pathname; requests.push(pathname);
      let payload;
      if (pathname === '/manifest.json') payload = {id: 'fixture', name: 'Fixture addon', types: ['series'],
        resources: ['catalog', 'meta', 'stream'], catalogs: Array.from({length: 13}, (_, index) =>
          ({id: `top-${index}`, name: `Catalog ${index}`, type: 'series'}))};
      else if (pathname.startsWith('/catalog/')) payload = {metas: Array.from({length: 11}, (_, index) => visualMeta(index))};
      else if (pathname.startsWith('/meta/')) payload = {meta: visualMeta(Number(decodeURIComponent(pathname.split('/')[3]).match(/^show:(\d+)/)[1]))};
      else if (pathname.startsWith('/stream/')) payload = {streams: [{name: 'Torrent fixture', infoHash: 'unsupported'},
        {name: 'Direct fixture', url: 'https://media.example.invalid/video.m3u8?token=STREAMSECRET',
          behaviorHints: {proxyHeaders: {request: {Authorization: 'Bearer HEADERSECRET'}}}}]};
      else throw Error('Unexpected fixture request');
      return new Response(JSON.stringify(payload), {headers: {'content-type': 'application/json'}});
    }});
  assert.equal(await controller.init(), true);
  return {controller, requests, calls};
}

test('visual presentation keeps poster selection, bounded catalog tabs and existing navigation aligned', async t => {
  const {controller, requests} = await visualFixture(); t.after(() => controller.close());
  let model = controller.getMenuModel();
  assert.equal(model.brand, 'Stremio'); assert.equal(model.view, 'catalog');
  assert.equal(model.cards.length, 4); assert.equal(model.cards[0].poster, 'https://images.example.invalid/poster-0.jpg');
  assert.deepEqual(model.breadcrumb, ['Discover', 'Catalog 0']);
  assert.equal(model.hero.title, 'Show 0'); assert.equal(model.hero.rating, '8.2');
  assert.deepEqual(model.hero.genres, ['Drama', 'Mystery']); assert.equal(model.hero.runtime, '45 min');
  assert.equal(model.cards[0].description.length, 180); assert.ok(model.hero.description.length > 180);
  for (let index = 0; index < 10; index++) await controller.handleButton('right');
  model = controller.getMenuModel();
  assert.equal(model.offset, 8); assert.equal(model.selected, 2); assert.equal(model.cards.at(-1).index, 10);
  assert.equal(model.cards.filter(card => card.selected).length, 1); assert.equal(model.cards.at(-1).selected, true);
  assert.equal(model.hero.id, 'show:10'); assert.equal(model.rows.at(-1).index, 10);
  await controller.handleButton('b');
  await controller.handleButton('down'); await controller.handleButton('down'); await controller.handleButton('a');
  for (let index = 0; index < 10; index++) await controller.handleButton('down');
  model = controller.getMenuModel(); assert.equal(model.view, 'catalogs');
  assert.equal(model.tabs.length, 7); assert.equal(model.tabCount, 13); assert.equal(model.tabOffset, 6);
  assert.equal(model.tabs.find(tab => tab.selected).label, 'Catalog 10');
  await controller.handleButton('a'); model = controller.getMenuModel();
  assert.equal(model.catalog.index, 10); assert.equal(model.tabs.find(tab => tab.active).label, 'Catalog 10');
  await controller.handleButton('a'); model = controller.getMenuModel();
  assert.equal(model.view, 'details'); assert.equal(model.actions[0].action, 'currentSeason');
  assert.deepEqual(model.breadcrumb, ['Discover', 'Catalog 10', 'Show 0']);
  assert.equal(model.hero.background, 'https://images.example.invalid/background.jpg');
  await selectDetailsAction(controller, 'watch'); model = controller.getMenuModel();
  assert.equal(model.view, 'seasons'); assert.equal(model.rows[0].label, 'Season 1'); assert.equal(model.rows[0].episodeCount, 2);
  await controller.handleButton('a'); model = controller.getMenuModel();
  assert.equal(model.view, 'episodes'); assert.equal(model.rows[0].season, 1); assert.equal(model.rows[0].episode, 1);
  assert.equal(model.rows[0].title, 'First episode'); assert.equal(model.rows[0].released, '2026-10-01');
  assert.ok(requests.every(route => !/images/.test(route)));
});

test('L/R switches top catalog tabs while browsing and wraps around library tabs', async t => {
  const saved = {_id: 'show:0', type: 'series', name: 'Show 0', removed: false, temp: false,
    state: {video_id: 'show:0:1:1', timeOffset: 52000, duration: 120000}};
  const {controller} = await visualFixture({libraryItems: [saved]}); t.after(() => controller.close());
  assert.equal(controller.getMenuModel().catalog.name, 'Continue watching');
  assert.equal(await controller.handleButton('l'), true);
  assert.equal(controller.getMenuModel().catalog.name, 'Catalog 12');
  assert.equal(await controller.handleButton('r'), true);
  assert.equal(controller.getMenuModel().catalog.name, 'Continue watching');
  await controller.handleButton('r');
  assert.equal(controller.getMenuModel().catalog.name, 'My Library');
  await controller.handleButton('r');
  assert.equal(controller.getMenuModel().catalog.name, 'Catalog 0');
  await controller.handleButton('a');
  assert.equal(controller.getMenuModel().view, 'details');
  await controller.handleButton('r');
  assert.equal(controller.getMenuModel().view, 'catalog');
  assert.equal(controller.getMenuModel().catalog.name, 'Catalog 1');
  assert.equal(controller.getMenuModel().tabs.find(tab => tab.active).label, 'Catalog 1');
});

test('visual presentation exposes resume progress while source selection preserves exact playback identity', async t => {
  const saved = {_id: 'show:0', type: 'series', name: 'Show 0', removed: false, temp: false,
    poster: 'https://images.example.invalid/saved.jpg', state: {video_id: 'show:0:1:2', timeOffset: 52000,
      duration: 120000, watched: 'OPAQUEWATCHEDSECRET', custom: 'CUSTOMSTATESECRET'}};
  const {controller, calls} = await visualFixture({libraryItems: [saved]}); t.after(() => controller.close());
  let model = controller.getMenuModel();
  assert.equal(model.catalog.kind, 'continue'); assert.equal(model.cards[0].inLibrary, true);
  assert.equal(model.cards[0].canResume, true);
  assert.deepEqual(model.cards[0].progress, {position: 52, duration: 120, ratio: 52 / 120, label: '0:52 / 2:00'});
  await controller.handleButton('a'); model = controller.getMenuModel();
  assert.equal(model.actions[0].action, 'resume'); assert.equal(model.actions[0].id, 'show:0:1:2');
  assert.equal(model.actions[0].selected, true); assert.equal(model.hero.progress.position, 52);
  await controller.handleButton('a'); model = controller.getMenuModel();
  assert.equal(model.view, 'sources'); assert.equal(model.rows[0].playable, false);
  assert.equal(model.rows[1].provider, 'Fixture addon'); assert.equal(model.rows[1].playable, true);
  assert.equal(/STREAMSECRET|HEADERSECRET|OPAQUEWATCHEDSECRET|CUSTOMSTATESECRET/.test(JSON.stringify(model)), false);
  await controller.handleButton('down'); await controller.handleButton('a');
  assert.equal(calls[0].meta.videoId, 'show:0:1:2'); assert.equal(calls[0].resumePosition, 52);
  assert.equal(calls[0].headers.Authorization, 'Bearer HEADERSECRET');
  controller.updatePlayback({position: 72, duration: 120}); model = controller.getMenuModel();
  assert.equal(model.playback.position, 72); assert.equal(model.playback.ratio, 0.6);
  await controller.handleButton('b'); await controller.handleButton('b'); await controller.handleButton('b'); model = controller.getMenuModel();
  assert.equal(model.view, 'episodes'); assert.equal(model.rows[0].progress, null);
  assert.equal(model.rows[1].progress.position, 72);
});

test('resume reuses the last selected source while a different episode still opens source selection', async t => {
  const saved = {_id: 'show:0', type: 'series', name: 'Show 0', removed: false, temp: false,
    state: {video_id: 'show:0:1:2', timeOffset: 52000, duration: 120000}};
  const preferences = new SourcePreferences();
  const first = await visualFixture({libraryItems: [saved]}); t.after(() => first.controller.close());
  first.controller.sourcePreferences = preferences;
  await first.controller.handleButton('a');
  await first.controller.handleButton('a');
  assert.equal(first.controller.view, 'sources');
  await first.controller.handleButton('down'); await first.controller.handleButton('a');
  assert.equal(first.controller.view, 'playing');

  const resumed = await visualFixture({libraryItems: [saved]}); t.after(() => resumed.controller.close());
  resumed.controller.sourcePreferences = preferences;
  await resumed.controller.handleButton('a');
  await resumed.controller.handleButton('a');
  assert.equal(resumed.controller.view, 'playing');
  assert.equal(resumed.calls.length, 1);
  assert.equal(resumed.calls[0].resumePosition, 52);
  assert.equal(resumed.calls[0].meta.videoId, 'show:0:1:2');
  resumed.controller.playbackFailed('Source failed.');
  const failed = await visualFixture({libraryItems: [saved]}); t.after(() => failed.controller.close());
  failed.controller.sourcePreferences = preferences;
  await failed.controller.handleButton('a');
  await failed.controller.handleButton('a');
  assert.equal(failed.controller.view, 'sources');
  assert.equal(failed.calls.length, 0);
  await preferences.remember('series', 'show:0', 'show:0:1:2', first.controller.streams, 1);

  const next = await visualFixture({libraryItems: [saved]}); t.after(() => next.controller.close());
  next.controller.sourcePreferences = preferences;
  await next.controller.handleButton('a');
  await selectDetailsAction(next.controller, 'watch');
  await next.controller.handleButton('a');
  await next.controller.handleButton('a');
  assert.equal(next.controller.view, 'sources');
  assert.equal(next.calls.length, 0);
});

test('visual presentation remains within the renderer budget with maximum metadata and missing artwork', () => {
  const controller = createController();
  controller.catalogs = Array.from({length: 2000}, () => ({id: '界'.repeat(256), name: '界'.repeat(120), addonName: '界'.repeat(120)}));
  const imagePrefix = 'https://images.example.invalid/';
  const image = imagePrefix + 'p'.repeat(2048 - imagePrefix.length);
  controller.catalogItems = Array.from({length: 11}, (_, index) => ({id: String(index) + '界'.repeat(2047),
    name: '界'.repeat(120), type: '界'.repeat(64), poster: image, background: image, logo: image,
    description: '界'.repeat(600), releaseInfo: '界'.repeat(48), genres: Array(8).fill('界'.repeat(48)),
    runtime: '界'.repeat(48), rating: '界'.repeat(16), videos: []}));
  controller.libraryItems = controller.catalogItems.map(meta => ({_id: meta.id, type: 'movie', removed: false,
    temp: false, state: {timeOffset: 1000, duration: 2000, video_id: meta.id}}));
  assert.ok(Buffer.byteLength(JSON.stringify(controller.getMenuModel())) <= 65536);
  assert.equal(controller.getMenuModel().cards[0].id, undefined);
  controller.catalogItems.forEach((meta, index) => { meta.id = String(index) + '界'.repeat(127); });
  controller.libraryItems.forEach((item, index) => { item._id = controller.catalogItems[index].id; item.state.video_id = item._id; });
  assert.ok(Buffer.byteLength(JSON.stringify(controller.getMenuModel())) <= 65536);
  controller.catalogItems[0].poster = 'https://images.example.invalid/' + 'x'.repeat(2048);
  assert.equal(controller.getMenuModel().cards[0].poster, undefined);
  controller.catalogItems = []; assert.equal(controller.getMenuModel().hero, null);
  assert.deepEqual(controller.getMenuModel().cards, []);
  controller.close();
});

const touchTarget = (controller, target) => controller.handleTouch({x: target.x + target.width / 2,
  y: target.y + target.height / 2, phase: 'tap'});
const target = (controller, group, id) => controller.getMenuModel().navigation[group].find(entry => entry.id === id);

test('horizontal title navigation clamps at the ends and preserves content through tabs and sidebar focus', async t => {
  const {controller} = await visualFixture(); t.after(() => controller.close());
  await controller.handleButton('down'); assert.equal(controller.selected, 0);
  for (let index = 0; index < 14; index++) await controller.handleButton('right');
  let model = controller.getMenuModel();
  assert.equal(model.selectedIndex, 10); assert.deepEqual(model.cards.map(card => card.index), [8, 9, 10]);
  await controller.handleButton('up'); assert.equal(controller.focusArea, 'tabs');
  assert.equal(controller.selected, 10);
  await controller.handleButton('right'); assert.equal(controller.tabSelected, 1);
  await controller.handleButton('down'); assert.equal(controller.selected, 10); assert.equal(controller.focusArea, 'content');
  await controller.handleButton('b'); assert.equal(controller.focusArea, 'sidebar');
  assert.equal(controller.getMenuModel().navigation.sidebar.find(entry => entry.focused).label, 'Home');
  await controller.handleButton('right'); assert.equal(controller.focusArea, 'content'); assert.equal(controller.selected, 10);
  for (let index = 0; index < 10; index++) await controller.handleButton('left');
  assert.equal(controller.selected, 0); assert.equal(controller.focusArea, 'content');
  await controller.handleButton('left'); assert.equal(controller.focusArea, 'sidebar');
  await controller.handleButton('down'); await controller.handleButton('down'); await controller.handleButton('a');
  assert.equal(controller.view, 'catalogs');
  for (let index = 0; index < 20; index++) await controller.handleButton('down');
  assert.equal(controller.selected, 12); assert.equal(controller.getMenuModel().offset, 8);
  await controller.handleButton('a'); assert.equal(controller.catalogIndex, 12); assert.equal(controller.focusArea, 'content');
});

test('touch reaches every catalog and title page and opens the exact touched media on the first tap', async t => {
  const {controller, requests} = await visualFixture(); t.after(() => controller.close());
  await touchTarget(controller, target(controller, 'tabPaging', 'nextTabs'));
  let model = controller.getMenuModel();
  assert.equal(model.navigation.focus.area, 'tabs');
  assert.ok(model.tabs.some(tab => tab.index === 7));
  await touchTarget(controller, model.navigation.tabs.find(tab => tab.index === 7));
  assert.equal(controller.catalogIndex, 7);
  await touchTarget(controller, target(controller, 'tabPaging', 'nextTabs'));
  model = controller.getMenuModel();
  await touchTarget(controller, model.navigation.tabs.find(tab => tab.index === 12));
  assert.equal(controller.catalogIndex, 12);
  await touchTarget(controller, target(controller, 'paging', 'next'));
  assert.deepEqual(controller.getMenuModel().cards.map(card => card.index), [4, 5, 6, 7]);
  await touchTarget(controller, target(controller, 'paging', 'next'));
  model = controller.getMenuModel();
  assert.deepEqual(model.cards.map(card => card.index), [8, 9, 10]);
  assert.equal(await touchTarget(controller, target(controller, 'paging', 'next')), false);
  await touchTarget(controller, model.navigation.cards.find(card => card.index === 10));
  assert.equal(controller.view, 'details'); assert.equal(controller.meta.id, 'show:10');
  assert.ok(requests.includes('/meta/series/show%3A10.json'));
  const browseSeasons = controller.getMenuModel().actions.find(entry => entry.action === 'watch');
  await touchTarget(controller, controller.getMenuModel().navigation.actions.find(entry => entry.index === browseSeasons.index));
  assert.equal(controller.view, 'seasons');
  await touchTarget(controller, controller.getMenuModel().navigation.rows[0]);
  assert.equal(controller.view, 'episodes');
  await touchTarget(controller, controller.getMenuModel().navigation.rows[1]);
  assert.equal(controller.view, 'sources'); assert.equal(controller.video.id, 'show:10:1:2');
  assert.equal(await touchTarget(controller, controller.getMenuModel().navigation.rows[0]), false);
  await touchTarget(controller, target(controller, 'commands', 'back')); assert.equal(controller.view, 'episodes');
});

test('touch pages vertical episode, source and catalog lists using canonical indices', async t => {
  const calls = [], requests = [];
  const controller = createController({callbacks: {play: async source => calls.push(source)}}); t.after(() => controller.close());
  controller.meta = {...visualMeta(0), videos: Array.from({length: 19}, (_, index) => ({id: `episode:${index}`,
    title: `Episode ${index}`, season: 1, episode: index + 1, released: ''}))};
  controller.view = 'episodes';
  controller.addons.streams = async (type, id) => {
    requests.push(id);
    return Array.from({length: 19}, (_, index) => ({label: `Source ${index}`, addonName: 'Fixture', playable: true,
      url: `https://media.example.invalid/source-${index}`, headers: {}}));
  };
  await touchTarget(controller, target(controller, 'paging', 'next'));
  await touchTarget(controller, target(controller, 'paging', 'next'));
  assert.deepEqual(controller.getMenuModel().rows.map(row => row.index), [16, 17, 18]);
  await touchTarget(controller, controller.getMenuModel().navigation.rows[2]);
  assert.deepEqual(requests, ['episode:18']); assert.equal(controller.video.id, 'episode:18');
  await touchTarget(controller, target(controller, 'paging', 'next'));
  await touchTarget(controller, target(controller, 'paging', 'next'));
  await touchTarget(controller, controller.getMenuModel().navigation.rows[1]);
  assert.equal(calls[0].url, 'https://media.example.invalid/source-17');
  assert.equal(calls[0].meta.videoId, 'episode:18');
  controller.view = 'catalogs'; controller.selected = 0;
  controller.catalogs = Array.from({length: 19}, (_, index) => ({name: `Catalog ${index}`, addonName: 'Fixture',
    client: {catalog: async () => []}}));
  await touchTarget(controller, target(controller, 'paging', 'next'));
  await touchTarget(controller, target(controller, 'paging', 'next'));
  await touchTarget(controller, controller.getMenuModel().navigation.rows[2]);
  assert.equal(controller.catalogIndex, 18); assert.equal(controller.view, 'catalog');
  assert.equal(controller.getMenuModel().hero, null);
  assert.equal(controller.getMenuModel().navigation.cards.length, 0);
  assert.equal(await controller.handleTouch({x: 300, y: 450}), false);
});

test('sidebar Home, Library and Catalogs work by touch, with usable empty and account library states', async t => {
  const {controller} = await visualFixture(); t.after(() => controller.close());
  await touchTarget(controller, target(controller, 'sidebar', 'library'));
  let model = controller.getMenuModel();
  assert.equal(model.catalog.kind, 'library'); assert.equal(model.count, 0); assert.match(model.message, /Sign in to Stremio/);
  assert.equal(model.navigation.sidebar.find(entry => entry.active).id, 'library');
  await touchTarget(controller, target(controller, 'commands', 'refresh'));
  assert.equal(controller.getMenuModel().catalog.kind, 'library');
  await touchTarget(controller, target(controller, 'sidebar', 'catalogs'));
  assert.equal(controller.view, 'catalogs');
  await touchTarget(controller, target(controller, 'sidebar', 'home'));
  assert.equal(controller.view, 'catalog'); assert.equal(controller.catalogIndex, 0); assert.equal(controller.getMenuModel().count, 11);
  const saved = {_id: 'show:3', type: 'series', name: 'Account title', removed: false, temp: false,
    state: {video_id: 'show:3:1:2', timeOffset: 52000, duration: 120000}};
  const account = (await visualFixture({libraryItems: [saved]})).controller; t.after(() => account.close());
  await touchTarget(account, target(account, 'sidebar', 'library'));
  model = account.getMenuModel();
  assert.equal(model.catalog.kind, 'library'); assert.equal(model.cards[0].id, 'show:3');
  assert.deepEqual(model.navigation.sidebar.map(entry => entry.label), ['Home', 'Library', 'Catalogs']);
  await touchTarget(account, model.navigation.cards[0]);
  assert.equal(account.meta.id, 'show:3'); assert.equal(account.getMenuModel().actions[0].action, 'resume');
});

test('failed touched catalog loads preserve the current catalog and reject pending or invalid input', async t => {
  const {controller} = await visualFixture(); t.after(() => controller.close());
  const items = controller.catalogItems, catalog = controller.catalogIndex;
  let finish;
  controller.catalogs[1].client.catalog = async () => new Promise((resolve, reject) => {finish = reject;});
  const tapped = controller.getMenuModel().navigation.tabs.find(tab => tab.index === 1);
  const pending = touchTarget(controller, tapped);
  assert.equal(controller.busy, true);
  assert.equal(await controller.handleButton('right'), false);
  assert.equal(await touchTarget(controller, tapped), false);
  finish(Error('Catalog failed https://user:secret@example.invalid/?token=SECRET'));
  assert.equal(await pending, false);
  assert.equal(controller.catalogItems, items); assert.equal(controller.catalogIndex, catalog); assert.equal(controller.view, 'catalog');
  assert.match(controller.getMenuModel().message, /Catalog failed/);
  assert.doesNotMatch(controller.getMenuModel().message, /SECRET|secret/);
  for (const touch of [{x: -1, y: 0}, {x: 1280, y: 0}, {x: 0, y: 720}, {x: 300, y: 300},
    {x: tapped.x, y: tapped.y, phase: 'move'}, {x: tapped.x, y: tapped.y, phase: 'end'}])
    assert.equal(await controller.handleTouch(touch), false);
  controller.close(); assert.equal(await touchTarget(controller, tapped), false);
});

function seasonFixture(videos, {libraryItems = []} = {}) {
  const calls = [], requests = [];
  const controller = createController({libraryItems, callbacks: {play: async value => calls.push(value), stop: async () => {}}});
  controller.view = 'details';
  controller.meta = {...visualMeta(0), videos: videos.map((video, index) => ({id: `episode:${index}`, title: `Episode ${index}`,
    episode: index + 1, released: '', ...video}))};
  controller.libraryItem = controller.libraryItems[0] || null;
  controller.addons.streams = async (type, id) => {
    requests.push([type, id]);
    return [{label: 'Direct', addonName: 'Fixture', playable: true, url: 'https://media.example.invalid/video', headers: {}}];
  };
  return {controller, calls, requests};
}

test('series choose seasons before filtered episodes, including Specials and unknown seasons', async t => {
  const {controller, requests} = seasonFixture([{season: 2}, {season: 0}, {season: 1}, {season: null},
    {season: 2}, {season: undefined}]); t.after(() => controller.close());
  assert.equal(controller.getMenuModel().actions.find(entry => entry.action === 'watch').label, 'Browse seasons (4)');
  await selectDetailsAction(controller, 'watch');
  let model = controller.getMenuModel();
  assert.equal(model.view, 'seasons'); assert.equal(model.subtitle, 'Choose a season');
  assert.deepEqual(model.rows.map(row => [row.label, row.season, row.episodeCount]),
    [['Specials', 0, 1], ['Season 1', 1, 1], ['Season 2', 2, 2], ['Other episodes', null, 2]]);
  await touchTarget(controller, model.navigation.rows[2]);
  model = controller.getMenuModel();
  assert.equal(model.view, 'episodes'); assert.equal(model.selectedSeason, 2);
  assert.deepEqual(model.rows.map(row => [row.index, row.videoIndex, row.id]), [[0, 0, 'episode:0'], [1, 4, 'episode:4']]);
  assert.match(model.subtitle, /Season 2/); assert.ok(model.breadcrumb.includes('Season 2'));
  await touchTarget(controller, model.navigation.rows[1]);
  assert.deepEqual(requests, [['series', 'episode:4']]); assert.equal(controller.episodeSelected, 4);
  await controller.handleButton('b'); assert.equal(controller.view, 'episodes'); assert.equal(controller.selected, 1);
  await controller.handleButton('b'); assert.equal(controller.view, 'seasons'); assert.equal(controller.selected, 2);
  await touchTarget(controller, controller.getMenuModel().navigation.rows[0]);
  assert.equal(controller.selectedSeason, 0); assert.equal(controller.getMenuModel().rows[0].id, 'episode:1');
  await controller.handleButton('b'); await touchTarget(controller, controller.getMenuModel().navigation.rows[3]);
  assert.deepEqual(controller.getMenuModel().rows.map(row => row.id), ['episode:3', 'episode:5']);
  await controller.handleButton('b'); await controller.handleButton('b'); assert.equal(controller.view, 'details');
});

test('season and filtered episode pages keep original video identity through failed and successful source lookups', async t => {
  const {controller, calls, requests} = seasonFixture(Array.from({length: 144}, (_, index) =>
    ({season: Math.floor(index / 12) + 1, episode: index % 12 + 1}))); t.after(() => controller.close());
  await selectDetailsAction(controller, 'watch');
  await touchTarget(controller, target(controller, 'paging', 'next'));
  let model = controller.getMenuModel();
  assert.deepEqual(model.rows.map(row => row.season), [9, 10, 11, 12]);
  await touchTarget(controller, model.navigation.rows[2]);
  await touchTarget(controller, target(controller, 'paging', 'next'));
  model = controller.getMenuModel();
  assert.equal(model.count, 12); assert.deepEqual(model.rows.map(row => row.videoIndex), [128, 129, 130, 131]);
  controller.addons.streams = async (type, id) => {requests.push([type, id]); throw Error('Source lookup failed');};
  assert.equal(await touchTarget(controller, model.navigation.rows[3]), false);
  assert.equal(controller.view, 'episodes'); assert.equal(controller.selectedSeason, 11); assert.equal(controller.selected, 11);
  assert.match(controller.getMenuModel().message, /Source lookup failed/);
  controller.addons.streams = async (type, id) => {
    requests.push([type, id]);
    return Array.from({length: 12}, (_, index) => ({label: `Source ${index}`, addonName: 'Fixture', playable: true,
      url: `https://media.example.invalid/${index}`, headers: {}}));
  };
  await touchTarget(controller, model.navigation.rows[3]);
  assert.equal(controller.video.id, 'episode:131'); assert.equal(controller.episodeSelected, 131);
  await touchTarget(controller, target(controller, 'paging', 'next'));
  await touchTarget(controller, controller.getMenuModel().navigation.rows[3]);
  assert.equal(calls[0].url, 'https://media.example.invalid/11'); assert.equal(calls[0].meta.videoId, 'episode:131');
  assert.equal(calls[0].libraryInfo.season, 11); assert.equal(calls[0].libraryInfo.episode, 12);
  assert.deepEqual(requests, [['series', 'episode:131'], ['series', 'episode:131']]);
});

test('saved resume bypasses seasons and Back restores its season and filtered episode selection', async t => {
  const saved = {_id: 'show:0', type: 'series', name: 'Saved show', removed: false, temp: false,
    state: {video_id: 'episode:3', timeOffset: 52000, duration: 120000}};
  const {controller, requests} = seasonFixture([{season: 1}, {season: 0}, {season: 2}, {season: 2}],
    {libraryItems: [saved]}); t.after(() => controller.close());
  assert.equal(controller.getMenuModel().actions[0].action, 'resume');
  await controller.handleButton('a');
  assert.equal(controller.view, 'sources'); assert.deepEqual(requests, [['series', 'episode:3']]);
  assert.equal(controller.selectedSeason, 2); assert.equal(controller.episodeSelected, 3);
  await controller.handleButton('b');
  assert.equal(controller.view, 'episodes'); assert.equal(controller.selected, 1);
  assert.deepEqual(controller.getMenuModel().rows.map(row => row.id), ['episode:2', 'episode:3']);
  await controller.handleButton('b');
  assert.equal(controller.view, 'seasons'); assert.equal(controller.getMenuModel().rows[controller.selected].season, 2);
});

test('unknown-only season lists remain usable and missing episode lists keep their visible error', async t => {
  const {controller} = seasonFixture([{season: null}, {}]); t.after(() => controller.close());
  await selectDetailsAction(controller, 'watch'); assert.equal(controller.getMenuModel().rows[0].label, 'Episodes');
  await controller.handleButton('a'); assert.equal(controller.view, 'episodes'); assert.equal(controller.getMenuModel().count, 2);
  await controller.handleButton('b'); await controller.handleButton('b');
  controller.meta.videos = [];
  assert.equal(await controller.handleButton('a'), false); assert.equal(controller.view, 'details');
  assert.match(controller.getMenuModel().message, /does not provide an episode list/);
});

function playingFixture(options = {}) {
  const calls = [], updates = [];
  const callbacks = Object.fromEntries(['play', 'pause', 'seek', 'seekTo', 'stop'].map(name =>
    [name, async value => { calls.push({name, value}); }]));
  const controller = createController({...options, callbacks: {...callbacks, ...options.callbacks},
    onChange: model => updates.push(model)});
  controller.view = 'playing'; controller.playTitle = 'A playing fixture';
  controller.playback = {paused: false, position: 100, duration: 600};
  return {controller, calls, updates};
}

function seriesPlayingFixture(options = {}) {
  const fixture = playingFixture(options), {controller} = fixture;
  controller.meta = {id: 'show:fixture', type: 'series', name: 'A series', videos: [
    {id: 'show:fixture:2:1', title: 'Season two', season: 2, episode: 1, released: '2026-02-01'},
    {id: 'show:fixture:1:2', title: 'Season one finale', season: 1, episode: 2, released: '2026-01-08'},
    {id: 'show:fixture:1:1', title: 'Pilot', season: 1, episode: 1, released: '2026-01-01'}]};
  controller.video = controller.meta.videos[1];
  controller.streams = [{addonName: 'Preferred addon', playable: true, url: 'https://media.example.invalid/current', headers: {}}];
  controller.sourceSelected = 0; controller.episodeSelected = 1;
  controller.addons.streams = async () => [
    {addonName: 'Fallback addon', playable: true, url: 'https://media.example.invalid/fallback', headers: {}},
    {addonName: 'Preferred addon', playable: true, url: 'https://media.example.invalid/preferred', headers: {}}];
  return fixture;
}

test('playback overlay supports Joy-Con focus, shortcuts and two-stage back navigation', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  assert.equal(controller.getMenuModel().playbackOverlay.visible, false);
  await controller.handleButton('plus');
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  await controller.handleButton('left');
  assert.equal(controller.getMenuModel().playbackOverlay.focused, 'prevEpisode');
  await controller.handleButton('a'); assert.equal(controller.video.id, 'show:fixture:1:1');
  assert.equal(controller.playback.position, 0);
  await controller.handleButton('a');
  assert.equal(controller.playback.paused, true);
  assert.equal(await controller.handleButton('l'), false);
  await controller.handleButton('r'); await controller.handleButton('r'); await controller.handleButton('l');
  assert.equal(controller.video.id, 'show:fixture:1:2');
  controller.updatePlayback({position: 70, duration: 600});
  await controller.handleButton('zl'); await controller.handleButton('zr');
  assert.equal(controller.playback.position, 70);
  assert.equal(await controller.handleButton('down'), false);
  assert.equal(await controller.handleButton('up'), false);
  assert.equal(await controller.handleButton('y'), false);
  await controller.handleButton('b'); assert.equal(controller.view, 'playing');
  assert.equal(controller.getMenuModel().playbackOverlay.visible, false);
  await controller.handleButton('b'); assert.equal(controller.view, 'sources');
  assert.equal(controller.getMenuModel().playbackOverlay, null);
  assert.deepEqual(calls.map(call => call.name), ['play', 'pause', 'play', 'play', 'play', 'seek', 'seek', 'stop']);
  assert.deepEqual(calls.filter(call => call.name === 'seek').map(call => call.value), [-10, 10]);
});

test('hidden-overlay A toggles playback and reveals controls; decoder status cannot double-toggle', async t => {
  let controller;
  ({controller} = playingFixture({callbacks: {pause: async () => controller.updatePlayback({paused: !controller.playback.paused}),
    seek: async delta => controller.updatePlayback({position: controller.playback.position + delta})}}));
  t.after(() => controller.close());
  await controller.handleButton('a'); assert.equal(controller.playback.paused, true);
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  await controller.handleButton('a'); assert.equal(controller.playback.paused, false);
  await controller.handleButton('zr'); assert.equal(controller.playback.position, 110);
  assert.equal(await controller.handleButton('up'), false);
  await controller.handleButton('x'); assert.equal(controller.getMenuModel().playbackOverlay.visible, false);
  await controller.handleButton('right'); assert.equal(controller.playback.position, 110);
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  assert.equal(controller.getMenuModel().playbackOverlay.focused, 'stop');
});

test('overlay auto-hides after inactivity while playing and stays open during pause or pending controls', async t => {
  let now = 0, finishSeek;
  const {controller, updates} = playingFixture({now: () => now,
    callbacks: {seek: async () => new Promise(resolve => { finishSeek = resolve; })}});
  t.after(() => controller.close());
  await controller.handleButton('x'); now = 3999;
  assert.equal(controller.tickOverlay(), false); now = 4000;
  assert.equal(controller.tickOverlay(), true); assert.equal(controller.getMenuModel().playbackOverlay.visible, false);
  const hiddenUpdates = updates.length;
  controller.updatePlayback({position: 110.8}); assert.equal(updates.length, hiddenUpdates);
  await controller.handleButton('a'); now = 20000;
  assert.equal(controller.tickOverlay(), false); assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  await controller.handleButton('a'); now = 23000;
  const pending = controller.handleButton('zr'); now = 60000;
  assert.equal(controller.busy, true); assert.equal(controller.tickOverlay(), false);
  assert.equal(await controller.handleButton('a'), false);
  finishSeek(); await pending;
  assert.equal(controller.tickOverlay(), false); now += 4000;
  assert.equal(controller.tickOverlay(), true);
  controller.close(); assert.equal(controller.tickOverlay(), false);
});

test('touch opens controls before activating episode, pause, stop and absolute seek controls', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  let overlay = controller.getMenuModel().playbackOverlay;
  const pause = overlay.controls.find(control => control.id === 'playPause');
  const pausePoint = {x: pause.x + 5, y: pause.y + 5, phase: 'start'};
  assert.equal(await controller.handleTouch(pausePoint), true); assert.equal(calls.length, 0);
  assert.equal(await controller.handleTouch({...pausePoint, phase: 'move'}), false);
  assert.equal(await controller.handleTouch({...pausePoint, phase: 'end'}), false);
  assert.equal(await controller.handleTouch(pausePoint), true); assert.equal(controller.playback.paused, true);
  overlay = controller.getMenuModel().playbackOverlay;
  const forward = overlay.controls.find(control => control.id === 'nextEpisode');
  await controller.handleTouch({x: forward.x + 1, y: forward.y + 1, phase: 'start'});
  assert.equal(controller.video.id, 'show:fixture:2:1'); assert.equal(controller.playback.position, 0);
  controller.updatePlayback({position: 130, duration: 600});
  await controller.handleTouch({x: overlay.seekbar.x + overlay.seekbar.width / 2, y: overlay.seekbar.y + 1, phase: 'start'});
  assert.equal(controller.playback.position, 130);
  await controller.handleTouch({x: overlay.seekbar.x + overlay.seekbar.width / 2, y: overlay.seekbar.y + 1, phase: 'end'});
  assert.equal(controller.playback.position, 300);
  await controller.handleTouch({x: overlay.close.x + 1, y: overlay.close.y + 1, phase: 'start'});
  assert.equal(controller.getMenuModel().playbackOverlay.visible, false);
  assert.equal(await controller.handleTouch({x: -1, y: 0}), false);
  assert.equal(await controller.handleTouch({x: 1280, y: 0}), false);
  assert.deepEqual(calls.map(call => call.name), ['pause', 'play', 'seekTo']);
  assert.equal(calls[1].value.meta.videoId, 'show:fixture:2:1'); assert.equal(calls[2].value, 300);
  await controller.handleTouch({x: 1, y: 1});
  const stop = overlay.controls.find(control => control.id === 'stop');
  await controller.handleTouch({x: stop.x + 1, y: stop.y + 1, phase: 'start'});
  assert.equal(controller.view, 'sources'); assert.equal(calls.at(-1).name, 'stop');
  assert.equal(await controller.handleTouch({x: 1, y: 1}), false);
});

test('playback seeking clamps to media bounds and unknown duration disables absolute touch seeking', async t => {
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  controller.playback.position = 5;
  await controller.handleButton('zl'); assert.equal(controller.playback.position, 0);
  await controller.handleButton('zl'); assert.equal(calls.length, 1);
  controller.playback.position = 595;
  await controller.handleButton('zr'); assert.equal(controller.playback.position, 600);
  await controller.handleButton('zr'); assert.equal(calls.length, 2);
  controller.playback.duration = 0;
  const overlay = controller.getMenuModel().playbackOverlay;
  assert.equal(overlay.seekbar.enabled, false);
  assert.equal(await controller.handleTouch({x: overlay.seekbar.x + 1, y: overlay.seekbar.y + 1}), false);
  assert.deepEqual(calls.map(call => [call.name, call.value]), [['seek', -5], ['seek', 5]]);
});

test('overlay status updates render at whole seconds and action failures remain visible and redacted', async t => {
  const {controller, updates} = playingFixture({callbacks: {pause: async () => { throw Error('Failed https://user:secret@example.invalid/?token=SECRET'); }}});
  t.after(() => controller.close());
  await controller.handleButton('x');
  let count = updates.length;
  controller.updatePlayback({position: 100.1}); controller.updatePlayback({position: 100.9});
  assert.equal(updates.length, count);
  controller.updatePlayback({position: 101}); assert.equal(updates.length, count + 1);
  controller.updatePlayback({duration: 601}); assert.equal(updates.length, count + 2);
  assert.equal(await controller.handleButton('a'), false);
  const overlay = controller.getMenuModel().playbackOverlay;
  assert.equal(overlay.visible, true); assert.equal(overlay.paused, false); assert.equal(overlay.busy, false);
  assert.match(overlay.message, /Failed/); assert.doesNotMatch(overlay.message, /SECRET|secret/);
  controller.playbackEnded(); assert.equal(controller.getMenuModel().playbackOverlay, null);
});

test('episode shortcuts cross season boundaries and prefer the current addon before a playable fallback', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  const requests = [];
  let savedBeforeStart;
  const play = controller.callbacks.play;
  controller.callbacks.play = async source => {
    savedBeforeStart = {...controller.libraryItem.state};
    await play(source);
  };
  controller.addons.streams = async (type, id) => {
    requests.push([type, id]);
    return [{addonName: 'Fallback addon', playable: true, url: 'https://media.example.invalid/fallback', headers: {}},
      {addonName: 'Preferred addon', playable: true, url: 'https://media.example.invalid/preferred', headers: {}}];
  };
  let model = controller.getMenuModel().playbackOverlay;
  assert.equal(model.canPreviousEpisode, true); assert.equal(model.canNextEpisode, true);
  assert.equal(await controller.handleButton('r'), true);
  assert.deepEqual(requests, [['series', 'show:fixture:2:1']]);
  assert.equal(calls[0].name, 'play'); assert.equal(calls[0].value.url, 'https://media.example.invalid/preferred');
  assert.equal(calls[0].value.meta.videoId, 'show:fixture:2:1');
  assert.equal(calls[0].value.libraryInfo.season, 2); assert.equal(calls[0].value.libraryInfo.episode, 1);
  assert.equal(calls[0].value.resumePosition, 0);
  assert.equal(savedBeforeStart.video_id, 'show:fixture:1:2'); assert.equal(savedBeforeStart.timeOffset, 100000);
  assert.equal(controller.view, 'playing'); assert.equal(controller.video.id, 'show:fixture:2:1');
  model = controller.getMenuModel().playbackOverlay;
  assert.equal(model.canNextEpisode, false); assert.equal(model.controls.find(control => control.id === 'nextEpisode').disabled, true);
  assert.equal(model.canPreviousEpisode, true);
  assert.equal(await controller.handleButton('r'), false); assert.equal(calls.length, 1);
  assert.match(controller.getMenuModel().message, /no next episode/);
  controller.addons.streams = async (type, id) => {
    requests.push([type, id]);
    return [{addonName: 'Preferred addon', playable: false, reason: 'Unsupported'},
      {addonName: 'Fallback addon', playable: true, url: 'https://media.example.invalid/fallback', headers: {}}];
  };
  assert.equal(await controller.handleButton('l'), true);
  assert.equal(calls[1].value.url, 'https://media.example.invalid/fallback');
  assert.equal(calls[1].value.meta.videoId, 'show:fixture:1:2');
  assert.equal(controller.sourceSelected, 1); assert.equal(controller.episodeSelected, 1);
  assert.ok(calls.every(call => call.name === 'play'));
});

test('episode playback shortcuts update the season picker and Back restores the destination season', async t => {
  const {controller} = seriesPlayingFixture(); t.after(() => controller.close());
  await controller.handleButton('r');
  assert.equal(controller.video.id, 'show:fixture:2:1'); assert.equal(controller.selectedSeason, 2);
  assert.equal(controller.episodeSelected, 0);
  await controller.handleButton('b'); await controller.handleButton('b'); await controller.handleButton('b');
  assert.equal(controller.view, 'episodes'); assert.equal(controller.selected, 0);
  let model = controller.getMenuModel();
  assert.equal(model.count, 1); assert.equal(model.rows[0].id, 'show:fixture:2:1'); assert.equal(model.rows[0].videoIndex, 0);
  await controller.handleButton('b'); model = controller.getMenuModel();
  assert.equal(model.view, 'seasons'); assert.equal(model.rows[controller.selected].season, 2);
});

test('episode lookup failure and unsupported sources preserve the current episode and active playback', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  const currentVideo = controller.video, streams = controller.streams, playback = {...controller.playback}, title = controller.playTitle;
  controller.addons.streams = async () => { throw Error('Source lookup failed https://user:secret@example.invalid/?token=SECRET'); };
  assert.equal(await controller.handleButton('r'), false);
  assert.match(controller.getMenuModel().message, /Source lookup failed/);
  assert.doesNotMatch(controller.getMenuModel().message, /SECRET|secret/);
  controller.addons.streams = async () => [{addonName: 'Torrent', playable: false, reason: 'Torrent sources are unsupported'}];
  assert.equal(await controller.handleButton('l'), false);
  assert.match(controller.getMenuModel().message, /No playable source.*previous episode/);
  controller.addons.streams = async () => [];
  assert.equal(await controller.handleButton('r'), false);
  assert.match(controller.getMenuModel().message, /No playable source.*next episode/);
  assert.equal(controller.video, currentVideo); assert.equal(controller.streams, streams);
  assert.deepEqual(controller.playback, playback); assert.equal(controller.playTitle, title);
  assert.equal(controller.view, 'playing'); assert.deepEqual(calls, []);
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
});

test('movies and missing current episode disable both episode controls without substituting time seeks', async t => {
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  controller.meta = {id: 'movie:fixture', type: 'movie', name: 'A movie', videos: []};
  for (const type of ['movie', 'series']) {
    controller.meta.type = type;
    const model = controller.getMenuModel().playbackOverlay;
    assert.equal(model.canPreviousEpisode, false); assert.equal(model.canNextEpisode, false);
    assert.equal(model.controls.find(control => control.id === 'prevEpisode').disabled, true);
    assert.equal(model.controls.find(control => control.id === 'nextEpisode').disabled, true);
    assert.equal(await controller.handleButton('l'), false); assert.equal(await controller.handleButton('r'), false);
    assert.match(controller.getMenuModel().message, /series episode/);
  }
  assert.deepEqual(calls, []); assert.equal(controller.playback.position, 100); assert.equal(controller.view, 'playing');
});

test('right-stick seek buttons bypass overlay selection and are ignored outside playback', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  await controller.handleButton('plus'); await controller.handleButton('right');
  assert.equal(controller.getMenuModel().playbackOverlay.focused, 'nextEpisode');
  await controller.handleButton('seekRight'); assert.equal(controller.playback.position, 110);
  await controller.handleButton('seekLeft'); assert.equal(controller.playback.position, 100);
  assert.equal(controller.getMenuModel().playbackOverlay.focused, 'nextEpisode');
  assert.deepEqual(calls.map(call => [call.name, call.value]), [['seek', 10], ['seek', -10]]);
  controller.view = 'catalog';
  assert.equal(await controller.handleButton('seekRight'), false); assert.equal(await controller.handleButton('seekLeft'), false);
  assert.equal(calls.length, 2);
});

test('analogue seeking previews small and large deflections without changing playback or saved progress', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  controller.updatePlayback({position: 100, duration: 600});
  const saved = JSON.stringify(controller.libraryItem.state);
  assert.equal(await controller.handleSeekAxis(0.15), false);
  assert.equal(await controller.handleSeekAxis(0.2), true);
  let model = controller.getMenuModel();
  const small = model.playbackOverlay.position - 100;
  assert.ok(small > 0 && small < 0.1);
  assert.match(model.playbackOverlay.message, /Release the stick/);
  assert.equal(model.playbackOverlay.visible, true);
  assert.equal(model.playback.position, 100); assert.equal(controller.playback.position, 100);
  assert.equal(JSON.stringify(controller.libraryItem.state), saved); assert.deepEqual(calls, []);
  assert.equal(await controller.handleSeekAxis(0), false); assert.deepEqual(calls, []);
  await controller.handleSeekAxis(0.5);
  const medium = controller.getMenuModel().playbackOverlay.position - 100;
  assert.ok(medium > small && medium < 4);
  await controller.handleSeekAxis(NaN); // Invalid input cancels rather than committing.
  await controller.handleSeekAxis(1);
  model = controller.getMenuModel();
  assert.equal(model.playbackOverlay.position, 118); assert.ok(18 > medium);
  await controller.handleSeekAxis(1); assert.equal(controller.getMenuModel().playbackOverlay.position, 136);
  assert.equal(controller.playback.position, 100); assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(controller.libraryItem.state), saved);
  assert.equal(await controller.handleSeekAxis(0), true);
  assert.deepEqual(calls.map(call => [call.name, call.value]), [['seekTo', 136]]);
  assert.equal(controller.playback.position, 136); assert.equal(controller.seekPreview, null);
  await controller.handleSeekAxis(0); assert.equal(calls.length, 1);
});

test('analogue seeking clamps time steps and media limits and cancels safely outside active playback', async t => {
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  await controller.handleSeekAxis(1, 1000); assert.equal(controller.seekPreview, 122.5);
  await controller.handleSeekAxis(NaN);
  await controller.handleSeekAxis(1, -1); assert.equal(controller.seekPreview, 100);
  await controller.handleSeekAxis(0); assert.deepEqual(calls, []);
  controller.playback.position = 599;
  await controller.handleSeekAxis(2, 0.25); assert.equal(controller.seekPreview, 599.9);
  await controller.handleSeekAxis(0); assert.equal(calls[0].value, 599.9);
  controller.playback.position = 1;
  await controller.handleSeekAxis(-1, 0.25); assert.equal(controller.seekPreview, 0);
  await controller.handleSeekAxis(0); assert.equal(calls[1].value, 0);
  await controller.handleSeekAxis(1);
  controller.view = 'catalog';
  assert.equal(await controller.handleSeekAxis(0), false); assert.equal(controller.seekPreview, null);
  controller.view = 'playing'; controller.playback.duration = 0;
  assert.equal(await controller.handleSeekAxis(1), false);
  controller.playback.duration = 600; await controller.handleSeekAxis(1);
  controller.close(); assert.equal(controller.seekPreview, null);
  assert.equal(await controller.handleSeekAxis(0), false); assert.equal(calls.length, 2);
});

test('analogue release commits once and input during a pending seek does not queue further actions', async t => {
  let finishSeek;
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  controller.callbacks.seekTo = async value => {
    calls.push({name: 'seekTo', value});
    await new Promise(resolve => { finishSeek = resolve; });
  };
  await controller.handleSeekAxis(1);
  const pending = controller.handleSeekAxis(0);
  assert.equal(controller.busy, true);
  assert.equal(await controller.handleSeekAxis(1), false);
  assert.equal(await controller.handleSeekAxis(-1), false);
  assert.equal(await controller.handleSeekAxis(0), false);
  assert.equal(controller.seekPreview, null); assert.equal(calls.length, 1);
  finishSeek(); assert.equal(await pending, true);
  assert.equal(controller.playback.position, 118);
  await controller.handleSeekAxis(0); assert.equal(calls.length, 1);
});

test('a gentle forward scrub stays ahead as video advances and saves only actual playback progress', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  controller.updatePlayback({position: 100, duration: 600});
  await controller.handleSeekAxis(0.3, 0.07);
  const offset = controller.seekPreview - 100;
  assert.ok(offset > 0.1 && offset < 0.25);
  controller.updatePlayback({position: 102});
  assert.equal(controller.playback.position, 102);
  assert.ok(Math.abs(controller.seekPreview - (102 + offset)) < 1e-9);
  assert.ok(controller.getMenuModel().playbackOverlay.position > controller.playback.position);
  assert.equal(controller.libraryItem.state.timeOffset, 102000);
  assert.deepEqual(calls, []);
  await controller.handleSeekAxis(0);
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'seekTo');
  assert.ok(calls[0].value > 102);
  assert.ok(Math.abs(calls[0].value - (102 + offset)) < 1e-9);
  assert.equal(controller.libraryItem.state.timeOffset, 102000);
});

test('held triggers preview the initial jump then continuous seek and commit once when every seek input releases', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  controller.updatePlayback({position: 100, duration: 600});
  const saved = JSON.stringify(controller.libraryItem.state);
  await controller.handleHeldSeek({forward: true}, 0.1);
  assert.equal(controller.seekPreview, 110);
  await controller.handleHeldSeek({forward: true}, 0.2);
  await controller.handleHeldSeek({forward: true}, 0.05);
  assert.equal(controller.seekPreview, 110);
  await controller.handleHeldSeek({forward: true}, 0.25);
  assert.equal(controller.seekPreview, 120);
  await controller.handleHeldSeek({forward: true, right: true}, 0.25);
  assert.equal(controller.seekPreview, 130);
  await controller.handleHeldSeek({right: true}, 0.25);
  assert.equal(controller.seekPreview, 140);
  assert.equal(controller.playback.position, 100);
  assert.equal(JSON.stringify(controller.libraryItem.state), saved);
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  assert.deepEqual(calls, []);
  assert.equal(await controller.handleHeldSeek({}), true);
  assert.equal(await controller.handleHeldSeek({}), false);
  assert.deepEqual(calls, [{name: 'seekTo', value: 140}]);
  assert.equal(controller.playback.position, 140);
  assert.equal(JSON.stringify(controller.libraryItem.state), saved);
});

test('left-stick held seeking moves continuously, clamps at media bounds and keeps opposite inputs from committing', async t => {
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  await controller.handleHeldSeek({left: true}, 0.25);
  assert.equal(controller.seekPreview, 90);
  await controller.handleHeldSeek({left: true, right: true}, 0.25);
  assert.equal(controller.seekPreview, 90); assert.deepEqual(calls, []);
  await controller.handleHeldSeek({left: true}, 100);
  assert.equal(controller.seekPreview, 80);
  await controller.handleHeldSeek({});
  assert.deepEqual(calls, [{name: 'seekTo', value: 80}]);
  controller.playback.position = 3;
  await controller.handleHeldSeek({backward: true}, 0.25);
  assert.equal(controller.seekPreview, 0);
  await controller.handleHeldSeek({});
  controller.playback.position = 595;
  await controller.handleHeldSeek({forward: true}, 0.25);
  assert.equal(controller.seekPreview, 599.9);
  await controller.handleHeldSeek({});
  assert.deepEqual(calls.map(call => call.value), [80, 0, 599.9]);
});

test('seek gesture owners ignore neutral and active polling from other input devices', async t => {
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  const {seekbar} = controller.getMenuModel().playbackOverlay;
  const start = {x: seekbar.x + seekbar.width / 2, y: seekbar.y + 1, phase: 'start', id: 7};
  await controller.handleHeldSeek({forward: true});
  assert.equal(await controller.handleSeekAxis(0), false);
  assert.equal(await controller.handleSeekAxis(-1), false);
  assert.equal(await controller.handleTouch(start), false);
  assert.equal(controller.seekPreview, 110);
  await controller.handleHeldSeek({});
  await controller.handleSeekAxis(1, 0.2);
  assert.equal(await controller.handleHeldSeek({}), false);
  assert.equal(await controller.handleHeldSeek({backward: true}), false);
  assert.equal(controller.seekPreview, 128);
  await controller.handleSeekAxis(0);
  await controller.handleTouch(start);
  assert.equal(await controller.handleSeekAxis(0), false);
  assert.equal(await controller.handleHeldSeek({}), false);
  assert.equal(await controller.handleHeldSeek({forward: true}), false);
  assert.equal(controller.seekPreview, 300);
  assert.equal(controller.cancelSeekGesture(), true);
  assert.equal(controller.cancelSeekGesture(), false);
  assert.deepEqual(calls.map(call => call.value), [110, 128]);
});

test('touching the hidden timeline reveals controls before a later gesture can seek', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  controller.updatePlayback({position: 100, duration: 600});
  const saved = JSON.stringify(controller.libraryItem.state);
  const {seekbar} = controller.getMenuModel().playbackOverlay;
  const touch = {x: seekbar.x + seekbar.width / 2, y: seekbar.y + 1, phase: 'start', id: 3};
  assert.equal(controller.getMenuModel().playbackOverlay.visible, false);
  assert.equal(await controller.handleTouch(touch), true);
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  assert.equal(controller.seekPreview, null); assert.equal(controller.seekGesture, null);
  assert.equal(await controller.handleTouch({...touch, phase: 'move', x: seekbar.x + seekbar.width}), false);
  assert.equal(await controller.handleTouch({...touch, phase: 'end'}), false);
  assert.equal(controller.playback.position, 100); assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(controller.libraryItem.state), saved);
  assert.equal(await controller.handleTouch(touch), true);
  assert.equal(controller.seekPreview, 300);
  assert.equal(await controller.handleTouch({...touch, phase: 'end'}), true);
  assert.deepEqual(calls, [{name: 'seekTo', value: 300}]);
});

test('timeline drag captures one touch, follows horizontal movement outside the bar and commits its absolute target once', async t => {
  const {controller, calls} = seriesPlayingFixture(); t.after(() => controller.close());
  await controller.handleButton('plus');
  controller.updatePlayback({position: 100, duration: 600});
  const {seekbar} = controller.getMenuModel().playbackOverlay;
  const start = {x: seekbar.x + seekbar.width / 4, y: seekbar.y + 1, phase: 'start', id: 4};
  await controller.handleTouch(start);
  assert.equal(controller.seekPreview, 150);
  assert.equal(controller.getMenuModel().playbackOverlay.previewKind, 'touch');
  assert.equal(await controller.handleTouch({...start, phase: 'move', x: seekbar.x, id: 5}), false);
  assert.equal(await controller.handleTouch({...start, phase: 'end', id: 5}), false);
  controller.updatePlayback({position: 105});
  assert.equal(controller.seekPreview, 150);
  assert.equal(controller.libraryItem.state.timeOffset, 105000);
  await controller.handleTouch({...start, phase: 'move', x: -300, y: 1000});
  assert.equal(controller.seekPreview, 0);
  await controller.handleTouch({...start, phase: 'move', x: 2000, y: -200});
  assert.equal(controller.seekPreview, 600);
  assert.deepEqual(calls, []); assert.equal(controller.playback.position, 105);
  await controller.handleTouch({...start, phase: 'end', x: seekbar.x + seekbar.width * 0.75, y: 40});
  assert.equal(await controller.handleTouch({...start, phase: 'end'}), false);
  assert.deepEqual(calls, [{name: 'seekTo', value: 450}]);
  assert.equal(controller.playback.position, 450);
  assert.equal(controller.libraryItem.state.timeOffset, 105000);
});

test('touch and held previews cancel after timeout, input cancellation and playback replacement', async t => {
  let now = 0;
  const {controller, calls} = playingFixture({now: () => now}); t.after(() => controller.close());
  await controller.handleButton('plus');
  const {seekbar} = controller.getMenuModel().playbackOverlay;
  const touch = {x: seekbar.x + seekbar.width / 2, y: seekbar.y, phase: 'start', id: 2};
  await controller.handleTouch(touch);
  now = 1500; controller.tickOverlay();
  assert.equal(controller.seekPreview, null);
  assert.equal(await controller.handleTouch({...touch, phase: 'end'}), false);
  await controller.handleTouch(touch);
  assert.equal(await controller.handleTouch({...touch, phase: 'cancel'}), true);
  assert.equal(controller.seekPreview, null);
  await controller.handleHeldSeek({forward: true});
  now += 1500; controller.tickOverlay();
  assert.equal(await controller.handleHeldSeek({}), false);
  await controller.handleHeldSeek({left: true});
  controller.playbackEnded();
  assert.equal(await controller.handleHeldSeek({}), false);
  assert.equal(controller.seekPreview, null); assert.deepEqual(calls, []);
});

test('pending held seek releases and decoder transitions cannot queue another seek or restore stale playback', async t => {
  let finish;
  const {controller, calls} = playingFixture({callbacks: {seekTo: async value => {
    calls.push({name: 'seekTo', value}); await new Promise(resolve => {finish = resolve;});
  }}}); t.after(() => controller.close());
  await controller.handleHeldSeek({forward: true});
  const pending = controller.handleHeldSeek({});
  assert.equal(controller.busy, true);
  assert.equal(await controller.handleHeldSeek({forward: true}), false);
  assert.equal(await controller.handleHeldSeek({}), false);
  assert.equal(await controller.handleSeekAxis(1), false);
  assert.equal(calls.length, 1);
  controller.playbackFailed('Decoder replaced.');
  finish(); await pending;
  assert.equal(controller.view, 'sources'); assert.equal(controller.playback.position, 100);
  assert.equal(controller.seekPreview, null);
});

test('unknown duration and a pending decoder transition disable every seek gesture', async t => {
  const {controller, calls} = playingFixture(); t.after(() => controller.close());
  await controller.handleButton('plus');
  const {seekbar} = controller.getMenuModel().playbackOverlay;
  const touch = {x: seekbar.x + 200, y: seekbar.y, phase: 'start'};
  for (const update of [{duration: 0}, {duration: 600, seeking: true}]) {
    controller.setPlaybackInfo(update);
    assert.equal(await controller.handleHeldSeek({forward: true}), false);
    assert.equal(await controller.handleSeekAxis(1), false);
    assert.equal(await controller.handleTouch(touch), false);
    assert.equal(controller.seekPreview, null);
  }
  assert.deepEqual(calls, []);
});

test('audio and subtitle options stay inside playback, page six rows and select exact track IDs or Off', async t => {
  let now = 0;
  const {controller, calls} = playingFixture({now: () => now, callbacks: {
    selectAudio: async value => calls.push({name: 'selectAudio', value}),
    selectSubtitle: async value => calls.push({name: 'selectSubtitle', value})
  }}); t.after(() => controller.close());
  controller.setMediaTracks({audioTracks: Array.from({length: 8}, (_, id) => ({id, label: `Audio ${id}`, selected: id === 0})),
    subtitleTracks: [{id: 'en:cc', label: 'English CC', selected: true}]});
  await controller.handleButton('plus');
  const button = id => controller.getMenuModel().playbackOverlay.controls.find(control => control.id === id);
  await controller.handleTouch({...button('audio'), phase: 'tap'});
  let overlay = controller.getMenuModel().playbackOverlay;
  assert.equal(overlay.mode, 'audio'); assert.equal(overlay.optionRows.length, 6);
  assert.equal(controller.view, 'playing');
  now = 10000; assert.equal(controller.tickOverlay(), false);
  for (let count = 0; count < 6; count++) await controller.handleButton('down');
  overlay = controller.getMenuModel().playbackOverlay;
  assert.equal(overlay.optionOffset, 6); assert.deepEqual(overlay.optionRows.map(row => row.id), [6, 7]);
  await controller.handleButton('b');
  assert.equal(controller.getMenuModel().playbackOverlay.mode, 'controls');
  assert.equal(controller.getMenuModel().playbackOverlay.visible, true);
  await controller.handleTouch({...button('audio'), phase: 'tap'});
  overlay = controller.getMenuModel().playbackOverlay;
  await controller.handleTouch({...overlay.optionPaging.find(paging => paging.action === 'nextOptions'), phase: 'tap'});
  overlay = controller.getMenuModel().playbackOverlay;
  await controller.handleTouch({...overlay.optionRows[1], phase: 'tap'});
  assert.equal(controller.getMenuModel().playbackOverlay.mode, 'controls');
  assert.equal(controller.audioTracks.find(track => track.selected).id, 7);
  await controller.handleTouch({...button('subtitles'), phase: 'tap'});
  overlay = controller.getMenuModel().playbackOverlay;
  assert.equal(overlay.mode, 'subtitles'); assert.equal(overlay.optionRows[0].id, null);
  await controller.handleTouch({...overlay.optionRows[0], phase: 'tap'});
  assert.ok(controller.subtitleTracks.every(track => !track.selected));
  assert.deepEqual(calls, [{name: 'selectAudio', value: 7}, {name: 'selectSubtitle', value: null}]);
  assert.equal(controller.view, 'playing');
});

test('track reporting validates IDs and selection aliases while unknown IDs and pending changes cannot queue', async t => {
  let finish;
  const {controller, calls} = playingFixture({callbacks: {selectAudio: async value => {
    calls.push({name: 'selectAudio', value}); await new Promise(resolve => {finish = resolve;});
  }}}); t.after(() => controller.close());
  controller.setPlaybackInfo({audioTracks: [{id: 0, label: 'Numeric'}, {id: '0', label: 'String'},
    {id: 0, label: 'Duplicate'}, {id: null}, {id: -1}], selectedAudioId: 0,
    subtitleTracks: [{id: 'en', language: 'en', selected: true}], selectedSubtitleId: null});
  assert.deepEqual(controller.audioTracks.map(track => track.id), [0, '0']);
  assert.deepEqual(controller.audioTracks.map(track => track.selected), [true, false]);
  assert.equal(controller.subtitleTracks[0].selected, false);
  const opaqueSubtitleId = `addon-provider:${'opaque-video-subtitle-id:'.repeat(100)}`;
  controller.setPlaybackInfo({subtitleTracks: [{id: opaqueSubtitleId, language: 'en'}], selectedSubtitleId: opaqueSubtitleId});
  assert.equal(controller.subtitleTracks[0].id, opaqueSubtitleId);
  assert.equal(controller.subtitleTracks[0].selected, true);
  controller.setPlaybackInfo({audioTrackId: '0'});
  assert.deepEqual(controller.audioTracks.map(track => track.selected), [false, true]);
  for (const [mode, id] of [['audio', null], ['audio', 'unknown'], ['subtitles', 0], ['video', 0]])
    assert.equal(await controller.selectMediaTrack(mode, id), false);
  await controller.handleButton('plus');
  const audio = controller.getMenuModel().playbackOverlay.controls.find(control => control.id === 'audio');
  await controller.handleTouch({...audio, phase: 'tap'});
  const pending = controller.selectMediaTrack('audio', 0);
  assert.equal(controller.busy, true);
  assert.ok(controller.getMenuModel().playbackOverlay.optionRows.every(row => row.disabled));
  assert.equal(await controller.selectMediaTrack('audio', '0'), false);
  assert.equal(await controller.handleButton('down'), false);
  assert.equal(await controller.handleTouch({...audio, phase: 'tap'}), false);
  finish(); assert.equal(await pending, true);
  assert.deepEqual(calls, [{name: 'selectAudio', value: 0}]);
  assert.deepEqual(controller.audioTracks.map(track => track.selected), [true, false]);
});

test('track selection failure preserves options and stale completion cannot reopen failed playback', async t => {
  const {controller, calls} = playingFixture({callbacks: {selectSubtitle: async () => {
    throw Error('Failed https://user:secret@example.invalid/?token=SECRET');
  }}}); t.after(() => controller.close());
  controller.setMediaTracks({subtitleTracks: [{id: 'en', label: 'English', selected: true}, {id: 'fr', label: 'French'}]});
  await controller.handleButton('plus');
  const subtitle = controller.getMenuModel().playbackOverlay.controls.find(control => control.id === 'subtitles');
  await controller.handleTouch({...subtitle, phase: 'tap'});
  assert.equal(await controller.selectMediaTrack('subtitles', 'fr'), false);
  let overlay = controller.getMenuModel().playbackOverlay;
  assert.equal(overlay.mode, 'subtitles'); assert.match(overlay.message, /Failed/);
  assert.doesNotMatch(overlay.message, /secret|SECRET/);
  assert.equal(controller.subtitleTracks.find(track => track.selected).id, 'en');
  let finish;
  controller.callbacks.selectSubtitle = async value => {calls.push({name: 'selectSubtitle', value}); await new Promise(resolve => {finish = resolve;});};
  const pending = controller.selectMediaTrack('subtitles', 'fr');
  controller.playbackFailed('Playback replaced.');
  finish(); await pending;
  assert.equal(controller.view, 'sources');
  assert.equal(controller.getMenuModel().playbackOverlay, null);
  assert.equal(controller.subtitleTracks.find(track => track.selected).id, 'en');
  assert.deepEqual(calls, [{name: 'selectSubtitle', value: 'fr'}]);
});

test('current season action defaults to the first regular season and remembers the last selected season', async t => {
  const {controller, requests} = seasonFixture([{season: 0}, {season: 3}, {season: null}, {season: 1}, {season: 1}]);
  t.after(() => controller.close());
  assert.equal(controller.getMenuModel().actions[0].label, 'Season 1 episodes');
  await selectDetailsAction(controller, 'currentSeason');
  assert.equal(controller.view, 'episodes'); assert.equal(controller.selectedSeason, 1);
  assert.deepEqual(controller.getMenuModel().rows.map(row => row.id), ['episode:3', 'episode:4']);
  assert.deepEqual(requests, []);
  await controller.handleButton('b');
  await touchTarget(controller, controller.getMenuModel().navigation.rows.find(row => row.index === 2));
  assert.equal(controller.selectedSeason, 3);
  await controller.handleButton('b'); await controller.handleButton('b');
  assert.equal(controller.getMenuModel().actions[0].label, 'Season 3 episodes');
  controller.selectedSeason = undefined;
  assert.equal(controller.getMenuModel().actions[0].season, 3);
});

test('saved current season resolves the original opaque video ID and keeps Resume plus Browse seasons available', async t => {
  const saved = {_id: 'show:0', type: 'series', name: 'Saved', removed: false, temp: false,
    state: {video_id: 'opaque-video-id', timeOffset: 52000, duration: 120000}};
  const {controller, requests} = seasonFixture([{id: 'misleading:5:1', season: 2},
    {id: 'opaque-video-id', season: 5}, {id: 'special', season: 0}], {libraryItems: [saved]});
  t.after(() => controller.close());
  let model = controller.getMenuModel();
  assert.deepEqual(model.actions.map(action => action.action), ['resume', 'currentSeason', 'watch', 'back']);
  assert.equal(model.actions[1].season, 5); assert.equal(model.actions[1].label, 'Season 5 episodes');
  await selectDetailsAction(controller, 'currentSeason');
  assert.deepEqual(controller.getMenuModel().rows.map(row => row.id), ['opaque-video-id']);
  assert.deepEqual(requests, []);
  await controller.handleButton('a');
  assert.deepEqual(requests, [['series', 'opaque-video-id']]);
  assert.equal(controller.video.id, 'opaque-video-id');
});
