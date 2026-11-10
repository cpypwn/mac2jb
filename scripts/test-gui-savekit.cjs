const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {PassThrough} = require('node:stream');
const {stageEditor, stageProEditor, stageCustomEditor, backupProof, chooseUser,
  existingEditorState, editorInstallPlan, customEditorPlan,
  artemisProfile, fullSeedsowProfile, stageArtemis, stageUpstreamArtemis,
  artemisInstallPlan, cachedArtemisArchive,
  stageBundledArtemis, artemisHttpShowcase, artemisInjectShowcase,
  missingSaveArchive, balatroProfile, stageBalatro, gravcircProfile, stageGravcirc,
  sameSaveEntries} = require('./gui-savekit.cjs');
const {prepare} = require('./prepare-seedsow-host.cjs');
const {profileById} = require('./host-profiles.cjs');
const sourceRoot = path.resolve(__dirname, '..');
const provenance = require('../vendor/ns2-savekit/provenance.json');
const showcaseFiles = ['cpypwn.lua', 'ssslot006.ref',
  'save0006.dat', 'save0006.png', 'save0006_s.png'];
const artemisFiles = ['core.lua', 'exploita.lua', 'http.lua', 'inject.iet',
  'inject.lua', 'proggy.ttf', 'save9999.dat', 'saveg.dat', 'system.dat'];
const bundledFiles = [...artemisFiles, 'exploitb.lua', 'inject2.lua', 'http2.lua'].sort();
const {indexedSave, patchAutosave, injectAsb, stageFullSeedsow} = require('./seedsow-full-save.cjs');

function fullSeedsowFixture() {
  const u32 = value => {const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes;};
  const string = value => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)]);
  const fields = [Buffer.alloc(4)];
  let length = 4;
  const add = bytes => {const at = length; fields.push(bytes); length += bytes.length; return at;};
  const handler = add(string('vsync'));
  const caretBase = add(u32(4));
  const script = add(string('system/script.asb'));
  const caret4 = add(u32(0));
  const bodyFields = Buffer.concat(fields);
  const index = Buffer.concat([u32(2), u32(0), u32(2),
    u32(3), u32(caretBase), u32(34), u32(handler),
    u32(caretBase), u32(3), u32(1), u32(caretBase),
    u32(3), u32(script), u32(4), u32(caret4)]);
  const body = Buffer.concat([bodyFields, index, u32(bodyFields.length)]);
  const zlib = require('node:zlib');
  return Buffer.concat([Buffer.from('BOWS'), u32(1003), u32(body.length), zlib.deflateSync(body)]);
}

test('full Seedsow install patches only a verified v1003 autosave', async t => {
  assert.equal(fullSeedsowProfile().titleId, '0100ee5021c9e000');
  const input = fullSeedsowFixture();
  const patched = patchAutosave(input);
  const save = indexedSave(patched);
  const root = save.groups.get(0), caret = save.groups.get(root.get(3));
  assert.equal(save.fieldString(caret.get(3)).toString(), 'save:/inject.asb');
  assert.equal(save.fieldU32(caret.get(1)), 0);
  assert.equal(save.fieldU32(caret.get(4)), 1);
  assert.equal(save.fieldString(root.get(34)).toString(), '');
  assert.deepEqual(patchAutosave(patched), patched);
  const wrongVersion = Buffer.from(input); wrongVersion.writeUInt32LE(1002, 4);
  assert.throws(() => patchAutosave(wrongVersion), /v1003/);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-full-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const backup = path.join(temp, 'backup'), stage = path.join(temp, 'stage');
  await fs.mkdir(backup); await fs.mkdir(stage);
  for (const name of ['autosave.dat', 'saveg.dat', 'system.dat', 'save0001.dat',
    'save0001.png', 'save0001_s.png'])
    await fs.writeFile(path.join(backup, name), name === 'autosave.dat' ? input : Buffer.from(name));
  for (const name of ['save9999.dat', 'saveg.dat', 'system.dat', 'core.lua'])
    await fs.writeFile(path.join(stage, name), name);
  const files = await stageFullSeedsow(stage, backup);
  assert.deepEqual(files, ['autosave.dat', 'core.lua', 'inject.asb', 'save0001.dat']);
  assert.deepEqual(await fs.readFile(path.join(stage, 'save0001.dat')), patched);
  assert.equal(injectAsb().subarray(0, 5).toString('hex'), '4153420000');
  await assert.rejects(fs.stat(path.join(stage, 'saveg.dat')), {code: 'ENOENT'});
});

