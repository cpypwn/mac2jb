'use strict';
// Optional offline qualification with owner-supplied private captures.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateCapture,buildAll}=require('../lib/native.cjs'),{discover,offset}=require('../lib/native/fs-layout.cjs');
const {plan,buildContext,layout}=require('../lib/lazy-context.cjs'),{Bridge}=require('../lib/native/bridge.cjs');
const {ABI,SDK}=require('../lib/native-namespace.cjs');
const {captureNative}=require('../lib/native-capture.cjs');
const files=process.argv.slice(2);assert(files.length,'Pass local FS executable captures; captures are never bundled.');
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fs-relocation-'));
 try{
 const captures=files.map(file=>({bytes:fs.readFileSync(file)})),seed=captures.find(c=>!validateCapture(c.bytes).layout);
 // Only globals move: every original operation remains byte-for-byte equal.
 // The sparse fast path must still notice and request complete discovery.
 if(seed)for(const [i,data]of require('../lib/native/fs-contract.json').data.entries()){
  const bytes=Buffer.from(seed.bytes),word=bytes.readUInt32LE(data.page),delta=i===0?1:-3;
  const immediate=((((word>>>29)&3)|(((word>>>5)&0x7ffff)<<2))+delta)&0x1fffff;
  bytes.writeUInt32LE(((word&0x9f00001f)|((immediate&3)<<29)|((immediate>>>2)<<5))>>>0,data.page);
  captures.push({bytes,expectedGlobal:{reference:data.offset,actual:data.offset+delta*4096}});
 }
 for(const [i,{bytes,expectedGlobal}]of captures.entries()){
  const validation=validateCapture(bytes),resolved=discover(bytes),base=0x4000000000n,context=0x6000000000n;
  if(expectedGlobal){assert(validation.layout,'Global-only relocation must not pass the fixed-address fast path');assert.equal(validation.layout.offsets[expectedGlobal.reference],expectedGlobal.actual);}
  assert.equal(resolved.unavailableLogging.length,0);
  // Exercise the actual PC capture/qualification flow with the supplied code
  // and an RPC contract model; this performs no connection to a console.
  const session='switch2-fixture'+i,run=path.join(directory,session),captured=path.join(directory,'capture'+i);fs.mkdirSync(path.join(run,'switch2'),{recursive:true});
  const proof={verified:true,session,identity:{pid:'13',programId:'0400000000000000'},mapping:{memory:{address:String(base)}}};
  fs.writeFileSync(path.join(run,'switch2/proof.json'),JSON.stringify(proof));fs.writeFileSync(path.join(run,'switch2/fs-execution-current.json'),JSON.stringify({verified:true,file:'switch2/proof.json'}));
  let readBytes=0,closed=false,globalOverride={};
  const client={pending:false,async fsProcess(){return 9;},async close(){closed=true;},async info(handle,address){
   assert.equal(handle,9);const header={result:0,queryResult:0,pid:'13',programId:proof.identity.programId};if(address===undefined)return header;
   const at=Number(address-base),code=at<bytes.length,global=at>=0x800000;
   return{...header,memory:{address:String(code?base:address&~4095n),size:String(code?bytes.length:4096),type:3,attributes:0,permissions:code?4:global?3:1,...(global?globalOverride:{})}};
  },async readBulk(handle,pid,address,size){
   assert.equal(handle,9);assert.equal(pid,13n);readBytes+=size;const at=Number(address-base),result=Buffer.alloc(size);if(at<bytes.length)bytes.copy(result,0,at,Math.min(at+size,bytes.length));
   const data=Buffer.alloc(56);data.writeBigUInt64LE(pid);data.writeBigUInt64LE(BigInt('0x'+proof.identity.programId),8);data.writeBigUInt64LE(BigInt(size),48);return{result:0,length:size,data,bytes:result};
  }};
  const clientPath=require.resolve('../lib/native/client.cjs');require(clientPath);require.cache[clientPath].exports={openClient:async()=>client};
  const captureFile=await captureNative(run,captured);assert(closed);
  const manifest=JSON.parse(fs.readFileSync(path.join(captured,'native-fs/manifest.json')));assert.equal(manifest.validatedRanges,require('../lib/native/fs-abi.json').ranges.length);assert.equal(manifest.runtimeLoggingCompatible,true);
  if(validation.layout){assert.equal(manifest.layout.kind,'relocated');assert(readBytes>=bytes.length);}else assert(readBytes<bytes.length/16,'Known FS must retain its sparse fast capture');
  if(!validation.layout)for(const invalid of [{permissions:1},{type:1},{attributes:1},{size:8}]){
   globalOverride=invalid;closed=false;await assert.rejects(captureNative(run,path.join(directory,'invalid'+Object.keys(invalid)[0])),/global is not backed by writable memory/);assert(closed);
  }
  globalOverride={};
  const p=plan({games:[{titleId:'0400000000001000',romfs:[{path:'/fixture',type:'file',size:4,sdPath:'/ns2jb-modloader/contents/0400000000001000/romfs/fixture'}],exefs:[],patches:[],stubs:[]}],patches:[]},'switch2-test');
  const n=await buildAll(base,context,p,{capture:captureFile,directory:path.join(directory,String(i))}),l=layout(p),c=buildContext(p,{filesystem:{object:0x6100001000n},registry:0x6100003000n},base,context,n);
  const address=reference=>base+BigInt(offset(resolved,reference)),bridge=new Bridge();Object.assign(bridge,{base,layout:resolved});
  for(const r of require('../lib/native/fs-contract.json').ranges)if(!r.optional)assert.equal(bridge.address(r.offset),address(r.offset));
  for(const [at,reference]of [[104,0x694c0],[112,0x1077b0],[136,0x69580],[l.lazyOffset+8,0x121400],[l.lazyOffset+16,0x24a7a0],[l.lazyOffset+24,0x11ee960],[l.lazyOffset+32,0x215620],[l.lazyOffset+40,0x215800],[l.lazyOffset+184,0x107bc0],[l.lazyOffset+192,0x107cd0]])assert.equal(c.readBigUInt64LE(at),address(reference));
  for(const [symbol,reference]of [['lfs_mutex_lock_address',0x2187d0],['lfs_mutex_unlock_address',0x218870]])assert.equal(n.runtimeCode.readBigUInt64LE(n.offsets[symbol]),address(reference));
  const hooks={...Object.fromEntries(Object.entries(ABI).map(([name,a])=>['ExeFS.'+name,a.offset])),...Object.fromEntries(Object.entries(SDK).map(([name,a])=>['SDK.'+name,a.offset])),'RomFS.Read':0x107570,'RomFS.GetSize':0x107600,'RomFS.OperateRange':0x107650,'RomFS.BatchRead':0x11fed0,'RomFS.Mount.current':0xedb60,'RomFS.Mount.program':0xedbe0,'RomFS.Mount.data':0xedc60};
  for(const hook of n.hooks){assert.equal(BigInt(hook.target),address(hooks[hook.name]));assert.equal(hook.originalHex,bytes.subarray(hook.offset,hook.offset+16).toString('hex'));}
  assert.equal(n.codeBytes,816);assert.equal(n.hooks.length,19);
  console.log('Capture '+(i+1)+': '+validation.validatedRanges+' ABI ranges, 19 hooks, registry/block globals, resident context and mutex bindings qualified'+(expectedGlobal?' (independent global relocation)':'')+'.');
 }}finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
