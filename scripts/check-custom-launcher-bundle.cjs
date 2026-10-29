#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

async function main(folder=process.argv[2],root=path.resolve(__dirname,'..')) {
  if(!folder)throw Error('Usage: check-custom-launcher-bundle.cjs FOLDER');
  const source=await fs.realpath(folder);
  const manifest=JSON.parse(await fs.readFile(path.join(source,'mac2jb-launcher.json'),'utf8'));
  if(manifest.format!=='mac2jb.held-rpc-launcher'||manifest.version!==1||
    manifest.profile!=='souljalauncher-2')throw Error('Unexpected launcher manifest');
  const files=manifest.files;
  if(!files||typeof files!=='object'||Array.isArray(files))throw Error('Invalid launcher file inventory');
  const names=Object.keys(files);
  for(const name of names) {
    if(name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'))
      throw Error('Unsafe launcher file: '+name);
    const file=path.join(source,name),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid launcher file: '+name);
    const bytes=await fs.readFile(file);
    if(crypto.createHash('sha256').update(bytes).digest('hex')!==files[name])
      throw Error('Changed launcher file: '+name);
    if(name.endsWith('.cjs')) {
      await run(process.execPath,['--check',file],{timeout:10000,maxBuffer:65536});
      const script=bytes.toString('utf8');
      const imports=[...script.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)];
      for(const [,relative] of imports) {
        const required=path.relative(source,path.resolve(path.dirname(file),relative)).split(path.sep).join('/');
        if(required==='smilebasic/engine/connection.json'&&
          name==='smilebasic/engine/shared/rpc.cjs')continue;
        if(!Object.hasOwn(files,required))throw Error(name+' requires missing '+required);
      }
    }
  }
  const actual=[];
  async function walk(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile()&&file!==path.join(source,'mac2jb-launcher.json'))
        actual.push(path.relative(source,file).split(path.sep).join('/'));
      else if(!entry.isFile())throw Error('Unexpected launcher entry: '+file);
    }
  }
  await walk(source);
  if(actual.length!==names.length||actual.some(name=>!Object.hasOwn(files,name)))
    throw Error('Launcher file inventory does not match the folder');
  const {preflightCustomHomebrew}=require('./gui-homebrew.cjs');
  const prepared=await preflightCustomHomebrew(root,source);
  try {
    if(prepared.kind!=='launcher')throw Error('Launcher was not selected as a launcher');
  }finally{await prepared.cleanup();}
  console.log('SouljaLauncher 2: '+names.length+' verified runtime files, import closure, syntax, shaders and app catalog passed; no console commands sent.');
}
module.exports={main};
if(require.main===module)main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
