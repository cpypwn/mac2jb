'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ArtworkCache, prepareArtwork, closeArtworkCache} = require('./artwork.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfkAAAAASUVORK5CYII=', 'base64');
const imageResponse = () => new Response(PNG, {headers: {'content-type': 'image/png'}});

async function idle(cache) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Artwork fixture did not settle.')), 1500);
  });
  try {
    await Promise.race([deadline, (async () => {
      while (cache.running.size || cache.queue.length) await Promise.allSettled([...cache.running]);
      await new Promise(setImmediate);
    })()]);
  } finally { clearTimeout(timer); }
}

async function waitForRemoval(file) {
  for (let attempt = 0; attempt < 150 && fs.existsSync(file); attempt++)
    await new Promise(resolve => setTimeout(resolve, 10));
}

function cacheFor(t, options) {
  const cache = new ArtworkCache(options); t.after(() => cache.close()); return cache;
}

test('explicit local artwork clones presentation references and suppresses remote fetching', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-artwork-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'poster.png'); fs.writeFileSync(file, PNG);
  let requests = 0;
  const cache = cacheFor(t, {fetchImpl: async () => { requests++; return imageResponse(); }});
  const url = 'https://images.example.invalid/poster.png?token=ARTWORKSECRET';
  const model = {view: 'catalog', cards: [{title: 'Fixture', poster: url}], hero: {poster: url, background: 'missing'},
    _artwork: {untrusted: '/private/secret'}};
  const prepared = prepareArtwork(model, {posterPaths: new Map([[url, file]]), fetchImages: true, cache});
  assert.equal(model.cards[0].poster, url); assert.equal(model.hero.background, 'missing');
  assert.notEqual(prepared.cards[0].poster, url); assert.equal(prepared.cards[0].poster, prepared.hero.poster);
  assert.equal(prepared._artwork[prepared.hero.poster], file); assert.equal(prepared.hero.background, undefined);
  assert.equal(prepared._artwork.untrusted, undefined);
  assert.equal(/ARTWORKSECRET/.test(JSON.stringify(prepared)), false); assert.equal(requests, 0);
  const absent = prepareArtwork(model, {posterPaths: {}, fetchImages: true, cache});
  assert.equal(absent.cards[0].poster, undefined); assert.equal(absent._artwork, undefined); assert.equal(requests, 0);
  assert.equal(prepareArtwork(model, {posterPaths: {[url]: 'relative.png'}})._artwork, undefined);
});

test('downloads return fallback immediately then private cached artwork with a bounded redraw callback', async t => {
  let release;
  let requests = 0, notifications = 0;
  const cache = cacheFor(t, {fetchImpl: () => { requests++; return new Promise(resolve => { release = () => resolve(imageResponse()); }); }});
  const url = 'https://images.example.invalid/poster.png?token=ARTWORKSECRET';
  const model = {cards: [{poster: url}], hero: {poster: url}};
  const options = {cache, fetchImages: true, onArtworkReady: () => { notifications++; }};
  const first = prepareArtwork(model, options);
  assert.equal(first.cards[0].poster, undefined); assert.equal(requests, 1);
  for (let index = 0; index < 20; index++) prepareArtwork(model, options);
  assert.equal(requests, 1);
  release(); await idle(cache);
  assert.equal(notifications, 1);
  const prepared = prepareArtwork(model, options);
  const file = prepared._artwork[prepared.cards[0].poster];
  assert.deepEqual(fs.readFileSync(file), PNG);
  assert.equal(fs.statSync(cache.directory).mode & 0o077, 0); assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(/ARTWORKSECRET/.test(file), false);
  assert.equal(requests, 1); assert.equal(prepareArtwork(model, {cache}).cards[0].poster, prepared.cards[0].poster);
  const directory = cache.directory; await cache.close();
  assert.equal(fs.existsSync(directory), false); assert.equal(cache.entries.size, 0);
});

test('unsafe URLs, credential redirects, downgrade redirects and redirect loops stay negative without retries', async t => {
  const seen = [];
  const cache = cacheFor(t, {fetchImpl: async url => {
    seen.push(url);
    const pathname = new URL(url).pathname;
    const location = pathname === '/credentials' ? 'https://user:secret@example.invalid/poster.png' :
      pathname === '/downgrade' ? 'http://images.example.invalid/poster.png' : '/loop';
    return new Response(null, {status: 302, headers: {location}});
  }});
  for (const value of ['file:///private/poster.png', 'https://user:secret@example.invalid/poster.png',
    'https://images.example.invalid/' + 'x'.repeat(2048)]) assert.equal(cache.get(value, true), null);
  assert.equal(seen.length, 0);
  for (const suffix of ['credentials', 'downgrade', 'loop']) cache.get('https://images.example.invalid/' + suffix, true);
  await idle(cache);
  assert.equal(seen.length, 6); // Two rejected redirects and four loop requests.
  for (const suffix of ['credentials', 'downgrade', 'loop']) cache.get('https://images.example.invalid/' + suffix, true);
  await idle(cache); assert.equal(seen.length, 6);
  assert.ok([...cache.entries.values()].every(entry => entry.status === 'failed'));
  assert.equal(cache.directory, null);
});

