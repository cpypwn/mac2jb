const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'switch2-probes-fontenv.js'), 'utf8');

function fixture(mode) {
  const fonts = new Set();
  fonts.status = 'loaded';
  fonts.check = () => true;
  const setAdd = fonts.add.bind(fonts);
  const setDelete = fonts.delete.bind(fonts);
  let additions = 0;
  fonts.add = face => { additions++; return setAdd(face); };
  fonts.delete = face => setDelete(face);
  function FontFace(family, source) {
    this.family = family;
    this.source = source;
    this.status = 'unloaded';
  }
  FontFace.prototype.load = function () {
    const face = this;
    if (mode === 'reject') {
      return Promise.reject(new Error('unavailable'));
    }
    if (mode === 'async') {
      return new Promise(resolve => setTimeout(() => { face.status = 'loaded'; resolve(face); }, 1));
    }
    this.status = 'loaded';
    return Promise.resolve(this);
  };
  const document = { fonts, body: {} };
  const window = {
    FontFace,
    SwitchProbeModules: [],
    setTimeout: (fn, ms) => setTimeout(fn, typeof ms === 'number' ? ms : 5),
    clearTimeout,
    getComputedStyle: () => ({ fontFamily: 'fixture', fontSize: '16px' })
  };
  if (mode === 'missing') { delete window.FontFace; }
  vm.runInNewContext(source, { window, document });
  return { run: window.SwitchProbeModules[0].run, fonts, additions: () => additions };
}

test('fontenv inventories families and cleans added fonts', async () => {
  const f = fixture('sync');
  const result = await f.run();
  const ids = result.checks.map(x => x.id);
  assert.ok(ids.includes('fontenv-api'));
  assert.ok(ids.includes('fontenv-computed-family'));
  assert.ok(ids.includes('fontenv-local-helvetica'));
  assert.ok(ids.includes('fontenv-summary'));
  const api = result.checks.find(x => x.id === 'fontenv-api');
  assert.equal(api.details.thenOverridden, false);
  const local = result.checks.filter(x => x.id.startsWith('fontenv-local-'));
  assert.ok(local.every(x => x.status === 'passed'));
  const summary = result.checks.find(x => x.id === 'fontenv-summary');
  assert.equal(summary.details.familiesLoaded.length, local.length);
  assert.equal(f.additions(), local.length);
  assert.equal(f.fonts.size, 0);
  assert.equal(result.budget.thenOverride, false);
  assert.equal(result.budget.styleInvalidation, false);
});

test('fontenv reports async loads without claiming synchronous completion', async () => {
  const f = fixture('async');
  const result = await f.run();
  const local = result.checks.filter(x => x.id.startsWith('fontenv-local-'));
  assert.ok(local.every(x => x.status === 'passed'));
  assert.ok(local.every(x => x.details.loadedSynchronously === false));
  assert.equal(f.fonts.size, 0);
});

test('fontenv missing API stays unsupported and adds nothing', async () => {
  const f = fixture('missing');
  const result = await f.run();
  assert.equal(result.checks.find(x => x.id === 'fontenv-api').status, 'unsupported');
  assert.ok(result.checks.filter(x => x.id.startsWith('fontenv-local-')).every(x => x.status === 'unsupported'));
  assert.equal(f.additions(), 0);
  assert.equal(f.fonts.size, 0);
});

test('fontenv rejected local families stay unsupported and leave no resources', async () => {
  const f = fixture('reject');
  const result = await f.run();
  const local = result.checks.filter(x => x.id.startsWith('fontenv-local-'));
  assert.ok(local.every(x => x.status === 'unsupported'));
  assert.equal(f.fonts.size, 0);
});

test('fontenv source does not install a then getter or remove styles', () => {
  assert.doesNotMatch(source, /prototype\s*\.\s*then\s*=/);
  assert.doesNotMatch(source, /defineProperty\s*\(\s*FontFace\.prototype/);
  assert.doesNotMatch(source, /#invalidate/);
  assert.doesNotMatch(source, /offsetHeight/);
  assert.doesNotMatch(source, /removeChild|\.remove\s*\(/);
  assert.doesNotMatch(source, /document\.fonts\.load\s*\(/);
});
