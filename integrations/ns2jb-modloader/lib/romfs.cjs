'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,align,sha,romPath,hashFile}=require('./common.cjs');
const {readRomfs}=require('./game-files/mounts.cjs');
const NONE=0xffffffff;
function bucketCount(n){if(n<3)return 3;if(n<19)return n|1;while([2,3,5,7,11,13,17].some(d=>n%d===0))n++;return n;}
function nameHash(parent,name){let h=(parent^123456789)>>>0;for(const c of name)h=(((h>>>5)|(h<<27))^c)>>>0;return h;}
function records(table,fixed){const out=new Map();let at=0;while(at<table.length){check(at+fixed<=table.length,'Truncated RomFS record');const n=table.readUInt32LE(at+fixed-4);check(n<=0x300&&at+fixed+n<=table.length,'Invalid RomFS name length');out.set(at,table.subarray(at+fixed,at+fixed+n));at=align(at+fixed+n,4);}check(at===table.length,'RomFS table alignment differs');return out;}
function captured(capture,mount,offset,length){
 const out=Buffer.alloc(length);for(let at=offset;at<offset+length;){const row=mount.metadata.find(r=>r.offset<=at&&at<r.offset+r.length);check(row,'Missing captured RomFS metadata');const b=fs.readFileSync(path.join(capture,mount.label,row.filename));check(b.length===row.length&&sha(b)===row.sha256,'Captured metadata hash differs');const n=Math.min(offset+length-at,row.offset+row.length-at);b.copy(out,at-offset,at-row.offset,at-row.offset+n);at+=n;}return out;
}
function makeBuckets(table,fixed){const names=records(table,fixed),n=bucketCount(names.size),b=Buffer.alloc(n*4,255);for(const [at,name]of names){const bucket=nameHash(table.readUInt32LE(at),name)%n;table.writeUInt32LE(b.readUInt32LE(bucket*4),at+fixed-8);b.writeUInt32LE(at,bucket*4);}return b;}
async function buildRomfs(capture,mount,mod,pack){
 const header=captured(capture,mount,0,80),h=Array.from({length:10},(_,i)=>Number(header.readBigUInt64LE(8*i)));
 check(h[0]===80,'Invalid RomFS header');
 const dirs=new Map([['/',{path:'/',name:'',parent:'/',children:[],files:[]}]]),files=new Map();
 for(const e of mount.entries){romPath(e.path);if(e.type==='directory')dirs.set(e.path,{path:e.path,name:path.posix.basename(e.path),parent:path.posix.dirname(e.path),children:[],files:[]});else files.set(e.path,{...e,name:path.posix.basename(e.path),parent:path.posix.dirname(e.path)});}
 const extensionStart=align(mount.size,4096),payloadStart=align(pack.size),resources=[];pack.pad();
 if(mod.romfsImage){
  const fd=fs.openSync(mod.romfsImage.file,'r');let imageEntries;
  try{imageEntries=await readRomfs(async(at,n)=>{const b=Buffer.alloc(n);check(fs.readSync(fd,b,0,n,at)===n,'Short mod romfs.bin read');return b;},mod.romfsImage.size);}finally{fs.closeSync(fd);}
  const written=pack.append(mod.romfsImage.file);
  for(const e of imageEntries){
   if(e.type==='directory'){check(!files.has(e.path),'romfs.bin directory conflicts with an original file');if(!dirs.has(e.path))dirs.set(e.path,{path:e.path,name:path.posix.basename(e.path),parent:path.posix.dirname(e.path),children:[],files:[]});}
   else{check(!dirs.has(e.path),'romfs.bin file conflicts with an original directory');const hash=require('node:crypto').createHash('sha256');const f=fs.openSync(mod.romfsImage.file,'r'),b=Buffer.alloc(0x40000);try{for(let at=0;at<e.size;){const n=fs.readSync(f,b,0,Math.min(b.length,e.size-at),e.offset+at);check(n>0,'Short romfs.bin resource');hash.update(b.subarray(0,n));at+=n;}}finally{fs.closeSync(f);}
    const offset=extensionStart+written.offset-payloadStart+e.offset;files.set(e.path,{...e,offset,name:path.posix.basename(e.path),parent:path.posix.dirname(e.path)});resources.push({path:e.path,overlayOffset:offset,modifiedSize:e.size,modifiedSha256:hash.digest('hex')});}
  }
 }
 for(const r of mod.romfs){
  let p=r.type==='directory'?r.path:path.posix.dirname(r.path);
  while(p!=='/'){check(!files.has(p),'A mod directory conflicts with an original file: '+p);if(!dirs.has(p))dirs.set(p,{path:p,name:path.posix.basename(p),parent:path.posix.dirname(p),children:[],files:[]});p=path.posix.dirname(p);}
  if(r.type==='file'){check(!dirs.has(r.path),'A mod file conflicts with an original directory: '+r.path);files.set(r.path,{...r,name:path.posix.basename(r.path),parent:path.posix.dirname(r.path),modified:true,added:!files.has(r.path)});}
 }
 // Large resources are copied in bounded chunks, never fully loaded into RAM.
 for(const f of [...files.values()].filter(f=>f.modified).sort((a,b)=>a.path.localeCompare(b.path))){
  const written=pack.append(f.file);check(written.size===f.size,'Mod resource changed during preparation: '+f.path);
  f.offset=extensionStart+written.offset-payloadStart;f.sha256=written.sha256;
  const prior=resources.findIndex(r=>r.path===f.path);if(prior>=0)resources.splice(prior,1);
  resources.push({path:f.path,added:f.added,overlayOffset:f.offset,modifiedSize:f.size,modifiedSha256:f.sha256});
 }
 const sortedDirs=[dirs.get('/'),...[...dirs.values()].filter(d=>d.path!=='/').sort((a,b)=>a.path.localeCompare(b.path))],sortedFiles=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
 let dirSize=0,fileSize=0;
 for(const d of sortedDirs){d.record=dirSize;dirSize+=align(24+Buffer.byteLength(d.name),4);if(d.path!=='/'){check(dirs.has(d.parent),'Missing RomFS parent');dirs.get(d.parent).children.push(d);}}
 for(const f of sortedFiles){f.record=fileSize;fileSize+=align(32+Buffer.byteLength(f.name),4);check(dirs.has(f.parent),'Missing file parent');dirs.get(f.parent).files.push(f);}
 check(dirSize<NONE&&fileSize<NONE,'RomFS metadata exceeds 32-bit record offsets');
 const dt=Buffer.alloc(dirSize),ft=Buffer.alloc(fileSize);
 for(const d of sortedDirs){const at=d.record,p=dirs.get(d.parent),siblings=d.path==='/'?[]:p.children,i=siblings.indexOf(d);dt.writeUInt32LE(p.record,at);dt.writeUInt32LE(siblings[i+1]?.record??NONE,at+4);dt.writeUInt32LE(d.children[0]?.record??NONE,at+8);dt.writeUInt32LE(d.files[0]?.record??NONE,at+12);dt.writeUInt32LE(NONE,at+16);dt.writeUInt32LE(Buffer.byteLength(d.name),at+20);dt.write(d.name,at+24);}
 for(const f of sortedFiles){const at=f.record,p=dirs.get(f.parent),i=p.files.indexOf(f);ft.writeUInt32LE(p.record,at);ft.writeUInt32LE(p.files[i+1]?.record??NONE,at+4);check(f.offset>=h[9],'File offset precedes data partition');ft.writeBigUInt64LE(BigInt(f.offset-h[9]),at+8);ft.writeBigUInt64LE(BigInt(f.size),at+16);ft.writeUInt32LE(NONE,at+24);ft.writeUInt32LE(Buffer.byteLength(f.name),at+28);ft.write(f.name,at+32);}
 const db=makeBuckets(dt,24),fb=makeBuckets(ft,32),newHeader=Buffer.from(header);
 for(const [i,b]of [[1,db],[3,dt],[5,fb],[7,ft]]){const at=pack.bytes(b);newHeader.writeBigUInt64LE(BigInt(extensionStart+at-payloadStart),i*8);newHeader.writeBigUInt64LE(BigInt(b.length),(i+1)*8);}
 const extensionLength=pack.size-payloadStart,headerOffset=pack.bytes(newHeader),identity=mount.identity;
 check(identity&&identity.length>0,'Missing storage fingerprint');
 // Both tables were rebuilt, including every hash chain and sibling/parent
 // link. Unmodified game file data keeps its original storage coordinates.
 const view={titleId:mod.titleId,label:mount.label,selection:mount.selection,source:mount.source,storage:mount.storage,
  storageSize:mount.size,virtualSize:extensionStart+extensionLength,headerHex:header.toString('hex'),
  fingerprintFileEntryOffset:identity.entryOffset,originalFileEntryHex:identity.entryHex,
  fingerprintDataOffset:identity.offset,originalPrefixHex:identity.hex,fingerprintLength:identity.length,
  segments:[{offset:0,length:80,sourceOffset:headerOffset},{offset:extensionStart,length:extensionLength,sourceOffset:payloadStart}],resources};
 return view;
}
module.exports={buildRomfs,captured,records,nameHash,makeBuckets};
