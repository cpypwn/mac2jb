'use strict';
const {isUncertain}=require('../game-files/uncertain.cjs');
const fs=require('node:fs/promises'),path=require('node:path');
const {check}=require('../common.cjs'),{runtime}=require('./artifacts.cjs');

async function objectForMount(a,b,mount){
 const clone=a.domain.oneHandle(await a.domain.send(a.s,'Clone owned capture mount',mount.handle,a.domain.wire.control(2)));
 try{
  const layout=JSON.parse(await fs.readFile(path.join(a.run,'switch2/ro',path.basename(a.run)+'-layout.json'))),reply=await a.domain.send(a.s,'Locate owned capture mount',clone,a.domain.wire.control(0));
  check(!reply.result,'Cannot locate native capture object');const id=reply.data.readUInt32LE();check(id>0&&id<=layout.count,'Invalid native capture domain');
  const row=await b.m.read(layout.table+(id-1)*0x30,0x30),object=row.readBigUInt64LE(32);check(object>=0x100000000n&&object<0x8000000000n,'Invalid native capture object');
  const vptr=(await b.m.read(Number(object),8)).readBigUInt64LE(),release=(await b.m.read(Number(vptr)+8,8)).readBigUInt64LE();
  check(release===b.base+BigInt(mount.kind==='storage'?0x107490:0x103390),'Native capture object type differs');return{object,clone};
 }catch(error){if(b.c.pending||isUncertain(error))b.c.pending=true;else await a.s.close(clone);throw error;}
}
async function readOutput(b,pointer,length){
 const data=Buffer.alloc(length);let region;
 for(let at=0;at<length;){
  const address=pointer+BigInt(at);
  if(!region||address>=BigInt(region.address)+BigInt(region.size)){
   const info=await b.c.info(b.h,address,b.pid);check(!info.result&&info.memory.permissions===3&&!info.memory.attributes,'Native capture output is not readable data');region=info.memory;
  }
  const n=Math.min(region.type===4?0x200000:0x8000,length-at,Number(BigInt(region.address)+BigInt(region.size)-address));check(n>0,'Invalid native capture output span');
  if(region.type===4){const reply=await b.c.readBulk(b.h,b.pid,address,n);check(!reply.result&&reply.length===n&&!reply.data.readBigUInt64LE(32)&&!reply.data.readBigUInt64LE(40),'Cannot read native capture output');reply.bytes.copy(data,at);}
  else(await b.m.read(Number(address),n)).copy(data,at);
  at+=n;
 }
 return data;
}
async function captureMount(a,bootstrap,mount){
 const b=bootstrap.bridge,owned=await objectForMount(a,b,mount);let allocation,pointer,capacity,initialized=false;
 try{
  allocation=await b.call(0x694c0,[4096],'allocate-native-capture');check(allocation>=0x100000000n&&allocation<0x8000000000n,'Cannot allocate native capture context');
  const data=Buffer.alloc(128),values=[owned.object+(mount.kind==='filesystem'?8n:0n),b.base+0x1048c0n,b.base+0x105800n,b.base+0x105720n,b.base+0x1045b0n,b.base+0x104ef0n,b.base+0x104e10n,b.base+0x107570n,b.base+0x694c0n,b.base+0x69580n];
  values.forEach((value,i)=>data.writeBigUInt64LE(value,i*8));data.writeBigUInt64LE(BigInt(mount.size||0),120);await b.writeData(Number(allocation),await b.m.read(Number(allocation),data.length),data);initialized=true;
  const result=await b.callRuntime(runtime(0n,0n).offsets[mount.kind==='storage'?'lfs_capture_romfs':'lfs_capture_codefs'],[allocation],'capture-'+mount.kind+'-metadata');
  const reply=await b.m.read(Number(allocation)+80,48);pointer=reply.readBigUInt64LE();const length=reply.readBigUInt64LE(8);capacity=reply.readBigUInt64LE(16);const count=reply.readBigUInt64LE(24),error=reply.readUInt32LE(32);
  check(!result&&!error,'Native '+mount.kind+' capture failed: 0x'+(result||BigInt(error)).toString(16));
  check(length<=capacity&&length<=BigInt(require('node:buffer').constants.MAX_LENGTH)&&count<=BigInt(Number.MAX_SAFE_INTEGER)&&(!length||pointer>=0x100000000n&&pointer<0x8000000000n),'Invalid native capture output');
  return{data:await readOutput(b,pointer,Number(length)),count:Number(count)};
 }catch(error){
  if(isUncertain(error))b.c.pending=true;
  throw error;
 }finally{
  if(!b.c.pending){
   if(initialized&&pointer===undefined){const reply=await b.m.read(Number(allocation)+80,24);pointer=reply.readBigUInt64LE();capacity=reply.readBigUInt64LE(16);}
   if(pointer)await b.call(0x69580,[pointer,capacity],'free-native-capture-output');
   if(allocation)await b.call(0x69580,[allocation,4096],'free-native-capture-context');
   await a.s.close(owned.clone);
  }
 }
}
function romfsReader(data){
 check(data.length>=80&&data.readBigUInt64LE()===80n,'Invalid native RomFS capture');
 const directoryOffset=Number(data.readBigUInt64LE(24)),directoryLength=Number(data.readBigUInt64LE(32)),fileOffset=Number(data.readBigUInt64LE(56)),fileLength=Number(data.readBigUInt64LE(64));
 check(data.length===80+directoryLength+fileLength,'Native RomFS capture length differs');
 const ranges=[{offset:0,length:80,at:0},{offset:directoryOffset,length:directoryLength,at:80},{offset:fileOffset,length:fileLength,at:80+directoryLength}];
 return async(offset,length)=>{const row=ranges.find(row=>offset>=row.offset&&offset+length<=row.offset+row.length);check(row,'Range is outside captured RomFS tables');return data.subarray(row.at+offset-row.offset,row.at+offset-row.offset+length);};
}
function codefsIndex(data,count){
 const rows=[];let at=0;
 while(at<data.length){
  check(at+16<=data.length,'Truncated native CodeFS capture');const size=Number(data.readBigUInt64LE(at)),n=data.readUInt32LE(at+8),length=data.readUInt32LE(at+12),headerAt=Math.ceil((16+n+1)/8)*8,next=at+Math.ceil((headerAt+length)/8)*8;
  check(Number.isSafeInteger(size)&&size>=0&&n>0&&n<0x300&&length===Math.min(256,size)&&next<=data.length&&data[at+16+n]===0,'Invalid native CodeFS capture row');
  const name=data.toString('utf8',at+16,at+16+n),header=data.subarray(at+headerAt,at+headerAt+length);check(!/[\\/\x00]/.test(name)&&!['.','..'].includes(name)&&!rows.some(row=>row.name===name),'Invalid native CodeFS name');
  rows.push({name,size,headerHex:header.toString('hex'),buildId:length===256&&header.toString('ascii',0,4)==='NSO0'?header.subarray(0x40,0x60).toString('hex'):null});at=next;
 }
 check(at===data.length&&rows.length===count,'Native CodeFS capture count differs');return rows;
}
module.exports={captureMount,readOutput,romfsReader,codefsIndex};