test('full Seedsow installer stages the upstream menu even after a showcase install', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-upstream-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const backup = path.join(temp, 'backup'), stage = path.join(temp, 'stage');
  await fs.mkdir(backup);
  for (const name of ['autosave.dat', 'saveg.dat', 'system.dat', 'save0001.dat',
    'save0001.png', 'save0001_s.png'])
    await fs.writeFile(path.join(backup, name), name === 'autosave.dat'
      ? fullSeedsowFixture() : Buffer.from(name));
  await fs.writeFile(path.join(backup, 'inject.asb'), injectAsb());
  await fs.writeFile(path.join(backup, 'inject2.lua'), 'personal HTTP display');
  const staged = await stageUpstreamArtemis(stage, 'seedsow');
  assert.equal(staged.includes('inject.lua'), true);
  assert.equal(staged.includes('inject2.lua'), false);
  const files = await stageFullSeedsow(stage, backup, {preferUpdate: false});
  assert.equal(files.includes('exploitb.lua'), false);
  assert.equal(files.includes('http2.lua'), false);
  const loader = await fs.readFile(path.join(stage, 'inject.asb'));
  assert.equal(loader.includes(Buffer.from('save:/inject.lua')), true);
  assert.equal(loader.includes(Buffer.from('inject2.lua')), false);
  const plan = await customEditorPlan(stage, backup, files);
  assert.equal(plan.files.includes('inject.asb'), true);
  assert.equal(plan.files.includes('inject.lua'), true);
});

test('Seedsow Lua Editor Pro stages its pinned demo save without replacing slot 6', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-pro-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const files = await stageProEditor(path.join(temp, 'editor'));
  assert.equal(files.length, 301);
  assert.ok(files.includes('sscode006.lua'));
  assert.ok(files.includes('ssedit1.lua'));
  assert.ok(!files.includes('.nx_save_meta.bin'));
  assert.ok(!files.includes('cpypwn.lua'));
});

async function artemisFixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artemis-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const files = path.join(temp, 'files'), archive = path.join(temp, 'save.zip');
  await fs.mkdir(files);
  for (const name of artemisFiles) {
    const content = name === 'http.lua'
      ? 'local function run_save(body, path)\n\treturn #body .. " bytes to " .. path\nend\n' +
        'function n2h_http_frame() end\npost_init()\n' +
        'e:setEventHandler{ onEnterFrame = "n2h_http_frame" }\n'
      : name === 'inject.lua'
        ? 'local function init_console() end\nlocal function launch(mode)\n' +
          '\te:setEventHandler{ onEnterFrame = "n2h_launcher_idle" }\n' +
          '\tn2h_clear()\n\te:include(core_path)\n\te:include(payload)\nend\n' +
          'function n2h_launcher_frame()\nend\nlocal function launcher_main() end\nlauncher_main()'
        : name + ' from pinned fixture';
    await fs.writeFile(path.join(files, name), content);
  }
  const {execFileSync} = require('node:child_process');
  execFileSync('/usr/bin/zip', ['-jq', archive, ...artemisFiles.map(name => path.join(files, name))],
    {stdio: 'ignore'});
  const sha256 = require('node:crypto').createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  return {temp, files, archive, profile: {sha256}};
}

test('Artemis profiles pin four separate demo saves', () => {
  assert.equal(artemisProfile('seedsow').titleId, '010042d022aea000');
  assert.equal(artemisProfile('nora').titleId, '010012900d38a000');
  assert.equal(artemisProfile('hamidashi').titleId, '0100848014154000');
  assert.equal(artemisProfile('nora1').titleId, '01002eb00ce48000');
  assert.equal(artemisProfile('nora1').sourceDirectory,
    'integrations/artemis/upstream-nora1');
  assert.notEqual(artemisProfile('seedsow').sha256, artemisProfile('nora').sha256);
  assert.notEqual(artemisProfile('nora').sha256, artemisProfile('hamidashi').sha256);
  assert.notEqual(artemisProfile('hamidashi').sha256, artemisProfile('nora1').sha256);
  assert.throws(() => artemisProfile('full'), /Seedsow, Nora 2, Hamidashi or Nora 1/);
});

test('both pinned Balatro saves stage nested hidden files without JKSV metadata', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-balatro-stage-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  assert.throws(() => balatroProfile('unknown'), /original Balatro save/);
  assert.equal(balatroProfile('upstream').path,
    'integrations/balatro-rce/balatro-switch-rce-1.1.0.zip');
  const upstream = await stageBalatro(path.join(temp, 'upstream'), 'upstream');
  const showcase = await stageBalatro(path.join(temp, 'showcase'), 'showcase');
  assert.equal(upstream.length, 20);
  assert.equal(showcase.length, 21);
  assert.ok(upstream.includes('.lovegame/main.lua'));
  assert.ok(upstream.includes('.lovegame/conf.lua'));
  assert.ok(showcase.includes('.lovegame/bl/showcase.lua'));
  assert.equal(upstream.includes('.nx_save_meta.bin'), false);
  assert.deepEqual(showcase.filter(name => name !== '.lovegame/bl/showcase.lua'), upstream);
  const overlay = await fs.readFile(path.join(temp, 'showcase', '.lovegame', 'bl', 'showcase.lua'), 'utf8');
  assert.match(overlay, /package\.loaded\["bl\.app"\]/);
  assert.match(overlay, /return ip, "RPC 9026  ·  FTP 5000  ·  PASV 5001"/);
  assert.doesNotMatch(overlay, /FTP ftp:\/\//);
});

