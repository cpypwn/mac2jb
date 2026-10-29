// Bounded native jobs. The console exits its worker even if the host disconnects.
const {build,SENTINEL}=require('../../smilebasic/engine/shared/frames.cjs');
async function create(rpc){
 const code=require('../../smilebasic/engine/switch2/app/thread-code.json').functions,sdk=rpc.a.sdk;
 for(const f of Object.values(code))await rpc.request({command:'verify-function',address:sdk+f.offset,hex:f.bytes.slice(0,512)});
 const a=await rpc.call(5732112,[rpc.output,4096,0x400000]);if(a.result!==0n)throw Error('Finite worker allocation failed');const base=Number(a.output.readBigUInt64LE());if(!Number.isSafeInteger(base)||base<=0||base%4096)throw Error('Invalid finite allocation');let busy=false;
 return {async run(calls){
  if(busy)throw Error('Native job already running');busy=true;let joined=false;
  try{
   const program=build(base+0x10000,sdk,calls.map(c=>({...c,args:[...c.args,...Array(4-c.args.length).fill(0)]})),code);if(program.frame.length>0x300000)throw Error('Finite frame too large');await rpc.write(base+0x10000,program.frame);
   if((await rpc.callAddress(sdk+code.create.offset,[base,0,sdk+code.longjmp.offset,base+0x10000])).result!==0n)throw Error('Native job create failed');const thread=(await rpc.read(base,8)).readBigUInt64LE();
   const until=Date.now()+15000;while(Date.now()<until){const state=(await rpc.callAddress(sdk+code.tryWait.offset,[thread])).result;if(state===1n){if((await rpc.callAddress(sdk+code.join.offset,[thread,base+8])).result!==0n)throw Error('Native job join failed');joined=true;break;}if(state!==0n)throw Error('Invalid native job state');await new Promise(r=>setTimeout(r,10));}
   if(!joined)throw Error('Native job wait timed out; allocation remains in use');
   const b=await rpc.read(base+0x10000+program.proof.resultOffsets[0],program.proof.resultOffsets.length*8),results=program.proof.logicalResultIndices.map(i=>b.readBigUInt64LE(i*8));if(results.some(x=>x===SENTINEL))throw Error('Native job missed a call');return results;
  }finally{if(joined)busy=false;}
 }};
}
module.exports={create};
