'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {summarize} = require('../tools/diagnose-ns2jb-acquisition.cjs');

function fixture(name, {success, error = ''}) {
  const dir = path.join(root, name);
  const switch2 = path.join(dir, 'switch2');
  fs.mkdirSync(path.join(switch2, 'memory'), {recursive: true});
  fs.writeFileSync(path.join(switch2, 'pipeline.json'), JSON.stringify({
    stages: [{name: 'FS read, write and restoration', status: success ? 'complete' : 'failed'}],
  }));
  fs.writeFileSync(path.join(switch2, 'acquisition.log'), error
    ? JSON.stringify({stage: 'bounded-failure', error}) + '\n' : '');
  const report = {qualifiedReadSize: success ? 1572864 : null, markerSelected: success,
    linkCandidates: success ? [{target: 1}, {target: 2}] : [],
    cases: [{profile: 'abort-control', pinCost: 13616, pinWindow: true}]};
  fs.writeFileSync(path.join(switch2, 'memory', 'reserved-gap-1.json'), JSON.stringify(report));
  if (success) {
    fs.mkdirSync(path.join(switch2, 'ro', 'root'), {recursive: true});
    fs.writeFileSync(path.join(switch2, 'ro', 'root', 'current-root.json'), '{}');
  }
  return dir;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2jb-diag-'));

test('a run with a promoted root is a pass', () => {
  const run = summarize(fixture('switch2-ok', {success: true}));
  assert.equal(run.success, true);
  assert.equal(run.failure, null);
  assert.equal(run.links, 2);
  assert.equal(run.pins[0], 13616);
});

test('a bounded native link failure is classified', () => {
  const run = summarize(fixture('switch2-bad', {success: false,
    error: 'The bounded native leak contains no qualified, encodable link candidate'}));
  assert.equal(run.success, false);
  assert.equal(run.failure, 'no-link-candidate');
});

test('an extent requalification failure is classified from the cases', () => {
  const dir = fixture('switch2-extent', {success: false});
  fs.writeFileSync(path.join(dir, 'switch2', 'memory', 'reserved-gap-1.json'), JSON.stringify({
    qualifiedReadSize: null, cases: [{profile: 'extent-present', allPending: false}]}));
  assert.equal(summarize(dir).failure, 'extent-requalify');
});
