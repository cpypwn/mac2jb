'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{PassThrough}=require('node:stream');
const {spawnSync}=require('node:child_process');
const {main,verifySnapshot,validateConfiguration,catalogEntries,validateAttachment}=require('./gui-ouncecake.cjs');
const {withProgramIndexMap}=require('../vendor/OunceCake/engine/fs-context.cjs');
const {buildIndex}=require('../vendor/OunceCake/engine/mounts.cjs');
const {prepareInstalledLicense}=require('../vendor/OunceCake/engine/program.cjs');
const root=path.resolve(__dirname,'..'),title='0100000000001234';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(check){for(let n=0;n<200;n++){if(check())return;await wait(5);}throw Error('Fixture timed out');}
async function folder(t){const value=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'ouncecake-fixture-'));t.after(()=>fs.rm(value,{recursive:true,force:true}));return value;}
test('real self-test verifies the complete pin and image without a run or native connection',async()=>{
 const result=spawnSync(process.execPath,[path.join(root,'scripts/gui-ouncecake.cjs'),'--self-test'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).files,36);
 assert.equal(JSON.parse(result.stdout).commit,'6dfd7750752f8b6c18f2c40b34fdadc628cd9a6e');
});
test('changed bundled code is refused before loading any console interface',async t=>{
 const target=await folder(t);await fs.mkdir(path.join(target,'vendor'));await fs.mkdir(path.join(target,'packaging'));
 await fs.cp(path.join(root,'vendor/OunceCake'),path.join(target,'vendor/OunceCake'),{
  recursive:true,filter:source=>!source.split(path.sep).includes('.build')});
 for(const file of ['OunceCake-SHA256SUMS','OunceCake-upstream-SHA256SUMS','OunceCake-provenance.json'])await fs.copyFile(path.join(root,'packaging',file),path.join(target,'packaging',file));
 await fs.appendFile(path.join(target,'vendor/OunceCake/engine/session.cjs'),'\n// changed');
 await assert.rejects(verifySnapshot(target),/Changed bundled OunceCake file/);
});
test('configuration and catalog are explicit, bounded and omit arbitrary fields',()=>{
 assert.deepEqual(validateConfiguration({consoleAddress:'192.0.2.20',port:2121}),{consoleAddress:'192.0.2.20',port:2121});
 assert.deepEqual(validateConfiguration({consoleAddress:'192.0.2.20',port:2121,mode:'ftp'}),
  {consoleAddress:'192.0.2.20',port:2121,mode:'ftp'});
 for(const value of [{port:2121},{consoleAddress:'host.local',port:2121},
  {consoleAddress:'192.0.2.1',port:21},{consoleAddress:'192.0.2.1',port:2121,mode:'other'},null,[]])
  assert.throws(()=>validateConfiguration(value));
 const catalog=catalogEntries([{title,name:'💛'.repeat(100)+'\nSECRET',storages:[4,4,2],token:'secret'}]);
 assert.ok(Buffer.byteLength(catalog[0].name)<=160);assert.deepEqual(catalog[0].storages,[4,2]);assert.equal(catalog[0].token,undefined);
 assert.throws(()=>catalogEntries([]));assert.throws(()=>catalogEntries(Array(1001).fill({title,name:'Title',storages:[4]})));
 assert.throws(()=>catalogEntries([{title,name:'Title',storages:[3]}]));
});
test('native game card with zero FS606 RightsId skips ES account ELicense lookup',async()=>{
 const {prepareNativeInstalledLicense}=require('../vendor/OunceCake/engine/native-license.cjs');
 let esCalled=false;
 const result=await prepareNativeInstalledLicense({
  s:{threads:new Set(),async ipc(label,handle,command){assert.equal(command,606);return {result:0,data:Buffer.alloc(16)};}},
  root:1,domain:{},service:async()=>{esCalled=true;throw Error('ES should not be queried when FS606 RightsId is zero');},
  programId:'0400341027e14000',storage:2,optional:false
 });
 assert.equal(result,false);
 assert.equal(esCalled,false);
});
test('game-card program path checks FS606 before ES and installed content still checks rights',async()=>{
 const calls=[];
 const programId='0400f5802371e000',identity=Buffer.alloc(8);
 identity.writeBigUInt64LE(BigInt('0x'+programId));
 let rights=Buffer.alloc(16);
 const attachment={s:{base:0x10000,threads:new Set(),async write(){calls.push('write');},
  async ipc(label,handle,command,input){calls.push('FS606');assert.equal(command,606);assert.equal(input[0],storage);return {result:0,data:rights};}},
  root:7,domain:{async send(){calls.push('identity');return {result:0,data:identity};}},
  service:async()=>{calls.push('service');throw Error('ES requested');}};
 const source={storage:2,contentPath:'@GcS00000001://game.nca',attributes:1};
 let storage=2;
 assert.equal(await prepareInstalledLicense({...attachment,title:programId,source}),false);
 assert.deepEqual(calls,['write','identity','FS606']);
 calls.length=0;storage=4;rights=Buffer.alloc(16,1);
 await assert.rejects(prepareInstalledLicense({...attachment,title:programId,
  source:{...source,storage,contentPath:'@Ncm://game.nca'}}),/ES requested/);
 assert.deepEqual(calls,['write','identity','FS606','service']);
});
async function proofFixture(t){
 const directory=await folder(t),session='owned-session',reportFile=path.join(directory,'report.json'),engine=path.join(directory,'switch2');
 const proofFile=path.join(engine,'ro/root/proof.json'),socket=path.join(directory,'memory.sock');
 const rows={
  [reportFile]:{memoryControl:{socketPath:socket}},
  [path.join(engine,'current-acquisition.json')]:{session,report:reportFile,socketPath:socket},
  [path.join(engine,'ro/root/current-root.json')]:{session,report:reportFile,proof:proofFile,pid:1,rootHandle:9,rootAddress:2**33},
  [proofFile]:{session,report:reportFile,success:true,cloneIdentityVerified:true,rootHandle:9,rootAddress:2**33},
  [path.join(engine,'ro',session+'-layout.json')]:{session,report:reportFile,count:0x4000,table:2**34,rootVptr:2**35}
 };
 for(const [file,value]of Object.entries(rows)){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,JSON.stringify(value),{mode:0o600});}
 return {run:{directory,proof:{session,reportFile}},rows,write:async(file,value)=>fs.writeFile(file,JSON.stringify(value),{mode:0o600})};
}
test('additional promoted-root proofs reject stale sessions, mismatched sockets and symlinks',async t=>{
 const f=await proofFixture(t);await validateAttachment(f.run);
 const file=path.join(f.run.directory,'switch2/ro/root/current-root.json'),value=f.rows[file];
 await f.write(file,{...value,session:'another-boot'});await assert.rejects(validateAttachment(f.run),/verified promoted FS root/);
 await f.write(file,value);
 const acquisition=path.join(f.run.directory,'switch2/current-acquisition.json');await f.write(acquisition,{...f.rows[acquisition],socketPath:'/other/socket'});
 await assert.rejects(validateAttachment(f.run),/verified promoted FS root/);await f.write(acquisition,f.rows[acquisition]);
 const proof=value.proof,other=proof+'.other';await fs.rename(proof,other);await fs.symlink(other,proof);await assert.rejects(validateAttachment(f.run),/private owned/);
});
async function helperFixture(t,options={}){
 const directory=await folder(t),held=path.join(directory,'held');await fs.mkdir(held,{mode:0o700});
 if(options.existingAttempt)await fs.writeFile(path.join(held,'.mac2jb-hblauncher-attempt.json'),'{}',{mode:0o600});
 const input=new PassThrough(),events=[],calls=[],blockedGate=deferred();let live=true,finished=false;
 const attachment={live:{session:'held-session'},s:{base:4096,handles:new Set([7]),threads:new Set()},
  async close(){calls.push('attachment-close');this.s.base=0;this.s.handles.clear();}};
 const modules={session:{async attachGame(){calls.push('attach');if(options.attachFailure)throw Error('attachment ownership uncertain');return attachment;}},
  content:{async discoverGames(){calls.push('catalog');return [{title,name:'Fixture Game',storages:[4]}];}},
  mounts:{async prepareGame(args){calls.push('prepare:'+args.title);if(options.prepareFailure)throw Error('mount failed');return {index:buildIndex([{path:'/game',kind:'storage',entries:[{path:'/file.bin',type:'file',size:1}]}]),sources:[{handle:7}]};}},
  server:{async deployServer(args){calls.push('deploy:'+args.port);return {address:options.serverAddress||'192.0.2.88',async close(){calls.push('server-close');if(options.stopFailure)throw Object.assign(Error('thread still active'),{cleanupBlocked:true});return {nativeStopped:true,joined:true,mappingsCleared:true};}};}}};
 const promise=main([held],{root:directory,input,modules,isLive:()=>live,waitBlocked:()=>blockedGate.promise,
  verifySnapshot:async()=>({vendor:path.join(root,'vendor/OunceCake'),image:Buffer.alloc(16)}),validateRun:async()=>({directory:held,proof:{session:'held-session'}}),validateAttachment:async()=>{},
  createFtpBridge:async({sourceAddress,sourcePort})=>{calls.push('ftp-start:'+sourceAddress+':'+sourcePort);
   return {address:'127.0.0.1',port:34678,async close(){calls.push('ftp-close');}};},
  emit:(type,fields)=>{events.push({type,...fields});options.onEvent?.({type,...fields},input);}
 }).finally(()=>{finished=true;});promise.catch(()=>{});
 input.write(JSON.stringify({consoleAddress:'192.0.2.88',port:2121,
  ...(options.ftp?{mode:'ftp'}:{})})+'\n');
 t.after(async()=>{live=false;input.end();blockedGate.resolve();await promise.catch(()=>{});});
 return {input,events,calls,attachment,promise,blockedGate,get finished(){return finished;}};
}
test('one selected catalog title uses the exact configured console endpoint and stops HTTP/WebDAV before attachment',async t=>{
 const f=await helperFixture(t,{onEvent(event,input){if(event.type==='catalog')input.write(JSON.stringify({action:'select-game',titleId:title})+'\n'+JSON.stringify({action:'select-game',titleId:title})+'\n');if(event.type==='running')input.end();}});
 await f.promise;assert.equal(f.calls.filter(call=>call.startsWith('prepare:')).length,1);assert.equal(f.calls.filter(call=>call.startsWith('deploy:')).length,1);
 const running=f.events.find(event=>event.type==='running');assert.equal(running.host,'192.0.2.88');assert.equal(running.httpURL,'http://192.0.2.88:2121/');
 assert.ok(f.calls.indexOf('server-close')<f.calls.indexOf('attachment-close'));assert.equal(f.events.at(-1).type,'stopped');
 assert.equal(f.events.at(-1).cleanupVerified,true);
 assert.deepEqual(f.events.at(-1).attemptMarkers,['.mac2jb-hblauncher-attempt.json','.mac2jb-ouncecake-attempt.json']);
 assert.equal(f.events.at(-1).attemptMarkerSha256,crypto.createHash('sha256').update(
  await fs.readFile(path.join(path.dirname(path.dirname(f.events.at(-1).path)),'held','.mac2jb-hblauncher-attempt.json'))).digest('hex'));
});
test('FTP mode publishes the Mac-local address and closes the bridge before the console server',async t=>{
 const f=await helperFixture(t,{ftp:true,onEvent(event,input){
  if(event.type==='catalog')input.write(JSON.stringify({action:'select-game',titleId:title})+'\n');
  if(event.type==='running')input.end();
 }});
 await f.promise;
 const running=f.events.find(event=>event.type==='running');
 assert.equal(running.httpURL,'http://192.0.2.88:2121/');
 assert.equal(running.ftpURL,'ftp://127.0.0.1:34678/');
 assert.ok(f.calls.indexOf('ftp-start:192.0.2.88:2121')<f.calls.indexOf('ftp-close'));
 assert.ok(f.calls.indexOf('ftp-close')<f.calls.indexOf('server-close'));
 assert.equal(f.events.at(-1).cleanupVerified,true);
});
test('EOF before selection releases only the attachment and never deploys the native server',async t=>{
 const f=await helperFixture(t,{onEvent(event,input){if(event.type==='catalog')input.end();}});await f.promise;
 assert.deepEqual(f.calls,['attach','catalog','attachment-close']);
});
test('server address mismatch is rejected before endpoint publication and still cleaned up',async t=>{
 const f=await helperFixture(t,{serverAddress:'192.0.2.89',onEvent(event,input){if(event.type==='catalog')input.write(JSON.stringify({action:'select-game',titleId:title})+'\n');}});
 await assert.rejects(f.promise,/different console address/);
 assert.equal(f.events.some(event=>event.type==='running'),false);
 assert.ok(f.calls.indexOf('server-close')<f.calls.indexOf('attachment-close'));
 assert.equal(f.events.at(-1).cleanupBlocked,false);
});
test('an existing launcher or Stremio attempt prevents another native attachment',async t=>{
 const f=await helperFixture(t,{existingAttempt:true});await assert.rejects(f.promise,/EEXIST/);assert.deepEqual(f.calls,[]);
 assert.equal(f.events.find(event=>event.type==='failed').cleanupBlocked,false);
});
for(const failure of ['attachFailure','prepareFailure','stopFailure'])test(failure+' retains held resources and remains alive until the restart boundary',async t=>{
 const f=await helperFixture(t,{[failure]:true,onEvent(event,input){if(event.type==='catalog')input.write(JSON.stringify({action:'select-game',titleId:title})+'\n');if(event.type==='running')input.end();}});
 await until(()=>f.events.some(event=>event.type==='failed'));const event=f.events.find(event=>event.type==='failed');assert.equal(event.cleanupBlocked,true);
 assert.equal(f.calls.includes('attachment-close'),false);assert.equal(f.finished,false);f.input.end();await wait(10);assert.equal(f.finished,false);
 f.blockedGate.resolve();await assert.rejects(f.promise,error=>error.cleanupBlocked===true);
 assert.equal(f.calls.includes('attachment-close'),false);
});

