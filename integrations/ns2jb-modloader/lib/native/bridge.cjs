'use strict';
// Temporary, instance-guarded native calls. Used only while the owned notifier
// and the original SmileBASIC controller are alive. Never the resident reader.
const fs=require('node:fs/promises'),path=require('node:path');
const {identifyFs,verifyBulk}=require('./identity.cjs');
const check=(x,s)=>{if(!x)throw Error(s);};
const CAVE=0x24d100,NOTIFIER=0x1201b0,WIDTH=1024;
function selectNotifier(state,proof,notifier){
 check(state.worker?.joined,'Native worker is active');
 const candidate=proof.notifier;
 if(candidate)check(candidate.object===notifier.E&&candidate.backend===notifier.B,'Owned notifier differs from the current FS proof');
 const handle=candidate?.handle??(state.notifiers?.length===1?state.notifiers[0]:null);
 check(handle&&state.notifiers?.includes(handle),'The verified owned notifier is unavailable');
 return handle;
}
class Bridge {
 async open(run,options={}) {
  this.caveOffset=options.caveOffset??CAVE;check([CAVE,0x24d800].includes(this.caveOffset),'Unqualified native cave');
  this.run=path.resolve(run);this.session=path.basename(this.run);
  this.dir=path.join(options.directory||path.join(__dirname,'../../state',this.session),'bridge-'+Date.now());await fs.mkdir(this.dir,{recursive:true});
  this.record={session:this.session,operations:[],resourcesRetained:false};this.journal=path.join(this.dir,'journal.json');await this.save();
  this.c=options.client||await require('./client.cjs').openClient(this.run);check(this.c.record.session===this.session&&!this.c.pending,'Native client is from another session or is busy');this.m=this.c.memory;this.h=options.processHandle??await this.c.fsProcess();
  const current=JSON.parse(await fs.readFile(path.join(this.run,'switch2/fs-execution-current.json')));
  const proof=JSON.parse(await fs.readFile(path.resolve(this.run,current.file)));check(current.verified&&proof.verified&&proof.session===this.session,'Wrong FS proof');
  this.identity=await identifyFs(this.c,this.h,proof.identity);this.pid=this.identity.pid;
  // Read supported mappings in one process-service transfer. Normal heap
  // allocations still use the retained endpoint supported by this session.
  const retainedRead=this.m.read.bind(this.m);
  this.m.read=async(at,size)=>{
   check(Number.isSafeInteger(at)&&at>=2**32&&Number.isInteger(size)&&size>0&&at+size<=2**39,'Invalid FS data read');
   const parts=[];let read=0;
   while(read<size){
    const address=BigInt(at+read),info=await this.c.info(this.h,address,this.pid);
    check(!info.result,'Cannot qualify native data read');
    const end=BigInt(info.memory.address)+BigInt(info.memory.size),n=Math.min(size-read,0x200000,Number(end-address));check(n>0,'Native data mapping is incomplete');
    if(!info.memory.attributes&&[3,4].includes(info.memory.type)&&[1,3,5].includes(info.memory.permissions)){
     if(n<=128)parts.push(await this.read(address,n));
     else{
      const r=await this.c.readBulk(this.h,this.pid,address,n);
      parts.push(verifyBulk(r,this.identity,n));
     }
    }else parts.push(await retainedRead(at+read,n));
    read+=n;
   }
   return parts.length===1?parts[0]:Buffer.concat(parts,size);
  };
  this.base=BigInt(proof.mapping.memory.address);this.cave=this.base+BigInt(this.caveOffset);this.page=this.base+BigInt(this.caveOffset&~4095);
  this.notifier=JSON.parse(await fs.readFile(path.join(this.run,'switch2/ro',this.session+'-notifier-proof.json')));
  check(this.notifier.identityVerified&&await this.m.pointer(this.notifier.E+8)===this.notifier.B&&await this.m.u32(this.notifier.E+16)===1,'Notifier is not exclusively owned');
  const state=await this.m.request({command:'root-native-info'});this.handle=selectNotifier(state,proof,this.notifier);
  this.capture=await fs.readFile(options.captureFile);
  this.original=await this.read(this.base+BigInt(NOTIFIER),16);
  check(this.original.equals(this.capture.subarray(NOTIFIER,NOTIFIER+16)),'Notifier instructions changed');
  this.previous=Buffer.alloc(this.caveOffset===CAVE?WIDTH:256);check((await this.read(this.cave,this.previous.length)).equals(this.previous),'Temporary cave already occupied');
  const mapping=await this.c.info(this.h,this.page,this.pid);this.originalPermission=mapping.memory.permissions;
  check(!mapping.result&&[4,5].includes(this.originalPermission),'Wrong native text page permissions');
  const r=await this.c.request(0x524f0015,this.h,[this.pid,this.page,4096n,5n]);check(!r.result,'Cannot read cave literals');this.readable=true;
  this.hook=Buffer.alloc(16);this.hook.writeUInt32LE((0x14000000|(this.caveOffset-NOTIFIER)/4)>>>0);for(let i=4;i<16;i+=4)this.hook.writeUInt32LE(0xd503201f,i);
  this.record.base=this.base.toString();this.record.notifier=this.notifier;await this.save();return this;
 }
 async save(){await fs.writeFile(this.journal,JSON.stringify(this.record,null,2)+'\n',{mode:0o600});}
 async read(at,size) {
  at=BigInt(at);
  if(size>128&&at>=this.base&&at+BigInt(size)<=this.base+BigInt(this.capture?.length||0)){
   const r=await this.c.readBulk(this.h,this.pid,at,size);
   return verifyBulk(r,this.identity,size);
  }
  const out=[];for(let p=0;p<size;){const n=Math.min(128,size-p,4096-Number((at+BigInt(p))&4095n)),r=await this.c.read(this.h,this.pid,at+BigInt(p),n);check(!r.result&&!r.unmapResult,'Native read failed');out.push(Buffer.from(r.hex,'hex'));p+=n;}return Buffer.concat(out);
 }
 async patch(at,before,after) {
  const r=await this.c.patch(this.h,this.pid,at,before,after);
  check(!r.result&&r.expectedMatched&&r.readbackMatched&&!r.unmapResult,'Native instruction patch failed');
 }
 async writeData(at,before,after){
  check(Buffer.isBuffer(before)&&Buffer.isBuffer(after)&&before.length===after.length&&after.length>0&&after.length<=0x10000,'Invalid native data write');
  // The retained endpoint compares the preimage and verifies its own readback.
  // Use that result directly instead of repeating both reads on the PC.
  if(typeof this.m.writeBytes==='function')return this.m.writeBytes(Number(at),before,after);
  return this.m.write(Number(at),before,after);
 }
 async stage(bytes) {
  check(!this.hooked&&!this.c.pending&&bytes.length<=this.previous.length,'Bridge is busy or code too large');
  const next=Buffer.alloc(this.previous.length);bytes.copy(next);
  for(let i=0;i<next.length;i+=16)if(!next.subarray(i,i+16).equals(this.previous.subarray(i,i+16)))await this.patch(this.cave+BigInt(i),this.previous.subarray(i,i+16),next.subarray(i,i+16));
  this.previous=next;
 }
 async detach() {if(this.hooked){await this.patch(this.base+BigInt(NOTIFIER),this.hook,this.original);this.hooked=false;}}
 async controlCave(){
  check(!this.hooked&&!this.c.pending&&this.caveOffset===CAVE,'Native bridge is busy');
  const cave=this.base+0x24d800n,previous=Buffer.alloc(256);
  check((await this.read(cave,previous.length)).equals(previous),'Control cave is already occupied');
  this.caveOffset=0x24d800;this.cave=cave;this.previous=previous;
  this.hook.writeUInt32LE((0x14000000|(this.caveOffset-NOTIFIER)/4)>>>0);
 }
 async releaseControl(){
  if(!this.control)return;
  const address=this.control;this.resultAddress=0n;
  await this.call(0x69580,[address,4096],'free-native-control');this.control=0n;
 }
 async call(offset,args,label,options={}) {
  check(Number.isInteger(offset)&&offset>=0&&offset+16<this.capture.length&&args.length<=6,'Invalid native call');
  if(options.clearAllocation)check(offset===0x694c0&&args.length===1&&BigInt(args[0])>0n&&BigInt(args[0])<=0x100000n,'Invalid cleared native allocation');
  check((await this.read(this.base+BigInt(offset),16)).equals(this.capture.subarray(offset,offset+16)),'Call target differs');
  const row={label,offset,args:args.map(String),pending:true};this.record.operations.push(row);await this.save();
  return this.invoke(args,row,this.base+BigInt(offset),false,options);
 }
 async invoke(args,row,operation,publish=false,options={}){
  this.progress?.(row.label,'preparing');
  const resultAddress=this.resultAddress||BigInt(this.notifier.E)+8n;
  const code=require('./artifacts.cjs').bridge(this.cave,this.notifier.E,args,{operation,result:resultAddress,clearAllocation:options.clearAllocation,original_tail:this.base+BigInt(NOTIFIER)+16n},publish);
  await this.stage(code);await this.patch(this.base+BigInt(NOTIFIER),this.original,this.hook);this.hooked=true;
  try {
   this.progress?.(row.label,'awaiting-native-reply');
   const r=await this.c.probeNotifier(this.handle);
   check(!r.transport&&r.canonicalResult===0x6dfe&&!r.copies.length&&!r.moves.length,'Native bridge did not return the nonce');
   row.result=(await this.m.u64(Number(resultAddress))).toString();row.pending=false;await this.save();this.progress?.(row.label,'complete');return BigInt(row.result);
  } finally {
   if(!this.c.pending){if(!this.resultAddress){const r=await this.m.u64(this.notifier.E+8);if(r!==BigInt(this.notifier.B))await this.m.writeU64(this.notifier.E+8,r,this.notifier.B);}await this.detach();}
  }
 }
 async mapRuntime(code,save,output){
  check(Buffer.isBuffer(code)&&code.length>0&&code.length%4096===0,'Runtime pages are incomplete');
  check(BigInt(output)>0n,'Missing owned allocation output');
  const manager=this.base+0x11ee960n,result=await this.call(0x215620,[manager,output,code.length],'allocate-resident-code');check(result===0n,'Cannot reserve native executable pages: '+result);
  const allocated=await this.m.u64(Number(output)),source=allocated,record={allocated:String(allocated),allocationKind:'SDK memory block',allocationBytes:code.length,source:String(source),address:null,bytes:code.length,pages:[],published:false};await save(record);
  const info=await this.c.info(this.h,source,this.pid),address=BigInt(info.freeAddress||0);
  check(allocated>=0x100000000n&&allocated<0x8000000000n&&!info.result&&info.memory.type===5&&info.memory.permissions===3&&!info.memory.attributes&&source+BigInt(code.length)<=BigInt(info.memory.address)+BigInt(info.memory.size),'Resident code allocation is not Normal/RW memory');
  const target=await this.c.info(this.h,address,this.pid);check(address>0n&&address%4096n===0n&&!target.result&&target.memory.type===0&&address+BigInt(code.length)<=BigInt(target.memory.address)+BigInt(target.memory.size),'No free resident code mapping');
  record.address=String(address);await save(record);
  for(let off=0;off<code.length;off+=0x10000){const at=Number(source)+off,part=code.subarray(off,off+0x10000);await this.writeData(at,await this.m.read(at,part.length),part);}
  for(let off=0;off<code.length;off+=4096){const page={source:String(source+BigInt(off)),address:String(address+BigInt(off)),pending:true};record.pages.push(page);await save(record);const r=await this.c.map(this.h,this.pid,BigInt(page.source),BigInt(page.address));check(!r.result&&!r.mapResult&&!r.permissionResult,'Cannot map resident RX code');page.pending=false;page.mapped=true;await save(record);}
  const row={label:'publish-resident-code',args:[String(address),String(code.length)],pending:true};this.record.operations.push(row);await this.save();await this.invoke([address,BigInt(code.length)],row,0n,true);record.published=true;await save(record);this.runtime=record;this.runtimeCode=Buffer.from(code);return record;
 }
 async replaceRuntime(code,save){
  const record=this.runtime;check(record?.published&&!this.hooked&&!this.c.pending&&Buffer.isBuffer(code)&&code.length===record.bytes,'Runtime is not idle or its size changed');
  const changed=record.pages.filter((page,i)=>!this.runtimeCode||!code.subarray(i*4096,(i+1)*4096).equals(this.runtimeCode.subarray(i*4096,(i+1)*4096)));
  if(!changed.length)return record;
  record.published=false;await save(record);
  for(const page of [...changed].reverse())if(page.mapped){check(!(await this.c.unmap(this.h,this.pid,BigInt(page.source),BigInt(page.address))).result,'Cannot release preparation code alias');page.mapped=false;await save(record);}
  for(const page of changed){const off=Number(BigInt(page.source)-BigInt(record.source)),part=code.subarray(off,off+4096),before=this.runtimeCode?.subarray(off,off+4096)||await this.m.read(Number(page.source),4096);await this.writeData(Number(page.source),before,part);}
  for(const page of changed){page.pending=true;await save(record);const r=await this.c.map(this.h,this.pid,BigInt(page.source),BigInt(page.address));check(!r.result&&!r.mapResult&&!r.permissionResult,'Cannot map resident code alias');page.pending=false;page.mapped=true;await save(record);}
  const row={label:'publish-prepared-runtime',args:[record.address,String(code.length)],pending:true};this.record.operations.push(row);await this.save();await this.invoke([BigInt(record.address),BigInt(code.length)],row,0n,true);record.published=true;await save(record);this.runtimeCode=Buffer.from(code);return record;
 }
 async callRuntime(offset,args,label){
  check(this.runtime?.published&&Number.isSafeInteger(offset)&&offset>=0&&offset+16<=this.runtime.bytes&&args.length<=6,'Unqualified resident entry');const address=BigInt(this.runtime.address)+BigInt(offset);
  const mapping=await this.c.info(this.h,address,this.pid);check(!mapping.result&&mapping.memory.permissions===5,'Resident entry is not RX');
  const row={label,address:String(address),args:args.map(String),pending:true};this.record.operations.push(row);await this.save();return this.invoke(args,row,address);
 }
 async close() {
  if(!this.c)return;
  if(this.c.pending){this.record.resourcesRetained=true;await this.save();return;}
  if(!this.previous){await this.c.close();this.record.closed=true;await this.save();return;}
  await this.detach();await this.stage(Buffer.alloc(0));
  if(this.readable){const r=await this.c.request(0x524f0015,this.h,[this.pid,this.page,4096n,BigInt(this.originalPermission)]);check(!r.result,'Cave readability did not restore');this.readable=false;}
  await this.c.close();this.record.closed=true;await this.save();
 }
}
module.exports={Bridge,CAVE,NOTIFIER,WIDTH,selectNotifier};
