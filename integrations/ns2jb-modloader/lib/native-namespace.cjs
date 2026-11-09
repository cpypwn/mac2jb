'use strict';
const fs=require('node:fs/promises');
const {check,sha}=require('./common.cjs');
const CAVE=0x24d580;
const ABI={open:{offset:0x1045b0,stack:0x70,words:[0xd503237f,0xd101c3ff,0xa9037bfd,0xf90023f7]},directory:{offset:0x1048c0,stack:0x70,words:[0xd503237f,0xd101c3ff,0xa9037bfd,0xf90023f7]},type:{offset:0x1042e0,stack:0x60,words:[0xd503237f,0xd10183ff,0xa9037bfd,0xa90457f6]}};
function branch(from,to){const delta=BigInt(to)-BigInt(from);check(delta%4n===0n&&delta>=-0x8000000n&&delta<0x8000000n,'Namespace branch exceeds ARM64 reach');return(0x14000000|Number((delta/4n)&0x3ffffffn))>>>0;}
async function buildNamespace(base,context,{capture,directory}){
 base=BigInt(base);context=BigInt(context);const original=await fs.readFile(capture);check(sha(original)==='8dba242cc3a7ca8888cc9e9055a840a98f2cb32ab184d9d081949f72afb63e54','Unsupported FS namespace ABI');
 for(const entry of Object.values(ABI))check(entry.words.every((w,i)=>original.readUInt32LE(entry.offset+i*4)===w),'Namespace gateway prologue differs');
 const {code,offsets}=require('./native/artifacts.cjs').namespace(context);check(code.length<=0x24e000-CAVE,'Namespace exceeds the reserved FS text padding');
 for(const [name,a] of Object.entries(ABI)){
  const at=offsets['lfs_namespace_original_'+name];
  check(code.readUInt32LE(at)===0xd503245f&&a.words.every((w,i)=>code.readUInt32LE(at+4+i*4)===w),'Namespace gateway BTI/PAC/frame differs');
  const word=code.readUInt32LE(at+20);let delta=word&0x3ffffff;if(delta&0x2000000)delta-=0x4000000;
  check((word>>>26)===5&&CAVE+at+20+delta*4===a.offset+16,'Namespace gateway tail differs');
 }
 const hooks=Object.entries(ABI).map(([name,a])=>{const b=Buffer.alloc(16);b.writeUInt32LE(0xd503245f);b.writeUInt32LE(branch(base+BigInt(a.offset+4),base+BigInt(CAVE+offsets['lfs_namespace_'+name+'_entry'])),4);b.writeUInt32LE(0xd503201f,8);b.writeUInt32LE(0xd503201f,12);return{name:'ExeFS.'+name,offset:a.offset,target:String(base+BigInt(a.offset)),originalHex:original.subarray(a.offset,a.offset+16).toString('hex'),replacementHex:b.toString('hex')};});
 return{code,cave:CAVE,offsets,hooks};
}
module.exports={buildNamespace,CAVE,ABI};
