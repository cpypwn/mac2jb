const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {verifiedRun,options}=require('../install.cjs');

function fixture(t,target){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'modloader-run-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=path.join(root,'switch2-test'),proof=path.join(root,'proof.json');
 fs.mkdirSync(path.join(run,'switch2'),{recursive:true});
 const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
 write(path.join(run,'result.json'),{verified:true,rpc:{state:'listening'},
  ...(target==='civ7'?{target:'civ7'}:{})});
 write(path.join(run,'connection.json'),{addresses:{session:'switch2-test',target}});
 write(proof,{verified:true,session:'switch2-test'});
 write(path.join(run,'switch2/fs-execution-current.json'),{verified:true,file:proof});
 return {run,write,proof};
}

test('accepts verified ns2jb and CivSwitch FS runs',t=>{
 const ns2jb=fixture(t,'switch2'),civ=fixture(t,'civ7');
 assert.equal(verifiedRun(ns2jb.run),ns2jb.run);
 assert.equal(verifiedRun(civ.run),civ.run);
});

test('rejects a CivSwitch run whose result and connection targets disagree',t=>{
 const {run,write}=fixture(t,'civ7');
 write(path.join(run,'result.json'),{verified:true,rpc:{state:'listening'},target:'switch2'});
 assert.throws(()=>verifiedRun(run),/mismatched FS host target/);
});

test('rejects an ended run or a proof from another session',t=>{
 const {run,write,proof}=fixture(t,'civ7');
 write(path.join(run,'result.json'),{verified:true,rpc:{state:'closed'},target:'civ7'});
 assert.throws(()=>verifiedRun(run),/listening RPC session/);
 write(path.join(run,'result.json'),{verified:true,rpc:{state:'listening'},target:'civ7'});
 write(proof,{verified:true,session:'another-session'});
 assert.throws(()=>verifiedRun(run),/matching verified FS 4\/4 proof/);
});

test('accepts only isolated SD mod directories beneath the loader root',()=>{
 assert.equal(options(['--mod-source','/ns2jb-modloader/switch2-test/attempt_1']).modSource,
  '/ns2jb-modloader/switch2-test/attempt_1');
 for(const source of ['/ns2jb-modloader/switch2-test','/ns2jb-modloader/../other/attempt',
  '/ns2jb-modloader/switch2-test/attempt/extra'])
  assert.throws(()=>options(['--mod-source',source]),/Invalid session mod source/);
});
