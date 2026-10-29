const fs=require('node:fs/promises'),path=require('node:path');
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),defs=require('../native/hid-functions.json');
 const keys=['style','vibrationHandles','vibrationInit','vibrationSend','vibrationRead','vibrationPermitted'];
 const api=await require('../native/client.cjs').create(rpc,Object.fromEntries(keys.map(k=>[k,defs[k]]))),word=require('../host/layout.cjs').word;const report={session:rpc.a.session};
 for(const id of [32,0,1,2,3,4,5,6,7]){
  await api.write(0,word(id));if(await api.result('style',[api.base+16,api.base]))continue;const style=(await api.read(16,4)).readUInt32LE(),bit=[1,2,4,8,16].find(b=>style&b);if(!bit)continue;
  const count=await api.result('vibrationHandles',[api.base+0x800,2,api.base,bit]);if(count>2)throw Error('Invalid handle count');const handles=[];
  for(let i=0;i<count;i++){const h=api.base+0x800+i*4;if(await api.result('vibrationInit',[h])===0)handles.push(h);}
  report.pad=id;report.devices=handles.length;
  const value=await require('../host/haptics.cjs').play(api,handles,{side:2,steps:[{milliseconds:150,amplitude:.2,lowFrequency:80,highFrequency:160},{milliseconds:200,amplitude:.65,lowFrequency:160,highFrequency:320},{milliseconds:150,amplitude:.3,lowFrequency:240,highFrequency:640}]});report.result=value.result;report.actual=value.actual.toString('hex');report.afterStop=value.afterStop?.toString('hex');break;
 }
 await fs.writeFile(path.join(directory,'sdk-haptics-probe.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(report);
}
module.exports={main};if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1;});
