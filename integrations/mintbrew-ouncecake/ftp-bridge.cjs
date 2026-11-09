const http=require('node:http');
const net=require('node:net');
const path=require('node:path');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {StringDecoder}=require('node:string_decoder');

const MAX_INDEX_BYTES=64*1024*1024;
const MAX_NODES=200000;
const NONE=0xffffffff;

function check(value,message){if(!value)throw Error(message);}

function number(value){
 check(value<=BigInt(Number.MAX_SAFE_INTEGER),'OunceCake FTP index value is too large');
 return Number(value);
}

function parseIndex(index){
 check(Buffer.isBuffer(index)&&index.length>=64&&index.length<=MAX_INDEX_BYTES,
  'Invalid OunceCake FTP index size');
 check(index.toString('ascii',0,8)==='NS2FTPIX'&&index.readUInt32LE(8)===1&&
  index.readUInt32LE(12)===48,'Invalid OunceCake FTP index header');
 const count=number(index.readBigUInt64LE(16));
 const nodesAt=number(index.readBigUInt64LE(24));
 const stringsAt=number(index.readBigUInt64LE(32));
 const stringsSize=number(index.readBigUInt64LE(40));
 const total=number(index.readBigUInt64LE(48));
 check(count>0&&count<=MAX_NODES&&nodesAt===64&&
  stringsAt===64+count*48&&stringsAt+stringsSize===total&&total===index.length,
  'Invalid OunceCake FTP index layout');
 const nodes=new Array(count);
 const byPath=new Map();
 for(let id=0;id<count;id++){
  const at=64+id*48;
  const parent=index.readUInt32LE(at);
  const first=index.readUInt32LE(at+4);
  const next=index.readUInt32LE(at+8);
  const type=index.readUInt32LE(at+12);
  const nameAt=index.readUInt32LE(at+16);
  const nameLength=index.readUInt32LE(at+20);
  const size=index.readBigUInt64LE(at+40);
  check((id===0?parent===0&&type===0&&nameLength===0:parent<id&&nodes[parent].type===0)&&
   (type===0||type===1)&&nameLength<1024&&nameAt+nameLength<stringsSize&&
   index[stringsAt+nameAt+nameLength]===0,
  'Invalid OunceCake FTP index node');
  check((first===NONE||type===0&&first>id&&first<count)&&
   (next===NONE||id>0&&next>id&&next<count),
  'Invalid OunceCake FTP index links');
  const name=index.toString('utf8',stringsAt+nameAt,stringsAt+nameAt+nameLength);
  check(id===0||name.length>0&&name!=='.'&&name!=='..'&&
   !/[\\/\x00-\x1f\x7f]/.test(name)&&Buffer.byteLength(name)===nameLength,
  'Unsafe OunceCake FTP file name');
  const filename=id===0?'/':nodes[parent].path==='/'?'/'+name:nodes[parent].path+'/'+name;
  check(Buffer.byteLength(filename)<=1023&&!byPath.has(filename),
   'Duplicate or excessive OunceCake FTP path');
  const node={id,parent,first,next,type,name,path:filename,size,children:[]};
  nodes[id]=node;byPath.set(filename,node);
  if(id>0)nodes[parent].children.push(node);
 }
 for(const node of nodes){
  if(node.first!==NONE)check(nodes[node.first].parent===node.id,
   'Invalid OunceCake FTP first child');
  if(node.next!==NONE)check(nodes[node.next].parent===node.parent,
   'Invalid OunceCake FTP next sibling');
 }
 return {nodes,byPath};
}

function resolvePath(cwd,value){
 const filename=path.posix.resolve(cwd,value||'.');
 check(Buffer.byteLength(filename)<=1023,'OunceCake FTP path is too long');
 return filename;
}

function sourcePath(filename){
 return filename.split('/').map(encodeURIComponent).join('/');
}

function reply(session,code,message){
 if(session.closed||session.socket.destroyed)return;
 session.socket.write(code+' '+String(message).replace(/[\r\n\x00]/g,' ').slice(0,256)+'\r\n');
}

