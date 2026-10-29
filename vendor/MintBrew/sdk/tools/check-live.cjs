// Integration check against an already qualified launcher session.
// Uses the reserved SDK tail of the launcher's mapped buffer; does not switch apps.
const fs=require('node:fs/promises'),path=require('node:path'),dgram=require('node:dgram'),crypto=require('node:crypto');
async function main(directory,host){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 const prepared=JSON.parse(await fs.readFile(path.join(directory,'launcher-auto.json')));
 if(prepared.session!==rpc.a.session||!prepared.ready)throw Error('Launcher session differs');
 const runtime=await require('../host/runtime.cjs').create({rpc,mapped:prepared.controls.mapped,directory});
 const L=require('../host/layout.cjs'),base=prepared.controls.mapped+L.OFFSET,report={session:rpc.a.session};
 try{
  await runtime.atBoundary();report.controllers=runtime.hardware.controllers;
  for(const call of runtime.hardware.frameCalls(prepared.controls.mapped))await rpc.callAddress(call.function,call.args);
  const snapshot=await rpc.read(base,1024);report.flags=snapshot.readUInt32LE(12);report.motion=L.motion(snapshot.subarray(128,224));report.ir={result:snapshot.readUInt32LE(480),status:snapshot.readUInt32LE(484)};
  const request=Buffer.alloc(1056);request.writeUInt32LE(1);request.writeUInt32LE(L.OP.nfc,4);await rpc.write(base+L.FIELD.request,request);await runtime.atBoundary();
  const response=await rpc.read(base+L.FIELD.response,1056);report.nfc={sequence:response.readUInt32LE(),status:response.readUInt32LE(4),devices:response.readUInt32LE(32),tag:response.readUInt32LE(36)};
  if(report.nfc.sequence!==1||report.nfc.status!==0)throw Error('SDK NFC mailbox failed');
  if(host){
   const server=dgram.createSocket('udp4');await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,host,resolve);});
   server.on('message',(bytes,peer)=>server.send(bytes,peer.port,peer.address));
   try{
    const network=await require('../host/network.cjs').create(rpc,directory),payload=crypto.randomBytes(32);
    const response=await network.exchange({address:host,port:server.address().port},payload);report.udpEcho=response.equals(payload);if(!report.udpEcho)throw Error('SDK UDP mismatch');
   }finally{server.close();}
  }
 }finally{await runtime.close();await rpc.write(base,Buffer.alloc(L.SIZE));report.completed=new Date().toISOString();await fs.writeFile(path.join(directory,'sdk-integration-check.json'),JSON.stringify(report,null,2),{mode:0o600});}
 console.log(JSON.stringify(report,null,2));return report;
}
module.exports={main};if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});