test('the pinned Gravity Circuit save stages its nested release files without JKSV metadata', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-gravcirc-stage-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const profile = gravcircProfile();
  assert.equal(profile.sha256,
    'ab018f3e9947dba3750f18b64100fb76366559fce94bd45db3799fcf9028709e');
  const files = await stageGravcirc(path.join(temp, 'save'));
  assert.equal(files.length, 18);
  assert.ok(files.includes('.Gravity Circuit/main.lua'));
  assert.ok(files.includes('.Gravity Circuit/gc/offsets.lua'));
  assert.ok(files.includes('.Gravity Circuit/gc/rpc.lua'));
  assert.ok(files.includes('.Gravity Circuit/gc/ftp_server.lua'));
  assert.equal(files.includes('.nx_save_meta.bin'), false);
  const offsets = await fs.readFile(path.join(temp, 'save', '.Gravity Circuit', 'gc', 'offsets.lua'), 'utf8');
  assert.match(offsets, /gravity-circuit-v1\.0/);
  assert.match(offsets, /gravity-circuit-v1\.2\.1/);
});

test('the bundled Gravity Circuit source matches its pinned file manifest', async () => {
  const pinned = require('../packaging/GravCirc-v1.1.json');
  const manifest = await fs.readFile(path.join(sourceRoot, pinned.sourceManifest));
  assert.equal(crypto.createHash('sha256').update(manifest).digest('hex'),
    pinned.sourceManifestSha256);
  const entries = manifest.toString('utf8').trimEnd().split('\n');
  assert.equal(entries.length, pinned.sourceFileCount);
  for (const line of entries) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.\/-]+)$/.exec(line);
    assert.ok(match, `invalid source manifest entry: ${line}`);
    assert.ok(match[2].split('/').every(part => part && part !== '.' && part !== '..'));
    const bytes = await fs.readFile(path.join(sourceRoot, pinned.sourceDirectory, match[2]));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), match[1], match[2]);
  }
});

test('an unchanged-save proof rejects added, missing or altered files', () => {
  const before = {entries: [
    {path: '/.lovegame/1/profile.jkr', size: 630, sha256: 'a'.repeat(64)},
    {path: '/.lovegame/settings.jkr', size: 703, sha256: 'b'.repeat(64)}
  ]};
  assert.equal(sameSaveEntries(before, {entries: [...before.entries].reverse()}), true);
  assert.equal(sameSaveEntries(before, {entries: before.entries.slice(0, 1)}), false);
  assert.equal(sameSaveEntries(before, {entries: [...before.entries,
    {path: '/.lovegame/bl/app.lua', size: 100, sha256: 'c'.repeat(64)}]}), false);
  assert.equal(sameSaveEntries(before, {entries: [before.entries[0],
    {...before.entries[1], sha256: 'c'.repeat(64)}]}), false);
  assert.equal(sameSaveEntries(before, {entries: [before.entries[0], before.entries[0]]}), false);
});

test('a missing save archive is recognized only when every probe returned 0x7d402', () => {
  const title = '010042d022aea000';
  const absent = {code: 1, stderr:
    '  space=User type=Account rank=0 index=0 uid=1234 -> 0x7d402\n' +
    '  space=User type=Account rank=0 index=0 uid=0000 -> 0x7d402\n' +
    'Error: No save filesystem opened for 0x10042d022aea000 (tried 2 attribute combinations)\n'};
  assert.equal(missingSaveArchive(absent, title), true);
  assert.equal(missingSaveArchive({...absent, code: 0}, title), false);
  assert.equal(missingSaveArchive(absent, '010012900d38a000'), false);
  assert.equal(missingSaveArchive({...absent,
    stderr: absent.stderr.replace('uid=0000 -> 0x7d402', 'uid=0000 -> 0xe02')}, title), false);
});