function closeData(session){
 session.waitDataReject?.(Error('FTP data connection closed'));
 session.waitDataReject=null;
 if(session.waitDataTimer)clearTimeout(session.waitDataTimer);
 session.waitDataTimer=null;
 session.upstream?.destroy();
 session.upstream=null;
 session.data?.destroy();
 session.data=null;
 if(session.passive){
  const listener=session.passive;
  session.passive=null;
  const closed=new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  session.passiveClosures.add(closed);
  closed.then(()=>session.passiveClosures.delete(closed),
   ()=>session.passiveClosures.delete(closed));
 }
}

async function passiveInner(session,extended){
 closeData(session);
 const listener=net.createServer(socket=>{
  if(session.closed||session.data||!['127.0.0.1','::ffff:127.0.0.1'].includes(socket.remoteAddress)){
   socket.destroy();return;
  }
  session.data=socket;
  socket.setNoDelay(true);
  if(session.waitDataResolve){session.waitDataResolve(socket);session.waitDataResolve=null;
   session.waitDataReject=null;clearTimeout(session.waitDataTimer);session.waitDataTimer=null;}
 });
 try{
  await new Promise((resolve,reject)=>{
   listener.once('error',reject);
   listener.listen(0,'127.0.0.1',()=>{listener.removeListener('error',reject);resolve();});
  });
 }catch(error){listener.close(()=>{});throw error;}
 if(session.closed){
  await new Promise(resolve=>listener.close(resolve));
  throw Error('FTP session closed');
 }
 session.passive=listener;
 const port=listener.address().port;
 if(extended)reply(session,229,`Entering Extended Passive Mode (|||${port}|)`);
 else reply(session,227,`Entering Passive Mode (127,0,0,1,${port>>8},${port&255})`);
}

async function passive(session,extended){
 const task=passiveInner(session,extended);
 session.passiveTask=task;
 try{return await task;}
 finally{if(session.passiveTask===task)session.passiveTask=null;}
}

function dataConnection(session){
 if(session.data)return Promise.resolve(session.data);
 if(!session.passive)return Promise.reject(Error('Use PASV or EPSV first'));
 return new Promise((resolve,reject)=>{
  session.waitDataResolve=resolve;
  session.waitDataReject=reject;
  session.waitDataTimer=setTimeout(()=>{
   session.waitDataResolve=null;session.waitDataReject=null;session.waitDataTimer=null;
   reject(Error('FTP passive data connection timed out'));
  },30000);
 });
}

function listing(node,kind){
 const entries=node.type===0?node.children:[node];
 return Buffer.from(entries.map(entry=>{
  if(kind==='NLST')return entry.name;
  if(kind==='MLSD')return `type=${entry.type===0?'dir':'file'};size=${entry.type===0?'0':entry.size};modify=19700101000000; ${entry.name}`;
  return `${entry.type===0?'drwxr-xr-x':'-r--r--r--'} 1 ftp ftp ${String(entry.type===0?0:entry.size).padStart(12)} Jan 01  1970 ${entry.name}`;
 }).join('\r\n')+(entries.length?'\r\n':''));
}

function openSource(session,filename,size,offset,sourceAddress,sourcePort){
 return new Promise((resolve,reject)=>{
  const remaining=size-offset;
  const headers=offset?{Range:`bytes=${offset}-`}:{};
  const request=http.get({host:sourceAddress,port:sourcePort,
   path:sourcePath(filename),headers,timeout:30000},response=>{
   const expected=offset?206:200;
   const range=offset?`bytes ${offset}-`:null;
   if(response.statusCode!==expected||response.headers['content-length']!==remaining.toString()||
    (range&&!String(response.headers['content-range']||'').startsWith(range))){
    response.destroy();reject(Error('OunceCake WebDAV response differs from its file index'));
    return;
   }
   session.upstream=response;
   resolve(response);
  });
  session.upstream=request;
  request.once('timeout',()=>request.destroy(Error('OunceCake WebDAV download timed out')));
  request.once('error',reject);
 });
}

