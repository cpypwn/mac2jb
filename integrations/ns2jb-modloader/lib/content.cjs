'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {attachGame,createGameFiles,readRomfs}=require('./game-files/mount-api.cjs');
const {discoverUpdates,findOriginalContent,resolveDlcContent}=require('./game-files/content.cjs');
const {check,sha,writeJson}=require('./common.cjs');
const {validateProgramId}=require('./codefs-identity.cjs');
const absent=new Set([0xe05,0x21005,0x20a05]);
async function selection(a,title){
 try{const original=await findOriginalContent({...a,title}),updates=await discoverUpdates({...a,title});return{title,storage:original.storage,update:updates[0]||undefined};}
 catch(error){if(!/No installed base Program content/.test(error.message))throw error;}
 for(const storage of [4,5,2])try{const dlc={contentTitle:title};await resolveDlcContent({...a,title,storage,dlc});return{title,storage,dlc};}catch(error){if(!absent.has(error.nativeResult?.canonical))throw error;}
 throw Object.assign(Error('No installed Program or DLC Data content for '+title),{code:'CONTENT_UNAVAILABLE'});
}
async function openSelected(a,files,selected,section='romfs'){
 try{return await files.open({...selected,section});}
 catch(error){if(error.nativeResult?.canonical!==0x7d802||!error.source)throw error;await require('./game-files/program.cjs').prepareInstalledLicense({...a,title:selected.title,source:error.source});return files.open({...selected,section});}
}
async function streamFile(a,mount,name,destination){
 const opened=await a.filesystem.openFile(a.s,mount.handle,'/'+name);check(!opened.result,'Cannot open ExeFS '+name);
 let fd;try{const size=Number(await a.filesystem.fileSize(a.s,opened.handle)),hash=crypto.createHash('sha256');fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fd=fs.openSync(destination,'w',0o600);
  for(let at=0;at<size;at+=0x40000){const n=Math.min(0x40000,size-at),bytes=await a.filesystem.readFile(a.s,opened.handle,at,n);check(bytes.length===n,'Short ExeFS read');fs.writeSync(fd,bytes);hash.update(bytes);}return{size,sha256:hash.digest('hex')};
 }finally{if(fd!==undefined)fs.closeSync(fd);await a.s.close(opened.handle);}
}
async function captureGame(run,game,directory,globalPatches=[]){
 const {matchesPatch}=require('./exefs.cjs'),r={session:path.basename(run),titleId:game.titleId,complete:false,romfs:null,exefs:null,cleanupErrors:[]};
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,'inventory.json'),save=()=>writeJson(file,r);
 const a=await attachGame(run),files=createGameFiles(a);let mount,failure;
 try{
  const selected=await selection(a,game.titleId);r.selection=selected;
  if(game.romfs.length||game.romfsImage){
   mount=await openSelected(a,files,selected);check(mount.kind==='storage','Expected RomFS storage');
   const label='romfs',dir=path.join(directory,label);fs.mkdirSync(dir,{recursive:true,mode:0o700});
   const m={label,storage:selected.storage,selection:selected,source:mount.source,size:mount.size,metadata:[]};r.romfs=m;
   m.entries=await readRomfs(async(offset,length)=>{const b=await files.read(mount,offset,length);check(b.length===length,'Short RomFS metadata read');const filename=offset.toString(16)+'-'+length.toString(16)+'.bin';fs.writeFileSync(path.join(dir,filename),b,{mode:0o600});m.metadata.push({offset,length,filename,sha256:sha(b)});return b;},mount.size);
   const header=await files.read(mount,0,80),ft=Number(header.readBigUInt64LE(56)),fts=Number(header.readBigUInt64LE(64));
   const entryOffset=fts>=32?ft:80,entry=await files.read(mount,entryOffset,32),candidate=m.entries.find(e=>e.type==='file'&&e.size>=128),offset=candidate?.offset??80,length=Math.min(128,mount.size-offset),prefix=await files.read(mount,offset,length);
   check(entry.length===32&&prefix.length===length&&length>0,'Cannot qualify storage identity');m.identity={entryOffset,entryHex:entry.toString('hex'),offset,length,hex:prefix.toString('hex').padEnd(256,'0')};
   await files.close(mount);mount=null;save();
  }
  if(game.exefs.length||game.patches.length||game.stubs?.length||game.exefsImage||globalPatches.length&&!selected.dlc){
   check(!selected.dlc,'DLC Data content does not contain ExeFS');mount=await openSelected(a,files,selected,'exefs');check(mount.kind==='filesystem','Expected CodeFS filesystem');
   const rows=await files.list(mount,'/',()=>false);
   check(!rows.some(e=>e.type!=='file'),'Unexpected subdirectory in original CodeFS');
   let needed=!!(game.exefs.length||game.patches.length||game.stubs?.length||game.exefsImage);
   if(!needed)for(const e of rows.filter(e=>e.type==='file'&&e.size>=256)){
    const opened=await a.filesystem.openFile(a.s,mount.handle,'/'+e.name);check(!opened.result,'Cannot inspect NSO Build ID');let h;
    try{h=await a.filesystem.readFile(a.s,opened.handle,0,256);}finally{await a.s.close(opened.handle);}
    if(h.length===256&&h.toString('ascii',0,4)==='NSO0'&&globalPatches.some(p=>matchesPatch(p,e.name,h.subarray(0x40,0x60).toString('hex')))){needed=true;break;}
   }
   if(needed){
   const m={source:mount.source,selection:selected,storage:selected.storage,files:[]};r.exefs=m;
   for(const e of rows.filter(e=>e.type==='file')){
    check(e.name&&!/[\\/\x00]/.test(e.name)&&!['.','..'].includes(e.name),'Invalid original CodeFS name');
    const item={name:e.name,localPath:path.join('exefs',e.name)};
    Object.assign(item,await streamFile(a,mount,e.name,path.join(directory,item.localPath)));
    const fd=fs.openSync(path.join(directory,item.localPath),'r'),header=Buffer.alloc(Math.min(256,item.size));
    try{check(fs.readSync(fd,header,0,header.length,0)===header.length,'Short captured ExeFS header');}finally{fs.closeSync(fd);}
    item.headerHex=header.toString('hex');item.buildId=header.length===256&&header.toString('ascii',0,4)==='NSO0'?header.subarray(0x40,0x60).toString('hex'):null;
    m.files.push(item);
   }
   const main=m.files.find(e=>e.name==='main'),npdm=m.files.find(e=>e.name==='main.npdm');
   check(main?.buildId&&npdm&&npdm.size>=128,'CodeFS must contain main and main.npdm for title qualification');
   const meta=fs.readFileSync(path.join(directory,npdm.localPath)),aci=meta.readUInt32LE(0x70),aciSize=meta.readUInt32LE(0x74);
   check(meta.toString('ascii',0,4)==='META'&&aci>=128&&aciSize>=0x20&&aci+aciSize<=meta.length&&meta.toString('ascii',aci,aci+4)==='ACI0','Invalid original NPDM identity');
   const id=meta.readBigUInt64LE(aci+0x10);
   validateProgramId(game.titleId,m.source,id);
   m.owner={programId:String(id),programOffset:aci+0x10,npdmHeaderHex:meta.subarray(0,128).toString('hex'),mainSize:main.size,mainHeaderHex:main.headerHex};
   }
   await files.close(mount);mount=null;save();
  }
  r.complete=true;
 }catch(error){failure=error;r.error=error.stack;}
 finally{if(mount)try{await files.close(mount);}catch(e){r.cleanupErrors.push(e.stack);}try{await a.close();r.temporarySessionClosed=true;}catch(e){r.cleanupErrors.push(e.stack);}save();}
 if(failure){
  failure.captureCleanupComplete=r.temporarySessionClosed===true&&!r.cleanupErrors.length;
  if(failure.captureCleanupComplete&&[0x691,0x1491,0x7d802].includes(failure.nativeResult?.canonical))failure.code='CONTENT_LICENSE_UNAVAILABLE';
  throw failure;
 }
 check(!r.cleanupErrors.length,'Temporary capture cleanup failed');return r;
}
module.exports={captureGame,selection,openSelected,streamFile};
