'use strict';
const path=require('node:path');
const {check,writeJson,romPath}=require('../common.cjs'),{Bridge}=require('./bridge.cjs'),{openSource}=require('./source.cjs'),{runtime}=require('./artifacts.cjs');

function decodeInventory(data,count,root){
 const tree=new Map([[root,{type:'directory',children:[]}]]),roots=new Set([root+'/contents',root+'/exefs_patches']);let at=0,seen=0;
 while(at<data.length){
  check(at+16<=data.length,'Truncated native SD inventory');
  const length=data.readUInt32LE(at),kind=data[at+4],base=data[at+5],size=Number(data.readBigUInt64LE(at+8)),end=at+16+length,next=Math.ceil((end+1)/8)*8;
  check(length>0&&length<0x301&&next<=data.length&&data[end]===0&&kind<=2,'Invalid native SD inventory row');
  const name=romPath(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(at+16,end)));check(name.startsWith(root+'/')&&!tree.has(name),'Invalid or duplicate native SD path');
  if(kind===2){check(base===1&&roots.has(name),'Unexpected missing SD mod directory');}
  else{
   check(Number.isSafeInteger(size)&&size>=0,'Invalid native SD file size');
   const parent=path.posix.dirname(name);check(tree.get(parent)?.type==='directory','Native SD inventory parent is missing');
   tree.get(parent).children.push(path.posix.basename(name));tree.set(name,{type:kind===1?'file':'directory',...(kind===1?{size}:{}),children:[]});
  }
  seen++;at=next;
 }
 check(at===data.length&&seen===count,'Native SD inventory count differs');return tree;
}
async function scanSd(run,source,directory,options={}){
 const state=path.dirname(directory),journal=path.join(state,'sd-scan.json'),r={session:path.basename(run),started:new Date().toISOString(),complete:false};
 const save=()=>writeJson(journal,r),capture=path.join(state,'native-fs/fs-4.bin');save();
 const b=new Bridge();let sd,allocation,mapped,data,output,native,initialized=false,held=false;
 async function releaseRuntime(){
  check(!b.c.pending,'Preparation runtime is pending');
  for(const page of [...mapped.pages].reverse())if(page.mapped){check(!(await b.c.unmap(b.h,b.pid,BigInt(page.source),BigInt(page.address))).result,'Cannot release SD inventory code alias');page.mapped=false;}
  await b.call(0x215800,[b.base+0x11ee960n,BigInt(mapped.source),mapped.allocationBytes],'free-SD-inventory-code');mapped.released=true;await b.releaseControl();await b.close();r.released=true;save();
 }
 try{
  await b.open(run,{captureFile:capture,client:options.client,processHandle:options.processHandle});sd=await openSource(run,b);
  allocation=await b.call(0x694c0,[4096],'allocate-SD-inventory',{clearAllocation:true});check(allocation>=0x100000000n&&allocation<0x8000000000n,'Native SD inventory allocation failed');b.control=allocation;b.resultAddress=allocation+896n;r.context=String(allocation);save();
  const input=Buffer.alloc(4096),values=[BigInt(sd.filesystem.object)+8n,b.base+0x1048c0n,b.base+0x105800n,b.base+0x105720n,b.base+0x694c0n,b.base+0x69580n,allocation+1024n];
  values.forEach((value,i)=>input.writeBigUInt64LE(value,i*8));[b.base+0x11ee960n,b.base+0x215620n,b.base+0x215800n].forEach((value,i)=>input.writeBigUInt64LE(value,864+i*8));input.write(source,1024);await b.writeData(Number(allocation),Buffer.alloc(input.length),input);initialized=true;
  native=runtime(0n,0n);const code=Buffer.alloc((native.code.length+4095)&~4095);native.code.copy(code);
  mapped=await b.mapRuntime(code,record=>{r.runtime=record;save();},allocation+4088n);
  output=await b.callRuntime(native.offsets.lfs_inventory,[allocation],'walk-SD-mod-directories');
  const header=await b.m.read(Number(allocation),864),pointer=header.readBigUInt64LE(56),length=header.readBigUInt64LE(64),capacity=header.readBigUInt64LE(72),count=header.readBigUInt64LE(80),error=header.readUInt32LE(88);
  r.data=String(pointer);r.bytes=String(length);r.capacity=String(capacity);r.count=String(count);r.result=String(output);save();
  check(output===0n&&!error,'SD inventory failed at '+header.subarray(96).toString('utf8').split('\0')[0]+': 0x'+output.toString(16));
  check(pointer>=0x100000000n&&pointer<0x8000000000n&&length<=capacity&&capacity<=BigInt(Number.MAX_SAFE_INTEGER)&&length<=BigInt(require('node:buffer').constants.MAX_LENGTH),'Native SD inventory output is invalid');
  data=Buffer.alloc(Number(length));
  for(let at=0;at<data.length;){
   const address=pointer+BigInt(at),info=await b.c.info(b.h,address,b.pid);check(!info.result&&info.memory.permissions===3&&!info.memory.attributes,'SD inventory output is not readable data');
   const n=Math.min(0x100000,data.length-at,Number(BigInt(info.memory.address)+BigInt(info.memory.size)-address));check(n>0,'Invalid SD inventory output span');
   let bytes;if(info.memory.type===4){const read=await b.c.readBulk(b.h,b.pid,address,n);check(!read.result&&read.length===n&&!read.data.readBigUInt64LE(32)&&!read.data.readBigUInt64LE(40),'Cannot read native SD inventory');bytes=read.bytes;}else bytes=await b.m.read(Number(address),n);
   bytes.copy(data,at);at+=n;
  }
  const tree=decodeInventory(data,Number(count),source);r.complete=true;held=true;r.runtimeHeldForInstallation=true;
  const bootstrap={bridge:b,transferred:false,async release(){if(!bootstrap.transferred&&!r.released)await releaseRuntime();},transfer(){bootstrap.transferred=true;r.runtimeHeldForInstallation=false;r.transferredToResident=true;save();}};
  return{tree,bootstrap};
 }catch(error){r.error=error.stack;throw error;}
 finally{
  if(b.c&&!b.c.pending&&(!r.runtime||mapped)){
   if(initialized&&mapped?.published)check(await b.callRuntime(native.offsets.lfs_inventory_release,[allocation],'free-SD-inventory-list')===0n,'Cannot release the SD inventory');
   if(allocation&&!held)await b.releaseControl();
   if(sd)await sd.close();
   if(!held){if(mapped)await releaseRuntime();else{await b.close();r.released=true;}}
  }else r.resourcesRetained=true;
  r.finished=new Date().toISOString();save();
 }
}
module.exports={scanSd,decodeInventory};
