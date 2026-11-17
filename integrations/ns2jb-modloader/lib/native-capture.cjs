'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {check,writeJson}=require('./common.cjs');
const {validateCapture}=require('./native.cjs');
const {profile,validateFsMappings}=require('./native/fs-abi.cjs');
const {identifyFs,verifyBulk}=require('./native/identity.cjs');
async function readNativeText(c,handle,base,identity,mappings=[]){
 identity=identity||await identifyFs(c,handle);
 base=BigInt(base);const bytes=Buffer.alloc(profile.captureSize),spans=[];
 for(const range of [...profile.ranges,profile.padding].sort((a,b)=>a.offset-b.offset)){
  const last=spans.at(-1),end=range.offset+range.size;
  // Coalesce reads within one mapped page without making the intervening
  // bytes part of ABI qualification. Avoid an RPC round trip per function.
  if(last&&(range.offset<=last.end||Math.floor(range.offset/4096)===Math.floor((last.end-1)/4096)))last.end=Math.max(last.end,end);else spans.push({offset:range.offset,end});
 }
 let regionEnd=base;
 for(const span of spans){
  let off=span.offset;
  while(off<span.end){
   const address=base+BigInt(off);
   if(address>=regionEnd){
    const info=await c.info(handle,address,identity.pid);
    // A capture contains code and read-only data. Its pages need not all be
    // executable. Function bytes are qualified separately before any patch.
    const accepted=!info.result&&!info.queryResult&&info.pid===String(identity.pid)&&info.programId===identity.programId&&
     [1,4,5].includes(info.memory?.permissions)&&[3,4].includes(info.memory?.type)&&info.memory.attributes===0;
    if(!accepted){const error=Error('Cannot read native FS profile at FS+0x'+off.toString(16)+' (permissions='+info.memory?.permissions+', attributes='+info.memory?.attributes+', queryResult='+info.queryResult+', result='+info.result+')');error.fsCompatibility={stage:'capture-mapping',offset:off,identity:{pid:String(identity.pid),programId:identity.programId},observed:info};throw error;}
    const start=BigInt(info.memory.address),size=BigInt(info.memory.size);regionEnd=start+size;
    check(size>0n&&start<=address&&regionEnd>address,'Incomplete native FS mapping');
    mappings.push({offset:Number(start-base),end:Number(regionEnd-base),permissions:info.memory.permissions});
   }
   const n=Math.min(0x200000,span.end-off,Number(regionEnd-address)),r=await c.readBulk(handle,identity.pid,address,n);
   verifyBulk(r,identity,n,{partial:true}).copy(bytes,off);off+=r.length;
  }
 }
 return bytes;
}
async function readExecutableText(c,handle,base,identity,mappings=[]){
 base=BigInt(base);
 const info=await c.info(handle,base,identity.pid),memory=info.memory;
 check(!info.result&&!info.queryResult&&info.pid===String(identity.pid)&&info.programId===identity.programId&&memory&&BigInt(memory.address)===base&&[4,5].includes(memory.permissions)&&[3,4].includes(memory.type)&&!memory.attributes,'Cannot qualify native FS executable segment');
 const size=Number(memory.size);check(Number.isSafeInteger(size)&&size>=4096&&size<=64*1024*1024&&size%4096===0,'Invalid native FS executable segment size');
 const bytes=Buffer.alloc(size);mappings.push({offset:0,end:size,permissions:memory.permissions});
 for(let at=0;at<size;){
  const n=Math.min(0x200000,size-at),reply=await c.readBulk(handle,identity.pid,base+BigInt(at),n),part=verifyBulk(reply,identity,n,{partial:true});part.copy(bytes,at);at+=part.length;
 }
 return bytes;
}
async function finishFailedCapture(c,error){
 if(!c.pending){try{await c.close();error.retrySafe=true;return true;}catch{}}
 return false;
}
async function captureNative(run,directory,options={}){
 const session=path.basename(run),current=JSON.parse(await fs.readFile(path.join(run,'switch2/fs-execution-current.json'))),proof=JSON.parse(await fs.readFile(path.resolve(run,current.file)));
 check(current.verified&&proof.verified&&proof.session===session,'Missing same-session FS 4/4 proof');
 const c=await require('./native/client.cjs').openClient(run);
 const output=path.join(directory,'native-fs/fs-4.bin');await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
 let transferred=false,closed=false,identity;
 try{
  const handle=await c.fsProcess();identity=await identifyFs(c,handle,proof.identity);
  let mappings=[],bytes,validation;
  try{bytes=await readNativeText(c,handle,BigInt(proof.mapping.memory.address),identity,mappings);await fs.writeFile(output,bytes,{mode:0o600});validation=validateCapture(bytes,{relocate:false});}
  catch(error){
   if(!['native-functions','capture-mapping'].includes(error.fsCompatibility?.stage))throw error;
   mappings=[];bytes=await readExecutableText(c,handle,BigInt(proof.mapping.memory.address),identity,mappings);
   await fs.writeFile(output,bytes,{mode:0o600});
   validation=validateCapture(bytes);
  }
  const mappingValidation=validateFsMappings(mappings,validation.layout);
  for(const reference of require('./native/fs-contract.json').data){
   const offset=require('./native/fs-layout.cjs').offset(validation.layout,reference.offset),address=BigInt(proof.mapping.memory.address)+BigInt(offset),info=await c.info(handle,address,identity.pid);
   check(!info.result&&!info.queryResult&&info.pid===String(identity.pid)&&info.programId===identity.programId&&info.memory?.permissions===3&&[3,4,5].includes(info.memory.type)&&!info.memory.attributes&&BigInt(info.memory.address)<=address&&address+16n<=BigInt(info.memory.address)+BigInt(info.memory.size),'Native FS global is not backed by writable memory: FS+0x'+offset.toString(16));
  }
  writeJson(path.join(directory,'native-fs/manifest.json'),{session,verified:true,pid:String(identity.pid),programId:identity.programId,size:bytes.length,mappings,...validation,...mappingValidation,runtimeLoggingCompatible:validation.runtimeLoggingCompatible&&mappingValidation.loggingExecutable});
  if(options.retainClient){transferred=true;return{file:output,client:c,processHandle:handle};}return output;
 }catch(error){
  writeJson(path.join(directory,'native-fs/compatibility.json'),{session,verified:false,...(identity?{pid:String(identity.pid),programId:identity.programId}:{}),error:error.message,...error.fsCompatibility});
  closed=await finishFailedCapture(c,error);
  throw error;
 }finally{if(!transferred&&!closed&&!c.pending)await c.close();}
}
module.exports={captureNative,readNativeText,readExecutableText,finishFailedCapture};
