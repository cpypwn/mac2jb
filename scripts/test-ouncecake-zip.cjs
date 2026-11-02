'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {buildIndex} = require('../vendor/OunceCake/engine/mounts.cjs');
const {catalog, startZipServer} = require('../vendor/OunceCake/engine/zip-download.cjs');

const indexFor = entries => buildIndex([{path: '/game', kind: 'storage', entries}]);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('downloads selected game files as a valid ZIP64 archive through bounded HTTP streams', async t => {
  const contents = new Map([
    ['/game/readme.txt', Buffer.from('hello from OunceCake\n')],
    ['/game/assets/%E9%9B%AA.bin', Buffer.alloc(2048, 0x5a)],
  ]);
  const source = http.createServer((request, response) => {
    const data = contents.get(request.url);
    if (!data) return response.writeHead(404).end();
    response.writeHead(200, {'Content-Length': data.length});
    for (let offset = 0; offset < data.length; offset += 31)
      response.write(data.subarray(offset, offset + 31));
    response.end();
  });
  await listen(source);
  t.after(() => close(source));
  const index = indexFor([
    {path: '/readme.txt', type: 'file', size: contents.get('/game/readme.txt').length},
    {path: '/assets/雪.bin', type: 'file', size: contents.get('/game/assets/%E9%9B%AA.bin').length},
  ]);
  const zip = await startZipServer({index, sourcePort: source.address().port, title: 'Selected Game'});
  t.after(() => zip.close());
  zip.setSourceAddress('127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${zip.port}/download-all.zip`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-length'), catalog(index).bytes.toString());
  assert.match(response.headers.get('content-disposition'), /Selected_Game\.zip/);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(BigInt(archive.length), catalog(index).bytes);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ouncecake-zip-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const archivePath = path.join(directory, 'game.zip');
  await fs.writeFile(archivePath, archive);
  const check = spawnSync('python3', ['-c', `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 print(json.dumps({name: archive.read(name).hex() for name in archive.namelist()}))`, archivePath], {encoding: 'utf8'});
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), {
    'game/readme.txt': contents.get('/game/readme.txt').toString('hex'),
    'game/assets/雪.bin': contents.get('/game/assets/%E9%9B%AA.bin').toString('hex'),
  });
});

test('ZIP64 catalog supports files over 4 GiB without allocating their contents', () => {
  const size = 5n * 1024n * 1024n * 1024n;
  const index = indexFor([{path: '/large.bin', type: 'file', size}]);
  const result = catalog(index);
  assert.equal(result.files[0].size, size);
  assert.ok(result.bytes > 0xffffffffn);
});

test('unsafe names and malformed indexes cannot become ZIP paths', () => {
  const index = indexFor([{path: '/safe.txt', type: 'file', size: 1}]);
  const corrupt = Buffer.from(index);
  const fileNode = 64 + 2 * 48;
  const stringOffset = Number(corrupt.readBigUInt64LE(32));
  const nameOffset = corrupt.readUInt32LE(fileNode + 16);
  corrupt[stringOffset + nameOffset] = '/'.charCodeAt(0);
  assert.throws(() => catalog(corrupt), /Unsafe OunceCake file path/);
  assert.throws(() => catalog(index.subarray(0, index.length - 1)), /Invalid OunceCake file index layout/);
});
