'use strict';
const {check,align}=require('./common.cjs'),{validateProgramId}=require('./codefs-identity.cjs'),{sdPath}=require('./sources.cjs');
const HEADER=368,VIEW=288,SEGMENT=32,CODE_HEADER=112,CODE_ENTRY=424,FILE_ENTRY=112,SOURCE_ENTRY=48;
function groupFiles(plan,group){return[...plan.exefs.filter(e=>e.titleId===group.titleId).map(e=>({name:e.name,...e.replacement,flags:e.modified?(e.replacement.segments?5:1):0})),...(group.removed||[]).map(name=>({name,size:0,flags:2}))];}
function strings(plan){return[...new Set([...plan.views.flatMap(v=>v.segments.map(s=>s.sourcePath).filter(Boolean)),...(plan.namespaces||[]).flatMap(g=>groupFiles(plan,g).flatMap(e=>[e.name,e.sourcePath].filter(Boolean)))])];}
function layout(plan){
 if(plan.lazy)return require('./lazy-context.cjs').layout(plan);
 const viewStatsOffset=HEADER+plan.views.length*VIEW+plan.views.reduce((n,v)=>n+v.segments.length*SEGMENT,0),sourceStatsOffset=viewStatsOffset+plan.views.length*SOURCE_ENTRY;
 const romfs=align(sourceStatsOffset+plan.sources.length*SOURCE_ENTRY,16);
 check(!plan.exefs.length||plan.namespaces?.length,'ExeFS requires a title-qualified namespace');
 const exefs=plan.namespaces?.length?align(CODE_HEADER+plan.namespaces.length*CODE_ENTRY+plan.namespaces.reduce((n,g)=>n+groupFiles(plan,g).reduce((sum,e)=>sum+FILE_ENTRY+(e.segments?.length||0)*SEGMENT,0),0),16):0;
 const stringsOffset=romfs+exefs;
 const inlineOffset=align(stringsOffset+strings(plan).reduce((n,s)=>n+Buffer.byteLength(s)+1,0),16);
 const logOffset=align(inlineOffset+plan.payload.size,16);
 return{romfs,exefs,stringsOffset,inlineOffset,viewStatsOffset,sourceStatsOffset,logOffset,bytes:align(logOffset+(plan.diagnostics?.size||0),4096)};
}
function buildContext(plan,source,base,address,native,active=0,payload){
 if(plan.lazy)return require('./lazy-context.cjs').buildContext(plan,source,base,address,native,active);
 base=BigInt(base);address=BigInt(address);const l=layout(plan),b=Buffer.alloc(l.bytes),u64=(n,at)=>b.writeBigUInt64LE(BigInt(n),at),pool=new Map(),sources=new Map(plan.sources.map(s=>[s.sdPath,s]));
 let stringAt=l.stringsOffset;
 for(const text of strings(plan)){pool.set(text,address+BigInt(stringAt));b.write(text,stringAt);stringAt+=Buffer.byteLength(text)+1;}
 check(Buffer.isBuffer(payload)&&payload.length===plan.payload.size,'Resident metadata payload is incomplete');payload.copy(b,l.inlineOffset);
 const diagnostic=source.logFile?plan.diagnostics:null;
 if(diagnostic){
  const log=Buffer.from(diagnostic.text);check(log.length===diagnostic.size&&log.length<=1024*1024,'Invalid runtime report size');
  for(const [at,length]of [[diagnostic.unmatchedOffset,72],[diagnostic.readyOffset,1],[diagnostic.errorOffset,0x309]])check(Number.isSafeInteger(at)&&at>=0&&at+length<=log.length,'Invalid report field');
  log.copy(b,l.logOffset);u64(source.logFile.object,160);u64(source.logFile.write,168);u64(source.logFile.flush,176);u64(address+BigInt(l.logOffset),184);u64(log.length,192);u64(diagnostic.unmatchedOffset,248);u64(address+BigInt(l.logOffset+diagnostic.readyOffset),272);u64(address+BigInt(l.logOffset+diagnostic.errorOffset),280);
 }
 u64(plan.sources.length,216);u64(address+BigInt(l.sourceStatsOffset),224);u64(address+BigInt(l.viewStatsOffset),264);
 for(const [i,s]of plan.sources.entries()){const at=l.sourceStatsOffset+i*SOURCE_ENTRY;u64(pool.get(s.sdPath),at);if(diagnostic?.sourceOffsets[s.sdPath])u64(address+BigInt(l.logOffset+diagnostic.sourceOffsets[s.sdPath]),at+40);}
 for(const [i,v]of plan.views.entries())if(diagnostic?.viewOffsets[v.titleId])u64(address+BigInt(l.logOffset+diagnostic.viewOffsets[v.titleId]),l.viewStatsOffset+i*SOURCE_ENTRY+40);
 const sourcePointers=new Map(plan.sources.map((s,i)=>[s.sdPath,address+BigInt(l.sourceStatsOffset+i*SOURCE_ENTRY)]));
 const sourcePointer=name=>{check(sourcePointers.has(name),'Missing direct SD source');return sourcePointers.get(name);};
 b.write('NS2LFS02');b.writeUInt32LE(active,8);b.writeUInt32LE(plan.views.length,12);u64(address+BigInt(l.inlineOffset),32);u64(source.filesystem.object,40);u64(base+BigInt(native.sdk.original.fileRead),48);u64(plan.payload.size,72);
 for(const [i,name]of ['fileRead','fileSize','fileRelease','filesystemRelease','storageRelease','directoryRead','directoryCount','directoryRelease'].entries())u64(base+BigInt(native.sdk.original[name]),304+i*8);
 if(l.exefs)u64(address+BigInt(l.romfs),56);
 u64(base+0x694c0n,104);u64(base+0x1077b0n,112);u64(base+BigInt(native.originalSize),120);u64(base+BigInt(native.namespace.original.open),128);u64(base+0x69580n,136);
 let next=HEADER+VIEW*plan.views.length;const seen=new Set();
 for(let i=0;i<plan.views.length;i++){
  const v=plan.views[i],at=HEADER+i*VIEW,identity=[v.storageSize,v.headerHex,v.fingerprintFileEntryOffset,v.originalFileEntryHex,v.fingerprintDataOffset,v.originalPrefixHex,v.fingerprintLength].join(':');
  check(!seen.has(identity),'Two contents have indistinguishable storage fingerprints: '+v.titleId);seen.add(identity);
  u64(v.storageSize,at);u64(v.virtualSize,at+8);u64(v.fingerprintFileEntryOffset,at+16);u64(v.fingerprintDataOffset,at+24);
  for(const [hex,p,n]of [[v.headerHex,at+32,80],[v.originalFileEntryHex,at+112,32],[v.originalPrefixHex,at+144,128]]){check(typeof hex==='string'&&hex.length===n*2&&/^[0-9a-f]+$/.test(hex),'Invalid storage fingerprint');Buffer.from(hex,'hex').copy(b,p);}
  check(v.fingerprintLength>0&&v.fingerprintLength<=128&&v.fingerprintDataOffset+v.fingerprintLength<=v.storageSize,'Invalid storage identity extent');
  b.writeUInt32LE(v.segments.length,at+272);b.writeUInt32LE(v.fingerprintLength,at+276);u64(address+BigInt(next),at+280);let end=0;
  for(const s of v.segments){
   const sourceSize=s.original?v.storageSize:s.sourcePath?sources.get(sdPath(s.sourcePath))?.size:plan.payload.size;
   check([s.offset,s.length,s.sourceOffset].every(Number.isSafeInteger)&&s.offset>=end&&s.length>0&&s.offset+s.length<=v.virtualSize&&s.sourceOffset>=0&&s.sourceOffset+s.length<=sourceSize,'Invalid virtual segment');
   u64(s.offset,next);u64(s.length,next+8);u64(s.sourceOffset,next+16);if(s.original)u64(2,next+24);else if(s.sourcePath)u64(sourcePointer(s.sourcePath),next+24);next+=SEGMENT;end=s.offset+s.length;
  }
 }
 if(l.exefs){
  const c=l.romfs;b.writeUInt32LE(active,c);b.writeUInt32LE(0x34465343,c+4);
  for(const [key,at]of [['open',8],['directory',16],['type',24]])u64(base+BigInt(native.namespace.original[key]),c+at);
  u64(BigInt(source.filesystem.object)+8n,c+32);u64(base+BigInt(native.sdk.original.fileRead),c+40);u64(base+BigInt(native.sdk.original.fileSize),c+48);u64(base+BigInt(native.sdk.original.fileRelease),c+56);u64(plan.namespaces.length,c+64);u64(address+BigInt(c+CODE_HEADER),c+72);
  let entriesAt=c+CODE_HEADER+CODE_ENTRY*plan.namespaces.length;const ids=new Set();
  plan.namespaces.forEach((g,i)=>{
   const p=c+CODE_HEADER+i*CODE_ENTRY,o=g.owner;check(!ids.has(g.titleId)&&o,'Duplicate or missing ExeFS title identity');ids.add(g.titleId);validateProgramId(g.titleId,g.source,o.programId);
   check(Number.isSafeInteger(o.mainSize)&&o.mainSize>=256&&Number.isSafeInteger(o.programOffset)&&o.programOffset>=128&&o.programOffset<=0x100000,'Invalid CodeFS owner extent');
   u64(o.programId,p);u64(o.mainSize,p+8);b.writeUInt32LE(o.programOffset,p+16);u64(address+BigInt(entriesAt),p+24);const files=groupFiles(plan,g);u64(files.length,p+32);
   for(const [hex,at,n]of [[o.npdmHeaderHex,p+40,128],[o.mainHeaderHex,p+168,256]]){check(typeof hex==='string'&&hex.length===n*2&&/^[0-9a-f]+$/.test(hex),'Invalid CodeFS fingerprint');Buffer.from(hex,'hex').copy(b,at);}
   const filesBase=entriesAt;let segmentsAt=filesBase+files.length*FILE_ENTRY;
   for(const [k,e]of files.entries()){
    const at=filesBase+k*FILE_ENTRY;
    check(e.name&&!/[\\/\x00]/.test(e.name)&&!['.','..'].includes(e.name)&&Buffer.byteLength(e.name)<=0x300,'Invalid CodeFS filename');
    u64(pool.get(e.name),at);u64(e.size,at+8);u64(e.flags,at+40);
    u64(pool.get(e.name),at+64);if(diagnostic?.moduleOffsets[g.titleId+'/'+e.name])u64(address+BigInt(l.logOffset+diagnostic.moduleOffsets[g.titleId+'/'+e.name]),at+104);
    if(e.flags&1){
     const source=e.sourcePath?sources.get(sdPath(e.sourcePath)):null,sourceSize=source?.size??e.sourceSize;check(source||e.segments,'Modified CodeFS file has no source');
     check(Number.isSafeInteger(e.sourceOffset)&&e.sourceOffset>=0&&Number.isSafeInteger(sourceSize)&&sourceSize>=0,'Invalid CodeFS source extent');
     if(source)u64(sourcePointer(e.sourcePath),at+16);u64(e.sourceOffset,at+24);u64(sourceSize,at+32);
     if(e.segments?.length){
      const segmentAt=segmentsAt;u64(address+BigInt(segmentAt),at+48);u64(e.segments.length,at+56);let end=0;
      for(const [j,s]of e.segments.entries()){
       check([s.offset,s.length,s.sourceOffset].every(Number.isSafeInteger)&&s.offset===end&&s.length>0&&s.sourceOffset>=0&&s.sourceOffset+s.length<=(s.inline?plan.payload.size:sourceSize-e.sourceOffset),'Invalid IPS virtual extent');const p=segmentAt+j*SEGMENT;
       u64(s.offset,p);u64(s.length,p+8);u64(s.inline?address+BigInt(l.inlineOffset+s.sourceOffset):s.sourceOffset,p+16);if(s.inline)u64(1,p+24);end=s.offset+s.length;
      }
      check(end===e.size,'IPS virtual file is incomplete');segmentsAt+=e.segments.length*SEGMENT;
     }else check(e.sourceOffset+e.size<=sourceSize,'CodeFS replacement exceeds its file');
    }
   }
   entriesAt=segmentsAt;
  });
 }
 return b;
}
module.exports={layout,buildContext,groupFiles,HEADER,VIEW,SEGMENT,CODE_HEADER,CODE_ENTRY,FILE_ENTRY};
