#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {profiles,profileById,selectedProfile,sourceDigest,trustedProfileForDigest,validStartCommand} = require('./host-profiles.cjs');
const {verifyProfile,selectHost} = require('./prepare-host-profiles.cjs');
const root = path.resolve(__dirname,'..');

test('four pinned host sources preserve their original bootstraps and capabilities', async () => {
  assert.deepEqual(profiles.map(row=>row.label),['pepsipu','kurumuz','BermTheSequel','IZMYSH']);
  assert.equal(new Set(profiles.map(row=>row.sourceSha256)).size,4);
  assert.equal(selectedProfile(root).id,'kurumuz');
  for (const profile of profiles) {
    const folder=verifyProfile(root,profile);
    assert.equal(sourceDigest(folder,profile),profile.sourceSha256);
    if (profile.engine === 'izmysh') {
      assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'engine.json'),'utf8')).consolePort,39395);
      assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'engine.json'),'utf8')).bootstrap.saveName,'NS2I');
    } else {
      assert.equal(sourceDigest(folder),await require(path.join(folder,'run.cjs')).sourceDigest());
      assert.equal(fs.readFileSync(path.join(folder,'bootstrap.bas'),'utf8').includes(
        profile.startArgumentCount===9 ? 'COMMON DEF START(PORT,A,B,C,D,T0#,T1#,T2#,T3#)' : 'COMMON DEF START(PORT,A,B,C,D)'),true);
    }
  }
  assert.equal(profileById('pepsipu').supportsHeldRPC,false);
  assert.equal(profileById('pepsipu').supportsDemo,false);
  assert.equal(profileById('kurumuz').supportsDemo,true);
  assert.equal(profileById('BermTheSequel').supportsDemo,true);
  assert.equal(profileById('izmysh').startPort,39395);
  assert.equal(profileById('izmysh').saveName,'NS2I');
  assert.equal(profileById('izmysh').supportsHeldRPC,false);
  assert.equal(profileById('izmysh').supportsDemo,false);
  assert.throws(()=>trustedProfileForDigest(root,profileById('pepsipu').sourceSha256));
});

test('pairing commands are bound to selected arity, address and exact 48-bit token limits',()=>{
  const five='V=START(39380,192,0,2,1)', nine='V=START(39380,192,0,2,1,0,1,281474976710655,42)';
  for (const profile of profiles) {
    assert.equal(validStartCommand(five,profile,'192.0.2.1'),profile.startArgumentCount===5);
    assert.equal(validStartCommand(nine,profile,'192.0.2.1'),profile.startArgumentCount===9 && profile.startPort===39380);
  }
  assert.equal(validStartCommand('V=START(39395,192,0,2,1,0,1,2,3)',profileById('izmysh'),'192.0.2.1'),true);
  assert.equal(validStartCommand('V=START(39380,192,0,2,1,0,1,2,3)',profileById('izmysh'),'192.0.2.1'),false);
  for (const bad of [nine.replace('281474976710655','281474976710656'),nine.replace(',42)',',042)'),
    nine.replace(',42)',',-1)'),nine.replace(',42)',',4.2)'),nine+'\n',nine+';PRINT 1',nine.replace(',192,',',256,')])
    assert.equal(validStartCommand(bad,profileById('pepsipu')),false,bad);
  assert.equal(validStartCommand(nine,profileById('pepsipu'),'192.0.2.2'),false);
});

test('each pinned host command generator matches its own bootstrap and profile',()=>{
  const address='192.0.2.1', tokens=[1,2,3,4];
  for(const profile of profiles) {
    const folder=path.join(root,profile.sourceDirectory);
    const generated=profile.engine==='izmysh'
      ? require(path.join(folder,'server/lib/network.cjs')).connectCommand(address,tokens,profile.startPort)
      : profile.id==='pepsipu'
        ? require(path.join(folder,'run.cjs')).connectCommand(address,tokens)
        : require(path.join(folder,'run.cjs')).connectCommand(address,profile.startArgumentCount);
    const source=fs.readFileSync(path.join(folder,'bootstrap.bas'),'utf8');
    const declaration=/COMMON DEF START\(([^)]+)\)/.exec(source);
    assert.ok(declaration,profile.id);
    assert.equal(declaration[1].split(',').length,profile.startArgumentCount,profile.id);
    assert.equal(validStartCommand(generated,profile,address),true,profile.id);
    for(const other of profiles.filter(row=>row.startArgumentCount!==profile.startArgumentCount ||
      row.startPort!==profile.startPort))
      assert.equal(validStartCommand(generated,other,address),false,profile.id+' / '+other.id);
  }
});

