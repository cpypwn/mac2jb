#!/usr/bin/env node
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const archive=require('../vendor/IZ2S-Platform/core/archive.cjs');
const {stage}=require('./stage-custom-izmodule.cjs');

async function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-izmodule-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runtime=path.join(root,'homebrew/IZ2S-Platform'),folder=path.join(root,'my-module');
  fs.mkdirSync(path.join(runtime,'modules'),{recursive:true});
  fs.mkdirSync(path.join(folder,'switch'),{recursive:true});
  const descriptor={format:'izlauncher.module',formatVersion:1,apiVersion:1,id:'my-module',name:'My Module',
    version:'1.0.0',author:'Test',platforms:['darwin-arm64'],
    requires:{platformApi:1,shell:'izlauncher',consoleAbi:1},
    switch:{entry:'switch/app.json',files:['switch/app.json','switch/icon.png'],abi:1},
    dependencies:[],settingsSchema:[],license:'MIT'};
  fs.writeFileSync(path.join(folder,'module.json'),JSON.stringify(descriptor));
  fs.writeFileSync(path.join(folder,'README.md'),'my module');
  fs.writeFileSync(path.join(folder,'LICENSE'),'MIT');
  fs.writeFileSync(path.join(folder,'switch/app.json'),JSON.stringify({format:'hblauncher.gpu-app',abi:1,id:'my-module'}));
  fs.writeFileSync(path.join(folder,'switch/icon.png'),Buffer.from('test icon'));
  const bytes=await archive.pack(folder),pkg=archive.inspect(bytes);
  fs.writeFileSync(path.join(folder,'checksums.json'),pkg.files.find(file=>file.name==='checksums.json').bytes);
  return {root,runtime,folder,descriptor,options:{archive,verify:()=>({directory:runtime})}};
}

test('a compatible checked module is staged into the current private IZlauncher runtime',async t=>{
  const f=await fixture(t),result=await stage(f.root,f.folder,f.options);
  assert.equal(result.id,'my-module');
  const file=path.join(f.runtime,'modules/my-module/my-module.izm');
  assert.equal(fs.readFileSync(file).equals(await archive.pack(f.folder)),true);
  assert.equal(archive.inspect(fs.readFileSync(file)).descriptor.platforms.includes('darwin-arm64'),true);
  assert.equal(fs.statSync(file).mode&0o077,0);
  await result.cleanup();
  assert.equal(fs.existsSync(path.dirname(file)),false);
});

test('invalid checksums and incompatible platforms leave no staged module',async t=>{
  const f=await fixture(t);
  fs.writeFileSync(path.join(f.folder,'README.md'),'changed after checksums');
  await assert.rejects(stage(f.root,f.folder,f.options),/checksums.json/);
  assert.equal(fs.existsSync(path.join(f.runtime,'modules/my-module')),false);
  fs.writeFileSync(path.join(f.folder,'README.md'),'my module');
  f.descriptor.platforms=['linux-x64'];
  fs.writeFileSync(path.join(f.folder,'module.json'),JSON.stringify(f.descriptor));
  const bytes=await archive.pack(f.folder),pkg=archive.inspect(bytes);
  fs.writeFileSync(path.join(f.folder,'checksums.json'),pkg.files.find(file=>file.name==='checksums.json').bytes);
  await assert.rejects(stage(f.root,f.folder,f.options),/not compatible/);
  assert.equal(fs.existsSync(path.join(f.runtime,'modules/my-module')),false);
});
