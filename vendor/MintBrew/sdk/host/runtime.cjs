const L=require('./layout.cjs');
function validateManifest(value){
 if(value===undefined)return {capabilities:[],endpoints:[]};
 if(!value||value.version!==1||!Array.isArray(value.capabilities)||value.capabilities.some(x=>!['vibration','nfc','udp'].includes(x)))throw Error('Invalid SDK manifest');
 const services=value.services??[];if(!Array.isArray(services)||services.some(s=>s!=='ftp'))throw Error('Invalid SDK background service');
 if(value.ftpPort!==undefined&&(!Number.isInteger(value.ftpPort)||value.ftpPort<1024||value.ftpPort>65535))throw Error('Invalid FTP port');
 const endpoints=value.endpoints??[];if(!Array.isArray(endpoints)||endpoints.length>8)throw Error('SDK supports at most eight UDP endpoints');
 return {capabilities:[...new Set(value.capabilities)],endpoints:endpoints.map(require('./network.cjs').endpoint)};
}
async function create({rpc,mapped,directory,hardware:providedHardware}){
 const hardware=providedHardware??await require('./hardware.cjs').create(rpc);let nfc,network,lastSequence=0,owner=null;
 const base=mapped+L.OFFSET;
 return {hardware,async atBoundary(app=null){
  const identity=app?.fingerprint??'launcher';
  if(owner!==identity){owner=identity;lastSequence=0;await rpc.write(base+L.FIELD.request,Buffer.alloc(6144));}
  await rpc.write(base,await hardware.poll());
  const request=await rpc.read(base+L.FIELD.request,1056),sequence=request.readUInt32LE();
  if(!sequence||sequence===lastSequence)return;lastSequence=sequence;
  const op=request.readUInt32LE(4),reply=Buffer.alloc(1056);reply.writeUInt32LE(sequence);
  const config=app?validateManifest(app.manifest.sdk):{capabilities:['vibration','nfc'],endpoints:[]};
  const capability=({1:'vibration',2:'nfc',3:'udp',4:'vibration'})[op];let status=L.STATUS.ok,payload=Buffer.alloc(0);
  try{
   if(!capability||!config.capabilities.includes(capability)){status=L.STATUS.unsupported;}
   else if(op===L.OP.vibrate){
    const result=await hardware.pulse({side:request.readUInt32LE(8),milliseconds:request.readUInt32LE(12),amplitude:request.readUInt32LE(16)/1000});payload=result.actual;
   }else if(op===L.OP.haptics){
    const count=request.readUInt32LE(12);if(count<1||count>32){status=L.STATUS.invalid;}else{
     const steps=Array.from({length:count},(_,i)=>{const o=32+i*20;return {milliseconds:request.readUInt32LE(o),lowAmplitude:request.readFloatLE(o+4),lowFrequency:request.readFloatLE(o+8),highAmplitude:request.readFloatLE(o+12),highFrequency:request.readFloatLE(o+16)};});
     payload=(await hardware.pattern({side:request.readUInt32LE(8),steps})).actual;
    }
   }else if(op===L.OP.nfc){
    nfc??=await require('./nfc.cjs').create(rpc);const devices=await nfc.scan({milliseconds:500});
    const tag=devices.find(d=>d.tag);payload=Buffer.alloc(16+(tag?88:0));payload.writeUInt32LE(devices.length);payload.writeUInt32LE(tag?1:0,4);payload.writeUInt32LE(devices[0]?.tagResult??0xffffffff,8);payload.writeUInt32LE(devices[0]?.start??0xffffffff,12);tag?.tag.copy(payload,16);
   }else if(op===L.OP.udp){
    const index=request.readUInt32LE(8),length=request.readUInt32LE(12);if(index>=config.endpoints.length||length<1||length>1024){status=L.STATUS.invalid;}
    else{network??=await require('./network.cjs').create(rpc,directory);payload=await network.exchange(config.endpoints[index],request.subarray(32,32+length));}
   }
  }catch(error){status=error.code==='ETIMEDOUT'?L.STATUS.timeout:L.STATUS.native;payload=Buffer.from(error.message).subarray(0,1024);}
  reply.writeUInt32LE(status,4);reply.writeUInt32LE(payload.length,8);payload.copy(reply,32);await rpc.write(base+L.FIELD.response,reply);
 },async close(){await hardware.close();}};
}
module.exports={create,validateManifest};
