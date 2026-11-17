'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const title='0100123412345000',build='12'.padEnd(64,'0'),sd='/ns2jb-modloader';
const text=Buffer.from('@nsobid-'+build+'\n@enabled\n00000108 78\n');
function load(file,paths,overrides={},runtime=process){
 const module={exports:{}},filename=path.resolve(__dirname,'../lib',file);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,console,process:runtime,
  require:name=>name==='node:path'?paths:Object.hasOwn(overrides,name)?overrides[name]:require(name.startsWith('.')?path.resolve(path.dirname(filename),name):name)}, {filename});
 return module.exports;
}
function fixture(root,paths,remote){
 const tree=new Map(),reads=[];
 function add(relative,data){
  const file=relative?paths.join(root,relative):root;
  if(tree.has(file))return;
  if(file!==root){const parent=paths.dirname(file);if(!tree.has(parent))add(paths.relative(root,parent));tree.get(parent).children.push(paths.basename(file));}
  tree.set(file,{children:[],...(data===undefined?{}:{data})});
 }
 add('');
 const rom='contents/'+title+'/romfs/Models/日本語 skin/model.bin';add(rom,Buffer.from('model'));add('contents/'+title+'/romfs/Paks/one.pak',Buffer.from('pak'));
 const exefs='contents/'+title+'/exefs/';
 add(exefs+'main',Buffer.from('NSO0'));add(exefs+'sdk.stub',Buffer.alloc(0));add(exefs+build+'.ips',Buffer.from('PATCH'));add(exefs+build+'.pchtxt',Buffer.from('unused invalid reference'));
 add(exefs+'descriptive-name.pchtxt',text);add('contents/'+title+'/exefs_patches/group/34.ips32',Buffer.from('IPS32'));
 add('contents/exefs_patches/alias/56.ips',Buffer.from('PATCH'));add('exefs_patches/78.ips',Buffer.from('PATCH'));add('exefs_patches/group/90.ips',Buffer.from('PATCH'));
 const images='contents/0400123412345000/';add(images+'romfs.bin',Buffer.from('image'));add(images+'exefs.nsp',Buffer.from('PFS0'));
 function stat(file){const row=tree.get(file);assert(row,'Unexpected path lookup: '+file);return{size:row.data?.length||0,isDirectory:()=>row.data===undefined,isFile:()=>row.data!==undefined,isSymbolicLink:()=>false};}
 const io={remote,existsSync:file=>tree.has(file),statSync:stat,lstatSync:stat,
  readdirSync:(folder,options)=>{assert(tree.has(folder),'Unexpected directory: '+folder);return tree.get(folder).children.map(name=>options?.withFileTypes?{name,...stat(paths.join(folder,name))}:name);},
  readFileSync:file=>{reads.push(file);assert(tree.has(file),'Unexpected file read: '+file);return tree.get(file).data;}};
 return{io,reads,rom,tree};
}
let reference;
for(const host of [path.posix,path.win32]){
 const {io,reads,rom}=fixture(sd,path.posix,true),result=load('mods.cjs',host).collectMods(sd,io),plain=JSON.parse(JSON.stringify(result));
 if(reference)assert.deepEqual(plain,reference);else reference=plain;
 assert.equal(result.directory,sd);assert.equal(result.games.length,2);assert.equal(result.patches.length,3);assert.equal(result.games[0].patches.length,3);
 assert.deepEqual(Array.from(result.games[0].exefs,row=>row.path),['/main']);assert.deepEqual(Array.from(result.games[0].stubs),['sdk']);
 assert(result.games[0].romfs.some(row=>row.sdPath===sd+'/'+rom));assert.equal(reads.length,0);
 for(const game of result.games){
  const rows=[...game.romfs,...game.exefs,...game.patches,...game.patchReferences,game.romfsImage,game.exefsImage].filter(Boolean);
  for(const row of rows){assert(row.file.startsWith(sd+'/'));assert(!row.file.includes('\\'));if(row.type==='file'||row.size!==undefined)assert.equal(row.sdPath,row.file);}
 }
 for(const patch of result.patches){assert(patch.sdPath.startsWith(sd+'/'));assert(!patch.sdPath.includes('\\'));}
 assert.throws(()=>load('mods.cjs',host).collectMods('C:\\SD\\mods',io),/Invalid resource path/);
}
for(const [host,root] of [[path.win32,'D:\\People\\Example User\\ModLoader'],[path.posix,'/home/example user/ModLoader']]){
 const {io,reads}=fixture(root,host,false),result=load('mods.cjs',host).collectMods(root,io);
 assert.equal(result.directory,host.resolve(root));assert.equal(result.games[0].patches.filter(row=>row.inputFormat==='pchtxt').length,1);
 assert.deepEqual(reads,[host.join(root,'contents',title,'exefs','descriptive-name.pchtxt')]);
 for(const row of [...result.games.flatMap(game=>[...game.romfs,...game.exefs,...game.patches]),...result.patches]){assert(row.file.startsWith(root+host.sep));assert.equal(row.sdPath,undefined);assert(!row.path.includes('\\'));}
}
const runtime=(platform,env={})=>({platform,env});
const linux=load('host-path.cjs',path.posix,{'node:os':{release:()=> 'Linux'}},runtime('linux'));
assert.equal(linux.resolveRunDirectory('./runs/switch2-test'),path.posix.resolve('runs/switch2-test'));
assert.throws(()=>linux.resolveRunDirectory('C:\\runs\\switch2-test'),/Windows run directory was supplied/);
const windows=load('host-path.cjs',path.win32,{},runtime('win32'));
assert.equal(windows.resolveRunDirectory('C:\\Users\\Some Person\\runs\\switch2-test'),'C:\\Users\\Some Person\\runs\\switch2-test');
assert.equal(windows.resolveRunDirectory('\\\\server\\share\\runs\\switch2-test'),'\\\\server\\share\\runs\\switch2-test');
let calls=0;
const wsl=load('host-path.cjs',path.posix,{'node:os':{release:()=> 'Linux'},'node:child_process':{execFileSync:(program,args,options)=>{
 calls++;assert.equal(program,'wslpath');assert.deepEqual(Array.from(args),['-u','E:\\Other Person\\runs\\switch2-test']);assert.equal(options.shell,undefined);assert(options.timeout>0);return '/custom-drive-mount/e/Other Person/runs/switch2-test\r\n';
}}},runtime('linux',{WSL_DISTRO_NAME:'AnyDistro'}));
assert.equal(wsl.resolveRunDirectory('/home/person/runs/switch2-test'),'/home/person/runs/switch2-test');assert.equal(calls,0);
assert.equal(wsl.resolveRunDirectory('E:\\Other Person\\runs\\switch2-test'),'/custom-drive-mount/e/Other Person/runs/switch2-test');assert.equal(calls,1);
assert.throws(()=>wsl.resolveRunDirectory('C:runs\\switch2-test'),/absolute Windows/);
for(const response of ['relative/path\n','/home/person\nextra\n']){
 const invalid=load('host-path.cjs',path.posix,{'node:os':{release:()=> 'Microsoft'},'node:child_process':{execFileSync:()=>response}},runtime('linux'));
 assert.throws(()=>invalid.resolveRunDirectory('C:\\runs'),/invalid Linux run directory/);
}
const unavailable=load('host-path.cjs',path.posix,{'node:os':{release:()=> 'Microsoft'},'node:child_process':{execFileSync:()=>{throw Error('missing');}}},runtime('linux'));
assert.throws(()=>unavailable.resolveRunDirectory('C:\\runs'),/could not translate/);
console.log('Path semantics: remote SD identical on Windows/POSIX; nested RomFS, ExeFS, images and all patch layouts; local drive paths preserved; WSL translation without fixed mounts or shell execution: passed');