test('fresh runtime selection installs actual selected code and keeps trusted original sources',t=>{
  for (const profile of profiles) {
    const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-profile-test-'));
    t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
    fs.mkdirSync(path.join(runtime,'source/vendor'),{recursive:true});
    fs.cpSync(path.join(root,'vendor/ns2jb'),path.join(runtime,'source/vendor/ns2jb'),{recursive:true});
    fs.cpSync(path.join(root,'vendor/IZ2S-Platform'),path.join(runtime,'source/vendor/IZ2S-Platform'),{recursive:true});
    fs.mkdirSync(path.join(runtime,'vendor'),{recursive:true});
    fs.cpSync(path.join(root,'vendor/ns2jb'),path.join(runtime,'vendor/ns2jb'),{recursive:true});
    fs.cpSync(path.join(root,'vendor/ns2jb-hosts'),path.join(runtime,'vendor/ns2jb-hosts'),{recursive:true});
    fs.cpSync(path.join(root,'vendor/IZ2S-Platform'),path.join(runtime,'vendor/IZ2S-Platform'),{recursive:true});
    fs.mkdirSync(path.join(runtime,'packaging'),{recursive:true});
    for (const name of ['IZ2S-Platform-SHA256SUMS','IZ2S-Platform-provenance.json'])
      fs.copyFileSync(path.join(root,'packaging',name),path.join(runtime,'packaging',name));
    fs.cpSync(path.join(root,'assets/hosts'),path.join(runtime,'assets/hosts'),{recursive:true});
    selectHost(runtime,profile.id);
    assert.equal(selectedProfile(runtime).id,profile.id);
    assert.equal(sourceDigest(profile.engine==='izmysh' ? path.join(runtime,'source',profile.sourceDirectory) :
      path.join(runtime,'vendor/ns2jb'),profile),profile.sourceSha256);
    assert.equal(fs.readFileSync(path.join(runtime,'assets/bootstrap.bas')).equals(
      fs.readFileSync(path.join(root,profile.bootstrap))),true);
    for (const held of profiles.filter(row=>row.supportsHeldRPC))
      assert.equal(trustedProfileForDigest(runtime,held.sourceSha256).profile.id,held.id);
    assert.throws(()=>selectHost(runtime,'BermTheSequel'),/fresh runtime/);
  }
});

test('packaged selection accepts the same runtime through a filesystem alias but rejects another root',t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-profile-alias-'));
  t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const runtime=path.join(parent,'runtime'),alias=path.join(parent,'alias');
  fs.mkdirSync(path.join(runtime,'source'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'source/LICENSE'),'runtime source marker');
  fs.writeFileSync(path.join(runtime,'node'),'runtime node marker');
  fs.mkdirSync(path.join(runtime,'scripts'));
  for(const name of ['host-profiles.cjs','prepare-host-profiles.cjs'])
    fs.copyFileSync(path.join(__dirname,name),path.join(runtime,'scripts',name));
  fs.mkdirSync(path.join(runtime,'packaging'));
  fs.copyFileSync(path.join(root,'packaging/host-profiles.json'),path.join(runtime,'packaging/host-profiles.json'));
  fs.cpSync(path.join(root,'vendor/ns2jb'),path.join(runtime,'vendor/ns2jb'),{recursive:true});
  fs.cpSync(path.join(root,'assets/hosts'),path.join(runtime,'assets/hosts'),{recursive:true});
  fs.symlinkSync(runtime,alias,'dir');
  const script=path.join(alias,'scripts/prepare-host-profiles.cjs');
  const different=path.join(parent,'different');
  fs.mkdirSync(path.join(different,'source'),{recursive:true});
  fs.writeFileSync(path.join(different,'source/LICENSE'),'other source marker');
  fs.writeFileSync(path.join(different,'node'),'other node marker');
  const wrong=spawnSync(process.execPath,[script,'--select','BermTheSequel',different],{encoding:'utf8'});
  assert.equal(wrong.status,1);assert.match(wrong.stderr,/fresh bundled runtime/);
  assert.equal(fs.existsSync(path.join(different,'selected-host.json')),false);
  const selected=spawnSync(process.execPath,[script,'--select','BermTheSequel',alias],{encoding:'utf8'});
  assert.equal(selected.status,0,selected.stderr);
  assert.equal(selectedProfile(runtime).id,'BermTheSequel');
  const repeated=spawnSync(process.execPath,[script,'--select','BermTheSequel',alias],{encoding:'utf8'});
  assert.equal(repeated.status,1);assert.match(repeated.stderr,/fresh runtime/);
});
