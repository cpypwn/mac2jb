'use strict';
const {check,align}=require('./common.cjs');
const {validateProgramId}=require('./codefs-identity.cjs');
const HEADER=128,VIEW=288,SEGMENT=32,CODE_HEADER=112,CODE_ENTRY=568;
function layout(plan){
 const romfs=align(HEADER+plan.views.length*VIEW+plan.views.reduce((n,v)=>n+v.segments.length*SEGMENT,0),16);
 check(!plan.exefs.length||plan.namespaces?.length,'ExeFS requires a title-qualified namespace');
 const exefs=plan.namespaces?.length?align(CODE_HEADER+plan.namespaces.length*CODE_ENTRY,16):0;
 return{romfs,exefs,bytes:align(romfs+exefs,4096)};
}
function buildContext(plan,source,base,address,native,active=0){
 const l=layout(plan),b=Buffer.alloc(l.bytes),u64=(n,at)=>b.writeBigUInt64LE(BigInt(n),at);
 b.write('NS2LFS01');b.writeUInt32LE(active,8);b.writeUInt32LE(plan.views.length,12);u64(source.fileObject.object,32);u64(source.filesystem.object,40);u64(base+0x104ef0n,48);u64(plan.payload.size,72);
 if(l.exefs)u64(address+BigInt(l.romfs),56);
 let next=HEADER+VIEW*plan.views.length;
 const seen=new Map();
 for(let i=0;i<plan.views.length;i++){
  const v=plan.views[i],at=HEADER+i*VIEW,identity=[v.storageSize,v.headerHex,v.fingerprintFileEntryOffset,v.originalFileEntryHex,v.fingerprintDataOffset,v.originalPrefixHex,v.fingerprintLength].join(':');
  check(!seen.has(identity),'Two selected contents have indistinguishable native storage fingerprints: '+v.titleId);seen.set(identity,true);
  u64(v.storageSize,at);u64(v.virtualSize,at+8);u64(v.fingerprintFileEntryOffset,at+16);u64(v.fingerprintDataOffset,at+24);
  for(const [hex,p,n]of [[v.headerHex,at+32,80],[v.originalFileEntryHex,at+112,32],[v.originalPrefixHex,at+144,128]]){check(typeof hex==='string'&&hex.length===n*2&&/^[0-9a-f]+$/.test(hex),'Invalid storage fingerprint');Buffer.from(hex,'hex').copy(b,p);}
  check(v.fingerprintLength>0&&v.fingerprintLength<=128&&v.fingerprintDataOffset+v.fingerprintLength<=v.storageSize,'Invalid storage identity extent');
  b.writeUInt32LE(v.segments.length,at+272);b.writeUInt32LE(v.fingerprintLength,at+276);u64(address+BigInt(next),at+280);let end=0;
  for(const s of v.segments){check([s.offset,s.length,s.sourceOffset].every(Number.isSafeInteger)&&s.offset>=end&&s.length>0&&s.offset+s.length<=v.virtualSize&&s.sourceOffset>=0&&s.sourceOffset+s.length<=plan.payload.size,'Invalid virtual segment');u64(s.offset,next);u64(s.length,next+8);u64(s.sourceOffset,next+16);next+=32;end=s.offset+s.length;}
 }
 if(l.exefs){
  const c=l.romfs;b.writeUInt32LE(active,c);b.writeUInt32LE(0x33465343,c+4);
  for(const [key,at] of [['open',8],['directory',16],['type',24]])u64(base+BigInt(native.namespace.original[key]),c+at);
  // The exported service object has an IFileSystemService subobject at +8.
  // Native namespace methods receive that subobject after their SDK thunk.
  u64(BigInt(source.filesystem.object)+8n,c+32);u64(base+0x104ef0n,c+40);u64(base+0x105480n,c+48);u64(base+0x104e10n,c+56);u64(plan.namespaces.length,c+64);u64(address+BigInt(c+CODE_HEADER),c+72);
  const ids=new Set();
  plan.namespaces.forEach((g,i)=>{
   const p=c+CODE_HEADER+i*CODE_ENTRY,o=g.owner;
   check(!ids.has(g.titleId)&&o,'Duplicate or missing ExeFS title identity');ids.add(g.titleId);
   validateProgramId(g.titleId,g.source,o.programId);
   check(Number.isSafeInteger(o.mainSize)&&o.mainSize>=256&&Number.isSafeInteger(o.programOffset)&&o.programOffset>=128&&o.programOffset<=0x100000,'Invalid CodeFS owner extent');
   check(/^\/ns2jb-modloader\/[0-9a-f]{64}\/[0-9a-f]{16}\/exefs$/.test(g.prefix)&&Buffer.byteLength(g.prefix)<160,'Invalid SD namespace prefix');
   u64(o.programId,p);u64(o.mainSize,p+8);b.writeUInt32LE(o.programOffset,p+16);b.write(g.prefix,p+24,159,'utf8');
   for(const [hex,at,n] of [[o.npdmHeaderHex,p+184,128],[o.mainHeaderHex,p+312,256]]){check(typeof hex==='string'&&hex.length===n*2&&/^[0-9a-f]+$/.test(hex),'Invalid CodeFS identity bytes');Buffer.from(hex,'hex').copy(b,at);}
  });
 }
 return b;
}
module.exports={layout,buildContext,HEADER,VIEW,SEGMENT,CODE_HEADER,CODE_ENTRY};
