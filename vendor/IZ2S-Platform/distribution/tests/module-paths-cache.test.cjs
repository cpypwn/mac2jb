const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archive = require('../../core/archive.cjs');
const modulePaths = require('../../core/module-paths.cjs');

test('archive descriptor discovery caches unchanged packages and sees replacements', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iz2s-module-paths-'));
  const first = path.join(root, 'modules', 'blitbun');
  fs.mkdirSync(first, { recursive: true });
  const packagePath = path.join(first, 'blitbun.izm');
  fs.writeFileSync(packagePath, 'original');
  const inspect = archive.inspect;
  let inspections = 0;
  archive.inspect = bytes => {
    inspections++;
    const id = bytes.toString();
    return { descriptor: { id, installationDirectory: id === 'newmod' ? 'newmod' : 'blitbun' } };
  };
  try {
    assert.deepEqual(modulePaths.discover(root).items.map(item => item.id), ['original']);
    assert.deepEqual(modulePaths.discover(root).items.map(item => item.id), ['original']);
    assert.equal(inspections, 1);

    const replacement = path.join(first, 'replacement.tmp');
    fs.writeFileSync(replacement, 'replaced');
    fs.renameSync(replacement, packagePath);
    assert.deepEqual(modulePaths.discover(root).items.map(item => item.id), ['replaced']);
    assert.equal(inspections, 2);

    const added = path.join(root, 'modules', 'newmod');
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, 'newmod.izm'), 'newmod');
    assert.deepEqual(modulePaths.discover(root).items.map(item => item.id), ['replaced', 'newmod']);
    assert.equal(inspections, 3);

    fs.writeFileSync(path.join(first, 'module.json'), JSON.stringify({ id: 'manifest', installationDirectory: 'blitbun' }));
    assert.deepEqual(modulePaths.discover(root).items.map(item => item.id), ['manifest', 'newmod']);
    assert.equal(inspections, 3);
  } finally {
    archive.inspect = inspect;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