test('four modified Artemis saves stage offline and preserve custom B scripts', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artemis-bundled-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  for (const game of ['seedsow', 'nora', 'hamidashi', 'nora1']) {
    const staged = path.join(temp, game);
    assert.deepEqual(await stageBundledArtemis(staged, game), bundledFiles);
    const http = await fs.readFile(path.join(staged, 'http2.lua'), 'utf8');
    assert.match(http, /draw\("cpypwn_http_status", 636, 52, 26, "0xD7FFE8", "http listening on 8080"\)/);
    assert.match(http, /n2h_http_frame\(\)/);
    assert.match(http, /local REQ_CAP = 0x40000/);
    assert.match(http, /fs_commit_save_data/);
    const showcase = await fs.readFile(path.join(staged, 'exploitb.lua'), 'utf8');
    assert.match(showcase, /"cpypwn"/);
    if (game === 'hamidashi') assert.match(showcase, /kaleido_name_/);
    if (game === 'nora1') {
      assert.match(await fs.readFile(path.join(staged, 'core.lua'), 'utf8'),
        /game_id = "nora"/);
      assert.equal(crypto.createHash('sha256').update(
        await fs.readFile(path.join(staged, 'saveg.dat'))).digest('hex'),
      '163219cc8c4651b8c5a34c342aeb90998cad07be68861cf05c972375036569a0');
    }
    const inject = await fs.readFile(path.join(staged, 'inject2.lua'), 'utf8');
    assert.match(inject, /init_console\(\)\nprint = _G\.n2h_orig_print\nlaunch\("http"\)\n$/);
    assert.doesNotMatch(inject, /Press a button on the controller|A : slot 1|B : slot 2/);
    const backup = path.join(temp, game + '-old-save');
    await fs.mkdir(backup);
    for (const name of artemisFiles)
      await fs.copyFile(path.join(staged, name), path.join(backup, name));
    await fs.writeFile(path.join(backup, 'exploitb.lua'), 'user-owned B script');
    const plan = await artemisInstallPlan(staged, backup, bundledFiles);
    assert.equal(plan.kind, 'upgrade');
    assert.deepEqual(plan.files, ['http2.lua', 'inject2.lua']);
    assert.equal(await fs.readFile(path.join(backup, 'exploitb.lua'), 'utf8'),
      'user-owned B script');
    for (const name of ['inject2.lua', 'http2.lua']) {
      const previous = await fs.readFile(path.join(sourceRoot,
        'scripts/fixtures/artemis-build-530', name));
      assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),
        name === 'inject2.lua'
          ? 'b1ba6df3ceb14c81c720e43ea06d821effd6ba648787524f5c3c54ea8f7c1bf2'
          : '8977807d5675753a0334c1b3ae2c8095fdc49ae9bdfd2d2f04912cfecd5ac19e');
      await fs.writeFile(path.join(backup, name), previous);
    }
    const upgrade = await artemisInstallPlan(staged, backup, bundledFiles);
    assert.equal(upgrade.kind, 'upgrade');
    assert.deepEqual(upgrade.files, ['http2.lua', 'inject2.lua']);
    assert.equal(upgrade.present.has('exploitb.lua'), true);
  }
});

test('installed v1 Artemis files are recognized for a verified v2 upgrade', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artemis-v1-upgrade-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const {execFileSync} = require('node:child_process');
  for (const [game, file] of [
    ['seedsow', 'seedsowhax-v1-mac2jb.zip'],
    ['nora', 'norahax-v1-mac2jb.zip']
  ]) {
    const current = path.join(temp, game + '-v2');
    const installed = path.join(temp, game + '-v1');
    await stageBundledArtemis(current, game);
    await fs.mkdir(installed);
    const archive = path.join(sourceRoot, 'integrations/artemis', file);
    for (const name of bundledFiles)
      await fs.writeFile(path.join(installed, name),
        execFileSync('/usr/bin/unzip', ['-p', archive, name]));
    const plan = await artemisInstallPlan(current, installed, bundledFiles, game);
    assert.equal(plan.kind, 'upgrade');
    assert.deepEqual(plan.files, [
      'core.lua', 'exploitb.lua', 'http.lua', 'http2.lua', 'inject.lua'
    ]);
  }
});

test('a pinned flat Artemis release stages from a verified archive and reuses verified cache', async t => {
  const fixture = await artemisFixture(t);
  const staged = path.join(fixture.temp, 'staged');
  assert.deepEqual(await stageArtemis(staged, fixture.archive, fixture.profile),
    [...artemisFiles, 'exploitb.lua', 'inject2.lua', 'http2.lua'].sort());
  const showcase = await fs.readFile(path.join(staged, 'exploitb.lua'), 'utf8');
  assert.match(showcase, /draw\("cpypwn_name_".*"cpypwn"\)/);
  assert.match(showcase, /onEnterFrame = "cpypwn_artemis_frame"/);
  const inject = await fs.readFile(path.join(staged, 'inject2.lua'), 'utf8');
  assert.match(inject, /if mode == "http" then print = _G\.n2h_orig_print end/);
  assert.match(inject, /init_console\(\)\nprint = _G\.n2h_orig_print\nlaunch\("http"\)\n$/);
  assert.doesNotMatch(inject, /function n2h_launcher_frame|Press a button on the controller/);
  const http = await fs.readFile(path.join(staged, 'http2.lua'), 'utf8');
  assert.match(http, /n2h_http_frame\(\)/);
  assert.match(http, /cpypwn_artemis_frame\(\)/);
  assert.match(http, /onEnterFrame = "cpypwn_artemis_http_frame"/);
  assert.match(http, /draw\("cpypwn_http_status", 636, 52, 26, "0xD7FFE8", "http listening on 8080"\)/);
  assert.match(http, /local ready = st\.phase ~= "init" and st\.phase ~= "dead"/);
  const cache = path.join(fixture.temp, 'cache');
  await fs.mkdir(cache);
  await fs.copyFile(fixture.archive, path.join(cache, 'nora.zip'));
  assert.equal(await cachedArtemisArchive('nora', fixture.profile, cache), path.join(cache, 'nora.zip'));
  await assert.rejects(stageArtemis(path.join(fixture.temp, 'bad'), fixture.archive,
    {sha256: '0'.repeat(64)}), /integrity check/);
});

