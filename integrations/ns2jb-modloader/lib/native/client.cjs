'use strict';
const path=require('node:path');
const {check}=require('../common.cjs');
const {guardSession,isUncertain}=require('../game-files/uncertain.cjs');

// Process-memory commands are ordinary CMIF calls to the already running RO
// helper. Keep one owned IPC buffer instead of creating a thread per command.
async function openClient(run){
 const {Client}=require(path.join(run,'switch2/process/client.cjs'));
 const {Session}=require(path.join(run,'switch2/app/session.cjs'));
 const {packet,response}=require(path.join(run,'shared/ipc.cjs'));
 const c=await new Client().open(),s=guardSession(new Session('modloader-process-'+Date.now(),0x210000));
 s.record=async()=>{};
 try{await s.initialize();}catch(error){if(!isUncertain(error)){await s.cleanup();await c.close();}else c.pending=true;throw error;}
 const close=c.close.bind(c);
 async function exchange(id,handle,values,length=0){
  check(!c.pending,'A native request remains pending');
  check([0x524f0010,0x524f0011,0x524f0012,0x524f0013,0x524f0014,0x524f0015,0x524f0016].includes(id),'Unknown process command');
  check(values.length===(id===0x524f0014?8:4),'Incorrect process input size');
  check(!length||id===0x524f0016&&Number.isInteger(length)&&length>0&&length<=0x200000,'Invalid bulk process read');
  const input=Buffer.alloc(values.length*8);values.forEach((value,i)=>input.writeBigUInt64LE(BigInt(value),i*8));
  const row={id,handle,input:values.map(String),started:new Date().toISOString()};c.record.calls.push(row);await c.save();
  const output=s.base+0x6000,receive=length?[{address:output,size:length}]:[];
  c.pending=true;
  await s.write(s.base,packet(id,input,{pid:true,copies:[handle],receive}));
  const transport=await s.call('send',s.base,4096,c.handle);
  if(transport){c.pending=false;throw Error('Process IPC transport failed: 0x'+transport.toString(16));}
  const raw=await s.readOwned(s.base,256),reply=response(raw);
  check(raw.readUInt32LE(4)>>>31&&raw.readUInt32LE(8)&1&&raw.readBigUInt64LE(12).toString()===String(c.pid),'Reply did not come from the verified RO kernel PID');
  check(!reply.copies.length&&!reply.moves.length,'Unexpected handle in process reply');
  const bytes=length&&!reply.result?await s.read(output,length):undefined;
  c.pending=false;
  row.reply={result:reply.result,data:reply.data.toString('hex')};row.finished=new Date().toISOString();await c.save();
  const data=reply.data,words=Array.from({length:Math.floor(data.length/8)},(_,i)=>data.readBigUInt64LE(i*8));
  return{result:reply.result,data,values:words,...(bytes?{bytes,length:bytes.length}:{})};
 }
 c.request=(id,handle,values)=>exchange(id,handle,values);
 c.readBulk=(handle,pid,address,length)=>exchange(0x524f0016,handle,[pid,address,length,0],length);
 c.probeNotifier=async handle=>{
  check(!c.pending,'A native request remains pending');c.pending=true;
  const reply=await s.ipc('Invoke owned FS notifier',handle,0);c.pending=false;
  return{...reply,transport:0};
 };
 c.close=async()=>{if(!c.pending)await s.cleanup();return close();};
 return c;
}
module.exports={openClient};
