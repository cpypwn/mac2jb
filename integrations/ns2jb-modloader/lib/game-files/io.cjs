'use strict';
const {check}=require('../common.cjs');
async function verifiedBytes(s,buffer,count){
 check(Number.isSafeInteger(buffer)&&Number.isInteger(count)&&count>=0&&buffer>=s.base+0x3000&&buffer+count<=s.base+s.bytes,'Read exceeds the owned buffer');
 const bytes=count?await s.read(buffer,count):Buffer.alloc(0);
 check(bytes.length===count,'Short RPC memory read');return bytes;
}
async function readFile(s,handle,offset,size,buffer=s.base+0x6000){
 check(!s.threads.size&&Number.isSafeInteger(offset)&&offset>=0&&Number.isInteger(size)&&size>0&&size<=0x40000&&buffer>=s.base+0x3000&&buffer+size<=s.base+s.bytes,'File read exceeds idle owned memory');
 const input=Buffer.alloc(24);input.writeBigUInt64LE(BigInt(offset),8);input.writeBigUInt64LE(BigInt(size),16);
 const reply=await s.ipc('ReadFile',handle,0,input,{receive:[{address:buffer,size,mode:1}]});check(!reply.result,'File read failed: '+reply.result);
 const count=Number(reply.data.readBigUInt64LE());check(Number.isSafeInteger(count)&&count>=0&&count<=size,'Invalid file byte count');return verifiedBytes(s,buffer,count);
}
async function readStorage(s,handle,offset,size,buffer=s.base+0x6000){
 check(!s.threads.size&&Number.isSafeInteger(offset)&&offset>=0&&Number.isInteger(size)&&size>0&&size<=0x40000&&buffer>=s.base+0x3000&&buffer+size<=s.base+s.bytes,'Storage read exceeds idle owned memory');
 const input=Buffer.alloc(16);input.writeBigUInt64LE(BigInt(offset));input.writeBigUInt64LE(BigInt(size),8);
 const reply=await s.ipc('ReadStorage',handle,0,input,{receive:[{address:buffer,size,mode:1}]});check(!reply.result,'Storage read failed: '+reply.result);return verifiedBytes(s,buffer,size);
}
module.exports={verifiedBytes,readFile,readStorage};