test('fresh Artemis installation replaces backed-up game data and preserves unrelated files', async t => {
  const fixture = await artemisFixture(t);
  const staged = path.join(fixture.temp, 'staged');
  const installFiles = await stageArtemis(staged, fixture.archive, fixture.profile);
  const backup = path.join(fixture.temp, 'backup');
  await fs.mkdir(backup);
  await fs.writeFile(path.join(backup, 'saveg.dat'), 'old game state');
  await fs.writeFile(path.join(backup, 'system.dat'), 'old settings');
  await fs.writeFile(path.join(backup, 'save0001.dat'), 'unrelated slot');
  const plan = await artemisInstallPlan(staged, backup, installFiles);
  assert.equal(plan.kind, 'fresh');
  assert.deepEqual(plan.files, installFiles);
  assert.equal(plan.present.has('saveg.dat'), true);
  assert.equal(plan.present.has('system.dat'), true);
  assert.equal(plan.present.has('save0001.dat'), true);
  for (const name of installFiles) await fs.copyFile(path.join(staged, name), path.join(backup, name));
  await fs.writeFile(path.join(backup, 'saveg.dat'), 'later user progress');
  assert.equal((await artemisInstallPlan(staged, backup, installFiles)).kind, 'current');
  await fs.rm(path.join(backup, 'inject2.lua'));
  await fs.rm(path.join(backup, 'http2.lua'));
  const upgrade = await artemisInstallPlan(staged, backup, installFiles);
  assert.equal(upgrade.kind, 'upgrade');
  assert.deepEqual(upgrade.files, ['http2.lua', 'inject2.lua']);
  await fs.copyFile(path.join(staged, 'inject2.lua'), path.join(backup, 'inject2.lua'));
  await fs.copyFile(path.join(staged, 'http2.lua'), path.join(backup, 'http2.lua'));
  await fs.rm(path.join(backup, 'exploitb.lua'));
  assert.deepEqual((await artemisInstallPlan(staged, backup, installFiles)).files, ['exploitb.lua']);
  await fs.writeFile(path.join(backup, 'exploitb.lua'), 'a user-owned B payload');
  const custom = await artemisInstallPlan(staged, backup, installFiles);
  assert.equal(custom.kind, 'custom');
  assert.deepEqual(custom.files, []);
  assert.equal(await fs.readFile(path.join(backup, 'exploitb.lua'), 'utf8'), 'a user-owned B payload');
  await fs.rm(path.join(backup, 'http2.lua'));
  const upgradeWithB = await artemisInstallPlan(staged, backup, installFiles);
  assert.equal(upgradeWithB.kind, 'upgrade');
  assert.deepEqual(upgradeWithB.files, ['http2.lua']);
  await fs.writeFile(path.join(backup, 'http2.lua'), 'a user-owned HTTP update');
  const customHttp = await artemisInstallPlan(staged, backup, installFiles);
  assert.equal(customHttp.kind, 'custom-http');
  assert.deepEqual(customHttp.files, []);
  await fs.copyFile(path.join(staged, 'http2.lua'), path.join(backup, 'http2.lua'));
  await fs.copyFile(path.join(staged, 'exploitb.lua'), path.join(backup, 'exploitb.lua'));
  await fs.rm(path.join(backup, 'save9999.dat'));
  assert.equal((await artemisInstallPlan(staged, backup, installFiles)).kind, 'partial');
  await fs.copyFile(path.join(staged, 'save9999.dat'), path.join(backup, 'save9999.dat'));
  await fs.writeFile(path.join(backup, 'save9999.dat'), 'modified entrypoint');
  assert.equal((await artemisInstallPlan(staged, backup, installFiles)).kind, 'different');
  await fs.copyFile(path.join(staged, 'save9999.dat'), path.join(backup, 'save9999.dat'));
  await fs.rm(path.join(backup, 'http.lua'));
  assert.equal((await artemisInstallPlan(staged, backup, installFiles)).kind, 'partial');
  await fs.copyFile(path.join(staged, 'http.lua'), path.join(backup, 'http.lua'));
  await fs.writeFile(path.join(backup, 'core.lua'), 'another Artemis core');
  assert.equal((await artemisInstallPlan(staged, backup, installFiles)).kind, 'different');

  const freshWithB = path.join(fixture.temp, 'fresh-with-b');
  await fs.mkdir(freshWithB);
  await fs.writeFile(path.join(freshWithB, 'exploitb.lua'), 'a user-owned B payload');
  const preserved = await artemisInstallPlan(staged, freshWithB, installFiles);
  assert.equal(preserved.kind, 'fresh');
  assert.equal(preserved.files.includes('exploitb.lua'), false);
});

test('Artemis script adapters reject an unrecognized upstream layout', () => {
  assert.throws(() => artemisInjectShowcase('different launcher'), /incompatible/);
  assert.throws(() => artemisHttpShowcase('different server', 'different showcase'), /incompatible/);
});

