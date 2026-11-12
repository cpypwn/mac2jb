'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {AddonClient, AddonCollection, requestJSON, normalizeMeta, normalizeStream, normalizeSubtitle, subtitleExtras, manifestURL, redactText, DEFAULT_ADDON_URL} = require('./addons.cjs');

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('real HTTP addon routes honor resources, prefixes, encoding, query and stream headers', async t => {
  const seen = [], logs = [];
  const base = await server(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture'); seen.push(url);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/addon/manifest.json') response.end(JSON.stringify({id: 'fixture', name: 'Fixture addon', types: ['series'],
      resources: ['catalog', {name: 'meta', types: ['series'], idPrefixes: ['fixture:']},
        {name: 'stream', types: ['series'], idPrefixes: ['fixture:']}],
      catalogs: [{type: 'series', id: 'top / picks', name: 'Top', extra: [{name: 'search'}]}]}));
    else if (url.pathname.startsWith('/addon/catalog/')) response.end(JSON.stringify({metas: [{id: 'fixture:show', name: 'Fixture show', type: 'series'}]}));
    else if (url.pathname.startsWith('/addon/meta/')) response.end(JSON.stringify({meta: {id: 'fixture:show', name: 'Fixture show', type: 'series',
      videos: [{id: 'fixture:show:1/1', title: 'Pilot', season: 1, episode: 1}]}}));
    else if (url.pathname.startsWith('/addon/stream/')) response.end(JSON.stringify({streams: [{name: 'HLS', url: base + '/video.m3u8?token=STREAMSECRET',
      behaviorHints: {notWebReady: true, proxyHeaders: {request: {Authorization: 'Bearer HEADERSECRET', 'User-Agent': 'Fixture player'}}}}]}));
    else response.writeHead(404).end('{}');
  });
  const client = await new AddonClient(base + '/addon/manifest.json?key=ADDONSECRET', {onLog: value => logs.push(value)}).init();
  assert.equal(client.supports('stream', 'series', 'fixture:show:1/1'), true);
  assert.equal(client.supports('stream', 'movie', 'fixture:show'), false);
  assert.equal(client.supports('meta', 'series', 'unrelated'), false);
  assert.equal(await client.meta('series', 'unrelated'), null);
  const catalog = client.manifest.catalogs[0];
  const items = await client.catalog(catalog, {search: 'space & slash/', ignored: 'not forwarded'});
  assert.equal(items[0].name, 'Fixture show');
  assert.match(seen[1].pathname, /top%20%2F%20picks\/search=space%20%26%20slash%2F\.json$/);
  assert.equal(seen[1].searchParams.get('key'), 'ADDONSECRET');
  const meta = await client.meta('series', 'fixture:show');
  const sources = await client.streams('series', meta.videos[0].id);
  assert.match(seen.at(-1).pathname, /fixture%3Ashow%3A1%2F1\.json$/);
  assert.equal(sources[0].playable, true);
  assert.equal(sources[0].headers.Authorization, 'Bearer HEADERSECRET');
  assert.ok(logs.every(message => !/ADDONSECRET|STREAMSECRET|HEADERSECRET/.test(message)));
});

test('required search, genre and skip extras reach catalog routes with validated values', async t => {
  const seen = [];
  const base = await server(t, (request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    response.setHeader('content-type', 'application/json');
    if (pathname === '/manifest.json') response.end(JSON.stringify({id: 'filters', name: 'Filter addon', types: ['movie'],
      resources: ['catalog'], catalogs: [{id: 'new', type: 'movie', name: 'New', extra: [
        {name: 'search', isRequired: true}, {name: 'genre', isRequired: true, options: ['Drama', 'Comedy']},
        {name: 'skip'}]}]}));
    else { seen.push(pathname); response.end(JSON.stringify({metas: [{id: 'movie:1', type: 'movie', name: 'One'}]})); }
  });
  const client = await new AddonClient(`${base}/manifest.json`).init();
  const catalog = client.manifest.catalogs[0];
  await assert.rejects(client.catalog(catalog), /Choose a search filter first/);
  await assert.rejects(client.catalog(catalog, {search: 'Alien'}), /Choose a genre filter first/);
  await assert.rejects(client.catalog(catalog, {search: 'Alien', genre: 'Unknown'}), /listed genre/);
  await assert.rejects(client.catalog(catalog, {search: 'Alien', genre: 'Drama', skip: '27'}), /valid catalog page/);
  assert.equal((await client.catalog(catalog, {search: 'Alien & eggs', genre: 'Drama', skip: '100', ignored: 'secret'}))[0].name, 'One');
  assert.match(seen[0], /search=Alien%20%26%20eggs&genre=Drama&skip=100\.json$/);
  assert.doesNotMatch(seen[0], /ignored|secret/);
});

