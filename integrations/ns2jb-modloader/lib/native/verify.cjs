'use strict';
const {isUncertain}=require('../game-files/uncertain.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const {check}=require('../common.cjs'),{runtime}=require('./artifacts.cjs');

function encodeSamples(samples,base,object,source,fsBase){
 const header=104,stride=56,strings=new Map(),chunks=[];let cursor=header+samples.length*stride;
 function append(bytes){const at=cursor;chunks.push({at,bytes});cursor+=bytes.length;return BigInt(base)+BigInt(at);}
 function text(value){if(!value)return 0n;check(typeof value==='string'&&!value.includes('\0')&&Buffer.byteLength(value)<=0x300,'Invalid routing sample path');if(!strings.has(value))strings.set(value,append(Buffer.from(value+'\0')));return strings.get(value);}
 const rows=samples.map(sample=>{
  check(Number.isSafeInteger(sample.offset)&&sample.offset>=0&&Number.isInteger(sample.length)&&sample.length>=0&&sample.length<=768,'Invalid routing sample range');
  check(Number.isSafeInteger(sample.sourceOffset||0)&&(sample.sourceOffset||0)>=0,'Invalid routing sample source');
  check(!sample.name||Number.isSafeInteger(sample.fileSize)&&sample.fileSize>=0,'Invalid routing sample size');
  check(Buffer.isBuffer(sample.expected)?sample.expected.length===sample.length:!!sample.sourcePath,'Missing routing sample expectation');
  return{sample,name:text(sample.name),source:text(sample.sourcePath),expected:Buffer.isBuffer(sample.expected)?append(sample.expected):0n};
 });
 const data=Buffer.alloc(cursor),values=[BigInt(object),BigInt(source)+8n,BigInt(fsBase)+0x107570n,BigInt(fsBase)+0x1045b0n,BigInt(fsBase)+0x104ef0n,BigInt(fsBase)+0x105480n,BigInt(fsBase)+0x104e10n,BigInt(fsBase)+0x1042e0n,BigInt(base)+BigInt(header),BigInt(samples.length)];
 values.forEach((value,i)=>data.writeBigUInt64LE(value,i*8));
 rows.forEach(({sample,name,source,expected},i)=>[BigInt(sample.offset),BigInt(sample.length),BigInt(sample.sourceOffset||0),BigInt(sample.fileSize||0),name,source,expected].forEach((value,j)=>data.writeBigUInt64LE(value,header+i*stride+j*8)));
 for(const chunk of chunks)chunk.bytes.copy(data,chunk.at);
 return data;
}
async function verifySamples(a,b,mount,samples,source){
 if(!samples.length)return;
 const layout=JSON.parse(await fs.readFile(path.join(a.run,'switch2/ro',path.basename(a.run)+'-layout.json')));
 const converted=await a.domain.send(a.s,'Locate owned verification object',mount.handle,a.domain.wire.control(0));
 check(!converted.result,'Cannot locate routing verification object');
 const id=converted.data.readUInt32LE();check(id>0&&id<=layout.count,'Invalid routing verification domain');
 const entry=await b.m.read(layout.table+(id-1)*0x30,0x30),object=entry.readBigUInt64LE(32);
 check(object>=0x100000000n&&object<0x8000000000n,'Invalid routing verification object');
 const vptr=(await b.m.read(Number(object),8)).readBigUInt64LE(),release=(await b.m.read(Number(vptr)+8,8)).readBigUInt64LE();
 check(release===b.base+BigInt(mount.kind==='storage'?0x107490:0x103390),'Routing verification object type differs');
 const shape=encodeSamples(samples,0n,object,source,b.base),size=(shape.length+4095)&~4095;
 const allocation=await b.call(0x694c0,[size],'allocate-routing-probes');check(allocation>=0x100000000n&&allocation<0x8000000000n,'Cannot allocate routing samples');
 try{
  const data=encodeSamples(samples,allocation,object+(mount.kind==='filesystem'?8n:0n),source,b.base);
  for(let off=0;off<data.length;off+=0x10000){const bytes=data.subarray(off,off+0x10000),at=Number(allocation)+off;await b.writeData(at,await b.m.read(at,bytes.length),bytes);}
  const result=await b.callRuntime(runtime(0n,0n).offsets.lfs_verify_samples,[allocation],'verify-routing-samples');
  const answer=await b.m.read(Number(allocation)+80,24),completed=Number(answer.readBigUInt64LE()),failed=Number(answer.readBigUInt64LE(8)),error=answer.readUInt32LE(16);
  check(!result&&!error&&completed===samples.length,'Native routing verification failed at sample '+failed+': 0x'+(result||BigInt(error)).toString(16));
 }catch(error){
  if(isUncertain(error))b.c.pending=true;
  throw error;
 }finally{if(!b.c.pending)await b.call(0x69580,[allocation,size],'free-routing-probes');}
}
module.exports={encodeSamples,verifySamples};
