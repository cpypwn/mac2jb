const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {assemble, verify} = require('./package-lovera1n.cjs');

test('standalone package works without the source checkout', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lovera1n-package-'));
  const output = path.join(temporary, 'lovera1n');
  try {
    const {manifest} = assemble(output);
    assert.equal(verify(output).files.length, manifest.files.length);
    const names = manifest.files.map(item => item.path);
    assert.ok(names.includes('integrations/lovera1n.cjs'));
    assert.ok(names.includes('integrations/lovera1n-NOTICE.txt'));
    assert.ok(names.includes('integrations/civswitch/fs-kit/LICENSE'));
    assert.ok(names.includes('integrations/civswitch/fs-kit/port/engine/build-payload.cjs'));
    assert.ok(names.includes('integrations/civswitch/fs-kit/port/engine/switch2/ro/payload/main'));
    assert.ok(!names.some(name => /(?:^|\/)(?:runs|showcase)(?:\/|$)|\.test\.cjs$|candidate|\.log$/.test(name)));
    const help = spawnSync(process.execPath, ['integrations/lovera1n.cjs', '--help'],
      {cwd: output, encoding: 'utf8'});
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage: node integrations\/lovera1n\.cjs/);
    const check = spawnSync(process.execPath, ['-e', [
      'const target = require("./integrations/civswitch/fs-kit/port/engine/shared/target.cjs")',
      'const engine = require("./integrations/civswitch/fs-kit/port/engine/run.cjs")',
      'const profile = target.loadTarget("gravcirc")',
      'target.validateArtifacts(profile)',
      'engine.sourceDigest(profile).then(digest => {',
      '  if (!/^[0-9a-f]{64}$/.test(digest)) process.exitCode = 1',
      '}).catch(error => { console.error(error); process.exitCode = 1 })',
    ].join(';')], {cwd: output, encoding: 'utf8'});
    assert.equal(check.status, 0, check.stderr);

    const payload = path.join(output,
      'integrations/civswitch/fs-kit/port/engine/switch2/ro/payload/main');
    fs.appendFileSync(payload, 'tamper');
    assert.throws(() => verify(output), /Package file changed/);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
