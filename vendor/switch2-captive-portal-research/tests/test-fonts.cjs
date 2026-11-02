const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'switch2-probes-fonts.js'), 'utf8');
function fixture(mode) {
  let resolveLoad;
  let additions = 0;
  const fonts = new Set();
  const nodes = new Set();
  fonts.status = 'loaded';
  fonts.check = () => true;
  const setAdd = fonts.add.bind(fonts);
  fonts.add = face => { additions++; return setAdd(face); };
  const body = {
    appendChild(node) { nodes.add(node); node.parentNode = body; },
    removeChild(node) { nodes.delete(node); node.parentNode = null; }
  };
  const document = { fonts, body, createElement() {
    return { style: {}, getBoundingClientRect() { return { width: 32 }; } };
  } };
  function FontFace() { this.status = 'unloaded'; }
  FontFace.prototype.load = function () {
    const face = this;
    if (mode === 'reject') { return Promise.reject(new Error('unavailable')); }
    if (mode === 'late') { return new Promise(resolve => { resolveLoad = () => { face.status = 'loaded'; resolve(face); }; }); }
    this.status = 'loaded';
    return Promise.resolve(this);
  };
  const window = { FontFace, SwitchProbeModules: [], setTimeout: fn => setTimeout(fn, 5), clearTimeout };
  if (mode === 'missing') { delete window.FontFace; }
  vm.runInNewContext(source, { window, document });
  return { run: window.SwitchProbeModules[0].run, fonts, nodes, late: () => resolveLoad(), additions: () => additions };
}
test('successful font run cleans added font and DOM sample', async () => {
  const f = fixture('success');
  const result = await f.run();
  assert.ok(result.checks.every(x => x.status === 'passed'));
  assert.equal(f.additions(), 1);
  assert.equal(f.fonts.size, 0);
  assert.equal(f.nodes.size, 0);
});
test('late font load cannot add a font after timed-out run cleanup', async () => {
  const f = fixture('late');
  const result = await f.run();
  assert.equal(result.checks.find(x => x.id === 'font-load').status, 'timeout');
  f.late();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.additions(), 0);
  assert.equal(f.fonts.size, 0);
  assert.equal(f.nodes.size, 0);
});
for (const mode of ['missing', 'reject']) {
  test(mode + ' fonts remain unsupported and leave no resources', async () => {
    const f = fixture(mode);
    const result = await f.run();
    assert.equal(result.checks.find(x => x.id === 'font-load').status, 'unsupported');
    assert.equal(f.fonts.size, 0);
    assert.equal(f.nodes.size, 0);
  });
}
