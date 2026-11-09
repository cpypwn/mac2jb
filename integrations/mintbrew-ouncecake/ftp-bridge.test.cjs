const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const net=require('node:net');
const {buildIndex}=require('../../vendor/OunceCake/engine/mounts.cjs');
const {start,parseIndex}=require('./ftp-bridge.cjs');

function indexFor(entries){
 return buildIndex([{path:'/game',kind:'storage',entries}]);
}

function listen(server){
 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{
   server.removeListener('error',reject);resolve(server.address().port);
  });
 });
}

function connect(port){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(port,'127.0.0.1');
  socket.once('error',reject);
  socket.once('connect',()=>{socket.removeListener('error',reject);resolve(socket);});
 });
}

function ftpClient(socket){
 let text='',waiter;
 const lines=[];
 socket.on('data',bytes=>{
  text+=bytes.toString();
  let end;
  while((end=text.indexOf('\n'))!==-1){
   const line=text.slice(0,end).replace(/\r$/,'');
   text=text.slice(end+1);
   if(waiter){const done=waiter;waiter=null;done(line);}else lines.push(line);
  }
 });
 const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise(resolve=>{waiter=resolve;});
 return {socket,next,async send(command){socket.write(command+'\r\n');return next();}};
}

async function login(port){
 const client=ftpClient(await connect(port));
 assert.match(await client.next(),/^220 /);
 assert.match(await client.send('USER anonymous'),/^331 /);
 assert.match(await client.send('PASS test@example.com'),/^230 /);
 return client;
}

async function passive(client){
 const response=await client.send('PASV');
 const match=response.match(/^227 .*\(127,0,0,1,(\d+),(\d+)\)/);
 assert.ok(match,response);
 return connect(Number(match[1])*256+Number(match[2]));
}

async function transfer(client,command){
 const data=await passive(client);
 const received=new Promise((resolve,reject)=>{
  const parts=[];
  data.on('data',part=>parts.push(part));
  data.once('end',()=>resolve(Buffer.concat(parts)));
  data.once('error',reject);
 });
 assert.match(await client.send(command),/^150 /);
 const bytes=await received;
 assert.match(await client.next(),/^226 /);
 data.destroy();
 return bytes;
}

test('OunceCake FTP handles a game beyond the ZIP helper file limit',async t=>{
 const entries=Array.from({length:100001},(_,id)=>({path:'/f'+id,type:'file',size:0}));
 const index=indexFor(entries);
 const catalog=parseIndex(index);
 assert.equal(catalog.byPath.get('/game').children.length,100001);
 const bridge=await start({index,sourceAddress:'127.0.0.1'});
 t.after(()=>bridge.close());
 const client=await login(bridge.port);
 t.after(()=>client.socket.destroy());
 assert.match(await client.send('SIZE /game/f100000'),/^213 0$/);
});

test('OunceCake FTP preserves UTF-8 commands split across TCP packets',async t=>{
 const index=indexFor([{path:'/caf\u00e9.bin',type:'file',size:0}]);
 const bridge=await start({index,sourceAddress:'127.0.0.1'});
 t.after(()=>bridge.close());
 const client=await login(bridge.port);
 t.after(()=>client.socket.destroy());
 assert.match(await client.send('FEAT'),/^211-Features$/);
 const features=[];
 for(;;){
  const line=await client.next();
  if(line==='211 End')break;
  features.push(line);
 }
 assert.equal(features.some(line=>line.includes('MLST')),false);
 client.socket.write(Buffer.concat([Buffer.from('SIZE /game/caf'),Buffer.from([0xc3])]));
 await new Promise(resolve=>setTimeout(resolve,10));
 client.socket.write(Buffer.concat([Buffer.from([0xa9]),Buffer.from('.bin\r\n')]));
 assert.match(await client.next(),/^213 0$/);
});

