const fs=require('node:fs/promises'),path=require('node:path');
async function main(directory,seconds=30){
 if(!Number.isInteger(seconds)||seconds<1||seconds>60)throw Error('Capture duration 1..60s');directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),ipc=await require('../native/ipc.cjs').open(rpc,'hid');
 const report={session:rpc.a.session,started:[],stopped:[],samples:[]},aruid=await ipc.aruid(),user=Buffer.alloc(8);user.writeBigUInt64LE(aruid);
 const api=await require('../native/client.cjs').create(rpc,{},0x4000);let tmem=0,owned=false;
 const save=()=>fs.writeFile(path.join(directory,'sdk-jcms-samples.json'),JSON.stringify(report,null,2),{mode:0o600});
 try{
  const create=await ipc.api.result('transfer',[ipc.api.base+0x2200,api.base,0x4000,1]);if(create)throw Error('Transfer result '+create);tmem=(await ipc.api.read(0x2200,4)).readUInt32LE();
  const data=Buffer.alloc(16);data.writeBigUInt64LE(aruid);data.writeBigUInt64LE(0x4000n,8);const init=await ipc.request(3110,data,{pid:true,handles:[tmem]});report.initialize=init.result;if(init.transport||init.result)throw Error('Jcms init failed');owned=true;
  // Jcms handles: player 0..7 in byte 0, optical side 0/1 in byte 1.
  for(let player=0;player<8;player++)for(let side=0;side<2;side++){
   const handle=player|(side<<8),data=Buffer.alloc(16);data.writeUInt32LE(handle);data.writeBigUInt64LE(aruid,8);const r=await ipc.request(3112,data,{pid:true});report.started.push({handle,result:r.result,transport:r.transport});
  }
  await save();console.log('Sampling Joy-Con 2 optical transfer memory');
  const until=Date.now()+seconds*1000;let previous=Buffer.alloc(0x4000);
  while(Date.now()<until){const bytes=await api.read(0,0x4000),changes=[];for(let o=0;o<bytes.length;o+=4)if(bytes.readUInt32LE(o)!==previous.readUInt32LE(o))changes.push([o,bytes.readUInt32LE(o)]);report.samples.push({at:Date.now(),changes});if(changes.length)console.log(JSON.stringify({changes:changes.length,first:changes.slice(0,30)}));previous=bytes;await save();await new Promise(r=>setTimeout(r,200));}
  await fs.writeFile(path.join(directory,'sdk-jcms-last.bin'),previous,{mode:0o600});
 }finally{
  if(owned){for(const {handle,result}of report.started)if(result===0){const data=Buffer.alloc(16);data.writeUInt32LE(handle);data.writeBigUInt64LE(aruid,8);const r=await ipc.request(3113,data,{pid:true});report.stopped.push({handle,result:r.result});}report.finalize=(await ipc.request(3111,user,{pid:true})).result;}
  if(tmem)report.closeTransfer=await ipc.api.result('close',[tmem]);report.close=await ipc.close();await save();
 }
 console.log(JSON.stringify({started:report.started,nonempty:report.samples.filter(s=>s.changes.length).length,finalize:report.finalize}));return report;
}
module.exports={main};if(require.main===module)main(process.argv[2],process.argv[3]?Number(process.argv[3]):30).catch(e=>{console.error(e);process.exitCode=1;});
