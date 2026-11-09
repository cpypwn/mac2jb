'use strict';
// Ordinary service checks only: no private RO protocol and no process launch.
const path=require('node:path');
const check=(v,s)=>{if(!v)throw Error(s);};
const definiteLookupFailure=r=>[0x1015,0xe15].includes((r.transport??r.result??0)&0x3fffff);
async function qualify({run,memory,client,sm,pmShell,record=async()=>{}}) {
 const {Session}=require(path.join(run,'switch2/app/session.cjs'));
 const s=new Session('stock-ro-standard-health-'+Date.now(),0x80000);await s.initialize();
 const owned=[];let ipcPending=false;
 const ipc=async(...args)=>{ipcPending=true;const r=await s.ipc(...args);ipcPending=false;return r;};
 try {
  const dmnt=await client.worker({kind:'sm-get',handle:sm,name:'ro:dmnt'},10000);
  check(!dmnt.transport&&!dmnt.result&&dmnt.handle,'Stock ro:dmnt unavailable');owned.push(dmnt.handle);
  const p=await memory.request({command:'root-native-ipc',handle:pmShell,id:6,hex:''});
  check(!p.result,'Application PID query failed');
  const pid=Buffer.from(p.hex,'hex').readBigUInt64LE(),input=Buffer.alloc(8);input.writeBigUInt64LE(pid);
  const output=s.base+0x4000,size=0x30*32;
  const modules=await ipc('Stock RO ordinary module query',dmnt.handle,0,input,{receive:[{address:output,size}]});
  check(!modules.result&&modules.data.readInt32LE()>=0&&modules.data.readInt32LE()<=32,'Stock module query failed');
  await record({operation:'module-info',result:modules.result,moduleCount:modules.data.readInt32LE()});
  // SmileBASIC may be allowed ldr:ro but not ro:1. Access denied is not proof
  // that the server is missing. Only a definite lookup failure permits fallback.
  let ro,serviceName;
  for(const name of ['ldr:ro','ro:1']) {
   const r=await client.worker({kind:'app-service',name},10000);
   await record({operation:'application-service',name,result:r.result,transport:r.transport,handle:r.handle});
   if(!r.transport&&!r.result&&r.handle){ro=r;serviceName=name;owned.push(r.handle);break;}
   check(definiteLookupFailure(r),'Unexpected application service lookup failure: '+JSON.stringify(r));
  }
  check(ro,'Application cannot open either ordinary RO service');
  const initialized=await ipc('Stock RO ordinary Initialize',ro.handle,4,Buffer.alloc(8),{pid:true,copies:[0xffff8001]});
  await record({operation:'initialize',serviceName,result:initialized.result});
  check(!initialized.result,'Stock RO rejected application initialization: '+initialized.result);
  return {moduleInfoVerified:true,applicationInitializeVerified:true,applicationService:serviceName,moduleCount:modules.data.readInt32LE(),fullNroLoadTested:false};
 } finally {
  if(!client.pending&&!ipcPending){for(const handle of owned)await memory.request({command:'root-native-close-handle',handle});await s.cleanup();}
 }
}
module.exports={qualify,definiteLookupFailure};
