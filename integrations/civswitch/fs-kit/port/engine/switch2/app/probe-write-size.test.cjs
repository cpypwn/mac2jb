const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('write-size file readbacks use the FileSystem read receive mode', () => {
  const probe = fs.readFileSync(require.resolve('./probe-write-size.cjs'), 'utf8');
  const filesystem = fs.readFileSync(require.resolve('./filesystem.cjs'), 'utf8');
  const readbackModes = [...probe.matchAll(/\{receive:\s*\[\{address:[^}]+mode:\s*(\d+)\}\]\}/g)]
    .map(match => Number(match[1]));

  assert.deepEqual(readbackModes, [1, 1, 1]);
  assert.match(filesystem, /async function readFile\([\s\S]*?\{receive:\s*\[\{address:\s*buffer,\s*size,\s*mode:\s*1\}\]\}/);
});
