// Real local TCP and generated receiver calls, with SDK semantics modeled in
// bounded memory. This is protocol validation, not a physical Switch test.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),zlib=require('node:zlib');
const S=require('../server/streaming/lib/pc-screen.cjs'),D=require('../server/streaming/lib/block-delta.cjs'),{programs}=require('../server/streaming/lib/delta-programs.cjs'),{receiver}=require('../server/streaming/lib/pc-stream-delta.cjs');
const sdk=0x20000000,mapped=0x30000000,code=require('../server/streaming/run13/abi/thread-code.json').functions,defs=require('../server/streaming/run13/abi/zlib-functions.json'),sock=require('../server/streaming/run13/abi/ftp-functions.json');
for(const directInflate of [false,true])test((directInflate?'Direct inflate: ':'Buffered inflate: ')+'Post-menu dictionary receiver completes 160 persistent length-framed TCP frames, ACKs verified data, and joins on close',{timeout:15000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'run10-delta-model-')),oldHost=process.env.HB_STREAM_HOST;process.env.HB_STREAM_HOST='127.0.0.1';
 const segments=[{base:mapped,b:Buffer.alloc(0x800000)},{base:sdk,b:Buffer.alloc(0x1000000)},{base:0x50000000,b:Buffer.alloc(0x10000)}];let alloc=0x10000000,graph,done=false,fatal,runner;const sockets=new Map(),streams=new Map();let nextFd=10,acks=0,connects=0,corruptCRC=false,truncateReads=false;
 function memory(p,n){assert.ok(Number.isSafeInteger(p)&&Number.isInteger(n)&&n>=0,'Bad model span');const s=segments.find(s=>p>=s.base&&p+n<=s.base+s.b.length);assert.ok(s,`Out-of-bounds SDK span ${p.toString(16)} + ${n}`);return s.b.subarray(p-s.base,p-s.base+n);}
 const put64=(p,n)=>memory(p,8).writeBigUInt64LE(BigInt.asUintN(64,BigInt(n))),get64=p=>Number(memory(p,8).readBigUInt64LE());
 const version=sdk+0xaa85b5;Buffer.from('1.2.11\0').copy(memory(version,16));
 const fname=Object.fromEntries(Object.entries(defs).map(([n,d])=>[sdk+d.offset,n.replace('nnutilZlib_','')]));Object.entries(sock).forEach(([n,d])=>fname[sdk+d.offset]=n);fname[sdk+require('../server/streaming/run13/abi/connect-function.json').offset]='connect';
 function latch(){const h=memory(mapped+S.HEADER,96),pub=h.readUInt32LE();if(!pub||pub===h.readUInt32LE(12))return;if(h.readUInt32LE(76)&&(h.readUInt32LE(64)!==h.readUInt32LE(72)||h.readUInt32LE(68))){h.writeUInt32LE(1,80);h.copy(h,32,56,64);return;}h.writeUInt32LE(pub,12);if(h.readUInt32LE(76))h.copy(h,32,(pub&1)?40:48,(pub&1)?48:56);}
 async function invoke(fn,args){const [a,b,c,d]=args,n=fname[fn];
  if(fn===sdk+0x586fb0){Buffer.from(memory(b,c)).copy(memory(a,c));if(a===mapped+S.HEADER)setTimeout(latch,1);return BigInt(a);}
  if(n==='zlibVersion')return BigInt(version);
  if(n==='inflateInit2_'){assert.equal(b,0xfffffff1);assert.equal(d,112);streams.set(a,{});put64(a+56,0x70000000);return 0n;}
  if(n==='inflateReset'){streams.set(a,{});put64(a+40,0);return 0n;}
  if(n==='inflateSetDictionary'){streams.get(a).dictionary=Buffer.from(memory(b,c));return 0n;}
  if(n==='inflate'){
   const s=streams.get(a),input=get64(a),n=memory(a+8,4).readUInt32LE(),output=get64(a+24),cap=memory(a+32,4).readUInt32LE();
   try{const raw=zlib.inflateRawSync(memory(input,n),{dictionary:s.dictionary,maxOutputLength:Math.max(1,cap)});assert.ok(raw.length<=cap);raw.copy(memory(output,cap));memory(a+8,4).writeUInt32LE(0);put64(a+40,raw.length);put64(a+24,output+raw.length);memory(a+32,4).writeUInt32LE(cap-raw.length);return 1n;}catch(e){if(e.code==='ERR_ASSERTION')throw e;return 0xfffffffdn;}
  }
  if(n==='inflateEnd'){streams.delete(a);return 0n;}
  if(n==='crc32')return BigInt((D.crc32(memory(b,c))^(corruptCRC?1:0))>>>0);
  if(n==='netAddress'){Buffer.from([127,0,0,1]).copy(memory(a,4));return 0n;}
  if(n==='socket'){const fd=nextFd++;sockets.set(fd,null);return BigInt(fd);}
  if(n==='connect'){connects++;const sa=memory(b,16),socket=net.createConnection({host:[...sa.subarray(4,8)].join('.'),port:sa.readUInt16BE(2),allowHalfOpen:true});const state={socket,buffer:Buffer.alloc(0),ended:false,wake:null};
   socket.on('data',p=>{state.buffer=Buffer.concat([state.buffer,p]);state.wake?.();});socket.on('end',()=>{state.ended=true;state.wake?.();});socket.on('error',()=>{state.ended=true;state.wake?.();});socket.on('close',()=>{state.ended=true;state.wake?.();});sockets.set(a,state);
   try{await new Promise((r,j)=>{socket.once('connect',r);socket.once('error',j);});return 0n;}catch{return 0xffffffffn;}}
  if(n==='recv'){if(truncateReads)return c===graph.layout.header?-1n:0n;const state=sockets.get(a);if(!state||state.ended&&!state.buffer.length)return 0n;while(state.buffer.length<c&&!state.ended)await new Promise(r=>{state.wake=r;});state.wake=null;const count=Math.min(c,state.buffer.length);state.buffer.copy(memory(b,c),0,0,count);state.buffer=state.buffer.subarray(count);return BigInt(count);}
  if(n==='send'){const socket=sockets.get(a).socket;const packet=Buffer.from(memory(b,c));socket.write(packet.subarray(0,13));socket.write(packet.subarray(13));return BigInt(c);}
  if(n==='socketClose'){sockets.get(a)?.socket.end();sockets.delete(a);return 0n;}
  throw Error('Unexpected SDK model function '+fn.toString(16)+' '+n);
 }
 const rpc={a:{sdk,session:'model'},output:0x50000000,async request(){return {ready:true};},async read(p,n){return Buffer.from(memory(p,n));},async write(p,b){b.copy(memory(p,b.length));},async call(offset,args){assert.equal(offset,5732112);const base=alloc;alloc+=0x800000;segments.push({base,b:Buffer.alloc(args[2])});put64(args[0],base);return {result:0n,output:Buffer.from(memory(0x50000000,0x10000))};},async callAddress(fn,args){
  if(fn===sdk+code.create.offset){put64(args[0],1);done=false;runner=(async()=>{let at=graph.addresses.boot;while(at!==graph.addresses.exit){const f=graph.frames.find(f=>f.at===at);assert.ok(f);let jumped=false;for(let i=0;i<f.calls.length;i++){const call=f.calls[i],resolved=call.args.map(v=>typeof v==='object'?v.u32!==undefined?memory(v.u32,4).readUInt32LE():get64(v.u64):v);
    if(call.function===sdk+code.longjmp.offset){at=resolved[0];jumped=true;break;}if(call.function===sdk+code.sleep.offset){await new Promise(r=>setTimeout(r,1));continue;}
    const result=await invoke(call.function,resolved),native=f.proof.logicalResultIndices[i],dest=Number(f.frame.readBigUInt64LE(f.proof.stackOffset+native*0x140+0x118));put64(dest,result);
   }assert.ok(jumped);}done=true;})().catch(e=>{fatal=e;done=true;});return {result:0n};}
  if(fn===sdk+code.tryWait.offset)return {result:done?1n:0n};if(fn===sdk+code.join.offset){if(fatal)throw fatal;return {result:0n};}return {result:await invoke(fn,args)};
 }};
 let r;
 try{
  for(const [name,data]of Object.entries({'launcher-auto.json':{ready:true,firstShaderFramePresented:true,scratchRestored:true},'launcher-auto-check.json':{passed:true,scratchRestored:true},'launcher-auto-loop.json':{threadRunning:true}}))await fs.writeFile(path.join(directory,name),JSON.stringify({session:'model',...data}));
  r=await receiver({rpc,mapped,directory,onInput:()=>acks++,programFactory:args=>(graph=programs({...args,directInflate}))});
  await r.prepare(320,200,2);await r.prepare(320,200,2);assert.equal(acks,0);assert.equal(connects,1);assert.equal(memory(mapped+S.HEADER,4).readUInt32LE(),0);
  const frame=Buffer.alloc(65024);for(let i=0;i<frame.length;i++)frame[i]=(i*17)&255;
  for(let i=0;i<160;i++){
   if(i===8||i===80)await new Promise(r=>setTimeout(r,20));
   if(i===80){const allocations=segments.length;await r.reset();await runner;assert.equal(done,true);assert.equal(streams.size,1);await r.prepare(320,200,2);assert.equal(segments.length,allocations,'Reconnect reuses the joined worker allocation');assert.equal(connects,2);}
   frame.fill((i+10)&255,150+i*20,170+i*20);const ack=await r.push(frame,320,200,Buffer.alloc(32),2);assert.equal(ack,i&1?3:2);assert.deepEqual(memory(mapped+S.SLOT+(ack&1)*S.STRIDE,frame.length),frame);
  }
  assert.equal(acks,160);assert.equal(connects,2);corruptCRC=true;await assert.rejects(r.push(frame,320,200,Buffer.alloc(32),2),/checksum rejected/);assert.equal(acks,160);assert.equal(connects,2);
  // The native call graph currently continues after recv fails. Model a header
  // receive error followed by zero body bytes: a resulting GPU CRC rejection
  // must be classified as truncated transport input, never accepted as a frame.
  await r.reset();corruptCRC=false;truncateReads=true;await r.prepare(320,200,2);
  await assert.rejects(r.push(frame,320,200,Buffer.alloc(32),2),e=>e.code==='FRAME_INPUT_TRUNCATED'&&e.inputFailure.part==='header'&&e.inputFailure.received===-1);
  assert.equal(acks,160);assert.equal(connects,3);assert.equal(r.report.lastState.headerExpectedBytes,graph.layout.header);assert.ok(r.report.lastState.bodyExpectedBytes>0);assert.equal(r.report.inputFailure.sourceError,true);
  try{await r.close();}catch(e){if(fatal)throw fatal;throw e;}await runner;assert.equal(done,true);assert.equal(streams.size,0);assert.equal(r.report.running,false);if(fatal)throw fatal;
 }finally{for(const state of sockets.values())state?.socket.destroy();await r?.close().catch(()=>{});if(oldHost===undefined)delete process.env.HB_STREAM_HOST;else process.env.HB_STREAM_HOST=oldHost;await fs.rm(directory,{recursive:true,force:true});}
});
