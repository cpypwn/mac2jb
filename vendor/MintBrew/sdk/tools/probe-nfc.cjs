const fs=require('node:fs/promises'),path=require('node:path');
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),defs=require('../native/service-functions.json');
 const api=await require('../native/client.cjs').create(rpc,Object.fromEntries(Object.entries(defs).filter(([k])=>k.startsWith('nfc'))));
 const report={session:rpc.a.session,before:await api.result('nfcState'),devices:[]};let initialized=false;
 const save=()=>fs.writeFile(path.join(directory,'sdk-nfc-probe.json'),JSON.stringify(report,null,2),{mode:0o600});
 await save();try{
  if(report.before===0){await api.call('nfcInit');initialized=true;}report.state=await api.result('nfcState');await save();
  report.listResult=await api.result('nfcList',[api.base+64,api.base,9]);report.count=(await api.read(0,4)).readUInt32LE();await save();
  if(report.listResult===0)for(let i=0;i<Math.min(report.count,9);i++){
   const handle=api.base+64+i*8,item={handle:(await api.read(64+i*8,8)).toString('hex')};report.devices.push(item);
   item.padResult=await api.result('nfcPad',[api.base+256,handle]);item.pad=(await api.read(256,4)).readUInt32LE();
   item.start=await api.result('nfcStart',[handle]);await save();
   if(item.start===0)try{await new Promise(r=>setTimeout(r,150));item.tagResult=await api.result('nfcTag',[api.base+512,handle]);if(item.tagResult===0)item.tagBytes=(await api.read(512,128)).toString('hex');}finally{item.stop=await api.result('nfcStop',[handle]);}
  }
 }finally{if(initialized){await api.call('nfcFinalize');report.finalized=true;}report.completed=new Date().toISOString();await save();}
 console.log(JSON.stringify(report,null,2));
}
module.exports={main};if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
