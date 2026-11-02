const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const {plan} = require('../tools/fs-rpc-browser/install.cjs');
const {check} = require('../tools/fs-rpc-browser/requirements.cjs');
test('release dependency check accepts supported Node versions and explains missing support', () => {
  for (const version of ['20.20.0', '22.0.0', '24.1.0']) assert.doesNotThrow(() => check(version));
  for (const version of ['18.20.8', '20.19.9', 'invalid', '20.bad']) assert.throws(() => check(version), /Node.js/);
});
test('user shortcuts preserve paths with spaces and quote command-sensitive characters without installation', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sfb-shortcut-')); t.after(() => fs.rm(home, {recursive: true, force: true}));
  const portable = path.join(home, "Files & Games ' 100%"), node = path.join(home, 'Node Runtime/node');
  const linux = plan({platform:'linux', home, root:portable, node, env:{}});
  assert.equal(linux.length,1); assert.match(linux[0].path,/super-file-bros\.desktop$/); assert.ok(linux[0].text.includes('100%%'));
  assert.match(linux[0].text,/Terminal=true/);
  const mac = plan({platform:'darwin', home, root:portable, node});
  assert.equal(mac.length,2); assert.match(mac[0].text,/CFBundleExecutable/); assert.ok(mac[1].text.includes("'\\''")); assert.equal(mac[1].mode,0o755);
  const windows = plan({platform:'win32', home, root:portable, node, env:{APPDATA:path.join(home,'Profile App Data')}});
  assert.equal(windows.length,1); assert.ok(windows[0].text.includes('100%%')); assert.ok(windows[0].text.includes('chcp 65001')); assert.match(windows[0].path,/Super File Bros\.cmd$/);
  // Planning writes nothing to the machine's real shortcut directories.
  assert.deepEqual(await fs.readdir(home), []);
});
test('public documentation brands the release, covers both upstreams and includes the requested warning', async () => {
  const base = path.join(root, 'tools/fs-rpc-browser');
  for (const name of ['README.md','RELEASE_NOTES.md']) {
    const text = await fs.readFile(path.join(base,name),'utf8');
    assert.match(text,/Super File Bros\./); assert.ok(text.includes('https://gitlab.com/BermTheSequel/ns2jb2'));assert.ok(text.includes('https://gitlab.com/kurumuz/ns2jb'));
    assert.ok(!text.includes('launcher-la8nSA')); assert.ok(!text.includes('RUN20')); assert.ok(!text.includes('/home/k2/'));
  }
  const warning = await fs.readFile(path.join(base,'DISCLAIMER.md'),'utf8');
  assert.match(warning,/unexpected/); assert.match(warning,/Modifying, corrupting or deleting/); assert.match(warning,/consequences/);
  const page = await fs.readFile(path.join(base,'ui/index.html'),'utf8');assert.match(page,/<title>Super File Bros\.<\/title>/);assert.match(page,/Use caution/);
});

test('project release text and comments contain no Cyrillic text', async () => {
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
      const filename=path.join(directory,entry.name);
      if(entry.isDirectory()) await visit(filename);
      else {const text=await fs.readFile(filename,'utf8'); assert.ok(!/[\u0400-\u04ff]/u.test(text), 'Non-English text in '+path.relative(root,filename));}
    }
  }
  await visit(path.join(root,'tools/fs-rpc-browser'));
});