test('stage the pinned editor save with the cpypwn showcase in slot 6', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-stage-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const folder = path.join(temp, 'save');
  const files = await stageEditor(folder);
  const {execFileSync} = require('node:child_process');
  const archive = path.join(sourceRoot, 'vendor/ns2-savekit', provenance.editor.asset);
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', archive], {encoding: 'utf8'})
    .trimEnd().split('\n').filter(name => name !== '.nx_save_meta.bin').sort();
  assert.equal(files.length, provenance.editor.installableFiles + showcaseFiles.length);
  assert.deepEqual(files, entries.concat(showcaseFiles).sort());
  assert.equal(await fs.readFile(path.join(folder, 'ssslot006.ref'), 'utf8'),
    'cpypwn.lua\n');
  assert.match(await fs.readFile(path.join(folder, 'cpypwn.lua'), 'utf8'),
    /p\.label\('cpypwn', 509, 315, 80, 'cpypwn'\)/);
  assert.deepEqual(await fs.readFile(path.join(folder, 'save0006.dat')),
    await fs.readFile(path.join(folder, 'ssseed006.bin')));
  assert.equal(files.includes('mintbrew.lua') || files.includes('hello-world.lua'), false);
});

test('a selected account resolves instead of being cancelled by readline close', async () => {
  const input = new PassThrough();
  const first = 'a'.repeat(32), second = 'b'.repeat(32);
  const choice = chooseUser([first, second], input);
  input.write(JSON.stringify({action: 'select-user', uid: 'c'.repeat(32)}) + '\n');
  input.write(JSON.stringify({action: 'select-user', uid: second}) + '\n');
  assert.equal(await choice, second);
  input.destroy();
});

test('account-selected save worker exits while its parent keeps stdin open',
  {timeout: 5000}, async t => {
    const child = spawn(process.execPath, ['-e',
      `const {chooseUser} = require('./scripts/gui-savekit.cjs');
       chooseUser(['a'.repeat(32), 'b'.repeat(32)])
         .then(() => console.log('selection complete'));`],
    {cwd: sourceRoot, stdio: ['pipe', 'pipe', 'pipe']});
    t.after(() => { child.kill('SIGKILL'); child.stdin.destroy(); });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    child.stdin.write(JSON.stringify({action: 'select-user', uid: 'b'.repeat(32)}) + '\n');
    let timeout;
    const outcome = await Promise.race([closed,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(
        'Save worker kept stdin alive after account selection')), 2000); })])
      .finally(() => clearTimeout(timeout));
    assert.equal(outcome.code, 0, error);
    assert.match(output, /selection complete/);
    assert.equal(child.stdin.writableEnded, false);
  });

test('an existing or partial editor is preserved for SaveKit instead of overwritten', () => {
  assert.equal(existingEditorState(new Set()), 'fresh');
  assert.equal(existingEditorState(new Set(['ssedit1.lua', 'sed01.asb'])), 'installed');
  assert.equal(existingEditorState(new Set(['ssedit1.lua'])), 'partial');
  assert.equal(existingEditorState(new Set(['sed01.asb'])), 'partial');
});

test('matching editor receives only the showcase while unrelated save files remain untouched', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-refresh-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const extracted = path.join(temp, 'editor'), backup = path.join(temp, 'backup');
  const files = await stageEditor(extracted);
  await fs.mkdir(backup);
  for (const name of ['ssedit1.lua', 'sed01.asb'])
    await fs.copyFile(path.join(extracted, name), path.join(backup, name));
  assert.equal((await editorInstallPlan(extracted, backup, files)).kind, 'partial');
  for (const name of files) {
    if (['ssedit1.lua', 'sed01.asb', ...showcaseFiles].includes(name)) continue;
    await fs.copyFile(path.join(extracted, name), path.join(backup, name));
  }
  await fs.writeFile(path.join(backup, 'progress.dat'), 'keep this');
  let plan = await editorInstallPlan(extracted, backup, files);
  assert.equal(plan.kind, 'showcase');
  assert.deepEqual(plan.files.sort(), [...showcaseFiles].sort());
  for (const name of plan.files) await fs.copyFile(path.join(extracted, name), path.join(backup, name));
  plan = await editorInstallPlan(extracted, backup, files);
  assert.equal(plan.kind, 'current');
  assert.deepEqual(plan.files, []);
  assert.equal(plan.present.has('progress.dat'), true);
  await fs.writeFile(path.join(backup, 'ssslot006.ref'), 'other.lua\n');
  assert.equal((await editorInstallPlan(extracted, backup, files)).kind, 'slot-conflict');
  await fs.copyFile(path.join(extracted, 'ssslot006.ref'), path.join(backup, 'ssslot006.ref'));
  await fs.writeFile(path.join(backup, 'ssedit1.lua'), 'different editor');
  assert.equal((await editorInstallPlan(extracted, backup, files)).kind, 'different');
  await fs.rm(path.join(backup, 'sed01.asb'));
  assert.equal((await editorInstallPlan(extracted, backup, files)).kind, 'partial');
});

