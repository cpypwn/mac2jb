'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Pack}=require('./pack.cjs'),{buildRomfs}=require('./romfs.cjs'),{buildExeFs}=require('./exefs.cjs');
const {check,writeJson}=require('./common.cjs');
async function prepare(collection,captures,directory,session){
 const file=path.join(directory,'mods.pack'),pack=new Pack(file),sources=new (require('./sources.cjs').Sources)(collection.reader),views=[],exefs=[],namespaces=[],matched=new Set();
 try{
  pack.bytes(Buffer.from('NS2META2'));
  for(const game of collection.games){
   const entry=captures.find(c=>c.inventory.titleId===game.titleId);check(entry,'Missing capture for '+game.titleId);const {inventory,directory:capture}=entry;
   // Cached entries contain content metadata and original file bytes, never
   // live handles or FS execution proofs from their source session.
   check(inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors.length&&(inventory.session===session||entry.cached===true),'Incomplete/different capture for '+game.titleId);
   if(game.romfs.length||game.romfsImage)views.push(await buildRomfs(capture,inventory.romfs,game,pack,sources));
   if(inventory.exefs){const result=await buildExeFs(game,inventory.exefs,capture,pack,collection.patches,sources,path.resolve(directory,'../../generated'));exefs.push(...result.entries);if(result.group)namespaces.push(result.group);for(const p of result.matched)matched.add(p);}
  }
  check(views.length||exefs.length,'No applicable RomFS/ExeFS changes');const payload=await pack.finish();payload.resident=true;
  const deferredGames=captures.filter(entry=>entry.deferred&&(views.some(v=>v.titleId===entry.inventory.titleId)||namespaces.some(g=>g.titleId===entry.inventory.titleId))).map(entry=>({titleId:entry.inventory.titleId,sourceSession:entry.inventory.session}));
  const inputs=[...collection.patches,...collection.games.flatMap(game=>game.patches.map(patch=>({...patch,path:game.titleId+'/'+patch.path})))];
  const plan={schema:5,kind:'ns2jb-layeredfs',session,titleIds:[...new Set([...views.map(v=>v.titleId),...namespaces.map(g=>g.titleId)])],views,exefs,namespaces,payload,sources:[...sources.entries.values()],deferredGames,ignoredPatches:inputs.filter(p=>!matched.has(p.file)).map(p=>p.path),installed:false,gameplayVerified:false};
  writeJson(path.join(directory,'overlay.json'),plan);return{plan,file};
 }finally{pack.close();}
}
module.exports={prepare};
