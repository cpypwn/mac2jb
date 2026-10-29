// Re-enter a restored qualified frame on-console; host requests a clean pthread exit.
const {build}=require('../../smilebasic/engine/shared/frames.cjs');
function frame({base,sdk,calls,code,verified=new Set()}){
 const live=base+0x10000,snapshot=base+0x210000,results=base+0x320000,exit=base+0x350000,selector=base+0x3f0000;
 const padded=calls.map(c=>({...c,args:[...c.args,...Array(4-c.args.length).fill(0)]}));
 const restore={function:sdk+0x586fb0,args:[live,snapshot,0,0]},jump={function:sdk+code.longjmp.offset,args:[{u64:selector},1,0,0]};
 let built=build(live,sdk,[...padded,restore,jump],code,false,verified);restore.args[2]=built.frame.length;
 built=build(live,sdk,[...padded,restore,jump],code,false,verified);if(built.frame.length>0x100000||calls.length*8>0x20000)throw Error('Repeating worker exceeds owned regions');
 // Result stores survive restoration so the host can inspect them without pausing frames.
 const addresses=calls.map((_,i)=>{const n=built.proof.logicalResultIndices[i],address=results+i*8;built.frame.writeBigUInt64LE(BigInt(address),built.proof.stackOffset+n*0x140+0x118);return address;});
 const stop=Buffer.alloc(0xb0);stop.writeBigUInt64LE(BigInt(sdk+code.exit.offset),0x58);stop.writeBigUInt64LE(BigInt(base+0x370000),0x68);
 return {...built,live,snapshot,results,exit,selector,stop,addresses};
}
async function prepare(rpc,options){
 const program=frame({...options,sdk:rpc.a.sdk});
 await rpc.write(program.live,program.frame);await rpc.write(program.snapshot,program.frame);await rpc.write(program.results,Buffer.alloc(options.calls.length*8));await rpc.write(program.exit,program.stop);
 const pointer=Buffer.alloc(8);pointer.writeBigUInt64LE(BigInt(program.live));await rpc.write(program.selector,pointer);
 if(!(await rpc.read(program.snapshot,program.frame.length)).equals(program.frame))throw Error('Repeating snapshot readback differs');
 return {...program,async stop(){const p=Buffer.alloc(8);p.writeBigUInt64LE(BigInt(program.exit));await rpc.write(program.selector,p);}};
}
module.exports={frame,prepare};

async function create(rpc){
 const code=require('../../smilebasic/engine/switch2/app/thread-code.json').functions,sdk=rpc.a.sdk;
 for(const f of Object.values(code))await rpc.request({command:'verify-function',address:sdk+f.offset,hex:f.bytes.slice(0,512)});
 await rpc.request({command:'verify-function',address:sdk+0x586fb0,hex:require('./ipc-functions.json').copy.hex});
 const allocation=await rpc.call(5732112,[rpc.output,4096,0x400000]);if(allocation.result!==0n)throw Error('Repeating worker allocation failed');
 const base=Number(allocation.output.readBigUInt64LE());if(!Number.isSafeInteger(base)||base<=0||base%4096)throw Error('Invalid repeating allocation');let program,thread=null;
 return {async start(calls){
  if(thread!==null)throw Error('Repeating worker already running');program=await prepare(rpc,{base,code,calls});
  if((await rpc.callAddress(sdk+code.create.offset,[base,0,sdk+code.longjmp.offset,program.live])).result!==0n)throw Error('Repeating pthread creation failed');thread=(await rpc.read(base,8)).readBigUInt64LE();
 },async stop(){
  if(thread===null)return;await program.stop();const until=Date.now()+5000;let done=false;
  while(Date.now()<until){const state=(await rpc.callAddress(sdk+code.tryWait.offset,[thread])).result;if(state===1n){done=true;break;}if(state!==0n)throw Error('Repeating thread state invalid');await new Promise(r=>setTimeout(r,5));}
  if(!done)throw Error('Repeating worker did not stop; resources retained');
  if((await rpc.callAddress(sdk+code.join.offset,[thread,base+8])).result!==0n)throw Error('Repeating pthread join failed');thread=null;
 },async results(){if(!program)return [];const b=await rpc.read(program.results,program.addresses.length*8);return program.addresses.map((_,i)=>b.readBigUInt64LE(i*8));}};
}
module.exports.create=create;
