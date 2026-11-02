const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const page = fs.readFileSync(path.join(__dirname, '..', 'switch2-browser-probe.html'), 'utf8');
test('page report export retains the complete installed-module baseline', () => {
  const baseline = JSON.parse(page.match(/getElementById\('baseline'\).*queue\((\[[^\]]+\])\)/)[1].replaceAll("'", '"'));
  const append = page.match(/reports\.push\([^\n]+/)[0];
  const exportBody = page.match(/getElementById\('export'\)\.onclick = function \(\) \{([^\n]+)\};/)[1];
  const report = {};
  const buttons = [...page.matchAll(/data-test="[^"]+"/g)];
  const context = vm.createContext({ reports: [], testButtons: buttons, begin: Date.now(), value: { checks: [] },
    navigator: { userAgent: 'host-export-fixture' }, document: { getElementById: () => report } });
  for (const name of ['previous-run', ...baseline]) {
    context.job = { test: name, revision: 'fixture-revision' };
    vm.runInContext(append, context);
  }
  vm.runInContext(exportBody, context);
  assert.deepEqual(JSON.parse(report.value).reports.map(x => x.test), baseline);
  assert.equal(report.hidden, false);
});
