#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const blitbun=require('../integrations/blitbun/prepare.cjs');
const prebuilt=require('../integrations/izlauncher-shell/prepare.cjs');
const vacootube=require('../integrations/vacootube/prepare.cjs');
const REVISION='d7a0df16e7e0c68acf78d2f68da8496ef3d9fd6b';
const MANIFEST_SHA256='bafbf27e48dc9879263977d910fc58fffdb275a95f81f752547f603a3ab0cca0';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(value,message)=>{if(!value)throw Error(message);};
function files(folder,prefix='') {
  const result=[];
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
    const relative=prefix+entry.name;
    check(!entry.isSymbolicLink(),'IZlauncher forbids links: '+relative);
    if(entry.isDirectory())result.push(...files(path.join(folder,entry.name),relative+'/'));
    else {check(entry.isFile(),'IZlauncher requires regular files: '+relative);result.push(relative);}
  }
  return result.sort();
}
function sourceFiles(root) {
  const source=path.join(root,'vendor/IZ2S-Platform');
  const manifest=fs.readFileSync(path.join(root,'packaging/IZ2S-Platform-SHA256SUMS'));
  check(hash(manifest)===MANIFEST_SHA256,'Changed IZlauncher source inventory.');
  const inventory=new Map();
  for(const line of manifest.toString('utf8').trim().split('\n')) {
    const match=/^([a-f0-9]{64})  (.+)$/.exec(line);
    check(match&&!path.isAbsolute(match[2])&&!/[\\\x00-\x1f]/.test(match[2])&&
      !match[2].split('/').some(part=>!part||part==='.'||part==='..')&&!inventory.has(match[2]),'Invalid IZlauncher source inventory.');
    inventory.set(match[2],match[1]);
  }
  check(JSON.stringify(files(source))===JSON.stringify([...inventory.keys()].sort()),'Unexpected or missing IZlauncher source file.');
  const contents=new Map();
  for(const [name,digest] of inventory) {
    const bytes=fs.readFileSync(path.join(source,name));
    check(hash(bytes)===digest,'Changed IZlauncher source: '+name);contents.set(name,bytes);
  }
  return contents;
}
function overlay(contents) {
  const out=new Map(contents);
  for(const name of ['shells/izlauncher/shell.json','modules/iz-exchange/module.json']) {
    const value=JSON.parse(out.get(name));
    check(JSON.stringify(value.platforms)==='["linux-x64","linux-arm64"]','Unexpected IZlauncher platform list.');
    value.platforms=['darwin-arm64'];out.set(name,Buffer.from(JSON.stringify(value,null,2)+'\n'));
  }
  const name='shells/izlauncher/server/hero-text.py';
  const before="font='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'",text=out.get(name).toString();
  check(text.split(before).length===2,'Unexpected IZlauncher font selection.');
  out.set(name,Buffer.from(text.replace(before,"font=os.environ['HB_FONT']")));
  const menu='shells/izlauncher/app/shaders/app-menu.glsl';
  const menuText=out.get(menu).toString();
  const doomLabel='83u,84u,65u,82u,84u,32u,68u,79u,79u,77u';
  check(menuText.split(doomLabel).length===2,'Unexpected IZlauncher stream menu label.');
  out.set(menu,Buffer.from(menuText.replace(doomLabel,
    '70u,82u,69u,69u,68u,79u,79u,77u,32u,32u')));
  const composition='shells/izlauncher/server/composition.cjs';
  const original=out.get(composition).toString();
  const target="  if (\n    await fs.access(path.join(folder, 'ready.json'))";
  check(original.split(target).length===2,'Unexpected IZlauncher shader composition.');
  out.set(composition,Buffer.from(original.replace(target,
    "  const prebuilt=path.join(__dirname,'../prebuilt',id);\n"+
    "  const frozen=await fs.readFile(path.join(prebuilt,'ready.json'),'utf8').then(JSON.parse,()=>null);\n"+
    "  if(frozen?.id===id)return catalog.readApp(prebuilt);\n"+
    target)));
  return out;
}
function location(root){return path.join(root,'homebrew/IZ2S-Platform');}
function privateWrite(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});}
function customModuleFiles(directory,archive){
  const result=new Set(),parent=path.join(directory,'modules');
  for(const entry of fs.readdirSync(parent,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    if(['iz-exchange','blitbun','VacooTube'].includes(entry.name))continue;
    check(!entry.isSymbolicLink()&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(entry.name),
      'Invalid custom IZlauncher module directory.');
    const id=entry.name,folder=path.join(parent,id),name=id+'.izm',file=path.join(folder,name);
    const stat=fs.lstatSync(file);
    check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=archive.MAX_ARCHIVE,
      'Invalid custom IZlauncher module archive.');
    const bytes=fs.readFileSync(file),pkg=archive.inspect(bytes),descriptor=pkg.descriptor;
    check(descriptor.id===id&&descriptor.switch&&descriptor.platforms.includes('darwin-arm64')&&
      (!descriptor.requires?.consoleAbi||descriptor.requires.consoleAbi===1)&&
      (descriptor.requires?.shell===undefined||[].concat(descriptor.requires.shell).includes('izlauncher')),
      'Incompatible custom IZlauncher module: '+id);
    result.add('modules/'+id+'/'+name);
    const version=path.join(folder,'.versions',pkg.sha256);
    if(fs.existsSync(version))for(const item of pkg.files){
      const target=path.join(version,item.name),saved=fs.lstatSync(target);
      check(saved.isFile()&&!saved.isSymbolicLink()&&fs.readFileSync(target).equals(item.bytes),
        'Changed custom IZlauncher module version: '+id+'/'+item.name);
      result.add('modules/'+id+'/.versions/'+pkg.sha256+'/'+item.name);
    }
  }
  return result;
}
async function prepare(root=path.resolve(__dirname,'..')) {
  const source=sourceFiles(root),expected=overlay(source),directory=location(root);
  check(!fs.existsSync(directory),'IZlauncher preparation requires a fresh destination.');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(const [name,bytes] of expected)privateWrite(path.join(directory,name),bytes);
  const archive=require(path.join(directory,'core/archive.cjs'));
  const moduleRoot=path.join(directory,'modules/iz-exchange'),bytes=await archive.pack(moduleRoot),pkg=archive.inspect(bytes);
  privateWrite(path.join(moduleRoot,'iz-exchange.izm'),bytes);
  await archive.unpack(bytes,path.join(moduleRoot,'.versions',pkg.sha256));
  for(const name of pkg.descriptor.switch.files)
    privateWrite(path.join(directory,'data/app-links/iz-exchange',name.slice(7)),expected.get('modules/iz-exchange/'+name));
  const blitbunInfo=blitbun.prepare(root,directory,archive,privateWrite);
  const vacootubeInfo=await vacootube.prepare(root,directory,archive,privateWrite);
  const prebuiltIds=prebuilt.prepare(root,directory,privateWrite);
  const modified=[...expected].filter(([name,bytes])=>!bytes.equals(source.get(name))).map(([name,bytes])=>({path:name,sha256:hash(bytes)}));
  privateWrite(path.join(directory,'mac2jb-runtime.json'),JSON.stringify({version:1,revision:REVISION,
    scope:'IZlauncher base shell, File Exchange, BlitBun browser capture and bundled Freedoom, and VacooTube Mac player',
    modules:require('./izlauncher-modules.cjs').DEFAULT_IDS,modified,moduleSha256:pkg.sha256,
    blitbunSha256:blitbunInfo.sha256,vacootubeSha256:vacootubeInfo.sha256,
    prebuiltShells:prebuiltIds},null,2)+'\n');
  return verify(root);
}
function verify(root=path.resolve(__dirname,'..')) {
  const expected=overlay(sourceFiles(root)),directory=location(root);
  check(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink(),'Invalid IZlauncher runtime directory.');
  for(const [name,bytes] of expected) {
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    check(stat.isFile()&&!stat.isSymbolicLink()&&fs.readFileSync(file).equals(bytes),'Changed IZlauncher runtime file: '+name);
  }
  const archive=require(path.join(directory,'core/archive.cjs'));
  const archiveBytes=fs.readFileSync(path.join(directory,'modules/iz-exchange/iz-exchange.izm')),pkg=archive.inspect(archiveBytes);
  check(pkg.descriptor.id==='iz-exchange'&&JSON.stringify(pkg.descriptor.platforms)==='["darwin-arm64"]','Unexpected IZlauncher module.');
  const archiveNames=new Set();
  for(const file of pkg.files) {
    archiveNames.add(file.name);
    if(file.name!=='checksums.json')check(expected.get('modules/iz-exchange/'+file.name)?.equals(file.bytes),'Changed File Exchange package source: '+file.name);
    const version=path.join(directory,'modules/iz-exchange/.versions',pkg.sha256,file.name),stat=fs.lstatSync(version);
    check(stat.isFile()&&!stat.isSymbolicLink()&&fs.readFileSync(version).equals(file.bytes),'Changed File Exchange prepared version: '+file.name);
  }
  for(const name of expected.keys())if(name.startsWith('modules/iz-exchange/')&&!name.split('/').some(part=>part.startsWith('.')))
    check(archiveNames.has(name.slice('modules/iz-exchange/'.length)),'File Exchange package omitted source: '+name);
  const blitbunInfo=blitbun.verify(root,directory,archive);
  const vacootubeInfo=vacootube.verifySync(root,directory,archive);
  const prebuiltInfo=prebuilt.verify(root,directory);
  const customFiles=customModuleFiles(directory,archive);
  const allowed=new Set([...expected.keys(),'mac2jb-runtime.json','modules/iz-exchange/iz-exchange.izm',
    ...pkg.files.map(file=>'modules/iz-exchange/.versions/'+pkg.sha256+'/'+file.name),
    ...pkg.descriptor.switch.files.map(name=>'data/app-links/iz-exchange/'+name.slice(7)),...blitbunInfo.allowed,
    ...vacootubeInfo.allowed,...prebuiltInfo.allowed,...customFiles]);
  const mutableModules=new Set(['VacooTube',...[...customFiles].map(name=>name.split('/')[1])]);
  for(const name of files(directory)) {
    if(name.startsWith('data/')&&!name.startsWith('data/app-links/'))continue;
    if(name.startsWith('modules/')&&name.split('/')[2]==='data'&&mutableModules.has(name.split('/')[1]))continue;
    check(allowed.has(name),'Unexpected IZlauncher runtime file: '+name);
  }
  for(const name of pkg.descriptor.switch.files) {
    const file=path.join(directory,'data/app-links/iz-exchange',name.slice(7));
    check(fs.readFileSync(file).equals(expected.get('modules/iz-exchange/'+name)),'Changed File Exchange catalog: '+name);
  }
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,'mac2jb-runtime.json')));
  check(metadata.version===1&&metadata.revision===REVISION&&metadata.moduleSha256===pkg.sha256&&
    metadata.blitbunSha256===blitbunInfo.sha256&&
    metadata.vacootubeSha256===vacootubeInfo.sha256&&
    JSON.stringify(metadata.prebuiltShells)===JSON.stringify(prebuiltInfo.ids)&&
    JSON.stringify(metadata.modules)===JSON.stringify(require('./izlauncher-modules.cjs').DEFAULT_IDS),'Invalid IZlauncher runtime metadata.');
  return {directory,revision:REVISION,modules:metadata.modules,moduleSha256:pkg.sha256,packageBytes:archiveBytes.length,
    blitbunSha256:blitbunInfo.sha256,blitbunPackageBytes:blitbunInfo.packageBytes,
    vacootubeSha256:vacootubeInfo.sha256,vacootubePackageBytes:vacootubeInfo.packageBytes};
}
function runtimeEnvironment(root,inherited=process.env) {
  const info=verify(root),font=path.join(root,'homebrew/fonts/DejaVuSans.ttf');
  const env={...require('./gui-homebrew.cjs').runtimeEnvironment(root,inherited),
    IZ2S_ROOT:info.directory,IZ15_ROOT:info.directory,IZ15_SHELL:'izlauncher',
    HB_APPS_DIR:path.join(info.directory,'data/app-links'),HB_FONT:font,
    GLSLANG:path.join(root,'homebrew/bin/glslangValidator'),
    IZ2S_MODULE_PINS:JSON.stringify({version:1,root:info.directory,modules:{
      'iz-exchange':{sha256:info.moduleSha256,packageBytes:info.packageBytes},
      blitbun:{sha256:info.blitbunSha256,packageBytes:info.blitbunPackageBytes},
      vacootube:{sha256:info.vacootubeSha256,packageBytes:info.vacootubePackageBytes}}})};
  return env;
}
async function main(args=process.argv.slice(2)) {
  const root=path.resolve(args[1]||path.join(__dirname,'..'));
  if(args[0]==='--check-source'&&args.length<=2){
    sourceFiles(root);
    console.log('Pinned IZlauncher sources verified.');return;
  }
  if(args[0]==='--prepare'&&args.length<=2){await prepare(root);console.log('Offline IZlauncher base runtime prepared.');return;}
  if(args[0]==='--check'&&args.length<=2){verify(root);console.log('Offline IZlauncher base runtime verified.');return;}
  throw Error('Usage: prepare-izlauncher.cjs --check-source|--prepare|--check [ROOT]');
}
module.exports={prepare,verify,runtimeEnvironment,sourceFiles,overlay,location,REVISION,MANIFEST_SHA256};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
