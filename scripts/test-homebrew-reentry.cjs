'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {releaseMarkers} = require('./homebrew-reentry.cjs');

const generic = '.mac2jb-hblauncher-attempt.json';
const ouncecake = '.mac2jb-ouncecake-attempt.json';

function fixture(t, names = [generic]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-reentry-'));
  fs.chmodSync(directory, 0o700);
  const bytes = Buffer.from(JSON.stringify({application: 'test', started: 'now'}));
  for (const name of names) fs.writeFileSync(path.join(directory, name), bytes, {mode: 0o600, flag: 'wx'});
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const proof = {cleanupVerified: true,
    attemptMarkerSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    attemptMarkers: names};
  return {directory, proof};
}

test('clean launcher releases exactly its verified marker', t => {
  const {directory, proof} = fixture(t);
  releaseMarkers(directory, proof);
  assert.equal(fs.existsSync(path.join(directory, generic)), false);
});

test('OunceCake requires both matching markers before releasing either', t => {
  const {directory, proof} = fixture(t, [generic, ouncecake]);
  fs.writeFileSync(path.join(directory, ouncecake), 'different');
  assert.throws(() => releaseMarkers(directory, proof, true), /changed/);
  assert.equal(fs.existsSync(path.join(directory, generic)), true);
  assert.equal(fs.existsSync(path.join(directory, ouncecake)), true);
});

test('missing proof and unexpected marker name do not release the attempt', t => {
  const {directory, proof} = fixture(t);
  assert.throws(() => releaseMarkers(directory, {...proof, cleanupVerified: false}), /prove/);
  assert.throws(() => releaseMarkers(directory, {...proof, attemptMarkers: ['result.json']}), /prove/);
  assert.equal(fs.existsSync(path.join(directory, generic)), true);
});

test('symlink marker is rejected without touching its target', t => {
  const {directory, proof} = fixture(t);
  const target = path.join(directory, 'target');
  fs.writeFileSync(target, 'untouched');
  fs.unlinkSync(path.join(directory, generic));
  fs.symlinkSync(target, path.join(directory, generic));
  assert.throws(() => releaseMarkers(directory, proof));
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
});
