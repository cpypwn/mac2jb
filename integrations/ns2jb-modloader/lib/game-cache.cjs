'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,titleId,writeJson}=require('./common.cjs');
const unavailable=error=>error.captureCleanupComplete&&['CONTENT_UNAVAILABLE','CONTENT_LICENSE_UNAVAILABLE'].includes(error.code);
function complete(inventory,id){
 check(inventory.titleId===id&&inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors?.length,'Incomplete game preparation: '+id);
}
function sourceFile(directory,name){
 check(typeof name==='string'&&!path.isAbsolute(name),'Invalid cached game path');
 const file=path.resolve(directory,name),relative=path.relative(directory,file);
 check(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..','Cached game path leaves its directory');return file;
}
function files(inventory){
 return[...(inventory.romfs?.metadata||[]).map(row=>({name:path.join(inventory.romfs.label,row.filename),size:row.length})),...(inventory.exefs?.files||[]).filter(row=>row.localPath).map(row=>({name:row.localPath,size:row.size}))];
}
function saveGameCache(entry,cacheRoot){
 const inventory=entry.inventory,id=titleId(inventory.titleId);complete(inventory,id);
 if(!inventory.romfs&&!inventory.exefs&&!inventory.exefsIndex)return;
 const folder=path.join(cacheRoot,id);fs.mkdirSync(folder,{recursive:true,mode:0o700});
 // Replacing one small pointer file publishes a complete, immutable snapshot.
 const snapshot=fs.mkdtempSync(path.join(folder,'.preparation-'));let published=false;
 try{
  for(const row of files(inventory)){
   const from=sourceFile(entry.directory,row.name),to=sourceFile(snapshot,row.name);check(fs.statSync(from).size===row.size,'Captured game file size changed');fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});
   try{fs.linkSync(from,to);}catch(error){if(!['EXDEV','EPERM','EACCES','ENOTSUP','EMLINK'].includes(error.code))throw error;fs.copyFileSync(from,to);}
  }
  writeJson(path.join(snapshot,'inventory.json'),inventory);
  const pointer=path.join(folder,'current.json'),temporary=path.join(snapshot,'current.json');let previous;
  try{previous=JSON.parse(fs.readFileSync(pointer,'utf8')).snapshot;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  writeJson(temporary,{schema:1,snapshot:path.basename(snapshot)});fs.renameSync(temporary,pointer);published=true;
  if(typeof previous==='string'&&/^\.preparation-[A-Za-z0-9]+$/.test(previous)&&previous!==path.basename(snapshot))fs.rmSync(path.join(folder,previous),{recursive:true,force:true});
 }catch(error){if(!published)fs.rmSync(snapshot,{recursive:true,force:true});throw error;}
}
function loadGameCache(game,cacheRoot,globalPatches=[]){
 const id=titleId(game.titleId),folder=path.join(cacheRoot,id),pointer=path.join(folder,'current.json');
 if(!fs.existsSync(pointer))return null;
 const current=JSON.parse(fs.readFileSync(pointer,'utf8'));check(current.schema===1&&/^\.preparation-[A-Za-z0-9]+$/.test(current.snapshot),'Invalid game preparation index');
 const directory=path.join(folder,current.snapshot),inventory=JSON.parse(fs.readFileSync(path.join(directory,'inventory.json'),'utf8'));complete(inventory,id);
 if((game.romfs.length||game.romfsImage)&&!inventory.romfs)return null;
 if((game.exefs.length||game.patches.length||game.stubs?.length||game.exefsImage)&&!inventory.exefs)return null;
 if(globalPatches.length&&!inventory.selection?.dlc){
  const index=inventory.exefs||inventory.exefsIndex;if(!index)return null;
  const {matchesPatch}=require('./exefs.cjs');if(index.files.some(e=>e.buildId&&globalPatches.some(p=>matchesPatch(p,e.name,e.buildId)))&&!inventory.exefs)return null;
 }
 for(const row of files(inventory))check(fs.statSync(sourceFile(directory,row.name)).size===row.size,'Cached game file is incomplete: '+row.name);
 const {matchesPatch}=require('./exefs.cjs'),replaced=new Set(game.exefs.map(e=>e.path.slice(1)));
 if(!game.exefsImage)for(const row of inventory.exefs?.files||[])if(!replaced.has(row.name)&&!game.stubs?.includes(row.name)&&row.buildId&&[...game.patches,...globalPatches].some(p=>matchesPatch(p,row.name,row.buildId))&&!row.localPath)return null;
 return{directory,inventory,cached:true};
}
function cachedTitles(cacheRoot,patches){
 const ids=new Set();
 if(fs.existsSync(cacheRoot))for(const row of fs.readdirSync(cacheRoot,{withFileTypes:true}))if(row.isDirectory()&&/^[0-9a-f]{16}$/.test(row.name)&&fs.existsSync(path.join(cacheRoot,row.name,'current.json')))ids.add(row.name);
 const state=path.dirname(cacheRoot);
 if(fs.existsSync(state))for(const row of fs.readdirSync(state,{withFileTypes:true}))if(row.isDirectory()&&/^switch2-/.test(row.name)){
  const games=path.join(state,row.name,'games');if(!fs.existsSync(games))continue;
  for(const game of fs.readdirSync(games,{withFileTypes:true}))if(game.isDirectory()&&/^[0-9a-f]{16}$/.test(game.name)){
   const file=path.join(games,game.name,'inventory.json');if(!fs.existsSync(file))continue;
   try{const inventory=JSON.parse(fs.readFileSync(file,'utf8'));if(inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors?.length&&inventory.exefs)ids.add(game.name);}catch{/* Ignore an unfinished historical preparation. */}
  }
 }
 const result=[...ids].sort();if(!patches?.length)return result;
 const {matchesPatch}=require('./exefs.cjs');
 return result.filter(id=>{
  const inventories=[];
  try{const folder=path.join(cacheRoot,id),pointer=JSON.parse(fs.readFileSync(path.join(folder,'current.json'),'utf8'));inventories.push(JSON.parse(fs.readFileSync(path.join(folder,pointer.snapshot,'inventory.json'),'utf8')));}catch{}
  if(!inventories.length)for(const row of fs.readdirSync(state,{withFileTypes:true}))if(row.isDirectory()&&/^switch2-/.test(row.name))try{inventories.push(JSON.parse(fs.readFileSync(path.join(state,row.name,'games',id,'inventory.json'),'utf8')));}catch{}
  return inventories.some(inventory=>inventory.complete&&(inventory.exefs||inventory.exefsIndex)?.files.some(e=>e.buildId&&patches.some(p=>matchesPatch(p,e.name,e.buildId))));
 });
}
function previousGameCache(game,cacheRoot,globalPatches){
 const state=path.dirname(cacheRoot),candidates=[];
 for(const row of fs.readdirSync(state,{withFileTypes:true}))if(row.isDirectory()&&/^switch2-/.test(row.name)){
  const directory=path.join(state,row.name,'games',titleId(game.titleId)),file=path.join(directory,'inventory.json');
  if(fs.existsSync(file))candidates.push({directory,file,time:fs.statSync(file).mtimeMs});
 }
 for(const candidate of candidates.sort((a,b)=>b.time-a.time)){
  try{
   const inventory=JSON.parse(fs.readFileSync(candidate.file,'utf8'));
   if(!inventory.complete||!inventory.temporarySessionClosed||inventory.cleanupErrors?.length)continue;
   saveGameCache({directory:candidate.directory,inventory},cacheRoot);
   const cached=loadGameCache(game,cacheRoot,globalPatches);if(cached)return cached;
  }catch{/* Try another complete historical preparation. */}
 }
 return null;
}
async function captureOrCachedGame(run,game,directory,globalPatches,cacheRoot,captureGame=require('./content.cjs').captureGame){
 let inventory,cached;
 try{cached=loadGameCache(game,cacheRoot,globalPatches)||previousGameCache(game,cacheRoot,globalPatches);}catch(error){console.warn('WARNING: Saved preparation will be refreshed for '+game.titleId+': '+error.message);}
 try{
  inventory=await captureGame(run,game,directory,globalPatches,cached);
  if(inventory.reuseCache){
   check(cached,'Missing saved preparation');const selection=inventory.selection||cached.inventory.selection,current={...cached.inventory,selection};
   for(const section of ['romfs','exefs','exefsIndex'])if(current[section])current[section]={...current[section],selection,storage:selection.storage,source:{...current[section].source,...inventory.currentSource}};
   return{...cached,inventory:current,deferred:false};
  }
 }catch(error){
  if(!unavailable(error))throw error;
  if(cached)return{...cached,deferred:true};
  return{pending:true,titleId:game.titleId,reason:'Game unavailable; prepare it once with the cartridge inserted or the digital game installed.'};
 }
 const entry={directory,inventory};
 try{saveGameCache(entry,cacheRoot);}catch(error){console.warn('WARNING: Could not save preparation for '+game.titleId+': '+error.message);}
 return entry;
}
module.exports={saveGameCache,loadGameCache,cachedTitles,captureOrCachedGame};
