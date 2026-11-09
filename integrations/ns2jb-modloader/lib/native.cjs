'use strict';
// Offline only. The final FS padding page is composed with RomFS; no RPC here.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {layout}=require('./context.cjs');
const check=(ok,why)=>{if(!ok)throw Error(why);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const CAVE=0x24d100,PAGE=0x24d000,FS_SHA='8dba242cc3a7ca8888cc9e9055a840a98f2cb32ab184d9d081949f72afb63e54';
const EXPECTED={read:'6207f8b7e408f8b7690440f99f0009eb',size:'7f2303d5ffc300d1fd7b01a9f44f02a9'};
function branch(from,to){const d=BigInt(to)-BigInt(from);check(d%4n===0n&&d>=-0x8000000n&&d<0x8000000n,'A64 branch out of range');return(0x14000000|Number((d/4n)&0x3ffffffn))>>>0;}
function target(word,at,bits,shift=0){let n=(word>>>shift)&(2**bits-1);if(n>=2**(bits-1))n-=2**bits;return at+4*n;}
function validateCapture(bytes){
 check(bytes.length===0x24e000&&sha(bytes)===FS_SHA,'Native FS capture differs');
 check(bytes.subarray(0x104ef0,0x104f00).toString('hex')===EXPECTED.read,'IFile Read displaced words differ');
 check(bytes.subarray(0x105480,0x105490).toString('hex')===EXPECTED.size,'IFile Size displaced words differ');
 check(target(bytes.readUInt32LE(0x104ef0),0x104ef0,14,5)===0x104fdc&&target(bytes.readUInt32LE(0x104ef4),0x104ef4,14,5)===0x105010,'Original TBNZ targets differ');
 check(bytes.subarray(CAVE,0x24e000).every(x=>x===0),'CodeFS range was not blank in capture');
 return {sha256:FS_SHA,readDisplacedWords:[0xb7f80762,0xb7f808e4,0xf9400469,0xeb09009f],sizeDisplacedWords:[0xd503237f,0xd100c3ff,0xa9017bfd,0xa9024ff4],readInvalidOffset:0x104fdc,readInvalidSize:0x105010};
}
async function buildAll(base,context,plan,options){
 base=BigInt(base);context=BigInt(context);const l=layout(plan),directory=options.directory;
 const {buildNamespace,CAVE:namespaceCave}=require('./native-namespace.cjs');
 const codefs=l.exefs?await buildNamespace(base,context+BigInt(l.romfs),options):null;
 const template=require('./native/artifacts.cjs').romfs(base,context),romfs=template.code;
 check(romfs.length<=namespaceCave-0x24d100,'RomFS reader overlaps the ExeFS namespace');
 const sizeOffset=template.symbols.lfs_size.value;
 const code=Buffer.alloc(codefs?0xf00:((romfs.length+15)&~15));romfs.copy(code);if(codefs)codefs.code.copy(code,namespaceCave-0x24d100);
 const hooks=codefs?[...codefs.hooks]:[];
 const capture=await fs.readFile(options.capture);validateCapture(capture);
 if(plan.views.length)for(const [name,offset,destination]of [['RomFS.Read',0x107570,0],['RomFS.GetSize',0x107600,sizeOffset]]){
  const original=capture.subarray(offset,offset+16);check(original.readUInt32LE(0)===(name==='RomFS.Read'?0x91002000:0xd503237f),'RomFS entry ABI differs');const replacement=Buffer.from(original);replacement.writeUInt32LE(branch(base+BigInt(offset),base+0x24d100n+BigInt(destination)));hooks.push({name,offset,target:String(base+BigInt(offset)),originalHex:original.toString('hex'),replacementHex:replacement.toString('hex')});
 }
 const namespace=codefs?{original:Object.fromEntries(['open','directory','type'].map(k=>[k,namespaceCave+codefs.offsets['lfs_namespace_original_'+k]])),entries:Object.fromEntries(['open','directory','type'].map(k=>[k,namespaceCave+codefs.offsets['lfs_namespace_'+k+'_entry']]))}:null;
 const result={hooks,romfsBytes:romfs.length,codefsBytes:codefs?.code.length||0,codefsOriginalRead:0,namespace,context:l,base:String(base),address:String(context),entry:String(base+0x24d100n),offsets:{romfs_size:sizeOffset},codeBytes:code.length,sha256:sha(code)};
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'combined.bin'),code,{mode:0o600});await fs.writeFile(path.join(directory,'combined-layout.json'),JSON.stringify(result,null,2)+'\n');return{...result,code};
}
module.exports={buildAll,branch,validateCapture,CAVE,PAGE,FS_SHA};
