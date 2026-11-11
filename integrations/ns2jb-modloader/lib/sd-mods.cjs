'use strict';
const fs=require('node:fs'),path=require('node:path');
const {attachGame}=require('./game-files/mount-api.cjs');
const {check,romPath,writeJson}=require('./common.cjs'),{collectMods}=require('./mods.cjs');
const {isUncertain}=require('./game-files/uncertain.cjs');
async function collectSdMods(run,directory,source='/ns2jb-modloader',options={}){
 romPath(source);check(!fs.existsSync(directory),'An SD inventory already exists for this session');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const {tree,bootstrap}=await require('./native/inventory.cjs').scanSd(run,source,directory,options);let a,sd,closed=false,uncertain=false;
 function noteUncertain(error){if(isUncertain(error)){uncertain=true;bootstrap.bridge.c.pending=true;}}
 async function close(){if(!closed&&!uncertain){closed=true;if(a)await a.close();}}
 try{
  for(const row of tree.values())if(row.type==='directory')row.children=row.children.filter(name=>!['.DS_Store','Thumbs.db','.gitkeep'].includes(name));
  function stat(name){const row=tree.get(name);check(row,'Unknown SD input');return{size:row.size,isSymbolicLink:()=>false,isFile:()=>row.type==='file',isDirectory:()=>row.type==='directory'};}
  const io={remote:true,existsSync:name=>tree.has(name),statSync:stat,lstatSync:stat,readdirSync:(name,options)=>tree.get(name).children.map(child=>options?.withFileTypes?{name:child,...stat(name+'/'+child)}:child)};
  const collection=collectMods(source,io);collection.inputDirectory=directory;collection.bootstrap=bootstrap;
  const manifest=[...tree].map(([name,row])=>({path:name,type:row.type,...(row.type==='file'?{size:row.size}:{})}));writeJson(path.join(directory,'inventory.json'),manifest);
  console.log('Scanned '+manifest.filter(r=>r.type==='file').length+' file(s) in SD:'+source+'/');
  const hasText=collection.patches.some(patch=>patch.format==='pchtxt')||collection.games.some(game=>game.patches.some(patch=>patch.format==='pchtxt'));
  if(options.nativePreparation&&!hasText)return collection;
  a=await attachGame(run);
  const opened=await a.s.ipc('Open SD mod inputs',a.root,18);check(!opened.result,'Cannot open the console SD');sd=a.domain.oneHandle(opened);
  const reader={close,async read(name,offset,length){
   const row=tree.get(name);check(!closed&&row?.type==='file'&&offset>=0&&length>=0&&offset+length<=row.size,'SD source changed or exceeds its extent');
   const opened=await a.filesystem.openFile(a.s,sd,name);check(!opened.result,'Cannot open SD source '+name);
   try{check(await a.filesystem.fileSize(a.s,opened.handle)===BigInt(row.size),'SD source size changed');const pieces=[];for(let at=0;at<length;at+=0x40000){const n=Math.min(0x40000,length-at),b=await a.filesystem.readFile(a.s,opened.handle,offset+at,n);check(b.length===n,'Short SD source read');pieces.push(b);}return Buffer.concat(pieces,length);}
   catch(error){noteUncertain(error);throw error;}
   finally{if(!uncertain)await a.s.close(opened.handle);}
  }};
  if(hasText){
   const {compileTextPatch}=require('./patch-input.cjs');
   for(const list of [collection.patches,...collection.games.map(game=>game.patches)])for(let i=0;i<list.length;i++)if(list[i].format==='pchtxt'){
    const patch=list[i];list[i]=compileTextPatch(patch,await reader.read(patch.sdPath,0,patch.size));
   }
  }
  if(options.nativePreparation){await close();return collection;}
  collection.reader=reader;
  // Only the patch records need to leave SD. Loose game data is read in FS.
  const patchInputs=[...collection.patches.map(patch=>({patch,relative:path.join('exefs_patches',patch.path)})),...collection.games.flatMap(game=>game.patches.map(patch=>({patch,relative:path.join('contents',game.titleId,patch.path)})))];
  for(const {patch,relative} of patchInputs){if(patch.compiledHex!==undefined)continue;const bytes=await reader.read(patch.sdPath,0,patch.size),file=path.join(directory,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600});patch.file=file;}
  return collection;
 }catch(error){noteUncertain(error);if(!uncertain){await close();await bootstrap.release();}throw error;}
}
module.exports={collectSdMods};