test('safe relative redirects produce a cached raster without forwarding credentials', async t => {
  const seen = [];
  const cache = cacheFor(t, {fetchImpl: async (url, options) => {
    seen.push({url, options});
    return seen.length === 1 ? new Response(null, {status: 302, headers: {location: '/final.png'}}) : imageResponse();
  }});
  const url = 'https://images.example.invalid/start.png'; cache.get(url, true); await idle(cache);
  assert.equal(seen[1].url, 'https://images.example.invalid/final.png');
  assert.equal(seen[0].options.credentials, 'omit'); assert.equal(seen[0].options.redirect, 'manual');
  assert.equal(seen[0].options.headers.Authorization, undefined); assert.ok(cache.get(url));
});

test('byte limits and unsupported payloads fail once without creating cache files', async t => {
  let requests = 0;
  const cache = cacheFor(t, {maxBytes: 128, fetchImpl: async url => {
    requests++;
    if (new URL(url).pathname === '/declared') return new Response(PNG, {headers: {'content-length': '200'}});
    if (new URL(url).pathname === '/chunked') return new Response(Buffer.alloc(200));
    return new Response('<html>not an image</html>', {headers: {'content-type': 'image/png'}});
  }});
  for (const suffix of ['declared', 'chunked', 'html']) cache.get('https://images.example.invalid/' + suffix, true);
  await idle(cache); assert.equal(requests, 3); assert.equal(cache.directory, null);
  for (const suffix of ['declared', 'chunked', 'html']) cache.get('https://images.example.invalid/' + suffix, true);
  assert.equal(requests, 3);
});

test('entry, queue and concurrency limits stay bounded while cache eviction removes only owned files', async t => {
  const releases = []; let active = 0, maximum = 0;
  const cache = cacheFor(t, {maxEntries: 4, maxConcurrent: 2, maxQueued: 2, fetchImpl: () => {
    active++; maximum = Math.max(maximum, active);
    return new Promise(resolve => releases.push(() => { active--; resolve(imageResponse()); }));
  }});
  for (let index = 0; index < 100; index++) cache.get(`https://images.example.invalid/${index}.png`, true);
  assert.equal(cache.entries.size, 4); assert.equal(cache.running.size, 2); assert.equal(cache.queue.length, 2);
  while (cache.running.size || cache.queue.length) {
    while (releases.length) releases.shift()();
    await new Promise(setImmediate);
  }
  assert.equal(maximum, 2);
  const oldFile = cache.get('https://images.example.invalid/0.png');
  assert.ok(oldFile);
  // The lookup made entry zero newest; entry one should be the next eviction.
  const evictedFile = cache.entries.get('https://images.example.invalid/1.png').file;
  assert.equal(fs.existsSync(evictedFile), true);
  cache.get('https://images.example.invalid/new.png', true);
  while (releases.length) releases.shift()(); await idle(cache);
  await waitForRemoval(evictedFile);
  assert.equal(cache.entries.size, 4); assert.equal(fs.existsSync(evictedFile), false); assert.equal(fs.existsSync(oldFile), true);
});

test('close aborts pending downloads and suppresses late notifications', async t => {
  let signal, notifications = 0;
  const cache = cacheFor(t, {fetchImpl: (url, options) => { signal = options.signal; return new Promise(() => {}); }});
  prepareArtwork({cards: [{poster: 'https://images.example.invalid/pending.png'}]},
    {cache, fetchImages: true, onArtworkReady: () => { notifications++; }});
  assert.equal(signal.aborted, false);
  await cache.close(); assert.equal(signal.aborted, true); assert.equal(notifications, 0);
  assert.equal(cache.get('https://images.example.invalid/after.png', true), null); assert.equal(cache.directory, null);
});

test('timeouts abort unresponsive fetches and remain negatively cached for the session', async t => {
  let signal, requests = 0;
  const cache = cacheFor(t, {timeoutMs: 20, fetchImpl: (url, options) => {
    requests++; signal = options.signal; return new Promise(() => {});
  }});
  const url = 'https://images.example.invalid/slow.png';
  cache.get(url, true); await idle(cache);
  assert.equal(signal.aborted, true); assert.equal(cache.entries.get(url).status, 'failed');
  cache.get(url, true); assert.equal(requests, 1);
});

test('prepared short image IDs cannot push a valid model beyond the renderer input budget', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-artwork-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'poster.png'); fs.writeFileSync(file, PNG);
  const model = {cards: [{poster: 'one'}], hero: {poster: 'two'}, padding: ''};
  model.padding = 'x'.repeat(65530 - Buffer.byteLength(JSON.stringify(model)));
  assert.ok(Buffer.byteLength(JSON.stringify(model)) <= 65536);
  const prepared = prepareArtwork(model, {posterPaths: {one: file, two: file}});
  assert.ok(Buffer.byteLength(JSON.stringify(prepared)) <= 65536);
  assert.equal(model.cards[0].poster, 'one');
});

test('default artwork shutdown is safe before use and remains idempotent', async () => {
  await closeArtworkCache(); await closeArtworkCache();
});