test('timeouts, size bounds, invalid JSON and redirect loops fail explicitly without URLs', async t => {
  const base = await server(t, (request, response) => {
    if (request.url === '/slow') setTimeout(() => response.end('{}'), 150).unref();
    else if (request.url === '/large') response.end(JSON.stringify({data: 'x'.repeat(500)}));
    else if (request.url === '/bad') response.end('not json');
    else if (request.url === '/loop') response.writeHead(302, {location: '/loop'}).end();
    else response.writeHead(503).end('https://user:password@example.invalid/?key=SECRET');
  });
  await assert.rejects(requestJSON(base + '/slow', {timeoutMs: 25}), /timed out/);
  await assert.rejects(requestJSON(base + '/large', {maxBytes: 64}), /size limit/);
  await assert.rejects(requestJSON(base + '/bad'), /invalid JSON/);
  await assert.rejects(requestJSON(base + '/loop'), /redirected too many/);
  await assert.rejects(requestJSON(base + '/error'), error => /HTTP 503/.test(error.message) && !error.message.includes('SECRET'));
});

test('unsupported stream types and unsafe headers never become executable playback requests', () => {
  for (const raw of [{infoHash: 'abc'}, {ytId: 'youtube-id'}, {externalUrl: 'https://example.invalid'},
    {url: 'file:///private/data'}, {url: 'https://user:password@example.invalid/movie'},
    {url: 'https://example.invalid/movie', behaviorHints: {proxyHeaders: {request: {Authorization: 'value\r\nInjected: yes'}}}}]) {
    const result = normalizeStream(raw, 'Fixture');
    assert.equal(result.playable, false); assert.ok(result.reason.length);
  }
  assert.equal(manifestURL('stremio://example.invalid/manifest.json').protocol, 'https:');
  assert.throws(() => manifestURL('https://example.invalid/configure'), /manifest.json/);
  assert.equal(new AddonCollection().urls[0], DEFAULT_ADDON_URL);
  const redacted = redactText('https://user:password@example.invalid/path/APISECRET?key=SECRET Authorization: Bearer TOKEN');
  assert.equal(/password|APISECRET|TOKEN|key=SECRET/.test(redacted), false);
});

test('visual metadata is bounded and artwork keeps only HTTP(S) URLs without embedded credentials', () => {
  const meta = normalizeMeta({id: 'fixture:movie', type: 'movie', name: 'Fixture',
    poster: 'https://images.example.invalid/poster.jpg', background: 'https://images.example.invalid/scene.jpg#fragment',
    logo: 'https://images.example.invalid/logo.png', posterShape: 'landscape',
    genres: ['Drama', 'Science\nfiction', ...Array(12).fill('x'.repeat(80))], runtime: '94 min', imdbRating: '8.2'});
  assert.equal(meta.background, 'https://images.example.invalid/scene.jpg');
  assert.equal(meta.logo, 'https://images.example.invalid/logo.png');
  assert.equal(meta.posterShape, 'landscape');
  assert.equal(meta.genres.length, 8); assert.equal(meta.genres[1], 'Science fiction');
  assert.equal(meta.genres.at(-1).length, 48);
  assert.equal(meta.runtime, '94 min'); assert.equal(meta.rating, '8.2');
  for (const value of ['file:///private/picture.jpg', 'https://user:secret@example.invalid/picture.jpg',
    'https://images.example.invalid/' + 'x'.repeat(2048), 'https://images.example.invalid/' + '界'.repeat(300)]) {
    const unsafe = normalizeMeta({id: 'fixture:movie', type: 'movie', background: value, logo: value,
      posterShape: 'unknown', genres: 'Drama', runtime: {}, rating: {value: 8}});
    assert.equal(unsafe.background, undefined); assert.equal(unsafe.logo, undefined);
    assert.equal(unsafe.posterShape, 'poster'); assert.deepEqual(unsafe.genres, []);
    assert.equal(unsafe.runtime, ''); assert.equal(unsafe.rating, '');
  }
  assert.equal(normalizeMeta({id: 'fixture:movie', type: 'movie', rating: 8.5}).rating, '8.5');
});

test('one malformed addon does not hide a valid provider', async t => {
  const base = await server(t, (_, response) => response.end(JSON.stringify({id: 'working', types: ['movie'], resources: ['catalog'],
    catalogs: [{id: 'working', type: 'movie'}]})));
  const collection = await new AddonCollection({addonUrls: ['invalid-url', base + '/manifest.json']}).init();
  assert.equal(collection.errors.length, 1); assert.equal(collection.catalogs().length, 1);
});

