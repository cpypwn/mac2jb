'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,titleId,romPath}=require('./common.cjs');
const {compileTextPatch}=require('./patch-input.cjs');
function walk(root,base=root,io=fs){
 check(!io.lstatSync(root).isSymbolicLink(),'Mod paths must not be symlinks: '+root);
 const rows=[];
 for(const e of io.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  const file=path.join(root,e.name);check(!e.isSymbolicLink(),'Mod paths must not be symlinks: '+file);
  const name=romPath('/'+path.relative(base,file).split(path.sep).join('/'));
  if(e.isDirectory()){rows.push({path:name,type:'directory',file});rows.push(...walk(file,base,io));}
  else{check(e.isFile(),'Unsupported mod entry: '+file);rows.push({path:name,type:'file',file,size:io.statSync(file).size,...(io.remote?{sdPath:file}:{})});}
 }
 return rows;
}
const patchExtension=/\.(?:ips|ips32)$/i,patchName=/^(?:[0-9a-f]{2}){1,32}\.(?:ips|ips32)$/i;
function patchRows(rows,references,io){
 const files=rows.filter(row=>row.type==='file'),binaries=files.filter(row=>patchExtension.test(row.path)),patches=[...binaries];
 for(const row of patches)check(patchName.test(path.posix.basename(row.path)),'IPS patches must be named for an NSO Build ID: '+row.file);
 for(const row of files.filter(row=>/\.pchtxt$/i.test(row.path))){
  const stem=row.path.replace(/\.pchtxt$/i,'').toLowerCase();
  const binary=binaries.find(patch=>patch.path.replace(patchExtension,'').toLowerCase()===stem);
  if(binary)references.push({...row,binary:binary.sdPath||binary.file});
  else patches.push(io.remote?{...row,format:'pchtxt'}:compileTextPatch(row,io.readFileSync(row.file)));
 }
 return patches.sort((a,b)=>(a.inputPath||a.path).localeCompare(b.inputPath||b.path));
}
function patchTree(folder,io,references){
 const rows=walk(folder,folder,io);
 for(const row of rows)check(row.type==='directory'||patchExtension.test(row.path)||/\.pchtxt$/i.test(row.path),'Unsupported patch file '+row.file+'. Use Build-ID-named .ips/.ips32 files or IPSwitch .pchtxt with @nsobid.');
 return patchRows(rows,references,io);
}
// Atmosphere uses global exefs_patches/. Emulator-style IPS files in a game's
// exefs/ (or exefs_patches/) keep that game's Title ID as an additional scope.
function collectMods(root,io=fs){
 root=path.resolve(root);const games=[],patches=[],patchReferences=[],contents=path.join(root,'contents'),patchRoot=path.join(root,'exefs_patches'),ids=new Set();
 if(io.existsSync(contents))for(const e of io.readdirSync(contents,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['.gitkeep','.DS_Store','Thumbs.db'].includes(e.name))continue;
  check(e.isDirectory()&&!e.isSymbolicLink(),'Expected a Title ID directory under contents/: '+e.name);
  if(e.name==='exefs_patches'){
   const folder=path.join(contents,e.name);patches.push(...patchTree(folder,io,patchReferences).map(row=>({...row,path:'contents/exefs_patches'+row.path})));continue;
  }
  const id=titleId(e.name),dir=path.join(contents,e.name);check(!ids.has(id),'Duplicate Title ID: '+id);ids.add(id);
  const g={titleId:id,romfs:[],exefs:[],patches:[],patchReferences:[],stubs:[]};
  const cheats=path.join(dir,'cheats');if(io.existsSync(cheats)&&io.statSync(cheats).isDirectory()&&io.readdirSync(cheats).some(name=>!['.gitkeep','.DS_Store','Thumbs.db'].includes(name)))console.warn('WARNING: Skipping cheats for '+id+'; this release loads RomFS, ExeFS and IPS mods.');
  for(const name of io.readdirSync(dir))check(['romfs','exefs','exefs_patches','romfs.bin','exefs.nsp','flags','romfs_metadata.bin','cheats'].includes(name)||/^(?:readme|license|copying|credits|changelog)/i.test(name)||/\.(?:md|txt|json)$/i.test(name),
   'Unsupported component '+name+' in '+dir+'. Put game files in romfs/ or exefs/, and IPS patches in exefs/ or exefs_patches/. Runtime plugins need their own loader.');
  for(const section of ['romfs','exefs']){const folder=path.join(dir,section);if(io.existsSync(folder))g[section]=walk(folder,folder,io);}
  for(const [name,key] of [['romfs.bin','romfsImage'],['exefs.nsp','exefsImage']]){
   const file=path.join(dir,name);if(io.existsSync(file)){const st=io.lstatSync(file);check(st.isFile()&&!st.isSymbolicLink(),'Invalid '+name);g[key]={file,size:st.size,...(io.remote?{sdPath:file}:{})};}
  }
  for(const section of ['romfs','exefs']){
   const names=new Set();for(const row of g[section]){const name=row.path.toLowerCase();check(!names.has(name),'Case-conflicting '+section+' entries: '+row.path);names.add(name);}
  }
  check(!g.exefs.some(r=>r.type==='directory'),'ExeFS files must be at the root of exefs/.');
  g.patches=patchRows(g.exefs,g.patchReferences,io).map(row=>({...row,path:'exefs'+row.path}));
  g.exefs=g.exefs.filter(row=>!patchExtension.test(row.path)&&!/\.pchtxt$/i.test(row.path));
  const localPatches=path.join(dir,'exefs_patches');
  if(io.existsSync(localPatches))g.patches.push(...patchTree(localPatches,io,g.patchReferences).map(row=>({...row,path:'exefs_patches'+row.path})));
  g.stubs=g.exefs.filter(r=>/\.stub$/.test(r.path)).map(r=>r.path.slice(1,-5));
  g.exefs=g.exefs.filter(r=>!r.path.endsWith('.stub'));
  games.push(g);
 }
 if(io.existsSync(patchRoot))patches.push(...patchTree(patchRoot,io,patchReferences).map(row=>({...row,path:row.path.slice(1)})));
 check(patches.length||games.some(g=>g.romfs.length||g.exefs.length||g.patches.length||g.stubs.length||g.romfsImage||g.exefsImage),'No supported mods found. Add files under contents/<TITLE_ID>/romfs/ or exefs/, or add IPS patches under exefs_patches/.');
 return{directory:root,games,patches,patchReferences};
}
module.exports={collectMods,walk};
