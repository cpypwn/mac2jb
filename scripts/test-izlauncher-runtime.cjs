'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const vacootube=require('../integrations/vacootube/prepare.cjs');
const runtime=require('./prepare-izlauncher.cjs'),repository=path.resolve(__dirname,'..');
const fixtureVacooSha='0'.repeat(64);
vacootube.prepare=async()=>({sha256:fixtureVacooSha,packageBytes:0});
vacootube.verifySync=()=>({allowed:new Set(),sha256:fixtureVacooSha,packageBytes:0});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-izruntime-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.cpSync(path.join(repository,'vendor/IZ2S-Platform'),path.join(root,'vendor/IZ2S-Platform'),{recursive:true});
  fs.cpSync(path.join(repository,'vendor/BlitBun'),path.join(root,'vendor/BlitBun'),{recursive:true});
  fs.cpSync(path.join(repository,'integrations/blitbun'),path.join(root,'integrations/blitbun'),{recursive:true});
  fs.copyFileSync(path.join(repository,'integrations/mac-stream-host.cjs'),path.join(root,'integrations/mac-stream-host.cjs'));
  fs.cpSync(path.join(repository,'integrations/izlauncher-shell'),path.join(root,'integrations/izlauncher-shell'),{recursive:true});
  fs.mkdirSync(path.join(root,'packaging'));
  fs.copyFileSync(path.join(repository,'packaging/IZ2S-Platform-SHA256SUMS'),path.join(root,'packaging/IZ2S-Platform-SHA256SUMS'));
  return root;
}
test('preparation preserves every frozen source file and exposes Mac base modules',async t=>{
  const root=fixture(t),before=runtime.sourceFiles(root),info=await runtime.prepare(root);
  assert.equal(info.revision,runtime.REVISION);assert.equal(before.size,598);
  assert.deepEqual(runtime.sourceFiles(root),before);
  const env=runtime.runtimeEnvironment(root,{PATH:'/usr/bin'});
  assert.equal(env.IZ2S_ROOT,info.directory);assert.equal(env.HB_APPS_DIR,path.join(info.directory,'data/app-links'));
  assert.deepEqual(Object.keys(JSON.parse(env.IZ2S_MODULE_PINS).modules),['iz-exchange','blitbun','vacootube']);
  const descriptor=JSON.parse(fs.readFileSync(path.join(info.directory,'modules/iz-exchange/module.json')));
  assert.deepEqual(descriptor.platforms,['darwin-arm64']);assert.deepEqual(descriptor.dependencies,[]);
  assert.equal(fs.existsSync(path.join(info.directory,'modules/izdoom')),false);
  assert.equal(fs.existsSync(path.join(info.directory,'data/app-links/izdoom')),false);
  assert.match(fs.readFileSync(path.join(info.directory,'shells/izlauncher/server/hero-text.py'),'utf8'),/font=os.environ\['HB_FONT'\]/);
  await assert.rejects(runtime.prepare(root),/fresh destination/);
});
test('changed source code and changed inventory fail before creating a prepared runtime',async t=>{
  for(const target of ['vendor/IZ2S-Platform/core/archive.cjs','packaging/IZ2S-Platform-SHA256SUMS']) {
    const root=fixture(t);fs.appendFileSync(path.join(root,target),'\nchanged');
    await assert.rejects(runtime.prepare(root),/Changed IZlauncher/);
    assert.equal(fs.existsSync(runtime.location(root)),false);
  }
});
test('runtime code, pinned version and catalog drift are rejected before a helper may use them',async t=>{
  const root=fixture(t),info=await runtime.prepare(root);
  for(const relative of ['core/module-adapter.cjs','modules/iz-exchange/module.json',
    'modules/iz-exchange/.versions/'+info.moduleSha256+'/server/runtime.cjs',
    'data/app-links/iz-exchange/app.json']) {
    const file=path.join(info.directory,relative),saved=fs.readFileSync(file);fs.appendFileSync(file,'\nchanged');
    assert.throws(()=>runtime.verify(root),/Changed/);fs.writeFileSync(file,saved);
  }
  assert.equal(runtime.verify(root).moduleSha256,info.moduleSha256);
});
test('unexpected modules, escaped links and forged package contents cannot extend the base runtime',async t=>{
  const root=fixture(t),info=await runtime.prepare(root);
  const extra=path.join(info.directory,'modules/unsupported/entry.cjs');fs.mkdirSync(path.dirname(extra));fs.writeFileSync(extra,'throw Error("not allowed")');
  assert.throws(()=>runtime.verify(root),/Invalid custom IZlauncher module archive|Unexpected IZlauncher runtime file|ENOENT/);fs.rmSync(path.dirname(extra),{recursive:true});
  const target=path.join(info.directory,'data/app-links/iz-exchange/app.json'),saved=fs.readFileSync(target);
  fs.unlinkSync(target);fs.symlinkSync(path.join(root,'vendor/IZ2S-Platform/modules/iz-exchange/switch/app.json'),target);
  assert.throws(()=>runtime.verify(root),/forbids links/);fs.unlinkSync(target);fs.writeFileSync(target,saved);
  const archive=require(path.join(info.directory,'core/archive.cjs')),file=path.join(info.directory,'modules/iz-exchange/iz-exchange.izm');
  const pkg=archive.inspect(fs.readFileSync(file));pkg.files.find(row=>row.name==='server/runtime.cjs').bytes=Buffer.from('changed');
  fs.writeFileSync(file,archive.encode(pkg.files));assert.throws(()=>runtime.verify(root),/integrity|checksum|digest/i);
});
