'use strict';
const {isUncertain}=require('../game-files/uncertain.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const {attachGame}=require('../game-files/mount-api.cjs');
// Retain one SD filesystem; mod bodies stay at their existing paths.
const check=(x,s)=>{if(!x)throw Error(s);};
async function openSource(run,bridge,log) {
 const a=await attachGame(run),{s,domain,filesystem}=a;
 let sd,file,traceFile;
 try {
  sd=domain.oneHandle(await s.ipc('Open own SD source',a.root,18));
  const layout=JSON.parse(await fs.readFile(path.join(run,'switch2/ro',bridge.session+'-layout.json')));
  async function locate(handle,kind,offset,add,release,read) {
   const clone=domain.oneHandle(await domain.send(s,'Locate pinned '+kind,handle,domain.wire.control(2)));
   let object,vptr,raw,table,uncertain=false;
   try {
    const converted=await domain.send(s,'Convert own '+kind,clone,domain.wire.control(0));
    check(!converted.result,'Cannot locate '+kind);const id=converted.data.readUInt32LE();check(id>0&&id<=layout.count,'Invalid owned domain id');
    const entry=await bridge.m.read(layout.table+(id-1)*0x30,0x30);object=Number(entry.readBigUInt64LE(32));
    raw=await bridge.m.read(object,offset+4);vptr=Number(raw.readBigUInt64LE());
    check(raw.readUInt32LE(offset)>=2&&raw.readUInt32LE(offset)<=16,'Unexpected '+kind+' clone references');
    table=await bridge.m.read(vptr,80);
    for(const [slot,fn]of [[0,add],[1,release],...(read?[[4,read]]:[])])check(table.readBigUInt64LE(slot*8)===bridge.base+BigInt(fn),'Wrong '+kind+' method table');
   }catch(error){uncertain=bridge.c.pending||isUncertain(error);throw error;}
   finally{if(!uncertain)await s.close(clone);}
   const baseline=await bridge.m.u32(object+offset);
   check(raw.readUInt32LE(offset)===baseline+1&&baseline>=1,'Clone reference did not release exactly once');
   if(kind==='mod-file')check(baseline===1,'Mod file is not exclusively owned');
   return {kind,object,vptr,methods:table.toString('hex'),refOffset:offset,baseline,add,release,read,pinned:false};
  }
  const source={a,sd};
  if(log)try{
   check(/^\/ns2jb-modloader\/logs\/\d{8}T\d{6}Z-switch2-[A-Za-z0-9]+\.log$/.test(log.sdPath),'Invalid runtime report path');
   const mode=Buffer.alloc(4);mode.writeUInt32LE(7);const opened=await filesystem.pathMethod(s,sd,8,log.sdPath,mode);check(!opened.result,'Cannot retain runtime report');file=domain.oneHandle(opened);check(await filesystem.fileSize(s,file)===BigInt(log.size),'Runtime report size changed');
   const qualified=await locate(file,'mod-file',0x20,0x1036f0,0x104e10,0x104ef0),table=Buffer.from(qualified.methods,'hex');
   for(const [key,slot,offset]of [['write',5,0x1050a0n],['flush',6,0x1053d0n],['setSize',7,0x105410n]]){
    const address=table.readBigUInt64LE(slot*8);check(address===bridge.base+offset,'Report '+key+' method differs from qualified file operations');qualified[key]=String(address);
   }
   source.logFile=qualified;
  }catch(error){
   if(bridge.c.pending||isUncertain(error))throw error;
   if(file){await s.close(file);file=null;}
   console.warn('WARNING: Runtime reporting is unavailable; mods will still load. '+error.message);
  }
  if(source.logFile&&log.tracePath)try{
   check(log.tracePath===log.sdPath.replace(/\.log$/,'.trace'),'Invalid runtime trace path');
   const mode=Buffer.alloc(4);mode.writeUInt32LE(7);
   const opened=await filesystem.pathMethod(s,sd,8,log.tracePath,mode);check(!opened.result,'Cannot retain runtime trace');
   traceFile=domain.oneHandle(opened);check(await filesystem.fileSize(s,traceFile)===40960n,'Runtime trace size changed');
   const qualified=await locate(traceFile,'mod-file',0x20,0x1036f0,0x104e10,0x104ef0),table=Buffer.from(qualified.methods,'hex');
   check(table.readBigUInt64LE(40)===BigInt(source.logFile.write)&&table.readBigUInt64LE(48)===BigInt(source.logFile.flush),'Trace and report file operations differ');
   source.traceFile=qualified;
  }catch(error){
   if(bridge.c.pending||isUncertain(error))throw error;
   if(traceFile){await s.close(traceFile);traceFile=null;}
   console.warn('WARNING: Runtime trace is unavailable; text reporting remains active. '+error.message);
  }
  // Opening files retains their parent filesystem. Measure after all opens.
  source.filesystem=await locate(sd,'SD-filesystem',0x28,0x4b8c0,0x103390);
  source.close=()=>a.close();return source;
 }catch(e){if(bridge.c.pending||isUncertain(e)){bridge.c.pending=true;throw e;}await a.close();throw e;}
}
async function pin(bridge,object) {
 check(await bridge.m.u32(object.object+object.refOffset)===object.baseline,'Pin reference baseline changed');
 await bridge.call(object.add,[object.object],'retain-'+object.kind);
 check(await bridge.m.u32(object.object+object.refOffset)===object.baseline+1,'Native AddRef did not increment once');object.pinned=true;
}
async function unpin(bridge,object,clientOpen=true) {
 if(!object.pinned)return;
 check(await bridge.m.u32(object.object+object.refOffset)===(clientOpen?object.baseline+1:1),'Pinned reference count changed');
 await bridge.call(object.release,[object.object],'release-'+object.kind);object.pinned=false;
 if(clientOpen)check(await bridge.m.u32(object.object+object.refOffset)===object.baseline,'Native Release did not decrement once');
}
module.exports={openSource,pin,unpin};
