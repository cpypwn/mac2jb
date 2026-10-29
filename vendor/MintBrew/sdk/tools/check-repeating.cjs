const fs=require('node:fs/promises'),path=require('node:path');
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),code=require('../../smilebasic/engine/switch2/app/thread-code.json').functions,tick=require('../../smilebasic/engine/switch2/app/timing-code.json').functions.tick;
 for(const f of [...Object.values(code),tick])await rpc.request({command:'verify-function',address:rpc.a.sdk+f.offset,hex:f.bytes.slice(0,512)});
 await rpc.request({command:'verify-function',address:rpc.a.sdk+0x586fb0,hex:require('../native/ipc-functions.json').copy.hex});
 const a=await rpc.call(5732112,[rpc.output,4096,0x400000]);if(a.result!==0n)throw Error('Allocation failed');const base=Number(a.output.readBigUInt64LE());if(!Number.isSafeInteger(base)||base<=0||base%4096)throw Error('Allocation alignment');
 const p=await require('../native/repeating.cjs').prepare(rpc,{base,code,calls:[{function:rpc.a.sdk+tick.offset,args:[]},{function:rpc.a.sdk+code.sleep.offset,args:[10000000]}]});
 const create=await rpc.callAddress(rpc.a.sdk+code.create.offset,[base,0,rpc.a.sdk+code.longjmp.offset,p.live]);if(create.result!==0n)throw Error('Create failed');const thread=(await rpc.read(base,8)).readBigUInt64LE(),samples=[];let joined=false;
 try{for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,50));samples.push(String((await rpc.read(p.addresses[0],8)).readBigUInt64LE()));}}
 finally{await p.stop();const until=Date.now()+5000;while(Date.now()<until){if((await rpc.callAddress(rpc.a.sdk+code.tryWait.offset,[thread])).result===1n){joined=true;break;}await new Promise(r=>setTimeout(r,20));}if(joined&&((await rpc.callAddress(rpc.a.sdk+code.join.offset,[thread,base+8])).result!==0n))throw Error('Join failed');}
 const report={session:rpc.a.session,samples,joined,advancing:samples.every((v,i)=>!i||BigInt(v)>BigInt(samples[i-1]))};await fs.writeFile(path.join(directory,'sdk-repeating-check.json'),JSON.stringify(report,null,2));console.log(report);if(!joined||!report.advancing)throw Error('Repeating worker failed');
}
module.exports={main};if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
