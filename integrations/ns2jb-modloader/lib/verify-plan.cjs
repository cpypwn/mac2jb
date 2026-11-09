'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {check,hashFile}=require('./common.cjs'),{readRomfs}=require('./game-files/mounts.cjs');
async function verifyPlan(plan,file){
 check(fs.statSync(file).size===plan.payload.size&&await hashFile(file)===plan.payload.sha256,'Prepared pack integrity failed');
 const fd=fs.openSync(file,'r');let romfs=0,exefs=0;
 function source(at,n){const out=Buffer.alloc(n);check(fs.readSync(fd,out,0,n,at)===n,'Short local pack read');return out;}
 try{
  for(const v of plan.views){
   const read=async(at,n)=>{const out=Buffer.alloc(n);let covered=0;for(const s of v.segments){const lo=Math.max(at,s.offset),hi=Math.min(at+n,s.offset+s.length);if(hi>lo){source(s.sourceOffset+lo-s.offset,hi-lo).copy(out,lo-at);covered+=hi-lo;}}check(covered===n,'Rebuilt metadata/resource is not fully backed by the mod pack');return out;};
   const entries=await readRomfs(read,v.virtualSize);
   for(const r of v.resources){const e=entries.find(e=>e.type==='file'&&e.path===r.path);check(e&&e.size===r.modifiedSize&&e.offset===r.overlayOffset,'Rebuilt RomFS record mismatch: '+r.path);const hash=crypto.createHash('sha256');for(let at=0;at<e.size;at+=0x40000)hash.update(await read(e.offset+at,Math.min(0x40000,e.size-at)));check(hash.digest('hex')===r.modifiedSha256,'Prepared resource hash mismatch: '+r.path);romfs++;}
  }
  for(const e of plan.exefs){const r=e.replacement;check([r.size,r.sourceOffset].every(Number.isSafeInteger)&&r.size>=0&&r.sourceOffset>=0&&r.sourceOffset+r.size<=plan.payload.size,'Invalid ExeFS payload extent');const hash=crypto.createHash('sha256');for(let at=0;at<r.size;at+=0x40000)hash.update(source(r.sourceOffset+at,Math.min(0x40000,r.size-at)));check(hash.digest('hex')===r.sha256,'Prepared ExeFS hash mismatch: '+e.name);exefs++;}
  if(plan.exefs.length){
   check(plan.namespaces?.length,'ExeFS entries have no namespace');
   for(const group of plan.namespaces){const entries=plan.exefs.filter(e=>e.titleId===group.titleId);check(entries.some(e=>e.name==='main')&&entries.some(e=>e.name==='main.npdm'),'Incomplete CodeFS mirror');const names=new Set();for(const e of entries){check(!names.has(e.name.toLowerCase())&&e.sdPath===group.prefix+'/'+e.name,'Conflicting or incorrectly scoped CodeFS mirror file');names.add(e.name.toLowerCase());}}
   check(plan.exefs.every(e=>plan.namespaces.some(g=>g.titleId===e.titleId)),'ExeFS entry has no matching namespace');
  }
  return{romfsResources:romfs,exefsModules:exefs,verified:true};
 }finally{fs.closeSync(fd);}
}
module.exports={verifyPlan};
