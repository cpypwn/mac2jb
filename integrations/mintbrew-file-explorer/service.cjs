const layout=require('../../vendor/MintBrew/sdk/host/layout.cjs');
const ftp=require('../../vendor/MintBrew/sdk/host/ftp-service.cjs');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function create({rpc,menu}){
 const base=menu.controls.mapped+layout.OFFSET;
 async function status(){
  const packet=await rpc.read(base+ftp.STATUS,48);
  if(packet.readUInt32LE()!==ftp.MAGIC)throw Error('MintFTP service is unavailable');
  return {state:packet.readUInt32LE(4),ack:packet.readUInt32LE(44)};
 }
 async function command(action,expected){
  const deadline=Date.now()+5000;
  let current=await status();
  if(current.state===expected||(action===1&&current.state===2))return;
  let request=await rpc.read(base+ftp.REQUEST,8);
  while(request.readUInt32LE()!==current.ack&&Date.now()<deadline){
   await sleep(20);current=await status();request=await rpc.read(base+ftp.REQUEST,8);
  }
  if(request.readUInt32LE()!==current.ack)throw Error('MintFTP command is still pending');
  let sequence=(current.ack+1)>>>0;if(sequence===0)sequence=1;
  const packet=Buffer.alloc(8);packet.writeUInt32LE(sequence);packet.writeUInt32LE(action,4);
  await rpc.write(base+ftp.REQUEST,packet);
  while(Date.now()<deadline){
   await sleep(20);current=await status();
   if(current.ack===sequence){
    if(current.state===3)throw Error('MintFTP could not change its FTP listener');
    if(current.state===expected)return;
   }
  }
  throw Error('MintFTP FTP listener did not confirm shutdown');
 }
 return {
  start:async()=>{},
  handoff(){return this;},
  stopForGame:()=>command(2,0),
  resumeForList:()=>command(1,1),
  close:async()=>{
   try{await command(2,0);}catch(error){
    if(!/service is unavailable/.test(error.message))throw error;
   }
  }
 };
}

module.exports={create};