test('known old cpypwn slot migrates to cpypwn.lua without replacing unrelated files', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-rename-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const extracted = path.join(temp, 'editor'), backup = path.join(temp, 'backup');
  const files = await stageEditor(extracted);
  await fs.mkdir(backup);
  for (const name of files) {
    if (name === 'cpypwn.lua' || name === 'ssslot006.ref') continue;
    await fs.copyFile(path.join(extracted, name), path.join(backup, name));
  }
  await fs.copyFile(path.join(extracted, 'cpypwn.lua'),
    path.join(backup, 'cpypwn-showcase.lua'));
  await fs.writeFile(path.join(backup, 'ssslot006.ref'), 'cpypwn-showcase.lua\n');
  await fs.writeFile(path.join(backup, 'progress.dat'), 'keep this');
  let plan = await editorInstallPlan(extracted, backup, files);
  assert.equal(plan.kind, 'showcase');
  assert.deepEqual(plan.files, ['cpypwn.lua', 'ssslot006.ref']);
  for (const name of plan.files) await fs.copyFile(path.join(extracted, name), path.join(backup, name));
  plan = await editorInstallPlan(extracted, backup, files);
  assert.equal(plan.kind, 'current');
  assert.deepEqual(plan.files, []);
  assert.equal(await fs.readFile(path.join(backup, 'ssslot006.ref'), 'utf8'), 'cpypwn.lua\n');
  assert.equal(await fs.readFile(path.join(backup, 'progress.dat'), 'utf8'), 'keep this');
  assert.deepEqual(await fs.readFile(path.join(backup, 'cpypwn-showcase.lua')),
    await fs.readFile(path.join(backup, 'cpypwn.lua')));

  await fs.writeFile(path.join(backup, 'ssslot006.ref'), 'cpypwn-showcase.lua\n');
  await fs.writeFile(path.join(backup, 'cpypwn-showcase.lua'), 'user-owned script');
  assert.equal((await editorInstallPlan(extracted, backup, files)).kind, 'slot-conflict');
  await fs.copyFile(path.join(extracted, 'cpypwn.lua'),
    path.join(backup, 'cpypwn-showcase.lua'));
  await fs.writeFile(path.join(backup, 'cpypwn.lua'), 'user-owned new script');
  assert.equal((await editorInstallPlan(extracted, backup, files)).kind, 'slot-conflict');
});

test('a selected editor folder or ZIP stages flat files and updates only differences', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-custom-editor-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const source = path.join(temp, 'my-editor');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'ssedit1.lua'), 'custom Lua editor');
  await fs.writeFile(path.join(source, 'sed01.asb'), 'custom Artemis payload');
  await fs.writeFile(path.join(source, 'ssslot006.ref'), 'custom.lua\n');
  await fs.writeFile(path.join(source, 'custom.lua'), 'print("cpypwn")\n');
  await fs.writeFile(path.join(source, 'manifest.json'), '{"backup":true}\n');
  const staged = path.join(temp, 'staged');
  const files = await stageCustomEditor(staged, source);
  assert.deepEqual(files, ['custom.lua', 'sed01.asb', 'ssedit1.lua', 'ssslot006.ref']);
  const backup = path.join(temp, 'backup');
  await fs.mkdir(backup);
  await fs.writeFile(path.join(backup, 'progress.dat'), 'keep this');
  await fs.writeFile(path.join(backup, 'ssedit1.lua'), 'older editor');
  let plan = await customEditorPlan(staged, backup, files);
  assert.equal(plan.kind, 'custom');
  assert.deepEqual(plan.files, files);
  for (const name of files) await fs.copyFile(path.join(staged, name), path.join(backup, name));
  plan = await customEditorPlan(staged, backup, files);
  assert.equal(plan.kind, 'current');
  assert.deepEqual(plan.files, []);
  assert.equal(await fs.readFile(path.join(backup, 'progress.dat'), 'utf8'), 'keep this');

  const archive = path.join(temp, 'my-editor.zip');
  const {execFileSync} = require('node:child_process');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, archive]);
  const zipFiles = await stageCustomEditor(path.join(temp, 'zip-staged'), archive);
  assert.deepEqual(zipFiles, files);
  assert.deepEqual(await fs.readFile(path.join(temp, 'zip-staged/custom.lua')),
    await fs.readFile(path.join(staged, 'custom.lua')));
});

test('a custom editor rejects nested files and missing editor markers', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-custom-invalid-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const source = path.join(temp, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'ssedit1.lua'), 'editor');
  await assert.rejects(stageCustomEditor(path.join(temp, 'missing'), source),
    /do not contain a Seedsow Lua Editor save/);
  await fs.writeFile(path.join(source, 'sed01.asb'), 'payload');
  await fs.mkdir(path.join(source, 'nested'));
  await assert.rejects(stageCustomEditor(path.join(temp, 'nested'), source), /flat regular files/);
});

