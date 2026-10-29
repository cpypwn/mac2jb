// Owned direct HID session. Does not change the legacy controller/mouse session.
const fs=require('node:fs/promises'),path=require('node:path');
async function main(directory,kind='nmouse'){
 if(!['nmouse','jcms'].includes(kind))throw Error('Unknown mouse interface');
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),ipc=await require('../native/ipc.cjs').open(rpc,'hid');
 const report={session:rpc.a.session,kind,queries:[],transfer:[]},save=()=>fs.writeFile(path.join(directory,'sdk-switch2-'+kind+'-probe.json'),JSON.stringify(report,null,2),{mode:0o600});
 const aruid=await ipc.aruid(),pid={pid:true};const user=Buffer.alloc(8);user.writeBigUInt64LE(aruid);
 async function query(command,data,options=pid){const r=await ipc.request(command,data,options);const row={command,transport:r.transport,result:r.result,data:r.data?.toString('hex')};report.queries.push(row);await save();return r;}
 try{
  await query(205,Buffer.alloc(0),{});await query(3133,user);
  for(const handle of [0x2004,0x12004]){const d=Buffer.alloc(16);d.writeUInt32LE(handle);d.writeBigUInt64LE(aruid,8);await query(220,d);}
  const api=await require('../native/client.cjs').create(rpc,{},0x80000);
  // Probe one bounded transfer-memory size at a time. Failed sizes retain only allocation.
  for(const bytes of Array.from({length:32},(_,i)=>(i+1)*4096)){
   const result=await ipc.api.result('transfer',[ipc.api.base+0x2200,api.base,bytes,1]);const row={bytes,result};report.transfer.push(row);await save();if(result)break;
   const handle=(await ipc.api.read(0x2200,4)).readUInt32LE();let owned=false;
   try{
    const data=Buffer.alloc(32);data.writeUInt8(0);data.writeInt32LE(1920,4);data.writeInt32LE(1080,8);data.writeBigUInt64LE(aruid,16);data.writeBigUInt64LE(BigInt(bytes),24);
    const jcms=Buffer.alloc(16);jcms.writeBigUInt64LE(aruid);jcms.writeBigUInt64LE(BigInt(bytes),8);
    const response=await query(kind==='jcms'?3110:3130,kind==='jcms'?jcms:data,{pid:true,handles:[handle]});row.initialize=response.result;
    if(response.transport===0&&response.result===0){owned=true;await query(3133,user);await new Promise(r=>setTimeout(r,100));row.head=(await api.read(0,Math.min(bytes,256))).toString('hex');break;}
   }finally{if(owned)row.finalize=(await query(kind==='jcms'?3111:3131,user)).result;row.close=await ipc.api.result('close',[handle]);await save();}
  }
 }finally{report.close=await ipc.close();report.completed=new Date().toISOString();await save();}
 console.log(JSON.stringify(report,null,2));return report;
}
module.exports={main};if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});
