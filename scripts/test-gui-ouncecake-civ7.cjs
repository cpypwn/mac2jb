'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PassThrough}=require('node:stream');
const {main,verifySnapshot,validateConfiguration,catalogEntries}=require('./gui-ouncecake-civ7.cjs');

const title='0100123456789000';
async function until(check){
 for(let attempt=0;attempt<200;attempt++){
  if(check())return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw Error('Civ7 FTP fixture timed out');
}

test('Civ7 configuration accepts only direct FTP and bounds game metadata',()=>{
 assert.deepEqual(validateConfiguration({consoleAddress:'192.0.2.9',port:2121,mode:'ftp'}),
  {consoleAddress:'192.0.2.9',port:2121,mode:'ftp'});
 assert.throws(()=>validateConfiguration({consoleAddress:'192.0.2.9',port:2121,mode:'webdav'}));
 assert.throws(()=>validateConfiguration({consoleAddress:'not-an-ip',port:2121,mode:'ftp'}));
 assert.deepEqual(catalogEntries([{title,name:'Game',storages:[4,4],secret:'token'}]),
  [{titleId:title,name:'Game',storages:[4]}]);
});

test('Civ7 adapter rejects a changed pinned source file before native work',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mac2jb-civ7-pin-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'..');
 await fs.mkdir(path.join(root,'vendor'),{recursive:true});
 await fs.mkdir(path.join(root,'packaging'),{recursive:true});
 await fs.cp(path.join(source,'vendor/OunceCake-Civ7'),path.join(root,'vendor/OunceCake-Civ7'),{recursive:true});
 for(const name of ['OunceCake-Civ7-SHA256SUMS','OunceCake-Civ7-provenance.json'])
  await fs.copyFile(path.join(source,'packaging',name),path.join(root,'packaging',name));
 await fs.appendFile(path.join(root,'vendor/OunceCake-Civ7/engine/civ7-ftp.cjs'),'\nchanged');
 await assert.rejects(verifySnapshot(root),/Changed bundled OunceCake file/);
});

test('Civ7 FTP keeps the direct endpoint and proves cleanup before releasing RPC',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mac2jb-civ7-ftp-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const held=path.join(root,'held');await fs.mkdir(held,{mode:0o700});
 const input=new PassThrough(),events=[],calls=[];
 let finished=false;
 const attachment={live:{session:'held-session'},s:{base:4096,handles:new Set([7]),threads:new Set()},
  async close(){calls.push('attachment-close');this.s.base=0;this.s.handles.clear();}};
 const modules={
  session:{async attachGame(directory,options){assert.equal(directory,held);assert.deepEqual(options,{bulkDownloads:false});calls.push('attach');return attachment;}},
  content:{async discoverGames(){calls.push('discover');return [{title,name:'Game',storages:[4]}];}},
  mounts:{async prepareGame(options){assert.equal(options.title,title);assert.equal(options.tar,false);assert.equal(options.defer,true);
   calls.push('prepare');return {index:Buffer.alloc(16),sources:[]};}},
  'civ7-ftp':{async deployCiv7Ftp(options){assert.equal(options.port,2121);calls.push('deploy');return {
   done:new Promise(()=>{}),get finished(){return finished;},async close(){finished=true;calls.push('server-close');}};}}
 };
 const work=main([held],{root,input,modules,isLive:()=>true,emit:(type,fields)=>events.push({type,...fields}),
  verifySnapshot:async()=>({vendor:path.join(root,'vendor'),image:Buffer.alloc(16),nativeImageSha256:'fixture'}),
  validateRun:async()=>({directory:held,proof:{session:'held-session'},connection:{addresses:{target:'civ7'}}}),
  validateAttachment:async()=>{calls.push('verify-root');}});
 input.write(JSON.stringify({consoleAddress:'192.0.2.9',port:2121,mode:'ftp'})+'\n');
 await until(()=>events.some(event=>event.type==='catalog'));
 input.write(JSON.stringify({action:'select-game',titleId:title})+'\n');
 await until(()=>events.some(event=>event.type==='running'));
 const running=events.find(event=>event.type==='running');
 assert.equal(running.ftpURL,'ftp://192.0.2.9:2121/');
 assert.equal(running.mode,'civ7-ftp');
 assert.equal(running.httpURL,undefined);
 input.end();await work;
 assert.deepEqual(calls,['verify-root','attach','discover','prepare','deploy','server-close','attachment-close']);
 assert.equal(events.at(-1).type,'stopped');
 assert.equal(events.at(-1).cleanupVerified,true);
 const report=JSON.parse(await fs.readFile(path.join(events.at(-1).path,'ouncecake-session.json'),'utf8'));
 assert.equal(report.ftpURL,'ftp://192.0.2.9:2121/');
 assert.equal(report.httpURL,undefined);
});

test('non-Civ7 verified run cannot start the Civ7 native image',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mac2jb-civ7-target-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const input=new PassThrough(),events=[];
 const work=main([path.join(root,'held')],{root,input,emit:(type,fields)=>events.push({type,...fields}),
  verifySnapshot:async()=>({vendor:path.join(root,'vendor'),image:Buffer.alloc(16)}),
  validateRun:async()=>({directory:path.join(root,'held'),connection:{addresses:{target:'switch2'}}}),
  validateAttachment:async()=>{throw Error('Civ7 attachment must not be called');}});
 input.write(JSON.stringify({consoleAddress:'192.0.2.9',port:2121,mode:'ftp'})+'\n');
 await assert.rejects(work,/verified Civilization VII filesystem session/);
 assert.equal(events.at(-1).type,'failed');
 input.end();
});
