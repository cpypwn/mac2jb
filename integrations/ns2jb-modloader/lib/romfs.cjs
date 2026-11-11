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
function originalBuckets(table,fixed,size){
 check(size>=4&&size%4===0,'Invalid original RomFS buckets');const b=Buffer.alloc(size,255),rows=records(table,fixed),referenced=new Set();
 for(const [at]of rows){const next=table.readUInt32LE(at+fixed-8);if(next!==NONE){check(rows.has(next),'Invalid original hash link');referenced.add(next);}}
 for(const [at,name]of rows)if(!referenced.has(at)&&!(fixed===24&&at===0)){
  const bucket=nameHash(table.readUInt32LE(at),name)%(size/4);check(b.readUInt32LE(bucket*4)===NONE,'Ambiguous original hash chain');b.writeUInt32LE(at,bucket*4);
 }
 if(fixed===24&&rows.has(0)&&!referenced.has(0)){const bucket=nameHash(0,Buffer.alloc(0))%(size/4);if(b.readUInt32LE(bucket*4)===NONE)b.writeUInt32LE(0,bucket*4);}
 return b;
}
function viewIdentity(mount,mod,header){
 const identity=mount.identity;check(identity&&identity.length>0,'Missing storage fingerprint');
 return{titleId:mod.titleId,label:mount.label,selection:mount.selection,source:mount.source,storage:mount.storage,storageSize:mount.size,headerHex:header.toString('hex'),fingerprintFileEntryOffset:identity.entryOffset,originalFileEntryHex:identity.entryHex,fingerprintDataOffset:identity.offset,originalPrefixHex:identity.hex,fingerprintLength:identity.length};
}
async function replacementsOnly(capture,mount,mod,pack,sources,header,h){
 if(mod.romfsImage)return null;
 const original=new Map(mount.entries.map(e=>[e.path,e]));
 if(mod.romfs.some(r=>original.get(r.path)?.type!==r.type))return null;
 const changes=mod.romfs.filter(r=>r.type==='file'),offsets=new Map();
 if(changes.every(r=>Number.isSafeInteger(original.get(r.path).recordOffset)))for(const r of changes)offsets.set(r.path,original.get(r.path).recordOffset);
 else{
  const dt=captured(capture,mount,h[3],h[4]),ft=captured(capture,mount,h[7],h[8]),paths=new Map([[0,'/']]),wanted=new Set(changes.map(r=>r.path));
  const directory=at=>{if(paths.has(at))return paths.get(at);const n=dt.readUInt32LE(at+20),parent=dt.readUInt32LE(at);check(parent!==at,'Invalid cached RomFS parent');const name=directory(parent).replace(/\/$/,'')+'/'+dt.toString('utf8',at+24,at+24+n);paths.set(at,name);return name;};
  for(let at=0;at<ft.length;){const n=ft.readUInt32LE(at+28),name=directory(ft.readUInt32LE(at)).replace(/\/$/,'')+'/'+ft.toString('utf8',at+32,at+32+n);if(wanted.has(name))offsets.set(name,h[7]+at);at=align(at+32+n,4);}
 }
 const segments=[],resources=[];let virtual=align(mount.size,4096);
 for(const r of changes){
  const recordOffset=offsets.get(r.path);check(Number.isSafeInteger(recordOffset),'Missing replacement file record: '+r.path);
  const source=await sources.add(r),offset=align(virtual),bytes=Buffer.alloc(16);bytes.writeBigUInt64LE(BigInt(offset-h[9]));bytes.writeBigUInt64LE(BigInt(r.size),8);
  segments.push({offset:recordOffset+8,length:16,sourceOffset:pack.bytes(bytes)});if(r.size)segments.push({offset,length:r.size,sourceOffset:0,sourcePath:source.sdPath});
  resources.push({path:r.path,added:false,recordOffset,overlayOffset:offset,modifiedSize:r.size,sourcePath:source.sdPath,sourceOffset:0});virtual=offset+r.size;
 }
 segments.sort((a,b)=>a.offset-b.offset);return{...viewIdentity(mount,mod,header),virtualSize:virtual,metadataPassthrough:true,segments,resources};
}
async function buildRomfs(capture,mount,mod,pack,sources){
 const {readSource}=require('./sources.cjs'),header=captured(capture,mount,0,80),h=Array.from({length:10},(_,i)=>Number(header.readBigUInt64LE(8*i)));
 check(h[0]===80,'Invalid RomFS header');const fast=await replacementsOnly(capture,mount,mod,pack,sources,header,h);if(fast)return fast;
 const dt=captured(capture,mount,h[3],h[4]),ft=captured(capture,mount,h[7],h[8]),db=originalBuckets(dt,24,h[2]),fb=originalBuckets(ft,32,h[6]);
 check(db.length>=4&&db.length%4===0&&fb.length>=4&&fb.length%4===0,'Invalid RomFS hash table');
 const dirs=new Map(),paths=new Map([[0,'/']]),originalFiles=new Map(),changes=new Map();
 function dirPath(at){if(paths.has(at))return paths.get(at);check(at+24<=dt.length,'Invalid directory record');const parent=dt.readUInt32LE(at);check(parent!==at,'Cyclic directory record');const n=dt.readUInt32LE(at+20),name=dirPath(parent).replace(/\/$/,'')+'/'+dt.toString('utf8',at+24,at+24+n);paths.set(at,name);return name;}
 for(const [record]of records(dt,24)){const name=dirPath(record);dirs.set(name,{path:name,record,parent:dt.readUInt32LE(record),child:dt.readUInt32LE(record+8),file:dt.readUInt32LE(record+12),original:true});}
 for(const [record,name]of records(ft,32)){const full=dirPath(ft.readUInt32LE(record)).replace(/\/$/,'')+'/'+name.toString('utf8');originalFiles.set(full,{record,size:Number(ft.readBigUInt64LE(record+16)),offset:h[9]+Number(ft.readBigUInt64LE(record+8))});}
 const extraDirs=[],extraFiles=[];let dirSize=dt.length,fileSize=ft.length;
 function ensureDir(name){
  if(dirs.has(name))return dirs.get(name);check(!originalFiles.has(name)&&!changes.has(name),'Mod directory conflicts with a file: '+name);
  const parent=ensureDir(path.posix.dirname(name)),text=path.posix.basename(name),record=dirSize;dirSize+=align(24+Buffer.byteLength(text),4);const d={path:name,name:text,record,parent:parent.record,sibling:parent.child,child:NONE,file:NONE,original:false};parent.child=record;dirs.set(name,d);extraDirs.push(d);return d;
 }
 function replace(row,source,sourceOffset){
  romPath(row.path);ensureDir(path.posix.dirname(row.path));check(!dirs.has(row.path),'Mod file conflicts with a directory: '+row.path);const original=originalFiles.get(row.path);
  changes.set(row.path,{path:row.path,size:row.size,source,sourceOffset,record:original?.record,added:!original});
 }
 if(mod.romfsImage)for(const row of await readRomfs((at,n)=>readSource(mod.romfsImage,at,n,sources.reader),mod.romfsImage.size)){if(row.type==='directory')ensureDir(row.path);else replace(row,mod.romfsImage,row.offset);}
 for(const row of mod.romfs)if(row.type==='directory')ensureDir(row.path);else replace(row,row,0);
 const patches={db:new Map(),dt:new Map(),fb:new Map(),ft:new Map()},segments=[],resources=[];let virtual=align(mount.size,4096);
 const word=value=>{const b=Buffer.alloc(4);b.writeUInt32LE(value);return b;};
 for(const d of extraDirs){const bucket=nameHash(d.parent,Buffer.from(d.name))%(db.length/4),old=patches.db.get(bucket*4);d.hash=old?old.readUInt32LE():db.readUInt32LE(bucket*4);patches.db.set(bucket*4,word(d.record));}
 for(const f of changes.values()){
  const source=await sources.add(f.source);check(f.sourceOffset+f.size<=source.size,'Mod source extent changed: '+f.path);f.offset=align(virtual);virtual=f.offset+f.size;
  if(f.size)segments.push({offset:f.offset,length:f.size,sourceOffset:f.sourceOffset,sourcePath:source.sdPath});
  if(f.added){const parent=dirs.get(path.posix.dirname(f.path)),name=path.posix.basename(f.path),record=fileSize;fileSize+=align(32+Buffer.byteLength(name),4);const bucket=nameHash(parent.record,Buffer.from(name))%(fb.length/4),old=patches.fb.get(bucket*4);f.record=record;f.name=name;f.parent=parent.record;f.sibling=parent.file;f.hash=old?old.readUInt32LE():fb.readUInt32LE(bucket*4);parent.file=record;patches.fb.set(bucket*4,word(record));extraFiles.push(f);}
  else{const bytes=Buffer.alloc(16);bytes.writeBigUInt64LE(BigInt(f.offset-h[9]));bytes.writeBigUInt64LE(BigInt(f.size),8);patches.ft.set(f.record+8,bytes);}
  resources.push({path:f.path,added:f.added,record:f.record,overlayOffset:f.offset,modifiedSize:f.size,sourcePath:source.sdPath,sourceOffset:f.sourceOffset});
 }
 check(dirSize<NONE&&fileSize<NONE,'RomFS metadata exceeds 32-bit offsets');
 for(const d of dirs.values())if(d.original){if(d.child!==dt.readUInt32LE(d.record+8))patches.dt.set(d.record+8,word(d.child));if(d.file!==dt.readUInt32LE(d.record+12))patches.dt.set(d.record+12,word(d.file));}
 const newDirs=Buffer.alloc(dirSize-dt.length),newFiles=Buffer.alloc(fileSize-ft.length);
 for(const d of extraDirs){const at=d.record-dt.length;[d.parent,d.sibling,d.child,d.file,d.hash,Buffer.byteLength(d.name)].forEach((v,i)=>newDirs.writeUInt32LE(v,at+i*4));newDirs.write(d.name,at+24);}
 for(const f of extraFiles){const at=f.record-ft.length;newFiles.writeUInt32LE(f.parent,at);newFiles.writeUInt32LE(f.sibling,at+4);newFiles.writeBigUInt64LE(BigInt(f.offset-h[9]),at+8);newFiles.writeBigUInt64LE(BigInt(f.size),at+16);newFiles.writeUInt32LE(f.hash,at+24);newFiles.writeUInt32LE(Buffer.byteLength(f.name),at+28);newFiles.write(f.name,at+32);}
 const newHeader=Buffer.from(header);virtual=align(virtual,4096);
 for(const [index,key,table,added]of [[1,'db',db,Buffer.alloc(0)],[3,'dt',dt,newDirs],[5,'fb',fb,Buffer.alloc(0)],[7,'ft',ft,newFiles]]){
  const start=align(virtual);newHeader.writeBigUInt64LE(BigInt(start),index*8);newHeader.writeBigUInt64LE(BigInt(table.length+added.length),(index+1)*8);let cursor=0;
  for(const [at,bytes]of [...patches[key]].sort((a,b)=>a[0]-b[0])){check(at>=cursor&&at+bytes.length<=table.length,'Overlapping metadata edits');if(at>cursor)segments.push({offset:start+cursor,length:at-cursor,sourceOffset:h[index]+cursor,original:true});segments.push({offset:start+at,length:bytes.length,sourceOffset:pack.bytes(bytes)});cursor=at+bytes.length;}
  if(cursor<table.length)segments.push({offset:start+cursor,length:table.length-cursor,sourceOffset:h[index]+cursor,original:true});
  if(added.length)segments.push({offset:start+table.length,length:added.length,sourceOffset:pack.bytes(added)});virtual=start+table.length+added.length;
 }
 for(const r of resources){r.recordOffset=Number(newHeader.readBigUInt64LE(56))+r.record;delete r.record;}
 segments.push({offset:0,length:80,sourceOffset:pack.bytes(newHeader)});segments.sort((a,b)=>a.offset-b.offset);
 return{...viewIdentity(mount,mod,header),virtualSize:virtual,segments,resources,originalMetadata:{directory:capture,label:mount.label,metadata:mount.metadata}};
}
module.exports={buildRomfs,captured,records,nameHash,makeBuckets,originalBuckets};
