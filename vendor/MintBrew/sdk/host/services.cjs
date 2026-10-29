// Read-only discovery. Opening a service is not proof its operations are permitted.
const definitions=require('../native/service-functions.json');
async function inspect(rpc){
 const names=['service','closeHandle','audioInputs'];
 const api=await require('../native/client.cjs').create(rpc,Object.fromEntries(names.map(k=>[k,definitions[k]])));
 const services={};
 for(const name of ['nfc:user','nfp:user','irs','audin:u','nifm:u','bsd:u','ssl','hidbus']){
  await api.write(64,Buffer.from(name+'\0'));const result=await api.result('service',[api.base,api.base+64,name.length]);services[name]={result};
  if(!result){const handle=(await api.read(0,4)).readUInt32LE();services[name].close=await api.result('closeHandle',[handle]);}
 }
 let audioInputs=null;
 if(services['audin:u'].result===0){
  const count=await api.result('audioInputs',[api.base+1024,8]);if(count>8)throw Error('Invalid audio input count');const bytes=await api.read(1024,count*256);
  audioInputs=Array.from({length:count},(_,i)=>bytes.subarray(i*256,(i+1)*256).toString('utf8').split('\0')[0]);
 }
 return {services,audioInputs};
}
module.exports={inspect};
