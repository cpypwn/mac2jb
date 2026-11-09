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
const {buildIndex}=require('../vendor/OunceCake/engine/mounts.cjs');
const root=path.resolve(__dirname,'..');
const gameIndex=()=>buildIndex([{path:'/game',kind:'storage',entries:[{path:'/file.bin',type:'file',size:1}]}]);

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

test('console HTTP/WebDAV address is taken only from qualified Switch network state',()=>{
 assert.equal(service.ipv4(network()),'192.0.2.20');
 const absent=network();absent.writeUInt32LE(0,layout.FIELD.flags);
 assert.throws(()=>service.ipv4(absent),/ready IPv4/);
 assert.throws(()=>service.ipv4(network('127.0.0.1')),/unusable IPv4/);
 const value=protocol.header(protocol.STATES.running,2,'http://192.0.2.20:2121/');
 assert.equal(value.readUInt32LE(0),protocol.MAGIC);
 assert.equal(value.readUInt32LE(4),protocol.STATES.running);
 assert.equal(value.subarray(128,128+value.readUInt32LE(16)).toString(),'http://192.0.2.20:2121/');
});

function fixture(t,{serverStopError,handleCloseError,detachError,prepareGame,
 realRaster=false,allowReattach=false,zipFailure}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-ouncecake-service-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const events={attach:0,detach:0,deployed:0,stopped:0,mounted:0,closed:[],order:[],fatal:[],writes:[],zipPorts:[]};
 const mapped=0x500000000,menu={controls:{mapped:0x600000000}};
 const rpc={a:{session:'mintbrew-test'},async write(address,bytes){events.writes.push({address,bytes:Buffer.from(bytes)});},
  async read(){return network();}};
 const modules={
  session:{async attachGame(){events.attach++;if(!allowReattach)assert.equal(events.attach,1);
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
   return {index:gameIndex(),sources:[{handle,kind:0,size:1}]};}},
  server:{async deployServer({attachment,zipPort}){events.deployed++;events.zipPorts.push(zipPort);events.order.push('http-started');attachment.s.handles.add(200+events.deployed);
   attachment.s.threads.add('server');
   return {async close(){events.stopped++;
   if(serverStopError)throw serverStopError;
   attachment.s.threads.delete('server');events.order.push('server-stopped');
   return {nativeStopped:true,joined:true,mappingsCleared:true};},address:'192.0.2.20'};}}
 };
 const options={rpc,menu,gpu:{fingerprint:'abc',privateStorage:{mapped,bytes:protocol.STORAGE_BYTES}},
  app:{id:'ouncecake',fingerprint:'abc',manifest:{service:'ouncecake-v1'}},directory,root,
  runDirectory:'/run/switch-test',sourceSession:'switch-test',modules,
  liveCheck:async()=>true,
  verifyHeld:async()=>({run:{directory:'/run/switch-test',proof:{session:'switch-test'},
   connection:{addresses:{session:'switch-test'}}},snapshot:{image:Buffer.from('native'),nativeImageSha256:'abc'}}),
  ...(!realRaster?{rasterGames:async games=>Buffer.alloc(games.length*protocol.TILE_BYTES,0xf0)}:{}),
  ...(zipFailure?{createZipServer:async()=>{throw Error(zipFailure);}}:{}),
  createFtpBridge:async()=>{events.order.push('ftp-started');return {address:'127.0.0.1',port:2122,
   async close(){events.order.push('ftp-stopped');}};},
  onGameList:async()=>{events.order.push('title-ftp-resumed');},
  onFatal:error=>events.fatal.push(error)};
 return {instance:service.create(options),createAgain:()=>service.create(options),events,directory};
}

