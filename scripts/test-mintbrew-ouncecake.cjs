const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const catalog=require('../vendor/MintBrew/homebrew-launcher/app-catalog.cjs');
const layout=require('../vendor/MintBrew/sdk/host/layout.cjs');
const prepare=require('../integrations/mintbrew-ouncecake/prepare.cjs');
const protocol=require('../integrations/mintbrew-ouncecake/protocol.cjs');
const service=require('../integrations/mintbrew-ouncecake/service.cjs');
const root=path.resolve(__dirname,'..');

function network(address='192.0.2.20'){
 const bytes=Buffer.alloc(layout.FIELD.network+24);
 bytes.writeUInt32LE(layout.MAGIC,layout.FIELD.magic);
 bytes.writeUInt32LE(layout.VERSION,layout.FIELD.version);
 bytes.writeUInt32LE(layout.FLAGS.network,layout.FIELD.flags);
 address.split('.').forEach((part,index)=>bytes[layout.FIELD.network+20+index]=Number(part));
 return bytes;
}

async function waitFor(read,expected){
 const until=Date.now()+2000;
 while(Date.now()<until){if(read()===expected)return;await new Promise(resolve=>setTimeout(resolve,2));}
 assert.equal(read(),expected);
}

test('OunceCake app bundle and title raster stay within its private GPU buffer',async t=>{
 prepare.verifySource(root);
 const folder=path.join(root,'integrations/mintbrew-ouncecake/app');
 const app=await catalog.readApp(folder);
 assert.equal(app.manifest.service,'ouncecake-v1');
 assert.equal(app.files.memory.allocationBytes,protocol.STORAGE_BYTES);
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-ouncecake-app-'));
 t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 assert.ok(prepare.prepareMintBrew(root,runtime).files>8);
 assert.ok(prepare.verifyMintBrew(root,runtime).files>8);
 const input=path.join(runtime,'games.json'),output=path.join(runtime,'games.bin');
 fs.writeFileSync(input,JSON.stringify([{name:'A game'},{name:'A second game'}]));
 execFileSync('python3',[path.join(root,'integrations/mintbrew-ouncecake/raster.py'),input,output]);
 const image=fs.readFileSync(output);
 assert.equal(image.length,2*protocol.TILE_BYTES);
 assert.ok(image.some(byte=>byte!==0));
 assert.ok(protocol.HEADER_BYTES+protocol.MAX_GAMES*protocol.TILE_BYTES<protocol.STORAGE_BYTES);
});

test('console FTP address is taken only from qualified Switch network state',()=>{
 assert.equal(service.ipv4(network()),'192.0.2.20');
 const absent=network();absent.writeUInt32LE(0,layout.FIELD.flags);
 assert.throws(()=>service.ipv4(absent),/ready IPv4/);
 assert.throws(()=>service.ipv4(network('127.0.0.1')),/unusable IPv4/);
 const value=protocol.header(protocol.STATES.running,2,'ftp://192.0.2.20:2121');
 assert.equal(value.readUInt32LE(0),protocol.MAGIC);
 assert.equal(value.readUInt32LE(4),protocol.STATES.running);
 assert.equal(value.subarray(128,128+value.readUInt32LE(16)).toString(),'ftp://192.0.2.20:2121');
});

function fixture(t,{serverStopError,handleCloseError,detachError,prepareGame}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-ouncecake-service-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const events={attach:0,detach:0,deployed:0,stopped:0,mounted:0,closed:[],order:[],fatal:[],writes:[]};
 const mapped=0x500000000,menu={controls:{mapped:0x600000000}};
 const rpc={a:{session:'mintbrew-test'},async write(address,bytes){events.writes.push({address,bytes:Buffer.from(bytes)});},
  async read(){return network();}};
 const modules={
  session:{async attachGame(){events.attach++;assert.equal(events.attach,1);
   const s={base:123,handles:new Set([1]),threads:new Set(),async close(handle){
    assert.ok(s.handles.has(handle));if(handleCloseError)throw handleCloseError;
    events.closed.push(handle);events.order.push('handle:'+handle);s.handles.delete(handle);
   }};
   return {live:{session:'switch-test'},s,async close(){
    if(detachError)throw detachError;
    for(const handle of [...s.handles].reverse())await s.close(handle);
    events.detach++;events.order.push('attachment-closed');s.base=0;
   }};}},
  content:{async discoverGames(){return [{title:'0100000000000001',name:'Test game',storages:[4]}];}},
  mounts:{async prepareGame(options){if(prepareGame)return prepareGame(options);
   const handle=100+(++events.mounted);options.attachment.s.handles.add(handle);
   return {index:Buffer.from('index'),sources:[{handle,kind:0,size:1}]};}},
  ftp:{async deployFtp({attachment}){events.deployed++;attachment.s.handles.add(200+events.deployed);
   attachment.s.threads.add('ftp');
   return {async close(){events.stopped++;
   if(serverStopError)throw serverStopError;
   attachment.s.threads.delete('ftp');events.order.push('ftp-stopped');
   return {nativeStopped:true,joined:true,mappingsCleared:true};}};}}
 };
 const instance=service.create({rpc,menu,gpu:{fingerprint:'abc',privateStorage:{mapped,bytes:protocol.STORAGE_BYTES}},
  app:{id:'ouncecake',fingerprint:'abc',manifest:{service:'ouncecake-v1'}},directory,root,
  runDirectory:'/run/switch-test',sourceSession:'switch-test',modules,
  liveCheck:async()=>true,
  verifyHeld:async()=>({run:{directory:'/run/switch-test',proof:{session:'switch-test'},
   connection:{addresses:{session:'switch-test'}}},snapshot:{image:Buffer.from('native'),nativeImageSha256:'abc'}}),
  rasterGames:async games=>Buffer.alloc(games.length*protocol.TILE_BYTES,0xf0),
  onGameList:async()=>{events.order.push('title-ftp-resumed');},
  onFatal:error=>events.fatal.push(error)});
 return {instance,events};
}

