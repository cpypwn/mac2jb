'use strict';
const {check}=require('../common.cjs');
const FS_PROGRAM='0400000000000000';
async function identifyFs(c,handle,expected){
 const info=await c.info(handle);
 check(!info.result&&info.programId===FS_PROGRAM&&/^\d+$/.test(String(info.pid))&&BigInt(info.pid)>0n,'The exported process handle is not native FS');
 if(expected)check(String(info.pid)===String(expected.pid)&&info.programId===expected.programId,'Native FS process differs from the current session proof');
 return{pid:BigInt(info.pid),programId:info.programId};
}
function verifyBulk(reply,identity,length,{partial=false}={}){
 const meta=reply.data;
 check(!reply.result&&Buffer.isBuffer(meta)&&meta.length>=56&&Number.isSafeInteger(reply.length)&&reply.length>0&&
  (partial?reply.length<=length:reply.length===length)&&Buffer.isBuffer(reply.bytes)&&reply.bytes.length===reply.length,'Native FS bulk read failed or returned an invalid length');
 check(meta.readBigUInt64LE(0)===identity.pid&&meta.readBigUInt64LE(8)===BigInt('0x'+identity.programId)&&
  meta.readBigUInt64LE(32)===0n&&meta.readBigUInt64LE(40)===0n&&meta.readBigUInt64LE(48)===BigInt(reply.length),'Native FS bulk identity or alias cleanup differs');
 return reply.bytes;
}
module.exports={identifyFs,verifyBulk,FS_PROGRAM};
