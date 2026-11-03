// Console sockets and title-owned files. No host filesystem is exposed over FTP.
const definitions=require('../abi/ftp-functions.json');
const MOUNTS=['save','tmp','rom'],CHUNK=32768;
function virtualPath(cwd,input){
 if(typeof input!=='string'||/[\x00-\x1f\x7f\\:]/.test(input))throw Error('Invalid path');
 const parts=(input.startsWith('/')?input:cwd+'/'+input).split('/'),out=[];
 for(const part of parts){if(!part||part==='.')continue;if(part==='..'){if(out.length)out.pop();}else out.push(part);}
 const value='/'+out.join('/');if(Buffer.byteLength(value)>740)throw Error('Path too long');return value;
}
function nativePath(value,write=false){
 value=virtualPath('/',value);const [mount,...parts]=value.slice(1).split('/');
 if(!MOUNTS.includes(mount))throw Error('Choose /save, /tmp or /rom');
 if(write&&(mount==='rom'||!parts.length))throw Error('Read-only path');
 return {mount,path:mount+':/'+parts.join('/')};
}
async function create(rpc,directory){
 const api=await require('../native/client.cjs').create(rpc,definitions,0x20000);
 const worker=await require('../native/six.cjs').create(rpc,directory);
 const signed=r=>Number(BigInt.asIntN(32,r)),integer=r=>Number(BigInt.asIntN(64,r));
 async function ok(name,args){const rc=await api.result(name,args);if(rc)throw Error(name+' failed (0x'+rc.toString(16)+')');}
 async function filename(value,write=false,offset=0){const target=nativePath(value,write);await api.write(offset,Buffer.from(target.path+'\0'));return target;}
 async function socketResult(name,args){const n=signed(await api.call(name,args));if(n<0)throw Error(name+' failed (errno '+await api.result('errno')+')');return n;}
 const transport={async address(){await ok('netAddress',[api.base+3072]);return [...await api.read(3072,4)].join('.');},async listen(port){
  const fd=await socketResult('socket',[2,1,6]);try{const sa=Buffer.alloc(16);sa[0]=16;sa[1]=2;sa.writeUInt16BE(port,2);await api.write(2048,sa);await socketResult('bind',[fd,api.base+2048,16]);await socketResult('listen',[fd,4]);await api.write(2080,Buffer.from([16,0,0,0]));await socketResult('getsockname',[fd,api.base+2048,api.base+2080]);return {fd,port:(await api.read(2048,16)).readUInt16BE(2)};}catch(e){await transport.close(fd);throw e;}
 },async accept(fd){const p=Buffer.alloc(8);p.writeInt32LE(fd);p.writeInt16LE(1,4);await api.write(2048,p);const n=await socketResult('poll',[api.base+2048,1,0]);if(!n)return null;const revents=(await api.read(2048,8)).readInt16LE(6);if(!(revents&1))throw Error('Listener closed');await api.write(2080,Buffer.from([16,0,0,0]));const client=await socketResult('accept',[fd,api.base+2112,api.base+2080]);const sa=await api.read(2112,16);return {fd:client,peer:[...sa.subarray(4,8)].join('.')};
 },async recv(fd,limit=CHUNK){const n=signed(await api.call('recv',[fd,api.base+0x10000,Math.min(limit,CHUNK),0x80]));if(n>=0)return api.read(0x10000,n);const e=await api.result('errno');if(e===35||e===11)return null;throw Error('Receive errno '+e);
 },async send(fd,bytes){const chunk=bytes.subarray(0,CHUNK);await api.write(0x10000,chunk);const n=signed(await api.call('send',[fd,api.base+0x10000,chunk.length,0x80]));if(n>=0)return n;const e=await api.result('errno');if(e===35||e===11)return 0;throw Error('Send errno '+e);
 },async close(fd){await api.call('socketClose',[fd]);}};
 const storage={async stat(value){if(value==='/')return {type:'dir',size:0};await filename(value);await ok('entryType',[api.base+3072,api.base]);const type=(await api.read(3072,4)).readUInt32LE();if(type===0)return {type:'dir',size:0};const f=await storage.openRead(value);try{return {type:'file',size:f.size};}finally{await storage.close(f);}},async list(value){
  if(value==='/')return MOUNTS.map(name=>({name,type:'dir',size:0}));await filename(value);await ok('openDirectory',[api.base+3072,api.base,3]);const handle=(await api.read(3072,8)).readBigUInt64LE(),entries=[];
  try{while(entries.length<4096){await ok('readDirectory',[api.base+3088,api.base+4096,handle,16]);const count=integer((await api.read(3088,8)).readBigUInt64LE());if(count<0||count>16)throw Error('Invalid directory response');if(!count)return entries;const bytes=await api.read(4096,count*0x310);for(let i=0;i<count;i++){const b=bytes.subarray(i*0x310,(i+1)*0x310),name=b.subarray(0,0x301).toString('utf8').split('\0')[0];if(!name||/[\x00-\x1f\x7f/\\]/.test(name))throw Error('Unsupported directory entry name');entries.push({name,type:b[0x304]===0?'dir':'file',size:integer(b.readBigUInt64LE(0x308))});}}throw Error('Directory exceeds 4096 entries');}finally{await api.call('closeDirectory',[handle]);}
 },async openRead(value){await filename(value);await ok('openFile',[api.base+3072,api.base,1]);const handle=(await api.read(3072,8)).readBigUInt64LE();try{await ok('fileSize',[api.base+3088,handle]);const size=integer((await api.read(3088,8)).readBigUInt64LE());if(!Number.isSafeInteger(size)||size<0)throw Error('File too large');return {handle,size,write:false};}catch(e){await api.call('closeFile',[handle]);throw e;}},async openWrite(value,append=false){
  const target=nativePath(value,true);let exists=true;try{const s=await storage.stat(value);if(s.type!=='file')throw Error('Target is a directory');}catch(e){if(!/entryType failed/.test(e.message))throw e;exists=false;}
  await filename(value,true);if(!exists)await ok('createFile',[api.base,0]);await ok('openFile',[api.base+3072,api.base,2]);const handle=(await api.read(3072,8)).readBigUInt64LE();try{await ok('fileSize',[api.base+3088,handle]);let size=integer((await api.read(3088,8)).readBigUInt64LE());if(!append){await ok('setFileSize',[handle,0]);size=0;}return {handle,size,write:true,mount:target.mount};}catch(e){await api.call('closeFile',[handle]);throw e;}
 },async read(file,offset,size){size=Math.min(size,CHUNK,file.size-offset);if(size<=0)return Buffer.alloc(0);await ok('readFile',[file.handle,offset,api.base+0x10000,size]);return api.read(0x10000,size);},async write(file,offset,bytes){if(!file.write||bytes.length>CHUNK)throw Error('Invalid write');const end=offset+bytes.length;if(!Number.isSafeInteger(end))throw Error('File too large');if(end>file.size){await ok('setFileSize',[file.handle,end]);file.size=end;}await api.write(0x10000,bytes);await api.write(3104,Buffer.alloc(4));const r=await worker.call(api.functions.writeFile,[file.handle,offset,api.base+0x10000,bytes.length,api.base+3104]);if(Number(BigInt.asUintN(32,r)))throw Error('Write failed (0x'+r.toString(16)+')');},async close(file){try{if(file.write)await ok('flushFile',[file.handle]);}finally{await api.call('closeFile',[file.handle]);}if(file.write)await storage.commit(file.mount);},async commit(mount){await api.write(0,Buffer.from(mount+'\0'));await ok('commit',[api.base]);},async remove(value,directory=false){const t=await filename(value,true);await ok(directory?'deleteDirectory':'deleteFile',[api.base]);await storage.commit(t.mount);},async mkdir(value){const t=await filename(value,true);await ok('createDirectory',[api.base]);await storage.commit(t.mount);},async rename(from,to){const a=nativePath(from,true),b=nativePath(to,true);if(a.mount!==b.mount)throw Error('Cross-mount rename unsupported');const stat=await storage.stat(from);await filename(from,true);await filename(to,true,1024);await ok(stat.type==='dir'?'renameDirectory':'renameFile',[api.base,api.base+1024]);await storage.commit(a.mount);}};
 return {transport,storage};
}
module.exports={create,virtualPath,nativePath,CHUNK};
