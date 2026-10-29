// Switch 2 optical input through the HID Jcms service, independent of generic MouseState.
const BYTES=0x4000,STRIDE=712,SLOTS=17,RECORD=40,DESTINATION=0x4000;
function samples(bytes,player,side){
 if(!Buffer.isBuffer(bytes)||bytes.length!==BYTES||!Number.isInteger(player)||player<0||player>7||!Number.isInteger(side)||side<0||side>1)throw Error('Invalid Jcms snapshot');
 const base=(player*2+side)*STRIDE,tail=bytes.readUInt32LE(base+16),count=bytes.readUInt32LE(base+24);
 if(tail>=SLOTS||count>16)throw Error('Invalid Jcms ring header');const result=[];
 for(let i=0;i<count;i++){
  const o=base+32+((tail+SLOTS-i)%SLOTS)*RECORD,guard=bytes.readBigUInt64LE(o),sequence=bytes.readBigUInt64LE(o+16);
  if(!sequence||guard!==BigInt.asUintN(64,sequence*2n))continue;
  result.push({sequence:String(sequence),deltaNanoseconds:String(bytes.readBigUInt64LE(o+8)),dx:bytes.readInt32LE(o+24),dy:bytes.readInt32LE(o+28),attributes:bytes.readUInt32LE(o+32)});
 }
 return result;
}
async function create(rpc){
 const ipc=await require('../native/ipc.cjs').open(rpc,'hid'),api=await require('../native/client.cjs').create(rpc,{},BYTES),aruid=await ipc.aruid();
 const user=Buffer.alloc(8);user.writeBigUInt64LE(aruid);let owned=false,transfer=0,closed=false;const started=[];
 async function command(id,handle){const data=Buffer.alloc(16);data.writeUInt32LE(handle);data.writeBigUInt64LE(aruid,8);return ipc.request(id,data,{pid:true});}
 async function close(){
  if(closed)return;closed=true;let failure;
  if(owned){for(const handle of started)try{const r=await command(3113,handle);if(r.transport||r.result)throw Error('Jcms stop failed');}catch(e){failure??=e;}
   try{const r=await ipc.request(3111,user,{pid:true});if(r.transport||r.result)throw Error('Jcms finalize failed');}catch(e){failure??=e;}}
  // Do not close the last transfer handle if service finalization could still own the buffer.
  if(transfer&&!failure)await ipc.api.result('close',[transfer]);await ipc.close();if(failure)throw failure;
 }
 try{
  const result=await ipc.api.result('transfer',[ipc.api.base+0x2200,api.base,BYTES,1]);if(result)throw Error('Jcms transfer Result '+result);
  transfer=(await ipc.api.read(0x2200,4)).readUInt32LE();const data=Buffer.alloc(16);data.writeBigUInt64LE(aruid);data.writeBigUInt64LE(BigInt(BYTES),8);
  const init=await ipc.request(3110,data,{pid:true,handles:[transfer]});if(init.transport||init.result)throw Error('Jcms initialize Result '+(init.transport||init.result));owned=true;
  for(let player=0;player<8;player++)for(let side=0;side<2;side++){const handle=player|(side<<8),r=await command(3112,handle);if(r.transport||r.result)throw Error('Jcms start Result '+(r.transport||r.result));started.push(handle);}
  const offset=0x586fb0;await rpc.request({command:'verify-function',address:rpc.a.sdk+offset,hex:require('../native/ipc-functions.json').copy.hex});
  return {async snapshot(){if(closed)throw Error('Jcms closed');return api.read(0,BYTES);},frameCall(mapped){if(closed)throw Error('Jcms closed');return {function:rpc.a.sdk+offset,args:[mapped+require('./layout.cjs').OFFSET+DESTINATION,api.base,BYTES]};},close};
 }catch(error){try{await close();}catch(cleanup){error.message+='; '+cleanup.message;}throw error;}
}
module.exports={create,samples,BYTES,STRIDE,SLOTS,RECORD,DESTINATION};