test('subtitle addon routes preserve exact episode IDs, bounded extras and query authentication', async t => {
  const seen = [], logs = [];
  const base = await server(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture'); seen.push(url);
    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/manifest.json')) response.end(JSON.stringify({id: 'same-provider', name: 'Subtitle fixture', types: ['series'],
      idPrefixes: ['tt'], resources: ['subtitles'], catalogs: []}));
    else response.end(JSON.stringify({subtitles: [
      {id: 'en-1', lang: 'eng', url: base + '/english.srt?key=SUBTITLESECRET'},
      {id: 'en-1', lang: 'eng', url: base + '/duplicate.srt'},
      {id: 'en-cc', lang: 'eng', label: 'English [CC]', url: base + '/captions.vtt'},
      {id: 'unsafe', lang: 'eng', url: 'file:///private/subtitles.srt'},
      {id: 'credentials', lang: 'eng', url: 'https://user:secret@fixture.invalid/file.srt'},
      {lang: 'eng', url: base + '/no-id.srt'}
    ]}));
  });
  const collection = await new AddonCollection({addonUrls: [base + '/a/manifest.json?key=FIRSTSECRET', base + '/b/manifest.json?key=SECONDSECRET'],
    onLog: message => logs.push(message)}).init();
  const extras = {videoHash: '0123456789abcdef', videoSize: 4096, filename: 'Show S01 & title.mkv', ignored: 'NOTFORWARDED'};
  const tracks = await collection.subtitles('series', 'tt123456:1/2', extras);
  assert.equal(tracks.length, 4); assert.equal(new Set(tracks.map(track => track.id)).size, 4);
  assert.equal(tracks[0].remoteId, 'en-1'); assert.equal(tracks[0].label, 'English');
  assert.equal(tracks[1].label, 'English [CC]'); assert.equal(tracks[0].addonName, 'Subtitle fixture');
  assert.equal(tracks[0].url, base + '/english.srt?key=SUBTITLESECRET');
  assert.deepEqual((await collection.subtitles('series', 'tt123456:1/2', extras)).map(track => track.id), tracks.map(track => track.id));
  for (const url of seen.filter(url => url.pathname.includes('/subtitles/'))) {
    assert.match(url.pathname, /\/subtitles\/series\/tt123456%3A1%2F2\/videoHash=0123456789abcdef&videoSize=4096&filename=Show%20S01%20%26%20title.mkv\.json$/);
    assert.ok(['FIRSTSECRET', 'SECONDSECRET'].includes(url.searchParams.get('key')));
    assert.ok(!url.href.includes('NOTFORWARDED'));
  }
  const before = seen.length;
  assert.deepEqual(await collection.subtitles('movie', 'tt123456'), []);
  assert.deepEqual(await collection.subtitles('series', 'unrelated:1:2'), []);
  assert.equal(seen.length, before);
  assert.ok(logs.every(message => !/FIRSTSECRET|SECONDSECRET|SUBTITLESECRET/.test(message)));
});

test('resource-specific rules override manifest prefixes while catalogs remain discoverable', async () => {
  const manifest = {id: 'fixture', name: 'Fixture', types: ['series'], idPrefixes: ['tt'], catalogs: [], resources: [
    {name: 'subtitles', types: ['series'], idPrefixes: ['episode:']}, 'catalog',
    {name: 'meta', types: ['series']}
  ]};
  const client = await new AddonClient('https://fixture.invalid/manifest.json',
    {fetchImpl: async () => new Response(JSON.stringify(manifest))}).init();
  assert.equal(client.supports('subtitles', 'series', 'episode:1:2'), true);
  assert.equal(client.supports('subtitles', 'series', 'tt1'), false);
  assert.equal(client.supports('subtitles', 'movie', 'episode:1'), false);
  assert.equal(client.supports('catalog', 'series', 'all'), true);
  assert.equal(client.supports('meta', 'series', 'any'), true);
  assert.equal(client.supports('subtitles', 'series', {}), false);
});

test('subtitle normalization and metadata reject unsafe values; collection bounds partial providers', async () => {
  assert.equal(normalizeSubtitle({id: 'x', lang: 'eng', url: 'https://fixture.invalid/subtitle.srt'}, 'Provider').lang, 'eng');
  for (const raw of [{id: 'x', lang: {}, url: 'https://fixture.invalid/file.srt'},
    {id: 'x', lang: ' ', url: 'https://fixture.invalid/file.srt'},
    {id: 'x\nsecret', lang: 'eng', url: 'https://fixture.invalid/file.srt'},
    {id: 'x', lang: 'eng', url: 'https://fixture.invalid/' + '界'.repeat(1000)},
    {id: 'x', lang: 'eng', url: 'javascript:alert(1)'}]) assert.equal(normalizeSubtitle(raw, 'Provider'), null);
  assert.deepEqual(subtitleExtras({videoSize: 42, ignored: 'private'}), {videoSize: 42});
  for (const extras of [{videoHash: 'invalid'}, {videoSize: '42'}, {videoSize: Infinity}, {filename: '\nprivate'}, []])
    assert.throws(() => subtitleExtras(extras), /invalid/);
  const collection = new AddonCollection();
  collection.clients = [{supports: () => true, subtitles: async () => { throw Error('secret provider error'); }},
    {supports: () => true, subtitles: async () => Array.from({length: 250}, (_, index) => ({id: String(index)}))}];
  assert.equal((await collection.subtitles('movie', 'tt123')).length, 200);
  collection.clients.pop();
  await assert.rejects(collection.subtitles('movie', 'tt123'), error => /providers could not return/.test(error.message) && !error.message.includes('secret'));
});

module.exports = {server};
