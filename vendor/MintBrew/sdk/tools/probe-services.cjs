const fs=require('node:fs/promises'),path=require('node:path');
const definitions=require('../native/service-functions.json');
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),report={session:rpc.a.session,services:{},calls:[]},functions={};
 for(const [key,f]of Object.entries(definitions)){await rpc.request({command:'verify-function',address:rpc.a.sdk+f.offset,hex:f.hex});functions[key]=rpc.a.sdk+f.offset;}
 const allocation=await rpc.call(5732112,[rpc.output,4096,4096]);if(allocation.result!==0n)throw Error('Allocation failed');const base=Number(allocation.output.readBigUInt64LE());if(!Number.isSafeInteger(base)||base<=0||base%4096)throw Error('Invalid allocation');await rpc.write(base,Buffer.alloc(4096));
 const save=()=>fs.writeFile(path.join(directory,'sdk-service-probe.json'),JSON.stringify(report,null,2),{mode:0o600});
 async function call(key,args=[]){const result=Number(BigInt.asUintN(32,(await rpc.callAddress(functions[key],args)).result));report.calls.push({key,result});await save();return result;}
 for(const service of ['nfc:user','nfp:user','irs','audin:u','nifm:u','bsd:u','ssl','hidbus']){
  await rpc.write(base+64,Buffer.from(service+'\0'));const result=await call('service',[base,base+64,service.length]);report.services[service]={result};
  if(result===0){const handle=(await rpc.read(base,4)).readUInt32LE();report.services[service].close=await call('closeHandle',[handle]);}await save();
 }
 report.network={initialized:await call('socketInitialized'),statusResult:await call('netStatus',[base+128]),statusHex:(await rpc.read(base+128,16)).toString('hex'),addressResult:await call('netAddress',[base+160]),address:[...(await rpc.read(base+160,4))].join('.')};
 // GetIrCameraStatus is result-returning and reports an uninitialized IR session.
 await rpc.write(base+192,Buffer.from([0,0,0,0]));report.ir={statusResult:await call('irStatus',[base+200,base+192]),status:(await rpc.read(base+200,4)).readUInt32LE()};
 report.completed=new Date().toISOString();await save();console.log(JSON.stringify(report,null,2));
}
module.exports={main};if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
