const definitions=require('../native/service-functions.json');
async function create(rpc){
 const api=await require('../native/client.cjs').create(rpc,Object.fromEntries(Object.entries(definitions).filter(([k])=>k.startsWith('nfc'))));let busy=false;
 return {async scan({milliseconds=500}={}){
  if(!Number.isInteger(milliseconds)||milliseconds<50||milliseconds>3000)throw Error('NFC scan duration must be 50..3000ms');
  if(busy)throw Error('NFC scan already in flight');busy=true;let owned=false;
  try{
   const before=await api.result('nfcState');
   // Never finalize or stop detection in another NFC client's session.
   if(before!==0)throw Error('NFC is already owned by another client');
   await api.call('nfcInit');owned=true;
   const list=await api.result('nfcList',[api.base+64,api.base,9]);if(list)throw Error('NFC list result '+list);
   const count=(await api.read(0,4)).readUInt32LE();if(count>9)throw Error('Invalid NFC device count');const devices=[];
   for(let i=0;i<count;i++){
    const handle=api.base+64+i*8,row={index:i};devices.push(row);
    row.padResult=await api.result('nfcPad',[api.base+256,handle]);if(!row.padResult)row.pad=(await api.read(256,4)).readUInt32LE();
    row.start=await api.result('nfcStart',[handle]);if(row.start)continue;
    try{
     const until=Date.now()+milliseconds;
     do{row.tagResult=await api.result('nfcTag',[api.base+512,handle]);if(row.tagResult===0){row.tag=await api.read(512,88);break;}await new Promise(r=>setTimeout(r,50));}while(Date.now()<until);
    }finally{row.stop=await api.result('nfcStop',[handle]);}
   }
   return devices;
  }finally{try{if(owned)await api.call('nfcFinalize');}finally{busy=false;}}
 }};
}
module.exports={create};