async function mapFixture(t,{cycle=false,small=false,badAddress=false}={}){
 const directory=await folder(t),engine=path.join(directory,'switch2');await fs.mkdir(path.join(engine,'ro'),{recursive:true});await fs.mkdir(path.join(engine,'tools'));
 await fs.writeFile(path.join(engine,'ro','map-session-layout.json'),'{}');const moduleFile=path.join(engine,'tools/fs-memory.cjs');await fs.writeFile(moduleFile,'module.exports={};');
 const rootAddress=2**32,nca=2**33,resolver=2**34,manager=2**35,head=manager+0x50,node=2**36,second=node+0x100;
 const pointers=new Map([[rootAddress+0x10,nca],[nca+0x18,resolver],[resolver+0x58,manager]]),reads=[];
 const memory={async pointer(address){assert.ok(pointers.has(address));return pointers.get(address);},async read(address,size){
  reads.push(address);const data=Buffer.alloc(size);
  if(address===head){data.writeBigUInt64LE(BigInt(badAddress?3:node),8);return data;}
  assert.ok(address===node||address===second);data.writeBigUInt64LE(BigInt(cycle?node:small&&address===node?second:head),8);
  data.writeBigUInt64LE(BigInt('0x'+title),0x10);data.writeBigUInt64LE(BigInt('0x'+title),0x18);return data;
 }};
 require.cache[moduleFile]={id:moduleFile,filename:moduleFile,loaded:true,exports:{connect:async()=>memory}};t.after(()=>delete require.cache[moduleFile]);
 const attachment={run:directory,live:{session:'map-session'},proof:{rootAddress},s:{bytes:small?0x10000+64:0x80000}};
 let operations=0;const run=()=>withProgramIndexMap({attachment,title,runtimeProgramId:title,operation:async()=>{operations++;return 'valid existing mapping';}});
 return {run,reads,get operations(){return operations;}};
}
test('program-map traversal accepts valid existing ownership without modifying it',async t=>{
 const f=await mapFixture(t);assert.equal(await f.run(),'valid existing mapping');assert.equal(f.operations,1);assert.equal(f.reads.length,2);
});
for(const scenario of ['cycle','small','badAddress'])test('program-map '+scenario+' is bounded before any operation or registration',async t=>{
 const f=await mapFixture(t,{[scenario]:true});await assert.rejects(f.run(),/invalid node, cycle or traversal bound/);
 assert.equal(f.operations,0);assert.ok(f.reads.length<=2);
});