test('OunceCake FTP lists indexed paths and streams read-only files with REST',async t=>{
 const contents=Buffer.from('abcdefghi');
 const source=http.createServer((request,response)=>{
  assert.equal(request.url,'/game/folder/hello%20world.bin');
  const startAt=request.headers.range?Number(request.headers.range.match(/^bytes=(\d+)-$/)?.[1]):0;
  response.writeHead(startAt?206:200,{
   'Content-Length':contents.length-startAt,
   ...(startAt?{'Content-Range':`bytes ${startAt}-${contents.length-1}/${contents.length}`}:{})
  });
  response.end(contents.subarray(startAt));
 });
 const sourcePort=await listen(source);
 t.after(()=>new Promise(resolve=>source.close(resolve)));
 const index=indexFor([{path:'/folder',type:'directory'},
  {path:'/folder/hello world.bin',type:'file',size:contents.length}]);
 const bridge=await start({index,sourceAddress:'127.0.0.1',sourcePort});
 t.after(()=>bridge.close());
 const client=await login(bridge.port);
 t.after(()=>client.socket.destroy());
 assert.match(await client.send('CWD /game/folder'),/^250 /);
 assert.match(await client.send('PWD'),/^257 "\/game\/folder"/);
 assert.match(await client.send('SIZE hello world.bin'),/^213 9$/);
 assert.match((await transfer(client,'NLST')).toString(),/^hello world\.bin\r\n$/);
 assert.match((await transfer(client,'MLSD')).toString(),/type=file;size=9;.*hello world\.bin/);
 assert.match((await transfer(client,'LIST')).toString(),/-r--r--r--.*hello world\.bin/);
 assert.deepEqual(await transfer(client,'RETR hello world.bin'),contents);
 assert.match(await client.send('REST 4'),/^350 /);
 assert.deepEqual(await transfer(client,'RETR hello world.bin'),Buffer.from('efghi'));
 assert.match(await client.send('STOR test.bin'),/^550 Read only$/);
 assert.match(await client.send('DELE hello world.bin'),/^550 Read only$/);
 assert.match(await client.send('MKD test'),/^550 Read only$/);
 assert.match(await client.send('CDUP'),/^250 /);
 assert.match(await client.send('PWD'),/^257 "\/game"/);
 assert.match(await client.send('QUIT'),/^221 /);
});

test('closing OunceCake FTP cancels a stalled WebDAV transfer and drains sockets',async t=>{
 let requested;
 const sawRequest=new Promise(resolve=>{requested=resolve;});
 const source=http.createServer((request,response)=>{
  response.writeHead(200,{'Content-Length':1000000});
  response.write('partial');
  requested();
 });
 const sourcePort=await listen(source);
 t.after(()=>{source.closeAllConnections();return new Promise(resolve=>source.close(resolve));});
 const bridge=await start({index:indexFor([{path:'/stalled.bin',type:'file',size:1000000}]),
  sourceAddress:'127.0.0.1',sourcePort});
 const client=await login(bridge.port);
 const data=await passive(client);
 assert.match(await client.send('RETR /game/stalled.bin'),/^150 /);
 await sawRequest;
 const controlClosed=new Promise(resolve=>client.socket.once('close',resolve));
 const dataClosed=new Promise(resolve=>data.once('close',resolve));
 await Promise.race([bridge.close(),new Promise((_,reject)=>{
  setTimeout(()=>reject(Error('FTP close hung')),2000).unref();
 })]);
 await Promise.all([controlClosed,dataClosed]);
 assert.equal(client.socket.destroyed,true);
 assert.equal(data.destroyed,true);
 await bridge.close();
});

test('OunceCake FTP rejects unsafe or malformed index nodes',()=>{
 const traversal=indexFor([{path:'/safe.bin',type:'file',size:1}]);
 const file=64+2*48;
 traversal.writeUInt32LE(0,file+20);
 assert.throws(()=>parseIndex(traversal),/Invalid OunceCake FTP index node/);
 const duplicate=indexFor([{path:'/one',type:'file',size:1},{path:'/two',type:'file',size:1}]);
 const second=64+3*48;
 duplicate.writeUInt32LE(duplicate.readUInt32LE(64+2*48+16),second+16);
 duplicate.writeUInt32LE(3,second+20);
 assert.throws(()=>parseIndex(duplicate),/Duplicate or excessive OunceCake FTP path/);
});
