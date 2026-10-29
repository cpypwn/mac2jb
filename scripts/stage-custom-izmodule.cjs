#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const check=(value,message)=>{if(!value)throw Error(message);};

async function stage(root,folder,options={}) {
  check(typeof folder==='string'&&path.isAbsolute(folder)&&folder.length<=4096&&!/[\x00\r\n]/.test(folder),
    'Choose a local IZlauncher module folder.');
  const source=path.resolve(folder),sourceInfo=await fs.lstat(source);
  check(sourceInfo.isDirectory()&&!sourceInfo.isSymbolicLink(),
    'Choose a module folder containing module.json and checksums.json.');
  const verify=options.verify||require('./prepare-izlauncher.cjs').verify;
  const runtime=verify(root).directory;
  const archive=options.archive||require(path.join(runtime,'core/archive.cjs'));
  const manifest=await fs.lstat(path.join(source,'module.json'));
  const checksums=await fs.lstat(path.join(source,'checksums.json'));
  check(manifest.isFile()&&!manifest.isSymbolicLink()&&checksums.isFile()&&!checksums.isSymbolicLink(),
    'Choose a module folder containing regular module.json and checksums.json files.');
  check(checksums.size<=1024*1024,'The module checksum manifest is too large.');
  const bytes=await archive.pack(source),pkg=archive.inspect(bytes),descriptor=pkg.descriptor;
  const supplied=JSON.parse(await fs.readFile(path.join(source,'checksums.json'),'utf8'));
  const generated=JSON.parse(pkg.files.find(file=>file.name==='checksums.json').bytes);
  check(supplied.algorithm==='sha256'&&supplied.files&&typeof supplied.files==='object'&&
    !Array.isArray(supplied.files)&&JSON.stringify(Object.entries(supplied.files).sort())===
    JSON.stringify(Object.entries(generated.files).sort()),
    'The module folder does not match checksums.json.');
  check(descriptor.switch&&descriptor.platforms.includes('darwin-arm64')&&
    (!descriptor.requires?.consoleAbi||descriptor.requires.consoleAbi===1)&&
    (descriptor.requires?.shell===undefined||[].concat(descriptor.requires.shell).includes('izlauncher')),
    'The module is not compatible with this Mac IZlauncher and console ABI.');
  const id=descriptor.id,target=path.join(runtime,'modules',id);
  check(!['iz-exchange','blitbun','VacooTube'].includes(id), 'The module uses a bundled app id.');
  const targetInfo=await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  check(!targetInfo,'A module with this id is already installed in the current session.');
  const parent=path.join(root,'runs');await fs.mkdir(parent,{recursive:true,mode:0o700});
  const parentInfo=await fs.lstat(parent);
  check(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink()&&parentInfo.uid===process.getuid()&&
    (parentInfo.mode&0o077)===0,'Expected a private session staging folder.');
  const temporary=await fs.mkdtemp(path.join(await fs.realpath(parent),'izmodule-stage-'));
  let installed=false;
  try {
    await fs.writeFile(path.join(temporary,id+'.izm'),bytes,{mode:0o600,flag:'wx'});
    await fs.rename(temporary,target);installed=true;
    verify(root);
    return {id,name:descriptor.name,version:descriptor.version,sha256:pkg.sha256,directory:target,
      cleanup:()=>fs.rm(target,{recursive:true,force:true})};
  } catch(error) {
    if(installed)await fs.rm(target,{recursive:true,force:true}).catch(()=>{});
    throw error;
  } finally {
    if(!installed)await fs.rm(temporary,{recursive:true,force:true}).catch(()=>{});
  }
}
module.exports={stage};
