'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {attachGame}=require('./game-files/session.cjs');
const {check,hashFile,writeJson}=require('./common.cjs');
const {pathRequest}=require('./game-files/protocol.cjs');
async function upload(run,plan,file,directory){
 check(fs.statSync(file).size===plan.payload.size&&await hashFile(file)===plan.payload.sha256,'Prepared pack changed');
 const a=await attachGame(run),{s,filesystem,domain}=a;let fd,handle,sd;
 async function ownPath(command,name,input=Buffer.alloc(0)){
  check([0,2,7,8].includes(command)&&(name==='/ns2jb-modloader'||name.startsWith('/ns2jb-modloader/'))&&!name.split('/').some(p=>p==='.'||p==='..')&&!/[\\\x00]/.test(name)&&Buffer.byteLength(name)<0x301,'Invalid loader SD path operation');
  const text=Buffer.alloc(0x304);text.write(name);await s.write(s.base+0x2000,text);
  return domain.send(s,'Loader SD path '+command,sd,pathRequest(command,input,s.base+0x2000));
 }
 const r={session:path.basename(run),verified:false,sdPath:plan.payload.sdPath,sha256:plan.payload.sha256,size:plan.payload.size};
 try{
  sd=domain.oneHandle(await s.ipc('Open SD for modloader pack',a.root,18));
  async function ensureDir(name){
   check(name.startsWith('/ns2jb-modloader/'),'SD directory is outside loader storage');let parent='';
   for(const component of name.split('/').filter(Boolean)){parent+='/'+component;const st=await ownPath(7,parent);if(st.canonicalResult===0x202)check(!(await ownPath(2,parent)).result,'Cannot create SD mirror directory '+parent);else check(!st.result&&st.data.readUInt32LE()===0,'SD mirror path is not a directory: '+parent);}
  }
  const dir=await ownPath(7,'/ns2jb-modloader');
  if(dir.canonicalResult===0x202)check(!(await ownPath(2,'/ns2jb-modloader')).result,'Cannot create modloader directory on SD');
  else check(!dir.result&&dir.data.readUInt32LE()===0,'SD modloader path is not a directory');
  const status=await ownPath(7,plan.payload.sdPath);
  if(status.canonicalResult===0x202){
   const create=Buffer.alloc(16);create.writeBigUInt64LE(BigInt(r.size),8);check(!(await ownPath(0,r.sdPath,create)).result,'Cannot create SD mod pack');
   const mode=Buffer.alloc(4);mode.writeUInt32LE(3);const opened=await ownPath(8,r.sdPath,mode);check(!opened.result,'Cannot open SD mod pack for writing');handle=domain.oneHandle(opened);fd=fs.openSync(file,'r');const b=Buffer.alloc(0x40000);
   for(let off=0;off<r.size;){const n=fs.readSync(fd,b,0,Math.min(b.length,r.size-off),off);check(n>0,'Short local pack read');await s.write(s.base+0x6000,b.subarray(0,n));const data=Buffer.alloc(24);data.writeBigUInt64LE(BigInt(off),8);data.writeBigUInt64LE(BigInt(n),16);check(!(await s.ipc('Write SD mod pack',handle,1,data,{send:[{address:s.base+0x6000,size:n,mode:1}]})).result,'SD pack write failed');off+=n;}
   check(!(await s.ipc('Flush SD mod pack',handle,2)).result,'SD flush failed');await s.close(handle);handle=null;fs.closeSync(fd);fd=undefined;
  }else check(!status.result&&status.data.readUInt32LE()===1,'SD payload path is not a file');
  const opened=await filesystem.openFile(s,sd,r.sdPath);check(!opened.result,'Cannot verify SD mod pack');handle=opened.handle;check(await filesystem.fileSize(s,handle)===BigInt(r.size),'Existing SD pack differs; refusing overwrite');
  const hash=crypto.createHash('sha256');for(let off=0;off<r.size;off+=0x40000){const n=Math.min(0x40000,r.size-off),bytes=await filesystem.readFile(s,handle,off,n);check(bytes.length===n,'Short SD readback');hash.update(bytes);}check(hash.digest('hex')===r.sha256,'SD pack readback hash differs');await s.close(handle);handle=null;
  r.exefs=[];
  for(const e of plan.exefs){
   check(e.sdPath===plan.namespaces.find(g=>g.titleId===e.titleId)?.prefix+'/'+e.name&&!/[\\/\x00]/.test(e.name)&&!['.','..'].includes(e.name),'Invalid ExeFS mirror destination');
   await ensureDir(path.posix.dirname(e.sdPath));const size=e.replacement.size,status=await ownPath(7,e.sdPath);
   if(status.canonicalResult===0x202){
    const create=Buffer.alloc(16);create.writeBigUInt64LE(BigInt(size),8);check(!(await ownPath(0,e.sdPath,create)).result,'Cannot create SD ExeFS file');
    const mode=Buffer.alloc(4);mode.writeUInt32LE(3);const opened=await ownPath(8,e.sdPath,mode);check(!opened.result,'Cannot open SD ExeFS for writing');handle=domain.oneHandle(opened);fd=fs.openSync(file,'r');const bytes=Buffer.alloc(0x40000);
    for(let off=0;off<size;){const n=Math.min(bytes.length,size-off);check(fs.readSync(fd,bytes,0,n,e.replacement.sourceOffset+off)===n,'Short local ExeFS pack read');await s.write(s.base+0x6000,bytes.subarray(0,n));const input=Buffer.alloc(24);input.writeBigUInt64LE(BigInt(off),8);input.writeBigUInt64LE(BigInt(n),16);check(!(await s.ipc('Write SD ExeFS mirror',handle,1,input,{send:[{address:s.base+0x6000,size:n,mode:1}]})).result,'SD ExeFS write failed');off+=n;}
    check(!(await s.ipc('Flush SD ExeFS mirror',handle,2)).result,'SD ExeFS flush failed');await s.close(handle);handle=null;fs.closeSync(fd);fd=undefined;
   }else check(!status.result&&status.data.readUInt32LE()===1,'SD ExeFS destination is not a file');
   const opened=await filesystem.openFile(s,sd,e.sdPath);check(!opened.result,'Cannot verify SD ExeFS mirror');handle=opened.handle;check(await filesystem.fileSize(s,handle)===BigInt(size),'Existing SD ExeFS size differs');const hash=crypto.createHash('sha256');
   for(let off=0;off<size;off+=0x40000){const n=Math.min(0x40000,size-off),bytes=await filesystem.readFile(s,handle,off,n);check(bytes.length===n,'Short SD ExeFS readback');hash.update(bytes);}check(hash.digest('hex')===e.replacement.sha256,'SD ExeFS readback hash differs');await s.close(handle);handle=null;r.exefs.push({titleId:e.titleId,name:e.name,verified:true});
  }
  r.verified=true;return r;
 }finally{if(fd!==undefined)fs.closeSync(fd);if(handle)await s.close(handle);await a.close();writeJson(path.join(directory,'sd-payload.json'),r);}
}
module.exports={upload};
