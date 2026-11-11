'use strict';
const fs=require('node:fs');
const {check,hashFile}=require('./common.cjs'),{readRomfs}=require('./game-files/mounts.cjs'),{sdPath}=require('./sources.cjs');
async function verifyPlan(plan,file){
 check(plan.schema===5&&fs.statSync(file).size===plan.payload.size&&await hashFile(file)===plan.payload.sha256,'Prepared metadata integrity failed');
 const sources=new Map();for(const row of plan.sources){sdPath(row.sdPath);check(!sources.has(row.sdPath)&&Number.isSafeInteger(row.size)&&row.size>=0,'Invalid or duplicate SD source');sources.set(row.sdPath,row);}
 const bytes=fs.readFileSync(file);let romfs=0,exefs=0;
 const extent=(offset,size,limit)=>check(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(size)&&size>=0&&offset+size<=limit,'Invalid prepared extent');
 for(const v of plan.views){
  let end=0;for(const s of v.segments){check(s.offset>=end&&s.length>0,'Overlapping virtual segments');extent(s.offset,s.length,v.virtualSize);extent(s.sourceOffset,s.length,s.original?v.storageSize:s.sourcePath?sources.get(s.sourcePath)?.size:bytes.length);end=s.offset+s.length;}
  const read=async(at,n)=>{const out=Buffer.alloc(n);let covered=0;for(const s of v.segments){const lo=Math.max(at,s.offset),hi=Math.min(at+n,s.offset+s.length);if(hi>lo){check(!s.sourcePath,'Metadata unexpectedly reads a mod body');if(s.original){const m=v.originalMetadata;check(m,'Missing original metadata reference');require('./romfs.cjs').captured(m.directory,m,s.sourceOffset+lo-s.offset,hi-lo).copy(out,lo-at);}else bytes.copy(out,lo-at,s.sourceOffset+lo-s.offset,s.sourceOffset+hi-s.offset);covered+=hi-lo;}}check(covered===n,'Rebuilt metadata is incomplete');return out;};
  const entries=v.metadataPassthrough?null:await readRomfs(read,v.virtualSize);
  for(const r of v.resources){
   extent(r.sourceOffset,r.modifiedSize,sources.get(r.sourcePath)?.size);extent(r.overlayOffset,r.modifiedSize,v.virtualSize);
   if(entries){const e=entries.find(e=>e.type==='file'&&e.path===r.path);check(e&&e.size===r.modifiedSize&&e.offset===r.overlayOffset,'Rebuilt RomFS record mismatch: '+r.path);}
   else{
    extent(r.recordOffset,32,v.storageSize);const entry=await read(r.recordOffset+8,16),dataOffset=Number(Buffer.from(v.headerHex,'hex').readBigUInt64LE(72));check(entry.readBigUInt64LE()===BigInt(r.overlayOffset-dataOffset)&&entry.readBigUInt64LE(8)===BigInt(r.modifiedSize),'Replacement RomFS record differs');
   }
   if(r.modifiedSize){const s=v.segments.find(s=>s.offset===r.overlayOffset);check(s&&s.length===r.modifiedSize&&s.sourcePath===r.sourcePath&&s.sourceOffset===r.sourceOffset,'RomFS mod source differs');}romfs++;
  }
 }
 for(const group of plan.namespaces){
  const entries=plan.exefs.filter(e=>e.titleId===group.titleId),names=new Set();check(entries.some(e=>e.name==='main')&&entries.some(e=>e.name==='main.npdm'),'Incomplete CodeFS namespace');
  for(const e of entries){
   check(!names.has(e.name.toLowerCase())&&!/[\\/\x00]/.test(e.name)&&!['.','..'].includes(e.name),'Invalid CodeFS name');names.add(e.name.toLowerCase());const r=e.replacement;
   if(e.modified){
    const source=r.sourcePath?sources.get(r.sourcePath):null;check(source||r.segments,'Modified CodeFS file has no source');
    if(r.segments){let end=0;for(const s of r.segments){check(s.offset===end&&s.length>0,'Incomplete IPS virtual file');extent(s.sourceOffset,s.length,s.inline?bytes.length:(source?.size??r.sourceSize)-r.sourceOffset);end=s.offset+s.length;}check(end===r.size,'IPS virtual size differs');}
    else extent(r.sourceOffset,r.size,source.size);
   }
   exefs++;
  }
  for(const name of group.removed||[])check(!names.has(name.toLowerCase()),'CodeFS stub conflicts with a file');
 }
 return{romfsResources:romfs,exefsModules:exefs,metadataBytes:bytes.length,directSdSources:sources.size,verified:true};
}
module.exports={verifyPlan};
