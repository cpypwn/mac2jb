'use strict';
// Snapshot mod inputs from the console SD using only owned, read-only handles.
const fs=require('node:fs'),path=require('node:path');
const {attachGame,createGameFiles}=require('./game-files/mount-api.cjs');
const {check,romPath}=require('./common.cjs'),{collectMods}=require('./mods.cjs');
async function collectSdMods(run,directory,source='/ns2jb-modloader'){
 romPath(source);check(!fs.existsSync(directory),'An SD snapshot already exists for this session');
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const a=await attachGame(run),files=createGameFiles(a);let count=0;
 try{
  const opened=await a.s.ipc('Open SD mod inputs',a.root,18);check(!opened.result,'Cannot open the console SD');const sd=a.domain.oneHandle(opened);
  async function copy(remote,local,depth=0){
   check(depth<=128,'SD mod directory nesting exceeds its limit');fs.mkdirSync(local,{recursive:true,mode:0o700});
   for(const row of await files.list({handle:sd},remote,()=>false)){
    check(row.name&&!/[\\/\x00]/.test(row.name)&&!['.','..'].includes(row.name),'Invalid SD directory entry');
    if(['.DS_Store','Thumbs.db','.gitkeep'].includes(row.name))continue;
    const from=romPath(remote+'/'+row.name),to=path.join(local,row.name);check(Buffer.byteLength(from)<0x301,'SD mod path exceeds the filesystem limit');
    if(row.type==='directory'){await copy(from,to,depth+1);continue;}
    check(row.type==='file'&&Number.isSafeInteger(row.size)&&row.size>=0,'Invalid SD file extent');
    const opened=await a.filesystem.openFile(a.s,sd,from);check(!opened.result,'Cannot read SD mod '+from);let fd;
    try{
     const size=Number(await a.filesystem.fileSize(a.s,opened.handle));check(size===row.size,'SD mod size changed: '+from);fd=fs.openSync(to,'wx',0o600);
     for(let at=0;at<size;at+=0x40000){const n=Math.min(0x40000,size-at),bytes=await a.filesystem.readFile(a.s,opened.handle,at,n);check(bytes.length===n,'Short SD mod read: '+from);let done=0;while(done<bytes.length)done+=fs.writeSync(fd,bytes,done,bytes.length-done);}
     check(Number(await a.filesystem.fileSize(a.s,opened.handle))===size,'SD mod size changed while reading: '+from);count++;
    }finally{if(fd!==undefined)fs.closeSync(fd);await a.s.close(opened.handle);}
   }
  }
  for(const name of ['contents','exefs_patches']){
   const remote=source+'/'+name,type=await a.filesystem.pathMethod(a.s,sd,7,remote);
   if((type.result&0x3fffff)===0x202)continue;
   check(!type.result&&type.data.readUInt32LE()===0,'Expected an SD directory: '+remote);await copy(remote,path.join(directory,name));
  }
  const collection=collectMods(directory);console.log('Read '+count+' mod file(s) from SD:'+source+'/');return collection;
 }finally{await a.close();}
}
module.exports={collectSdMods};