test('OunceCake can close and reopen in one MintBrew session with a fresh raster',async t=>{
 const {instance,createAgain,events,directory}=fixture(t,{realRaster:true,allowReattach:true});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 assert.match(instance.report.imageSha256,/^[a-f0-9]{64}$/);
 await instance.close();
 assert.equal(fs.readdirSync(directory).some(name=>name.startsWith('ouncecake-catalog-')),false);
 const reopened=createAgain();
 await reopened.start();await waitFor(()=>reopened.report.status,'catalog');
 assert.match(reopened.report.imageSha256,/^[a-f0-9]{64}$/);
 await reopened.close();
 assert.equal(fs.readdirSync(directory).some(name=>name.startsWith('ouncecake-catalog-')),false);
 assert.equal(events.attach,2);
 assert.equal(events.detach,2);
 assert.deepEqual(events.fatal,[]);
});

test('A selects one game; short B closes HTTP/WebDAV and allows another selection',async t=>{
 const {instance,events}=fixture(t);
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 assert.equal(events.attach,1);assert.equal(events.detach,0);
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 assert.equal(instance.report.httpURL,'http://192.0.2.20:2121/');
 assert.equal(instance.report.ftpURL,'ftp://127.0.0.1:2122/');
 const running=events.writes.map(row=>row.bytes).findLast(bytes=>bytes.length===protocol.HEADER_BYTES&&
  bytes.readUInt32LE(0)===protocol.MAGIC&&bytes.readUInt32LE(4)===protocol.STATES.running);
 assert.equal(running.subarray(128,128+running.readUInt32LE(16)).toString(),'WebDAV http://192.0.2.20:2121/');
 assert.equal(running.subarray(256,256+running.readUInt32LE(20)).toString(),
  'FTP on this Mac ftp://127.0.0.1:2122/');
 await instance.back();await waitFor(()=>instance.report.status,'catalog');
 assert.ok(events.order.indexOf('ftp-stopped')<events.order.indexOf('server-stopped'));
 assert.equal(events.stopped,1);assert.equal(events.detach,0);
 assert.deepEqual(events.closed.sort((a,b)=>a-b),[101,201]);
 assert.ok(events.order.indexOf('server-stopped')<events.order.indexOf('handle:201'));
 assert.ok(events.order.indexOf('server-stopped')<events.order.indexOf('handle:101'));
 assert.ok(events.order.indexOf('handle:101')<events.order.indexOf('title-ftp-resumed'));
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 await instance.close();
 assert.equal(events.attach,1);assert.equal(events.stopped,2);assert.equal(events.detach,1);
 assert.equal(instance.report.status,'stopped');
 assert.equal(events.fatal.length,0);
});

test('ZIP catalog limit does not prevent read-only WebDAV from starting',async t=>{
 const {instance,events}=fixture(t,{zipFailure:'Game has too many downloadable files'});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await waitFor(()=>instance.report.status,'running');
 assert.equal(instance.report.zipUnavailable,'Game has too many downloadable files');
 assert.deepEqual(events.zipPorts,[0]);
 assert.equal(instance.report.httpURL,'http://192.0.2.20:2121/');
 assert.equal(events.fatal.length,0);
 await instance.close();
});

test('uncertain HTTP/WebDAV shutdown keeps the held session blocked',async t=>{
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

for(const contentError of ['Invalid RomFS: header size','No installed account ELicense for 0400f5802371e000',
 'Game card content requires rights unavailable in this held RPC session'])
test('bad game content '+contentError+' releases selected handles and returns to the catalog',async t=>{
 let attempts=0;
 const {instance,events}=fixture(t,{prepareGame:async({attachment})=>{
  const handle=100+(++attempts);attachment.s.handles.add(handle);
  if(attempts===1)throw Object.assign(Error(contentError),contentError.startsWith('Game card')?
   {code:'GAME_CARD_RIGHTS_UNAVAILABLE'}:{});
  return {index:gameIndex(),sources:[{handle,kind:0,size:1}]};
 }});
 await instance.start();await waitFor(()=>instance.report.status,'catalog');
 await instance.select(0);await waitFor(()=>instance.report.error,contentError);
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
