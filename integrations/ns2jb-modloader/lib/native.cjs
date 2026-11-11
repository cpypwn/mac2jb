'use strict';
// Offline only. The final FS padding page is composed with RomFS; no RPC here.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {layout}=require('./context.cjs');
const check=(ok,why)=>{if(!ok)throw Error(why);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const CAVE=0x24d100,PAGE=0x24d000;
const EXPECTED={read:'6207f8b7e408f8b7690440f99f0009eb',size:'7f2303d5ffc300d1fd7b01a9f44f02a9'};
function branch(from,to){const d=BigInt(to)-BigInt(from);check(d%4n===0n&&d>=-0x8000000n&&d<0x8000000n,'A64 branch out of range');return(0x14000000|Number((d/4n)&0x3ffffffn))>>>0;}
function target(word,at,bits,shift=0){let n=(word>>>shift)&(2**bits-1);if(n>=2**(bits-1))n-=2**bits;return at+4*n;}
function validateCapture(bytes){
 const validation=require('./native/fs-abi.cjs').validateFsAbi(bytes);
 check(bytes.subarray(0x104ef0,0x104f00).toString('hex')===EXPECTED.read,'IFile Read displaced words differ');
 check(bytes.subarray(0x105480,0x105490).toString('hex')===EXPECTED.size,'IFile Size displaced words differ');
 check(target(bytes.readUInt32LE(0x104ef0),0x104ef0,14,5)===0x104fdc&&target(bytes.readUInt32LE(0x104ef4),0x104ef4,14,5)===0x105010,'Original TBNZ targets differ');
 return {...validation,readDisplacedWords:[0xb7f80762,0xb7f808e4,0xf9400469,0xeb09009f],sizeDisplacedWords:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4],readInvalidOffset:0x104fdc,readInvalidSize:0x105010};
}
async function buildAll(base,context,plan,options){
 base=BigInt(base);context=BigInt(context);const l=layout(plan),runtimeAddress=BigInt(options.runtimeAddress??0x8000000n);
 check(runtimeAddress%4096n===0n,'Runtime mapping must be page aligned');
 const template=require('./native/artifacts.cjs').runtime(context,l.exefs?context+BigInt(l.romfs):0n,plan.lazy?context+BigInt(l.lazyOffset):0n),runtimeCode=Buffer.alloc((template.code.length+4095)&~4095);template.code.copy(runtimeCode);
 const capture=await fs.readFile(options.capture);validateCapture(capture);
 const {ABI,SDK}=require('./native-namespace.cjs'),code=Buffer.alloc(1024),offsets=template.offsets,entries={},original={};let cursor=0;
 for(let i=0;i<code.length;i+=4)code.writeUInt32LE(0xd503201f,i);
 function gateway(symbol){
  check(Number.isSafeInteger(offsets[symbol]),'Missing runtime entry '+symbol);const at=cursor;cursor+=16;
  code.writeUInt32LE(0x58000050,at);code.writeUInt32LE(0xd61f0200,at+4);code.writeBigUInt64LE(runtimeAddress+BigInt(offsets[symbol]),at+8);return CAVE+at;
 }
 for(const name of ['read','size','open','directory','type','mount'])entries[name]=gateway(name==='read'?'lfs_read_entry':name==='size'?'lfs_size_entry':'lfs_namespace_'+name+'_entry');
 if(plan.lazy){entries.range=gateway('lfs_storage_range');entries.batch=gateway('lfs_storage_batch');}
 function replay(offset,words){
  check(words.length===4&&words.every((w,i)=>capture.readUInt32LE(offset+i*4)===w),'Native SDK prologue differs');
  const at=cursor;code.writeUInt32LE(0xd503245f,cursor);cursor+=4;
  for(const [i,word]of words.entries()){
   const from=offset+i*4;let bits=0,shift=5,invert=0,mask=0;
   if((word&0x7e000000)===0x36000000){bits=14;invert=0x01000000;mask=0x7ffe0;}
   else if((word&0x7e000000)===0x34000000){bits=19;invert=0x01000000;mask=0xffffe0;}
   else if((word&0xff000010)===0x54000000){bits=19;invert=1;mask=0xffffe0;}
   if(bits){
    const destination=target(word,from,bits,shift);check(destination<offset||destination>=offset+16,'Unsupported branch within a displaced prologue');
    code.writeUInt32LE((((word^invert)&~mask)|(2<<shift))>>>0,cursor);cursor+=4;code.writeUInt32LE(branch(base+BigInt(CAVE+cursor),base+BigInt(destination)),cursor);cursor+=4;
   }else{
    check((word&0x1f000000)!==0x10000000&&(word&0x7c000000)!==0x14000000&&(word&0x3b000000)!==0x18000000,'Unsupported PC-relative SDK prologue');code.writeUInt32LE(word,cursor);cursor+=4;
   }
  }
  code.writeUInt32LE(branch(base+BigInt(CAVE+cursor),base+BigInt(offset+16)),cursor);cursor=(cursor+4+15)&~15;return CAVE+at;
 }
 for(const [name,a]of Object.entries(ABI))original[name]=replay(a.offset,a.words);
 check(Number.isSafeInteger(offsets.lfs_codefs_original_address),'Missing original CodeFS mount literal');
 runtimeCode.writeBigUInt64LE(base+BigInt(original.mount),offsets.lfs_codefs_original_address);
 const originalSize=replay(0x107600,Array.from({length:4},(_,i)=>capture.readUInt32LE(0x107600+i*4)));
 const sdk={original:{},entries:{},targets:Object.fromEntries(Object.entries(SDK).map(([name,a])=>[name,a.offset]))},replayed=new Map();
 for(const [name,a]of Object.entries(SDK)){
  sdk.entries[name]=gateway(a.symbol);if(!replayed.has(a.offset))replayed.set(a.offset,replay(a.offset,a.words));sdk.original[name]=replayed.get(a.offset);
 }
 const lazy={original:{},entries:{}};
 if(plan.lazy)for(const [name,offset]of [['current',0xedb60],['program',0xedbe0],['data',0xedc60]]){
  lazy.entries[name]=gateway('lfs_lazy_mount_'+name);lazy.original[name]=replay(offset,Array.from({length:4},(_,i)=>capture.readUInt32LE(offset+i*4)));
 }
 const hooks=[];
 function hook(name,offset,destination){
  if(hooks.some(h=>h.offset===offset))return;
  const replacement=Buffer.alloc(16);replacement.writeUInt32LE(0xd503245f);replacement.writeUInt32LE(branch(base+BigInt(offset+4),base+BigInt(destination)),4);replacement.writeUInt32LE(0xd503201f,8);replacement.writeUInt32LE(0xd503201f,12);
  hooks.push({name,offset,target:String(base+BigInt(offset)),originalHex:capture.subarray(offset,offset+16).toString('hex'),replacementHex:replacement.toString('hex')});
 }
 if(l.exefs)for(const [name,a]of Object.entries(ABI))hook('ExeFS.'+name,a.offset,entries[name]);
 if(plan.views.length||plan.lazy){hook('RomFS.Read',0x107570,entries.read);hook('RomFS.GetSize',0x107600,entries.size);}
 if(plan.lazy){hook('RomFS.OperateRange',0x107650,entries.range);hook('RomFS.BatchRead',0x11fed0,entries.batch);}
 for(const [name,a]of Object.entries(SDK))if(name==='storageRelease'?(plan.views.length||plan.lazy):l.exefs)hook('SDK.'+name,a.offset,sdk.entries[name]);
 if(plan.lazy)for(const [name,offset]of [['current',0xedb60],['program',0xedbe0],['data',0xedc60]])hook('RomFS.Mount.'+name,offset,lazy.entries[name]);
 check(cursor<=code.length,'Native gateways exceed their owned padding');const gateways=code.subarray(0,cursor);
 const result={hooks,romfsBytes:template.code.length,codefsBytes:0,namespace:{original,entries:{open:entries.open,directory:entries.directory,type:entries.type,mount:entries.mount}},originalSize,sdk,lazy,context:l,base:String(base),address:String(context),entry:String(base+BigInt(entries.read)),offsets,runtimeAddress:String(runtimeAddress),runtimeBytes:runtimeCode.length,runtimeSha256:sha(runtimeCode),codeBytes:gateways.length,sha256:sha(gateways)};
 await fs.mkdir(options.directory,{recursive:true});await fs.writeFile(path.join(options.directory,'combined.bin'),gateways,{mode:0o600});await fs.writeFile(path.join(options.directory,'runtime.bin'),runtimeCode,{mode:0o600});await fs.writeFile(path.join(options.directory,'combined-layout.json'),JSON.stringify(result,null,2)+'\n');return{...result,code:gateways,runtimeCode};
}
module.exports={buildAll,branch,validateCapture,CAVE,PAGE};
