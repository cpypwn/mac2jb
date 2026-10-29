#!/usr/bin/env node
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const archive=require('../vendor/IZ2S-Platform/core/archive.cjs');
const catalog=require('../vendor/MintBrew/homebrew-launcher/app-catalog.cjs');
const adapter=require('../integrations/izdoom/prepare.cjs');
const root=path.resolve(__dirname,'..');

test('pinned IZDOOM release stages as a standalone MintBrew GPU app',async t=>{
  const upstream=adapter.source(root,archive),expected=adapter.mintBrewFiles(root,archive);
  const original=new Map(upstream.files.map(file=>[file.name,file.bytes]));
  for(const [name,bytes] of expected.files){
    if(name==='app.json'||name==='icon.png')continue;
    const releaseName=original.has('switch/'+name)?'switch/'+name:name;
    assert.ok(bytes.equals(original.get(releaseName)),name);
  }
  const manifest=JSON.parse(expected.files.get('app.json'));
  assert.equal(manifest.name,'DOOM');
  assert.equal(manifest.description,'GPU POC based on PureDOOM, bundled with DOOM shareware v1.9 (Episode 1)');
  assert.ok(expected.files.get('icon.png').equals(fs.readFileSync(path.join(root,'integrations/izdoom/branding/doom-icon.png'))));
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-izdoom-mintbrew-'));
  t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  assert.equal(adapter.prepareMintBrew(root,runtime).sha256,adapter.MODULE_SHA256);
  assert.equal(adapter.verifyMintBrew(root,runtime).sha256,adapter.MODULE_SHA256);
  const folder=path.join(runtime,'apps/izdoom');
  const oldValidator=process.env.SPIRV_VAL,oldPath=process.env.PATH;
  const portable=path.join(root,'.build-gui/homebrew');
  process.env.SPIRV_VAL=path.join(portable,'bin/spirv-val');
  process.env.PATH=path.join(portable,'python/bin')+path.delimiter+oldPath;
  t.after(()=>{
    if(oldValidator===undefined)delete process.env.SPIRV_VAL;else process.env.SPIRV_VAL=oldValidator;
    process.env.PATH=oldPath;
  });
  const app=await catalog.readApp(folder);
  assert.equal(app.id,'izdoom');
  assert.equal(app.name,'DOOM');
  assert.equal(app.manifest.computeSequence.repeat,2);
  assert.equal(app.files.memory.allocationBytes,32*1024*1024);
  assert.ok(app.files.memory.bytes.length>0);
  assert.ok(fs.statSync(path.join(folder,'game-data/DOOM1.WAD')).size>4*1024*1024);
  assert.ok(fs.statSync(path.join(folder,'LICENSES/DOOM1-SHAREWARE.txt')).size>0);
  assert.deepEqual((await catalog.scan(path.join(runtime,'apps'))).apps.map(item=>item.id),['izdoom']);
  fs.appendFileSync(path.join(folder,'app.json'),'\nchanged');
  assert.throws(()=>adapter.verifyMintBrew(root,runtime),/Changed IZDOOM MintBrew file/);
});
