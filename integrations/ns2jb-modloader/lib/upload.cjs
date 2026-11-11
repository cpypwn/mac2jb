'use strict';
const fs=require('node:fs'),path=require('node:path');
const {attachGame}=require('./game-files/session.cjs'),{pathRequest}=require('./game-files/protocol.cjs');
const {check,hashFile,writeJson}=require('./common.cjs'),{sdPath}=require('./sources.cjs');
async function upload(run,plan,file,directory){
 check(fs.statSync(file).size===plan.payload.size&&await hashFile(file)===plan.payload.sha256,'Resident metadata changed');
 const a=await attachGame(run),{s,filesystem,domain}=a;let sd,handle;
 const report={session:path.basename(run),verified:false,metadataInRam:true,sdBytesWritten:0,sources:[]};
 async function operation(command,name,input=Buffer.alloc(0)){
  check(name==='/ns2jb-modloader'||sdPath(name),'Invalid SD path');const text=Buffer.alloc(0x304);text.write(name);await s.write(s.base+0x2000,text);return domain.send(s,'Mod source path '+command,sd,pathRequest(command,input,s.base+0x2000));
 }
 async function ensureDirectory(name){
  let parent='';for(const part of name.split('/').filter(Boolean)){parent+='/'+part;const r=await operation(7,parent);if(r.canonicalResult===0x202)check(!(await operation(2,parent)).result,'Cannot create local mod directory');else check(!r.result&&r.data.readUInt32LE()===0,'Mod source parent is not a directory');}
 }
 try{
  sd=domain.oneHandle(await s.ipc('Open SD mod sources',a.root,18));
  const local=plan.sources.filter(e=>e.localFile);let required=0;
  for(const row of local){const r=await operation(7,row.sdPath);if(r.canonicalResult===0x202)required+=row.size;else check(!r.result&&r.data.readUInt32LE()===1,'Local mod source is not a file');}
  if(required){const free=await operation(11,'/ns2jb-modloader');check(!free.result&&free.data.readBigUInt64LE()>=BigInt(required),'Not enough SD space for the local mod files ('+required+' bytes required)');}
  for(const row of plan.sources){
   sdPath(row.sdPath);
   if(!row.localFile){report.sources.push({sdPath:row.sdPath,size:row.size,fromSdInventory:true});continue;}
   if(row.localFile){
    check(/^\/ns2jb-modloader\/\.cache\/files\/[0-9a-f]{64}$/.test(row.sdPath)&&await hashFile(row.localFile)===row.sha256,'Local mod source changed');const status=await operation(7,row.sdPath);
    if(status.canonicalResult===0x202){
     await ensureDirectory(path.posix.dirname(row.sdPath));const create=Buffer.alloc(16);create.writeBigUInt64LE(BigInt(row.size),8);check(!(await operation(0,row.sdPath,create)).result,'Cannot create local mod source');
     const mode=Buffer.alloc(4);mode.writeUInt32LE(3);const opened=await operation(8,row.sdPath,mode);check(!opened.result,'Cannot open local mod source');handle=domain.oneHandle(opened);
     const fd=fs.openSync(row.localFile,'r'),bytes=Buffer.alloc(0x40000);
     try{for(let at=0;at<row.size;){const n=fs.readSync(fd,bytes,0,Math.min(bytes.length,row.size-at),at);check(n>0,'Short local mod file');await s.write(s.base+0x6000,bytes.subarray(0,n));const input=Buffer.alloc(24);input.writeBigUInt64LE(BigInt(at),8);input.writeBigUInt64LE(BigInt(n),16);check(!(await s.ipc('Write local mod source',handle,1,input,{send:[{address:s.base+0x6000,size:n,mode:1}]})).result,'Local mod source write failed');at+=n;report.sdBytesWritten+=n;}}
     finally{fs.closeSync(fd);}
     check(!(await s.ipc('Flush local mod source',handle,2)).result,'Local mod source flush failed');await s.close(handle);handle=null;
    }
   }
   const opened=await filesystem.openFile(s,sd,row.sdPath);check(!opened.result,'Cannot open mod source '+row.sdPath);handle=opened.handle;
   check(await filesystem.fileSize(s,handle)===BigInt(row.size),'Mod source size changed: '+row.sdPath);await s.close(handle);handle=null;report.sources.push({sdPath:row.sdPath,size:row.size,readable:true});
  }
  report.verified=true;return report;
 }finally{if(handle)await s.close(handle);await a.close();writeJson(path.join(directory,'sd-payload.json'),report);}
}
module.exports={upload};
