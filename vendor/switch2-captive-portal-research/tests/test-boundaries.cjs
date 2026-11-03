const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'switch2-probes-boundaries.js'), 'utf8');
function load(overrides = {}) {
  const window = { SwitchProbeModules: [], setTimeout, Uint8Array, TextEncoder, TextDecoder, URL, ...overrides };
  const context = vm.createContext({ window });
  vm.runInContext(source, context);
  return { run: window.SwitchProbeModules[0].run, context };
}
test('fixed corpus completes 48 cases in six groups', async () => {
  const { run } = load();
  const result = await run();
  assert.equal(result.budget.casesAttempted, 48);
  assert.equal(result.checks.length, 6);
  assert.ok(result.checks.every(c => c.status === 'passed' && c.details.casesAttempted === 8));
});
test('missing APIs remain unsupported rather than passed', async () => {
  const { run } = load({ Uint8Array: undefined, URL: undefined, TextEncoder: undefined });
  const result = await run();
  assert.equal(result.checks.filter(c => c.status === 'unsupported').length, 3);
  assert.equal(result.budget.casesAttempted, 24);
});
test('cancelled campaign executes no cases', async () => {
  const { run } = load();
  const result = await run({ isActive: () => false });
  assert.equal(result.budget.casesAttempted, 0);
  assert.ok(result.checks.every(c => c.status === 'not-tested'));
});
test('deadline stops before another case without claiming a hard interrupt', async () => {
  const { run, context } = load();
  vm.runInContext('var ticks=0; Date.now=function(){ return (ticks++)*3000; };', context);
  const result = await run();
  assert.equal(result.budget.casesAttempted, 0);
  assert.ok(result.checks.every(c => c.status === 'timeout'));
  assert.equal(result.budget.cooperativeDeadline, true);
});
test('unexpected API exceptions become failed observations', async () => {
  const { run } = load({ URL: function () { throw new Error('fixture'); } });
  const result = await run();
  assert.equal(result.checks.find(c => c.id === 'url-roundtrip').status, 'failed');
});
