'use strict';
const net=require('node:net'),dgram=require('node:dgram'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');
const P=require('./protocol.cjs');
const check=(value,message)=>{if(!value)throw Error(message);};
const ACK_BYTES=24,TRIGGER_BYTES=8,DESCRIPTOR_BYTES=16;
const MAX_PACKET=P.FRAME_HEADER_BYTES+Math.max(...P.FORMATS.map(row=>row.bytes));
function descriptor({mapped,address,length}){
  check(Number.isSafeInteger(mapped)&&mapped>=4096&&mapped%4096===0&&mapped+P.MEMORY_BYTES<2**39,'Invalid receiver media mapping');
  const relative=address-mapped-P.HEADER_BYTES;
  check(Number.isSafeInteger(address)&&relative>=0&&relative%P.SLOT_BYTES===0&&relative/P.SLOT_BYTES<P.SLOTS,'Receiver destination is not an owned media slot');
  check(Number.isInteger(length)&&P.FORMATS.some(row=>length===P.FRAME_HEADER_BYTES+row.bytes)&&length<=MAX_PACKET,'Invalid receiver packet length');
  const bytes=Buffer.alloc(DESCRIPTOR_BYTES);bytes.writeBigUInt64LE(BigInt(address));bytes.writeUInt32LE(length,8);return bytes;
}
function createBulkSender({rpc,socket,control,mapped,timeoutMs=15000}){
  check(rpc&&typeof rpc.write==='function'&&socket&&typeof socket.write==='function','Missing receiver RPC or socket');
  check(Number.isSafeInteger(control)&&control>=4096&&control+DESCRIPTOR_BYTES<2**39&&control%8===0,'Invalid receiver control allocation');
  check(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000,'Invalid receiver timeout');
  let failure,closed=false,busy=false,pending=null,counter=0n;
  const stats={transport:'dedicated-tcp-v1',frames:0,payloadBytes:0,wireSentBytes:0,wireReceivedBytes:0,descriptorWrites:0};
  function fail(error){failure ||= error;if(pending){const own=pending;pending=null;clearTimeout(own.timer);own.reject(failure);}socket.destroy();}
  function alive(){if(failure)throw failure;check(!closed,'Bulk media receiver is closed');}
  socket.setNoDelay(true);
  socket.on('error',fail);socket.on('end',()=>fail(Error('Bulk media receiver disconnected')));
  socket.on('close',()=>{if(!closed)fail(Error('Bulk media receiver closed'));});
  socket.on('data',bytes=>{
    stats.wireReceivedBytes+=bytes.length;
    if(!pending){fail(Error('Unexpected bulk media acknowledgement'));return;}
    const own=pending;
    if(own.received.length+bytes.length>ACK_BYTES){fail(Error('Oversized bulk media acknowledgement'));return;}
    own.received=Buffer.concat([own.received,bytes]);
    if(own.received.length!==ACK_BYTES)return;
    const ack=own.received;
    if(!ack.subarray(0,8).equals(own.token)||ack.readBigInt64LE(8)!==8n||ack.readBigInt64LE(16)!==BigInt(own.length)){
      fail(Error('Bulk media receiver did not complete the expected frame'));return;
    }
    pending=null;clearTimeout(own.timer);own.resolve();
  });
  socket.resume();
  const upload=async({address,packet,sequence})=>{
    alive();check(!busy,'Bulk media upload is already pending');
    check(Buffer.isBuffer(packet)&&packet.length>=P.FRAME_HEADER_BYTES,'Invalid bulk media packet');
    const format=P.FORMATS.find(row=>row.width===packet.readUInt32LE(8)&&row.height===packet.readUInt32LE(12));
    check(format&&packet.length===P.FRAME_HEADER_BYTES+format.bytes,'Bulk media format and payload differ');
    check(Number.isInteger(sequence)&&sequence>0&&sequence<=0x3fffffff&&packet.readUInt32LE()===sequence,'Invalid bulk media sequence');
    const controlBytes=descriptor({mapped,address,length:packet.length});
    const body=Buffer.from(packet);busy=true;
    try{
      // the fixed trigger keeps descriptor loads behind this trusted write.
      await rpc.write(control,controlBytes);stats.descriptorWrites++;alive();
      const token=Buffer.alloc(8);token.writeBigUInt64LE(++counter);
      const acknowledged=new Promise((resolve,reject)=>{
        pending={resolve,reject,token,length:body.length,received:Buffer.alloc(0),
          timer:setTimeout(()=>fail(Error('Bulk media acknowledgement timed out; frame was not published')),timeoutMs)};
      });
      // handle rejection before a write can fail synchronously.
      const waiting=acknowledged.catch(error=>{throw error;});waiting.catch(()=>{});
      const wire=Buffer.concat([token,body]);stats.wireSentBytes+=wire.length;
      try{socket.write(wire,error=>{if(error)fail(error);});}catch(error){fail(error);}
      await waiting;alive();stats.frames++;stats.payloadBytes+=body.length;
    }catch(error){fail(error);throw failure;}finally{busy=false;}
  };
  return {upload,stats,get failed(){return failure;},close(){if(closed)return;closed=true;fail(Object.assign(Error('Bulk media receiver stopped'),{code:'STREMIO_RECEIVER_CANCELLED'}));}};
}
async function routeAddress(consoleIP){
  check(net.isIPv4(consoleIP)&&consoleIP!=='0.0.0.0','Console network address is unavailable');
  const socket=dgram.createSocket('udp4');
  try{return await new Promise((resolve,reject)=>{
    socket.once('error',reject);socket.connect(9,consoleIP,()=>{const host=socket.address().address;
      try{check(net.isIPv4(host)&&host!=='0.0.0.0'&&!host.startsWith('127.'),'No local IPv4 route to the console');resolve(host);}catch(error){reject(error);}});
  });}finally{socket.close();}
}
async function listen({host,consoleIP,token,timeoutMs=15000}){
  const candidates=new Set();let accepted,resolvePeer,rejectPeer,closed=false,timer;
  const peer=new Promise((resolve,reject)=>{resolvePeer=resolve;rejectPeer=reject;});peer.catch(()=>{});
  const server=net.createServer(socket=>{
    if(closed||accepted||socket.remoteAddress!==consoleIP||candidates.size>=2){socket.destroy();return;}
    candidates.add(socket);let bytes=Buffer.alloc(0);
    const drop=()=>{candidates.delete(socket);socket.destroy();};
    socket.setTimeout(3000,drop);socket.on('error',drop);
    const receive=part=>{
      bytes=Buffer.concat([bytes,part]);
      if(bytes.length>32){drop();return;}
      if(bytes.length!==32)return;
      if(!crypto.timingSafeEqual(bytes,token)){drop();return;}
      accepted=socket;socket.pause();socket.removeListener('data',receive);socket.setTimeout(0);socket.removeAllListeners('timeout');
      clearTimeout(timer);candidates.delete(socket);for(const other of candidates)other.destroy();candidates.clear();resolvePeer(socket);
    };
    socket.on('data',receive);socket.once('close',()=>candidates.delete(socket));
  });
  const abort=error=>{clearTimeout(timer);rejectPeer(error);};
  server.on('error',abort);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,()=>{server.removeListener('error',reject);resolve();});});
  return {port:server.address().port,wait(){
    if(!accepted&&!timer)timer=setTimeout(()=>abort(Error('Console did not authenticate the dedicated media connection')),timeoutMs);
    return peer;
  },async close(){
    if(closed)return;closed=true;abort(Error('Media listener stopped'));accepted?.destroy();for(const socket of candidates)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }};
}
async function create({rpc,mapped,directory,onProgress=()=>{},dependencies={}}){
  const native=dependencies.native||require('./receiver-program.cjs');
  const code=require('../vendor/GPUBrewLauncher/smilebasic/engine/switch2/app/thread-code.json').functions;
  const definitions=require('../vendor/GPUBrewLauncher/sdk/native/ftp-functions.json');
  const sdkFunctions=require('../vendor/GPUBrewLauncher/smilebasic/engine/shared/sdk-functions.json');
  const connect={offset:sdkFunctions.connect.offset,hex:sdkFunctions.connect.bytes};
  const functions={};let base,fd=-1,program,listener,sender,thread=null,closePromise,threadUncertain=false;
  const report={session:rpc.a.session,transport:'dedicated-tcp-v1',started:new Date().toISOString(),threadRunning:false,resourcesRetained:true};
  const file=path.join(directory,'stremio-receiver.json');
  const save=()=>fs.writeFile(file,JSON.stringify({...report,...(sender?{transfer:sender.stats}:{})},null,2)+'\n',{mode:0o600});
  const writeChunks=async(address,bytes)=>{for(let at=0;at<bytes.length;at+=P.WRITE_BYTES)await rpc.write(address+at,bytes.subarray(at,at+P.WRITE_BYTES));};
  async function close(){
    if(closePromise)return closePromise;
    closePromise=(async()=>{
      let error;
      try{if(program&&(thread!==null||threadUncertain)){const stop=Buffer.alloc(8);stop.writeBigUInt64LE(BigInt(program.exit));await rpc.write(program.selector,stop);}}
      catch(cause){error=cause;}
      // destroying the peer wakes a blocked receive even if stop delivery was
      // uncertain. retain the mapping and worker storage throughout shutdown.
      sender?.close();try{await listener?.close();}catch(cause){error ||= cause;}
      if(thread!==null)try{
        const until=Date.now()+10000;let done=false;
        while(Date.now()<until){const value=(await rpc.callAddress(rpc.a.sdk+code.tryWait.offset,[thread])).result;
          check(value===0n||value===1n,'Invalid receiver worker shutdown state');if(value===1n){done=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
        check(done,'Media receiver did not stop; restart the console');
        check((await rpc.callAddress(rpc.a.sdk+code.join.offset,[thread,base+8])).result===0n,'Media receiver join failed');thread=null;report.threadRunning=false;
      }catch(cause){error ||= cause;}
      if(thread===null&&!threadUncertain&&fd>=0)try{check((await rpc.callAddress(functions.socketClose,[fd])).result===0n,'Media socket close failed');fd=-1;}catch(cause){error ||= cause;}
      if(threadUncertain)error ||= Error('Receiver worker identity is uncertain; restart the console');
      report.completed=new Date().toISOString();report.cleanShutdown=!error&&thread===null;if(error){report.cleanupError=error.message;error.cleanupBlocked=true;report.cleanupBlocked=true;}await save();if(error)throw error;
    })();return closePromise;
  }
  try{
    onProgress('Preparing the dedicated Stremio media receiver');
    for(const [name,entry]of Object.entries({...Object.fromEntries(['socket','recv','send','socketClose','netAddress'].map(name=>[name,definitions[name]])),connect})){
      await rpc.request({command:'verify-function',address:rpc.a.sdk+entry.offset,hex:entry.hex});functions[name]=rpc.a.sdk+entry.offset;
    }
    for(const entry of Object.values(code))await rpc.request({command:'verify-function',address:rpc.a.sdk+entry.offset,hex:entry.bytes.slice(0,512)});
    await rpc.request({command:'verify-function',address:rpc.a.sdk+0x586fb0,hex:require('../vendor/GPUBrewLauncher/sdk/native/ipc-functions.json').copy.hex});
    const allocation=await rpc.call(5732112,[rpc.output,4096,native.ALLOCATION_BYTES]);
    check(allocation.result===0n,'Receiver worker allocation failed');base=Number(allocation.output.readBigUInt64LE());
    check(Number.isSafeInteger(base)&&base>=4096&&base%4096===0&&base+native.ALLOCATION_BYTES<2**39,'Invalid receiver allocation');
    await rpc.write(base,Buffer.alloc(4096));
    check((await rpc.callAddress(functions.netAddress,[base+128])).result===0n,'Console network address lookup failed');
    const ipBytes=await rpc.read(base+128,4);check(ipBytes.length===4,'Console network address was truncated');
    const consoleIP=[...ipBytes].join('.'),host=await (dependencies.routeAddress||routeAddress)(consoleIP),token=crypto.randomBytes(32);
    listener=await (dependencies.listen||listen)({host,consoleIP,token});report.host=host;report.consoleIP=consoleIP;report.port=listener.port;
    const result=(await rpc.callAddress(functions.socket,[2,1,6])).result;fd=Number(BigInt.asIntN(32,result));check(fd>=0,'Dedicated media socket creation failed');
    const sockaddr=Buffer.alloc(16);sockaddr[0]=16;sockaddr[1]=2;sockaddr.writeUInt16BE(listener.port,2);host.split('.').forEach((value,index)=>sockaddr[4+index]=Number(value));
    program=native.programs({base,sdk:rpc.a.sdk,mapped,memoryBytes:P.MEMORY_BYTES,fd,functions,sockaddr,handshake:token,code});
    for(const {address,bytes}of program.initialization)await writeChunks(address,bytes);
    for(const {address,bytes}of program.readbacks)check((await rpc.read(address,bytes.length)).equals(bytes),'Media receiver program readback differs');
    threadUncertain=true;
    check((await rpc.callAddress(rpc.a.sdk+code.create.offset,[base,0,rpc.a.sdk+code.longjmp.offset,program.boot])).result===0n,'Receiver worker did not start');
    const identity=await rpc.read(base,8);check(identity.length===8,'Receiver worker identity was truncated');thread=identity.readBigUInt64LE();check(thread!==0n,'Invalid receiver worker identity');threadUncertain=false;
    report.thread=String(thread);report.threadRunning=true;await save();
    const socket=await listener.wait();
    // authenticate the owned worker, then verify both startup calls before
    // arming a frame.
    const deadline=Date.now()+2000;
    for(;;){
      const connected=await rpc.read(program.bootResults.connect,8),sent=await rpc.read(program.bootResults.send,8);
      check(connected.length===8&&sent.length===8,'Media receiver bootstrap results were truncated');
      if(connected.readBigInt64LE()===0n&&sent.readBigInt64LE()===32n)break;
      check(Date.now()<deadline,'Media receiver bootstrap did not complete');await new Promise(resolve=>setTimeout(resolve,10));
    }
    check(!socket.destroyed,'Media receiver disconnected during qualification');
    sender=createBulkSender({rpc,socket,control:program.control,mapped});report.ready=true;await save();
    onProgress('Dedicated Stremio media receiver ready');
    return {upload:sender.upload,stats:sender.stats,report,close};
  }catch(error){report.error=error.message;try{await close();}catch(cleanupError){report.cleanupError=cleanupError.message;error.cleanupBlocked=true;}await save();throw error;}
}
module.exports={create,createBulkSender,descriptor,routeAddress,listen,ACK_BYTES,TRIGGER_BYTES,DESCRIPTOR_BYTES,MAX_PACKET};
