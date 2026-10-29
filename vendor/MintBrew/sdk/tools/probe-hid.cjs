// Bounded live HID probe. Reports stay in the private session directory.
const fs=require('node:fs/promises'),path=require('node:path');
const definitions=require('../native/hid-functions.json');
async function main(directory,{vibrate=false}={}){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 const report={session:rpc.a.session,started:new Date().toISOString(),controllers:[],calls:[]},functions={};
 for(const [key,f] of Object.entries(definitions)){await rpc.request({command:'verify-function',address:rpc.a.sdk+f.offset,hex:f.hex});functions[key]=rpc.a.sdk+f.offset;}
 const allocation=await rpc.call(5732112,[rpc.output,4096,65536]);if(allocation.result!==0n)throw Error('Probe allocation failed');const base=Number(allocation.output.readBigUInt64LE());if(!Number.isSafeInteger(base)||base<=0||base%4096)throw Error('Invalid probe allocation');
 report.base=base;report.allocationRetained=true;await rpc.write(base,Buffer.alloc(65536));
 const save=()=>fs.writeFile(path.join(directory,'sdk-hid-probe.json'),JSON.stringify(report,null,2),{mode:0o600});
 async function call(key,args){const result=Number(BigInt.asUintN(32,(await rpc.callAddress(functions[key],args)).result));report.calls.push({key,result});await save();return result;}
 const word=async(offset,n)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);await rpc.write(base+offset,b);};
 const u32=async offset=>(await rpc.read(base+offset,4)).readUInt32LE();
 const styles=[[1,'FullKey'],[2,'Handheld'],[4,'JoyDual'],[8,'JoyLeft'],[16,'JoyRight']];
 for(const id of [32,0,1,2,3,4,5,6,7,16]){
  await word(0,id);await word(16,0);const result=await call('style',[base+16,base]);if(result){report.controllers.push({id,result});continue;}
  const style=await u32(16),row={id,style};report.controllers.push(row);if(!style)continue;
  const selected=styles.find(([bit])=>style&bit);if(!selected){row.unsupportedStyle=true;continue;}
  await call('pad'+selected[1],[base+0x100,base]);row.state=(await rpc.read(base+0x100,64)).toString('hex');
  row.colorResult=await call('color',[base+0x200,base+0x210,base]);row.colors=(await rpc.read(base+0x200,32)).toString('hex');
  row.motionHandles=await call('motionHandles',[base+0x300,2,base,selected[0]]);row.motion=[];
  for(let i=0;i<Math.min(row.motionHandles,2);i++){
   const handle=base+0x300+i*4,item={handle:await u32(0x300+i*4)};row.motion.push(item);
   item.start=await call('motionStart',[handle]);if(item.start!==0)continue;
   try{item.samples=[];for(let j=0;j<3;j++){await new Promise(r=>setTimeout(r,80));const result=await call('motionRead',[base+0x400,base+0x500,1,handle]),count=await u32(0x400),b=await rpc.read(base+0x500,96);item.samples.push({result,count,hex:b.toString('hex'),sequence:String(b.readBigUInt64LE(8)),acceleration:[16,20,24].map(o=>b.readFloatLE(o)),angularVelocity:[28,32,36].map(o=>b.readFloatLE(o))});}}
   finally{item.stop=await call('motionStop',[handle]);}
  }
  row.vibrationHandles=await call('vibrationHandles',[base+0x800,2,base,selected[0]]);row.vibration=[];
  row.permissionResult=await call('vibrationPermitted',[base+0x900]);row.vibrationPermitted=(await rpc.read(base+0x900,1))[0]!==0;
  for(let i=0;i<Math.min(row.vibrationHandles,2);i++){
   const handle=base+0x800+i*4,item={handle:await u32(0x800+i*4)};row.vibration.push(item);item.initialize=await call('vibrationInit',[handle]);if(item.initialize)continue;
   item.readResult=await call('vibrationRead',[base+0xa00,handle]);item.initial=(await rpc.read(base+0xa00,16)).toString('hex');
   if(vibrate&&row.vibrationPermitted){
    const pulse=Buffer.alloc(16);[.15,160,.15,320].forEach((n,j)=>pulse.writeFloatLE(n,j*4));await rpc.write(base+0xb00,pulse);
    try{item.pulse=await call('vibrationSend',[handle,base+0xb00]);await new Promise(r=>setTimeout(r,120));item.actualResult=await call('vibrationRead',[base+0xa00,handle]);item.actual=[0,4,8,12].map(o=>0);const actual=await rpc.read(base+0xa00,16);item.actual=[0,4,8,12].map(o=>actual.readFloatLE(o));}
    finally{pulse.writeFloatLE(0,0);pulse.writeFloatLE(0,8);await rpc.write(base+0xb00,pulse);item.stop=await call('vibrationSend',[handle,base+0xb00]);}
   }
  }
 }
 report.keyboard={result:await call('keyboard',[base+0xc00,base+0xc10,1]),count:await u32(0xc00),hex:(await rpc.read(base+0xc10,48)).toString('hex')};
 report.mouse={result:await call('mouse',[base+0xd00]),hex:(await rpc.read(base+0xd00,40)).toString('hex')};
 report.completed=new Date().toISOString();await save();console.log(JSON.stringify({controllers:report.controllers,keyboard:report.keyboard,mouse:report.mouse},null,2));return report;
}
module.exports={main};
if(require.main===module)main(process.argv[2],{vibrate:process.argv.includes('--vibrate')}).catch(e=>{console.error(e);process.exitCode=1;});
