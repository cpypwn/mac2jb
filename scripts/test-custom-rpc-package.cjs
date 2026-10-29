#!/usr/bin/env node
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {preflight,verifyPackage,main,validateManifest,ouncecakeFiles}=require('./custom-rpc-package.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-rpc-package-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function copyOunceCake(destination){
  const source=path.resolve(__dirname,'../vendor/OunceCake');
  for(const name of ouncecakeFiles){
    const output=path.join(destination,name);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.copyFileSync(path.join(source,name),output);
  }
  fs.writeFileSync(path.join(destination,'package.json'),JSON.stringify({name:'My OunceCake fork',version:'2.0.0'}));
}
test('a built OunceCake folder works without a mac2jb manifest',async t=>{
  const root=fixture(t),source=path.resolve(__dirname,'../vendor/OunceCake');
  const prepared=await preflight(root,source);
  try{
    assert.equal(prepared.kind,'rpc-app');
    assert.equal(prepared.adapter,'ouncecake');
    assert.equal(prepared.app.name,'OunceCake');
    assert.equal(prepared.app.files,ouncecakeFiles.length);
    const inspected=await verifyPackage(prepared.packageFolder);
    assert.equal(inspected.manifest.adapter,'ouncecake');
    assert.deepEqual(fs.readFileSync(path.join(prepared.packageFolder,'engine/oz-code/native.bin')),
      fs.readFileSync(path.join(source,'engine/oz-code/native.bin')));
    const outcome=await main(['/private/held-run',prepared.packageFolder],{
      ouncecakeMain:async(args,options)=>({args,snapshot:await options.verifySnapshot(),modules:options.modules})});
    assert.deepEqual(outcome.args,['/private/held-run']);
    assert.equal(outcome.snapshot.commit,null);
    assert.equal(outcome.snapshot.nativeImageSha256,
      hash(fs.readFileSync(path.join(source,'engine/oz-code/native.bin'))));
    assert.equal(typeof outcome.modules.ftp.deployFtp,'function');
  }finally{await prepared.cleanup();}
});
test('a compatible fork can change code and add a local engine module',async t=>{
  const root=fixture(t),source=path.join(root,'my-fork');
  copyOunceCake(source);
  const content=path.join(source,'engine/content.cjs');
  fs.writeFileSync(content,fs.readFileSync(content,'utf8')+'\nrequire("./extra.cjs");\n');
  fs.writeFileSync(path.join(source,'engine/extra.cjs'),'module.exports={fork:true};\n');
  const prepared=await preflight(root,source);
  try{
    assert.equal(prepared.app.name,'My OunceCake fork');
    assert.equal(prepared.app.version,'2.0.0');
    assert.equal(prepared.app.files,ouncecakeFiles.length+1);
    assert.equal(fs.existsSync(path.join(prepared.packageFolder,'engine/extra.cjs')),true);
    assert.equal(fs.existsSync(path.join(prepared.packageFolder,'package.json')),false);
    assert.equal(fs.existsSync(path.join(prepared.packageFolder,'engine/oz-code/native.c')),false);
  }finally{await prepared.cleanup();}
  fs.writeFileSync(path.join(source,'engine/content.cjs'),'require("./missing.cjs");\n');
  await assert.rejects(preflight(root,source),/requires missing engine\/missing\.cjs/);
});
test('manifest packages validate paths, hashes and a script entry before RPC',async t=>{
  const root=fixture(t),source=path.join(root,'script-app');fs.mkdirSync(source);
  const bytes=Buffer.from('if(!process.env.MAC2JB_RPC_RUN||!process.env.MAC2JB_RPC_CLIENT)process.exit(2);\n'+
    'console.log("MAC2JB_RPC_APP "+JSON.stringify({type:"stopped",cleanupVerified:true}));\n');
  fs.writeFileSync(path.join(source,'run.cjs'),bytes);
  const manifest={format:'mac2jb.held-rpc-app',version:1,adapter:'script',name:'A custom RPC app',
    entry:'run.cjs',files:{'run.cjs':hash(bytes)}};
  fs.writeFileSync(path.join(source,'mac2jb-rpc-app.json'),JSON.stringify(manifest));
  const prepared=await preflight(root,source);
  try{
    assert.equal(prepared.adapter,'script');
    assert.equal(prepared.app.name,'A custom RPC app');
  }finally{await prepared.cleanup();}
  assert.throws(()=>validateManifest({...manifest,files:{'../escape.cjs':hash(bytes)}}),/unsafe file/);
  fs.appendFileSync(path.join(source,'run.cjs'),'changed');
  await assert.rejects(preflight(root,source),/changed/);
});
test('a script app requires an explicit shutdown event before reporting success',async t=>{
  const root=fixture(t),source=path.join(root,'app');fs.mkdirSync(source);
  const bytes=Buffer.from('if(!process.env.MAC2JB_RPC_RUN||!process.env.MAC2JB_RPC_CLIENT)process.exit(2);\n'+
    'console.log("MAC2JB_RPC_APP "+JSON.stringify({type:"stopped",cleanupVerified:true}));\n');
  fs.writeFileSync(path.join(source,'run.cjs'),bytes);
  fs.writeFileSync(path.join(source,'mac2jb-rpc-app.json'),JSON.stringify({format:'mac2jb.held-rpc-app',
    version:1,adapter:'script',name:'A script app',entry:'run.cjs',files:{'run.cjs':hash(bytes)}}));
  const prepared=await preflight(root,source);
  t.after(()=>prepared.cleanup());
  const run=path.join(root,'vendor/ns2jb/runs/switch2-test');
  fs.mkdirSync(run,{recursive:true,mode:0o700});
  const addresses={session:'switch2-test',target:'switch2',platform:2,
    scratch:4096,main:8192,sdk:12288,backing:16384,controller:20480};
  fs.writeFileSync(path.join(run,'connection.json'),JSON.stringify({port:12345,addresses}),{mode:0o600});
  const events=[];
  const outcome=await main([run,prepared.packageFolder],{root,input:Readable.from([]),
    verifySession:async directory=>({root:directory,session:path.basename(directory)}),
    request:async()=>({ready:true}),emit:(type,value)=>events.push({type,...value})});
  assert.equal(outcome.stopped,true);
  assert.deepEqual(events.map(event=>event.type),['started','stopped']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run,'.mac2jb-hblauncher-attempt.json'))).adapter,'script');
  const report=path.join(events.at(-1).path,'custom-rpc-session.json');
  await prepared.cleanup();
  assert.equal(JSON.parse(fs.readFileSync(report)).status,'stopped');
});
test('an unconfirmed native script exit blocks cleanup and another attempt',async t=>{
  const root=fixture(t),source=path.join(root,'app');fs.mkdirSync(source);
  const bytes=Buffer.from('console.log("work completed");\n');
  fs.writeFileSync(path.join(source,'run.cjs'),bytes);
  fs.writeFileSync(path.join(source,'mac2jb-rpc-app.json'),JSON.stringify({format:'mac2jb.held-rpc-app',
    version:1,adapter:'script',name:'Unconfirmed app',entry:'run.cjs',files:{'run.cjs':hash(bytes)}}));
  const prepared=await preflight(root,source);t.after(()=>prepared.cleanup());
  const run=path.join(root,'vendor/ns2jb/runs/switch2-test');
  fs.mkdirSync(run,{recursive:true,mode:0o700});
  const addresses={session:'switch2-test',target:'switch2',platform:2,
    scratch:4096,main:8192,sdk:12288,backing:16384,controller:20480};
  fs.writeFileSync(path.join(run,'connection.json'),JSON.stringify({port:12345,addresses}),{mode:0o600});
  const events=[];
  await assert.rejects(main([run,prepared.packageFolder],{root,input:Readable.from([]),
    verifySession:async directory=>({root:directory,session:path.basename(directory)}),
    request:async()=>({ready:true}),emit:(type,value)=>events.push({type,...value})}),
  /did not confirm its native shutdown/);
  assert.equal(events.at(-1).type,'failed');
  assert.equal(events.at(-1).cleanupBlocked,true);
  assert.equal(fs.existsSync(path.join(run,'.mac2jb-hblauncher-attempt.json')),true);
});
