'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Pack}=require('./pack.cjs'),{buildRomfs}=require('./romfs.cjs'),{buildExeFs}=require('./exefs.cjs');
const {check,writeJson}=require('./common.cjs');
async function prepare(collection,captures,directory,session){
 const file=path.join(directory,'mods.pack'),pack=new Pack(file),views=[],exefs=[],namespaces=[],matched=new Set();
 try{
  for(const game of collection.games){
   const entry=captures.find(c=>c.inventory.titleId===game.titleId);check(entry,'Missing capture for '+game.titleId);const {inventory,directory:capture}=entry;
   check(inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors.length&&inventory.session===session,'Incomplete/different capture for '+game.titleId);
   if(game.romfs.length||game.romfsImage)views.push(await buildRomfs(capture,inventory.romfs,game,pack));
   if(inventory.exefs){const result=await buildExeFs(game,inventory.exefs,capture,pack,collection.patches);exefs.push(...result.entries);if(result.group)namespaces.push(result.group);for(const p of result.matched)matched.add(p);}
  }
  check(views.length||exefs.length,'No applicable RomFS/ExeFS changes');const payload=await pack.finish();payload.sdPath='/ns2jb-modloader/'+payload.sha256+'.pack';
  for(const group of namespaces){group.prefix='/ns2jb-modloader/'+payload.sha256+'/'+group.titleId+'/exefs';for(const e of exefs.filter(e=>e.titleId===group.titleId))e.sdPath=group.prefix+'/'+e.name;}
  const plan={schema:4,kind:'ns2jb-layeredfs',session,titleIds:[...new Set([...views.map(v=>v.titleId),...namespaces.map(g=>g.titleId)])],views,exefs,namespaces,payload,ignoredPatches:collection.patches.filter(p=>!matched.has(p.file)).map(p=>p.path),installed:false,gameplayVerified:false};
  writeJson(path.join(directory,'overlay.json'),plan);return{plan,file};
 }finally{pack.close();}
}
module.exports={prepare};
