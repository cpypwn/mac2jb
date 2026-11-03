const {test}=require('node:test'),assert=require('node:assert/strict');
const {create,sdPath}=require('../tools/dolphin-fs-rpc/writes.cjs');
function fixture(){
 const files=new Map(),dirs=new Set(['/sd']),events=[];
 const storage={list:async p=>[...dirs,...files.keys()].filter(k=>k!==p&&require('node:path').posix.dirname(k)===p).map(k=>({name:require('node:path').posix.basename(k),type:dirs.has(k)?'dir':'file'})),
  openWrite:async(p,size)=>{if(files.has(p))throw Error('exists');const f={path:p,bytes:Buffer.alloc(size)};files.set(p,f.bytes);return f;},
  write:async(f,offset,bytes)=>bytes.copy(f.bytes,offset),flush:async()=>events.push('flush'),close:async()=>events.push('close'),
  rename:async(a,b)=>{if(files.has(b)||dirs.has(b))throw Error('exists');if(files.has(a)){files.set(b,files.get(a));files.delete(a);}else{dirs.delete(a);dirs.add(b);}},
  mkdir:async p=>dirs.add(p),stat:async p=>({type:dirs.has(p)?'dir':'file'}),remove:async(p,dir)=>{events.push('remove');if(dir){for(const k of files.keys())if(k.startsWith(p+'/'))files.delete(k);for(const k of dirs)if(k===p||k.startsWith(p+'/'))dirs.delete(k);}else files.delete(p);}};
 const manager=create({getStorage:()=>storage,lease:()=> 'one'});
 const call=(method,data={})=>manager.handle('sd-'+method,{lease:'one',...data});return {manager,call,files,dirs,events};
}
test('uploads stay temporary until complete and flushed; existing destinations are preserved',async()=>{
 const f=fixture();f.files.set('/sd/existing',Buffer.from('original'));
 await assert.rejects(f.call('upload-begin',{path:'/sd/existing',size:3}),/already exists/);
 assert.equal(f.files.get('/sd/existing').toString(),'original');
 const upload=await f.call('upload-begin',{path:'/sd/new',size:3});assert.equal(f.files.has('/sd/new'),false);
 await assert.rejects(f.call('upload-finish',{token:upload.token}),/incomplete/);
 await f.call('upload-chunk',{token:upload.token,offset:0,data:Buffer.from('abc').toString('base64')});
 await assert.rejects(f.call('upload-chunk',{token:upload.token,offset:0,data:'YQ=='}),/Invalid upload chunk/);
 await f.call('upload-finish',{token:upload.token});assert.equal(f.files.get('/sd/new').toString(),'abc');assert.deepEqual(f.events,['flush','close']);
});
test('cancel removes incomplete uploads; rename cannot overwrite; deletion requires explicit confirmation',async()=>{
 const f=fixture(),upload=await f.call('upload-begin',{path:'/sd/new',size:3});await f.call('upload-cancel',{token:upload.token});assert.equal(f.files.size,0);assert.equal(f.manager.count(),0);
 await f.call('mkdir',{path:'/sd/a/b',parents:true});assert.ok(f.dirs.has('/sd/a/b'));
 f.files.set('/sd/a/b/old',Buffer.from('data'));await f.call('rename',{path:'/sd/a/b/old',to:'/sd/a/b/new'});
 await assert.rejects(f.call('rename',{path:'/sd/a',to:'/sd/a/b/child'}),/inside itself/);
 await assert.rejects(f.call('delete',{path:'/sd/a'}),/Confirm/);
 await f.call('delete',{path:'/sd/a',confirmed:true});assert.equal(f.files.size,0);assert.equal(f.dirs.size,1);
});
test('mount roots, internal storage, stale sessions and conflicting transfer mutations are rejected',async()=>{
 const f=fixture();for(const path of ['/sd','/system/file','/user/file','/sd/../system/file','relative'])assert.throws(()=>sdPath(path));
 await assert.rejects(f.call('mkdir',{path:'/sd/new',lease:'old'}),/export changed/);
 const upload=await f.call('upload-begin',{path:'/sd/new',size:0});await assert.rejects(f.call('mkdir',{path:'/sd/other'}),/active transfers/);
 await f.call('upload-finish',{token:upload.token});assert.equal(f.files.get('/sd/new').length,0);
});
test('native SD mutations use correctly aligned CMIF paths, flags and bounded verified file data',async()=>{
 const packets=[],memory=new Map();let opened=false;
 const attachment={root:1,domain:{oneHandle:r=>r.moves[0],send:async(s,label,h,packet)=>{packets.push(Buffer.from(packet));return {result:0,moves:[3],data:Buffer.alloc(16)};}},
  s:{base:0x100000,write:async(a,b)=>memory.set(a,Buffer.from(b)),close:async()=>{},ipc:async(label,h,cmd,input,options)=>{if(label==='Open SD filesystem')return {result:0,moves:[2]};if(label.startsWith('Write SD')){assert.equal(cmd,1);assert.equal(input.readBigUInt64LE(16),3n);assert.equal(options.send[0].mode,1);opened=true;}return {result:0,data:Buffer.alloc(16)};}},
  filesystem:{nativeHash:async(s,a)=>require('node:crypto').createHash('sha256').update(memory.get(a)).digest('hex'),pathMethod:async()=>({result:0,data:Buffer.alloc(4)} )}};
 const storage=await require('../tools/dolphin-fs-rpc/storage.cjs').createStorage(attachment);
 const file=await storage.openWrite('/sd/hello',3);await storage.write(file,0,Buffer.from('abc'));await storage.flush(file);await storage.close(file);
 await storage.rename('/sd/folder','/sd/renamed');
 const rename=packets.at(-1);assert.equal(rename.readUInt32LE()>>>16,2);assert.equal(rename.toString('ascii',32,36),'SFCI');assert.equal(rename.readUInt32LE(40),6);assert.ok(opened);
 await assert.rejects(storage.mkdir('/system/test'),/inside \/sd only/);
});