test('a backup must match its manifest before a save write', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-backup-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const crypto = require('node:crypto');
  const uid = 'c'.repeat(32), bytes = Buffer.from('original demo save');
  await fs.writeFile(path.join(temp, 'save0001.dat'), bytes);
  await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify({
    archive: 'space=User type=Account uid=' + uid.slice(0, 16), files: 1,
    entries: [{path: '/save0001.dat', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')}]
  }));
  await backupProof(temp, uid);
  await fs.writeFile(path.join(temp, 'save0001.dat'), 'changed');
  await assert.rejects(backupProof(temp, uid), /failed verification/);
});

test('Artemis backup proof rejects a different title before planning a write', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artemis-backup-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const crypto = require('node:crypto');
  const uid = 'c'.repeat(32), bytes = Buffer.from('original demo save');
  await fs.writeFile(path.join(temp, 'saveg.dat'), bytes);
  await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify({
    titleId: artemisProfile('seedsow').titleId,
    selection: {space: 1, type: 1, rank: 0, index: 0, staticId: 0, uid},
    archive: 'space=User type=Account uid=' + uid.slice(0, 16), files: 1,
    entries: [{path: '/saveg.dat', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')}]
  }));
  await backupProof(temp, uid, artemisProfile('seedsow').titleId);
  const manifestPath = path.join(temp, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({...manifest,
    programId: manifest.titleId, uid, space: 1, type: 1, rank: 0, index: 0}));
  await backupProof(temp, uid, artemisProfile('seedsow').titleId);
  const upstream = {archive: manifest.archive, programId: manifest.titleId,
    uid, space: 1, type: 1, rank: 0, index: 0, files: 1,
    bytes: bytes.length, partial: false, failed: [], entries: manifest.entries};
  await fs.writeFile(manifestPath, JSON.stringify(upstream));
  const verified = await backupProof(temp, uid, artemisProfile('seedsow').titleId);
  assert.equal(verified.titleId, manifest.titleId);
  assert.equal(verified.selection.uid, uid);
  await fs.writeFile(manifestPath, JSON.stringify({...upstream,
    programId: artemisProfile('nora').titleId}));
  await assert.rejects(backupProof(temp, uid, artemisProfile('seedsow').titleId),
    /selected title and account archive/);
  await fs.writeFile(manifestPath, JSON.stringify({...manifest, programId: manifest.titleId,
    uid: 'd'.repeat(32)}));
  await assert.rejects(backupProof(temp, uid, artemisProfile('seedsow').titleId),
    /conflicting uid/);
  await assert.rejects(backupProof(temp, uid, artemisProfile('nora').titleId),
    /selected title and account archive/);
});

for (const hostId of ['kurumuz', 'cellenseres', 'astral']) test('private ' + hostId +
  ' host overlays the savekit IPC patch', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-host-'));
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  const vendor = path.join(temp, 'vendor');
  await fs.mkdir(vendor);
  await fs.cp(path.join(sourceRoot, 'vendor/ns2jb-hosts', hostId),
    path.join(vendor, 'ns2jb'), {recursive: true});
  const savekit = path.join(vendor, 'ns2-savekit');
  await fs.mkdir(savekit, {recursive: true});
  for (const name of ['Seedsow-Lua-Editor-Save.zip'])
    await fs.copyFile(path.join(sourceRoot, 'vendor/ns2-savekit', name), path.join(savekit, name));
  for (const relative of ['engine/shared/ipc.cjs', 'engine/switch2/ro/ncm.cjs',
    'engine/switch2/app/mounted-save.cjs']) {
    const target = path.join(savekit, 'overlay', relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(path.join(sourceRoot, 'vendor/ns2-savekit/overlay', relative), target);
  }
  await fs.writeFile(path.join(temp, 'selected-host.json'), JSON.stringify(profileById(hostId)));
  const folder = prepare(temp);
  assert.match(path.basename(folder), /^ns2-savekit-host-/);
  assert.ok((await fs.stat(path.join(folder, 'run.cjs'))).isFile());
  for (const relative of ['engine/shared/ipc.cjs', 'engine/switch2/ro/ncm.cjs',
    'engine/switch2/app/mounted-save.cjs'])
    assert.deepEqual(await fs.readFile(path.join(folder, relative)),
      await fs.readFile(path.join(savekit, 'overlay', relative)));
  assert.ok((await fs.stat(path.join(folder, 'runs'))).isDirectory());
  const ipc = path.join(vendor, 'ns2jb/engine/shared/ipc.cjs');
  await fs.appendFile(ipc, '\nmodified\n');
  assert.throws(() => prepare(temp), /source integrity check failed/);
  await fs.copyFile(path.join(sourceRoot, 'vendor/ns2jb-hosts', hostId,
    'engine/shared/ipc.cjs'), ipc);
  await fs.appendFile(path.join(savekit, 'overlay/engine/switch2/ro/ncm.cjs'), '\nmodified\n');
  assert.throws(() => prepare(temp), /source integrity check failed/);
});
