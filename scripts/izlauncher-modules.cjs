'use strict';
const path=require('node:path');
const MAX_MODULES=15;
const MAX_CATALOG=64;
const DEFAULT_IDS=Object.freeze(['iz-exchange','blitbun','vacootube']);
const validIds=ids=>Array.isArray(ids)&&ids.length<=MAX_MODULES&&
  ids.every(id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))&&new Set(ids).size===ids.length;
async function catalog(root,options={}){
  const runtime=(options.verify||require('./prepare-izlauncher.cjs').verify)(root).directory;
  const repo=await (options.repository||require(path.join(runtime,'core/packages/repository.cjs')).create)(runtime);
  const list=await repo.list();
  return list.packages.filter(item=>item.supported!==false).slice(0,MAX_CATALOG)
    .map(item=>({id:item.id,name:item.name,version:item.version,
      description:item.description||''}));
}
async function validate(root,ids,options={}){
  if(!validIds(ids))throw Error('Choose up to 15 distinct compatible IZlauncher modules.');
  const available=await catalog(root,options),known=new Set(available.map(item=>item.id));
  if(ids.some(id=>!known.has(id)))throw Error('The selected IZlauncher module is unavailable on this Mac.');
  return ids;
}
function withDefaults(ids){
  if(!validIds(ids))throw Error('Choose up to 15 distinct compatible IZlauncher modules.');
  const selected=[...new Set([...DEFAULT_IDS,...ids])];
  if(!validIds(selected))throw Error('Choose no more than 15 IZlauncher modules, including the defaults.');
  return selected;
}
async function queue(root,stateRoot,ids,options={}){
  if(!validIds(ids)||!ids.length)throw Error('Select at least one compatible IZlauncher module.');
  const runtime=(options.verify||require('./prepare-izlauncher.cjs').verify)(root).directory;
  const repo=await (options.repository||require(path.join(runtime,'core/packages/repository.cjs')).create)(runtime);
  const list=await repo.list(),available=new Map(list.packages.filter(item=>item.supported!==false).map(item=>[item.id,item]));
  for(const id of ids){const item=available.get(id);if(!item)throw Error('The selected IZlauncher module is unavailable on this Mac.');}
  const jobs=options.jobs||require(path.join(runtime,'core/packages/jobs.cjs'));
  for(const id of ids)await jobs.create(stateRoot,available.get(id),'mac2jb');
  return ids;
}
module.exports={MAX_MODULES,DEFAULT_IDS,validIds,catalog,validate,withDefaults,queue};
