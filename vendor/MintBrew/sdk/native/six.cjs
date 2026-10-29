// Six-argument worker using verified instructions from the supported SDK.
// Runs on an owned pthread and exits through the SDK's pthread_exit.
const fs=require('node:fs/promises'),path=require('node:path');
const code=require('../../smilebasic/engine/switch2/app/thread-code.json').functions;
const SENTINEL=0xfedcba9876543210n;
function frame(base,sdk,target,args){
 if(args.length>6)throw Error('At most six arguments');args=[...args];while(args.length<6)args.push(0);
 const b=Buffer.alloc(0x12000),put=(o,v)=>b.writeBigUInt64LE(BigInt(v),o),sp=0x10000;
 // Set x4/x5, pop the dispatch registers, then enter the qualified call4 path.
 put(0,sdk+code.loadTable.offset+8);put(8,args[5]);put(0x10,args[4]);put(0x30,args[0]);put(0x58,sdk+0x5604a8);put(0x68,base+sp);
 put(sp+8,sdk+code.loadTable.offset);put(sp+0x10,base+0x1000);
 put(0x1000,base+0x1010);put(0x1078,target);
 const next=sp+0x30;
 put(next+8,sdk+code.call4.offset);put(next+0x10,args[1]);put(next+0x20,args[2]);put(next+0x28,args[3]);
 put(next+0xd8,sdk+code.saveResult64.offset);put(next+0x118,base+0x800);put(next+0x128,sdk+code.exit.offset);put(0x800,SENTINEL);
 return b;
}
async function create(rpc,directory){
 const sdk=rpc.a.sdk,original=require('../../smilebasic/reference/sdk-checks.cjs');
 for(const name of ['create','join','longjmp','loadTable','call4','saveResult64','exit','tryWait']){
  const f=code[name],expected=Buffer.from(f.bytes,'hex').subarray(0,Math.min(256,f.bytes.length/2));
  await rpc.request({command:'verify-function',address:sdk+f.offset,hex:expected.toString('hex')});
 }
 await rpc.request({command:'verify-function',address:sdk+0x5604a8,hex:original.bytes(0x5604a8,36).toString('hex')});
 const slot=rpc.a.scratch+0x10000,saved=await rpc.read(slot,8);let base;
 try{if((await rpc.call(5732112,[slot,4096,0x13000])).result!==0n)throw Error('Worker allocation failed');base=Number((await rpc.read(slot,8)).readBigUInt64LE());}finally{await rpc.write(slot,saved);}
 if(!Number.isSafeInteger(base)||base%4096||!base)throw Error('Invalid worker allocation');
 const record={session:rpc.a.session,base,bytes:0x13000,calls:[]};const file=path.join(directory,'native-six.json');
 const save=()=>fs.writeFile(file,JSON.stringify(record,null,2));await save();
 async function call(target,args){
  // Explicitly verify the live target and never reuse a running worker's stack.
  const bytes=await rpc.read(target,32);await rpc.request({command:'verify-function',address:target,hex:bytes.toString('hex')});
  await rpc.write(base,frame(base,sdk,target,args));
  const out=base+0x12000;await rpc.write(out,Buffer.alloc(16));
  const row={target,args:args.map(String),status:'creating',started:new Date().toISOString()};record.calls.push(row);await save();
  const rc=(await rpc.callAddress(sdk+code.create.offset,[out,0,sdk+code.longjmp.offset,base])).result;
  if(rc)throw Error('pthread_create: '+rc);
  const thread=(await rpc.read(out,8)).readBigUInt64LE();row.thread=String(thread);row.status='running';await save();
  const until=Date.now()+30000;let done=false;
  while(Date.now()<until){const state=(await rpc.callAddress(sdk+code.tryWait.offset,[thread])).result;if(state===1n){done=true;break;}if(state!==0n)throw Error('Invalid worker state');await new Promise(r=>setTimeout(r,20));}
  if(!done)throw Error('Worker timeout; allocation retained');
  const result=(await rpc.read(base+0x800,8)).readBigUInt64LE();if(result===SENTINEL)throw Error('Worker did not return');
  if((await rpc.callAddress(sdk+code.join.offset,[thread,out+8])).result!==0n)throw Error('Worker join failed');
  if((await rpc.read(out+8,8)).readBigUInt64LE()!==result)throw Error('Worker exit differs');
  row.result=String(result);row.status='joined';row.completed=new Date().toISOString();await save();return result;
 }
 return {call,base,record};
}
module.exports={create,frame};
if(require.main===module)(async()=>{
 const directory=path.resolve(process.argv[2]),rpc=require(path.join(directory,'shared/rpc.cjs')),worker=await create(rpc,directory);
 const data=worker.base+0x12200;await rpc.write(data,Buffer.from('%llx:%llx:%llx\0'));
 const result=await worker.call(rpc.a.sdk+5888928,[data+0x100,256,data,0x123456789abcdef0n,0x8877665544332211n,0x1020304050607080n]);
 const output=(await rpc.read(data+0x100,256)).toString().split('\0')[0];
 if(output!=='123456789abcdef0:8877665544332211:1020304050607080'||result!==BigInt(output.length))throw Error('Six-register verification failed: '+output);
 console.log('Six-argument worker verified:',output);
})().catch(e=>{console.error(e);process.exitCode=1;});