function start({index,sourceAddress,sourcePort=2121}={}){
 const catalog=parseIndex(index);
 check(net.isIPv4(sourceAddress),'Invalid OunceCake FTP source address');
 check(Number.isInteger(sourcePort)&&sourcePort>0&&sourcePort<65536,
  'Invalid OunceCake FTP source port');
 const sessions=new Set();
 const transfers=new Set();
 const passiveClosures=new Set();
 let closing=false,closePromise;
 const server=net.createServer(socket=>{
  if(closing||sessions.size>=4){socket.end('421 Too many FTP clients\r\n');return;}
  socket.setNoDelay(true);
  const session={socket,cwd:'/',logged:false,user:'',restart:0n,input:'',decoder:new StringDecoder('utf8'),
   queue:Promise.resolve(),passive:null,passiveTask:null,data:null,upstream:null,transfer:null,
   closed:false,passiveClosures};
  sessions.add(session);
  reply(session,220,'OunceCake read-only FTP ready');
  socket.on('data',bytes=>{
   session.input+=session.decoder.write(bytes);
   if(session.input.length>8192){socket.destroy();return;}
   let end;
   while((end=session.input.indexOf('\n'))!==-1){
    const line=session.input.slice(0,end).replace(/\r$/,'');
    session.input=session.input.slice(end+1);
    session.queue=session.queue.then(()=>command(session,line)).catch(error=>{
     if(!session.closed)reply(session,550,error.message);
    });
   }
  });
  socket.on('error',()=>{});
  socket.on('close',()=>{
   session.closed=true;session.aborted=true;closeData(session);sessions.delete(session);
  });
 });

 function transfer(session,kind,node){
  if(session.transfer){reply(session,450,'Transfer already active');return;}
  if(!session.passive&&!session.data){reply(session,425,'Use PASV or EPSV first');return;}
  session.aborted=false;
  const offset=kind==='RETR'?session.restart:0n;
  session.restart=0n;
  if(kind==='RETR'&&offset>node.size){reply(session,551,'Restart offset exceeds file size');return;}
  reply(session,150,'Opening binary data connection');
  const operation=(async()=>{
   const data=await dataConnection(session);
   if(kind==='RETR'){
    if(offset===node.size){await new Promise(resolve=>data.end(resolve));return;}
    const response=await openSource(session,node.path,node.size,offset,sourceAddress,sourcePort);
    let received=0n;
    const count=new Transform({transform(bytes,encoding,done){
     received+=BigInt(bytes.length);
     done(received<=node.size-offset?null:Error('OunceCake file exceeded its indexed size'),bytes);
    }});
    await pipeline(response,count,data);
    check(received===node.size-offset,'OunceCake file ended before its indexed size');
   }else{
    const bytes=listing(node,kind);
    await new Promise((resolve,reject)=>{
     data.once('error',reject);
     data.end(bytes,()=>{data.removeListener('error',reject);resolve();});
    });
   }
  })().then(()=>{if(!session.aborted)reply(session,226,'Transfer complete');},error=>{
   if(!session.aborted)reply(session,451,error.message);
  }).finally(()=>{
   closeData(session);session.transfer=null;transfers.delete(operation);
  });
  session.transfer=operation;transfers.add(operation);
 }

 async function command(session,line){
  if(session.closed)return;
  const split=line.indexOf(' ');
  const verb=(split===-1?line:line.slice(0,split)).toUpperCase();
  const arg=split===-1?'':line.slice(split+1);
  if(!/^[A-Z]{3,5}$/.test(verb)){reply(session,500,'Invalid command');return;}
  if(verb==='QUIT'){reply(session,221,'Goodbye');session.socket.end();return;}
  if(verb==='USER'){
   session.user=arg.toLowerCase();session.logged=false;
   reply(session,['anonymous','ftp'].includes(session.user)?331:530,
    ['anonymous','ftp'].includes(session.user)?'Send password':'Use anonymous login');return;
  }
  if(verb==='PASS'){
   session.logged=['anonymous','ftp'].includes(session.user);
   reply(session,session.logged?230:530,session.logged?'Logged in':'Use anonymous login');return;
  }
  if(verb==='FEAT'){
   session.socket.write('211-Features\r\n UTF8\r\n EPSV\r\n PASV\r\n SIZE\r\n REST STREAM\r\n211 End\r\n');return;
  }
  if(verb==='SYST'){reply(session,215,'UNIX Type: L8');return;}
  if(verb==='OPTS'){reply(session,/^UTF8 ON$/i.test(arg)?200:501,'UTF8 ON supported');return;}
  if(verb==='NOOP'){reply(session,200,'OK');return;}
  if(!session.logged){reply(session,530,'Log in first');return;}
  if(verb==='ABOR'){
   const active=!!session.transfer;
   session.aborted=true;closeData(session);
   if(active)reply(session,426,'Transfer aborted');
   reply(session,226,'Abort complete');return;
  }
  if(session.transfer){reply(session,450,'Transfer in progress');return;}
  if(verb==='PWD'||verb==='XPWD'){
   reply(session,257,'"'+session.cwd.replaceAll('"','""')+'"');return;
  }
  if(verb==='CWD'||verb==='CDUP'){
   const filename=resolvePath(session.cwd,verb==='CDUP'?'..':arg);
   const node=catalog.byPath.get(filename);
   check(node&&node.type===0,'Directory not found');
   session.cwd=filename;reply(session,250,'Directory changed');return;
  }
  if(verb==='TYPE'){reply(session,['I','A','A N'].includes(arg.toUpperCase())?200:504,
   'Transfers preserve file bytes');return;}
  if(verb==='MODE'||verb==='STRU'){
   reply(session,(verb==='MODE'?arg==='S':arg==='F')?200:504,'Stream/file mode only');return;
  }
  if(verb==='PASV'||verb==='EPSV'){
   if(verb==='EPSV'&&arg&&arg!=='1'){reply(session,522,'IPv4 only');return;}
   await passive(session,verb==='EPSV');return;
  }
  if(verb==='PORT'||verb==='EPRT'){reply(session,502,'Use passive mode');return;}
  if(['STOR','APPE','DELE','RMD','MKD','RNFR','RNTO','SITE'].includes(verb)){
   reply(session,550,'Read only');return;
  }
  if(verb==='REST'){
   check(/^\d+$/.test(arg)&&BigInt(arg)<=(1n<<64n)-1n,'Invalid restart offset');
   session.restart=BigInt(arg);reply(session,350,'Restart offset accepted');return;
  }
  if(verb==='SIZE'){
   const node=catalog.byPath.get(resolvePath(session.cwd,arg));
   check(node&&node.type===1,'File not found');reply(session,213,node.size);return;
  }
  if(['LIST','NLST','MLSD','RETR'].includes(verb)){
   const value=verb==='LIST'&&/^-(a|l|la|al)$/.test(arg)?'.':arg;
   const node=catalog.byPath.get(resolvePath(session.cwd,value));
   check(node,'File or directory not found');
   check(verb!=='RETR'||node.type===1,'Not a file');
   transfer(session,verb,node);return;
  }
  reply(session,502,'Command not implemented');
 }

 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{
   server.removeListener('error',reject);
   resolve({address:'127.0.0.1',port:server.address().port,close(){
    if(closePromise)return closePromise;
    closing=true;
    const stopped=new Promise((done,fail)=>server.close(error=>error?fail(error):done()));
    const closedSockets=[];
    const passiveTasks=[];
    for(const session of sessions){
     closedSockets.push(new Promise(resolve=>session.socket.once('close',resolve)));
     if(session.passiveTask)passiveTasks.push(session.passiveTask);
     session.closed=true;session.aborted=true;closeData(session);session.socket.destroy();
    }
    closePromise=Promise.all([stopped,Promise.all(closedSockets),
     Promise.allSettled([...transfers]),Promise.allSettled(passiveTasks),
     Promise.all([...passiveClosures])]).then(()=>{
     check(sessions.size===0&&transfers.size===0&&passiveClosures.size===0,
      'OunceCake FTP did not drain');
    });
    return closePromise;
   }});
  });
 });
}

module.exports={start,parseIndex};