test('A selects one game; short B closes FTP and allows another selection',async t=>{
 const {instance,events}=fixture(t);
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 assert.equal(events.attach,1);assert.equal(events.detach,0);
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 assert.equal(instance.report.ftpURL,'ftp://192.0.2.20:2121');
 const running=events.writes.map(row=>row.bytes).findLast(bytes=>bytes.length===protocol.HEADER_BYTES&&
  bytes.readUInt32LE(0)===protocol.MAGIC&&bytes.readUInt32LE(4)===protocol.STATES.running);
 assert.equal(running.subarray(128,128+running.readUInt32LE(16)).toString(),'FTP://192.0.2.20:2121');
 await instance.back();await waitFor(()=>instance.report.status,'catalog');
 assert.equal(events.stopped,1);assert.equal(events.detach,0);
 assert.deepEqual(events.closed.sort((a,b)=>a-b),[101,201]);
 assert.ok(events.order.indexOf('ftp-stopped')<events.order.indexOf('handle:201'));
 assert.ok(events.order.indexOf('ftp-stopped')<events.order.indexOf('handle:101'));
 assert.ok(events.order.indexOf('handle:101')<events.order.indexOf('title-ftp-resumed'));
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 await instance.close();
 assert.equal(events.attach,1);assert.equal(events.stopped,2);assert.equal(events.detach,1);
 assert.equal(instance.report.status,'stopped');
 assert.equal(events.fatal.length,0);
});

test('uncertain FTP shutdown keeps the held session blocked',async t=>{
 const failure=Object.assign(Error('join did not complete'),{cleanupBlocked:true});
 const {instance,events}=fixture(t,{serverStopError:failure});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 await instance.back();await waitFor(()=>instance.report.cleanupBlocked,true);
 await assert.rejects(instance.close(),/join did not complete/);
 assert.equal(events.detach,0);
 assert.deepEqual(events.closed,[]);
 assert.equal(events.fatal.length,1);
});

test('selected-game handle cleanup must be proven before another selection',async t=>{
 const {instance,events}=fixture(t,{handleCloseError:Error('handle remained open')});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 await instance.back();await waitFor(()=>instance.report.cleanupBlocked,true);
 assert.equal(events.stopped,1);
 assert.equal(events.detach,0);
 await assert.rejects(instance.close(),/handle remained open/);
 assert.equal(events.fatal.length,1);
});

test('cancelled game preparation closes the retained attachment without blocking',async t=>{
 let started;
 const prepared=new Promise(resolve=>{started=resolve;});
 const {instance,events}=fixture(t,{prepareGame:async({attachment,shouldStop})=>{
  attachment.s.handles.add(101);started();
  await waitFor(shouldStop,true);
  throw Object.assign(Error('FTP preparation cancelled'),{code:'FTP_CANCELLED'});
 }});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await prepared;
 await instance.close();
 assert.equal(instance.report.status,'stopped');
 assert.equal(instance.report.cleanupBlocked,undefined);
 assert.equal(events.attach,1);
 assert.equal(events.detach,1);
 assert.deepEqual(events.closed,[101,1]);
 assert.equal(events.fatal.length,0);
});

test('cancelled preparation still blocks when attachment cleanup cannot be proven',async t=>{
 let started;
 const prepared=new Promise(resolve=>{started=resolve;});
 const {instance,events}=fixture(t,{detachError:Error('native free was deferred'),
  prepareGame:async({attachment,shouldStop})=>{
   attachment.s.handles.add(101);started();
   await waitFor(shouldStop,true);
   throw Object.assign(Error('FTP preparation cancelled'),{code:'FTP_CANCELLED'});
  }});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await prepared;
 await assert.rejects(instance.close(),/native free was deferred/);
 assert.equal(instance.report.cleanupBlocked,true);
 assert.equal(events.detach,0);
 assert.deepEqual(events.closed,[]);
});

test('bad game content releases selected handles and returns to the catalog',async t=>{
 let attempts=0;
 const {instance,events}=fixture(t,{prepareGame:async({attachment})=>{
  const handle=100+(++attempts);attachment.s.handles.add(handle);
  if(attempts===1)throw Error('Invalid RomFS: header size');
  return {index:Buffer.from('index'),sources:[{handle,kind:0,size:1}]};
 }});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await waitFor(()=>instance.report.error,'Invalid RomFS: header size');
 assert.equal(instance.report.status,'catalog');
 assert.equal(events.detach,0);
 assert.deepEqual(events.closed,[101]);
 await waitFor(()=>events.order.includes('title-ftp-resumed'),true);
 assert.equal(events.fatal.length,0);
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 assert.equal(instance.report.error,undefined);
 await instance.close();
 assert.equal(events.attach,1);
 assert.equal(events.detach,1);
});

test('uncertain preparation error retains the native attachment',async t=>{
 const {instance,events}=fixture(t,{prepareGame:async({attachment})=>{
  attachment.s.handles.add(101);
  throw Error('Memory request timed out');
 }});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await waitFor(()=>instance.report.cleanupBlocked,true);
 await assert.rejects(instance.close(),/Memory request timed out/);
 assert.equal(events.detach,0);
 assert.deepEqual(events.closed,[]);
 assert.equal(events.fatal.length,1);
});
