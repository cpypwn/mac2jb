'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,titleId,romPath}=require('./common.cjs');
function walk(root,base=root){
 check(!fs.lstatSync(root).isSymbolicLink(),'Mod paths must not be symlinks: '+root);
 const rows=[];
 for(const e of fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  const file=path.join(root,e.name);check(!e.isSymbolicLink(),'Mod paths must not be symlinks: '+file);
  const name=romPath('/'+path.relative(base,file).split(path.sep).join('/'));
  if(e.isDirectory()){rows.push({path:name,type:'directory',file});rows.push(...walk(file,base));}
  else{check(e.isFile(),'Unsupported mod entry: '+file);rows.push({path:name,type:'file',file,size:fs.statSync(file).size});}
 }
 return rows;
}
// Read the Atmosphere tree directly: contents/<TITLE_ID> and exefs_patches/.
function collectMods(root){
 root=path.resolve(root);const games=[],patches=[],contents=path.join(root,'contents'),patchRoot=path.join(root,'exefs_patches'),ids=new Set();
 if(fs.existsSync(contents))for(const e of fs.readdirSync(contents,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  check(e.isDirectory()&&!e.isSymbolicLink(),'Expected a Title ID directory under contents/: '+e.name);
  const id=titleId(e.name),dir=path.join(contents,e.name);check(!ids.has(id),'Duplicate Title ID: '+id);ids.add(id);
  const g={titleId:id,romfs:[],exefs:[],patches:[],stubs:[]};
  for(const name of fs.readdirSync(dir))check(['romfs','exefs','romfs.bin','exefs.nsp','flags','romfs_metadata.bin'].includes(name)||/^(?:readme|license|copying|credits|changelog)/i.test(name)||/\.(?:md|txt|json)$/i.test(name),
   'Unsupported component '+name+' in '+dir+'. Runtime cheats/plugins require their own loader; refusing to install only part of this mod.');
  for(const section of ['romfs','exefs']){const folder=path.join(dir,section);if(fs.existsSync(folder))g[section]=walk(folder);}
  for(const [name,key] of [['romfs.bin','romfsImage'],['exefs.nsp','exefsImage']]){
   const file=path.join(dir,name);if(fs.existsSync(file)){const st=fs.lstatSync(file);check(st.isFile()&&!st.isSymbolicLink(),'Invalid '+name);g[key]={file,size:st.size};}
  }
  for(const section of ['romfs','exefs']){
   const names=new Set();for(const row of g[section]){const name=row.path.toLowerCase();check(!names.has(name),'Case-conflicting '+section+' entries: '+row.path);names.add(name);}
  }
  check(!g.exefs.some(r=>r.type==='directory'),'ExeFS files must be at the root of exefs/.');
  g.stubs=g.exefs.filter(r=>/\.stub$/.test(r.path)).map(r=>r.path.slice(1,-5));
  g.exefs=g.exefs.filter(r=>!r.path.endsWith('.stub'));
  games.push(g);
 }
 if(fs.existsSync(patchRoot))for(const e of fs.readdirSync(patchRoot,{withFileTypes:true})){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  check(e.isDirectory()&&!e.isSymbolicLink(),'Expected a patchset directory under exefs_patches/: '+e.name);
  for(const r of walk(path.join(patchRoot,e.name))){
   check(r.type==='file'&&/^\/(?:[0-9a-f]{2}){1,32}\.(?:ips|ips32)$/i.test(r.path),'ExeFS patches must be named for an NSO Build ID: '+r.path);
   patches.push({...r,path:e.name+r.path});
  }
 }
 check(games.length||patches.length,'No mods found. Add contents/<TITLE_ID>/romfs/ or exefs/ to ns2jb-modloader.');
 return{directory:root,games,patches};
}
module.exports={collectMods,walk};