// Exercise the complete inventory -> collector -> text reader -> resident plan
// path while local state/cache paths use Windows rules and the SD stays POSIX.
(async()=>{
 for(const nativePreparation of [true,false]){
  const input=fixture(sd,path.posix,true),outputs=new Map(),handles=new Map(),reads=[];let next=10,closed=0;
  const tree=new Map([...input.tree].map(([name,row])=>[name,{type:row.data===undefined?'directory':'file',children:[...row.children],...(row.data===undefined?{}:{size:row.data.length})}]));
  const common={...require('../lib/common.cjs'),writeJson:(file,value)=>outputs.set(file,JSON.stringify(value))};
  const {collectSdMods}=load('sd-mods.cjs',path.win32,{
   'node:fs':{existsSync:file=>outputs.has(file),mkdirSync:()=>{},writeFileSync:(file,data)=>outputs.set(file,Buffer.from(data))},
   './common.cjs':common,'./mods.cjs':load('mods.cjs',path.win32),
   './native/inventory.cjs':{scanSd:async()=>({tree,bootstrap:{bridge:{c:{pending:false}},release:async()=>{throw Error('Unexpected bootstrap release');}}})},
   './game-files/mount-api.cjs':{attachGame:async()=>({root:1,domain:{oneHandle:()=>2},s:{ipc:async()=>({result:0}),close:async handle=>{assert(handles.delete(handle));}},close:async()=>{closed++;},
    filesystem:{openFile:async(s,handle,name)=>{assert(name.startsWith(sd+'/'));assert(!name.includes('\\'));const row=input.tree.get(name);assert(row?.data);const h=next++;handles.set(h,{name,data:row.data});return{result:0,handle:h};},
     fileSize:async(s,h)=>BigInt(handles.get(h).data.length),readFile:async(s,h,at,size)=>{const row=handles.get(h);reads.push(row.name);return row.data.subarray(at,at+size);}}
   })}
  });
  const dir='F:\\People\\Any User\\ModLoader\\state\\switch2-test\\sd-inputs';
  const collection=await collectSdMods('F:\\host\\runs\\switch2-test',dir,sd,{nativePreparation});
  assert(outputs.has(path.win32.join(dir,'inventory.json')));assert.equal(collection.games[0].patches.filter(p=>p.inputFormat==='pchtxt').length,1);
  const plan=require('../lib/lazy-context.cjs').plan(collection,'switch2-test');assert(plan.lazyGames[0].files.some(file=>file.kind===7));
  for(const file of [...plan.lazyGames.flatMap(game=>game.files),...plan.lazyPatches])if(file.sdPath){assert(file.sdPath.startsWith(sd+'/'));assert(!file.sdPath.includes('\\'));}
  if(nativePreparation){assert.equal(reads.length,1);assert.equal(closed,1);assert.equal(outputs.size,1);}
  else{
   assert.equal(reads.length,6);assert.equal(outputs.size,6);assert([...outputs.keys()].every(file=>file.startsWith(dir+'\\')));
   await collection.reader.close();assert.equal(closed,1);
  }
  assert.equal(handles.size,0);
 }
 console.log('Windows SD integration: native and prepared paths, PC inventory/cache destinations, standalone text, binary preference, resident SD names and session closure: passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
