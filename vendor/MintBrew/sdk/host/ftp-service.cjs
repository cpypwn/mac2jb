// independent SDK service owner; graphics keep running during file transfers.
const fs=require('node:fs/promises'),path=require('node:path');
const L=require('./layout.cjs'),{readApp}=require('../../homebrew-launcher/app-catalog.cjs');
const STATUS=8192,REQUEST=8448,MAGIC=0x46545031;
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 const menu=JSON.parse(await fs.readFile(path.join(directory,'launcher-auto.json'))),mapped=menu.controls.mapped,base=mapped+L.OFFSET;
 let stopping=false,owner=null,active=false,server=null,native=null,seen=0,port=5000,lastWrite=0,error='',lastState='';
 process.on('SIGTERM',()=>stopping=true);process.on('SIGINT',()=>stopping=true);
 const report=path.join(directory,'ftp-service.json');
 async function stop(){if(server){await server.stop();server=null;}error='';}
 console.log('SDK FTP service ready.');
 try{while(!stopping){
  const source=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
  if(source.session!==rpc.a.session)throw Error('FTP session differs');
  const selected=source.ftpOwner||source.package,token=selected?.fingerprint??null;
  if(token!==owner){await stop();owner=token;active=false;seen=0;
   if(selected){const catalog=JSON.parse(await fs.readFile(path.join(directory,'app-runtime.json'))),entry=catalog.catalog.apps.find(a=>a.id===selected.id);if(entry){const app=await readApp(entry.root);if(app.fingerprint===token&&app.manifest.sdk?.services?.includes('ftp')){active=true;port=app.manifest.sdk.ftpPort??5000;}}}
   await rpc.write(base+STATUS,Buffer.alloc(272));
  }
  if(active){
   const request=await rpc.read(base+REQUEST,8),sequence=request.readUInt32LE();
   if(sequence&&sequence!==seen){seen=sequence;error='';try{const action=request.readUInt32LE(4);if(action===1){native??=await require('./ftp-native.cjs').create(rpc,directory);server??=require('./ftp-server.cjs').create(native);await server.start(port);}else if(action===2)await stop();else throw Error('Unknown FTP action');}catch(e){error=e.message;}}
   if(server)await server.pump();
   if(Date.now()-lastWrite>=150){const s=server?.state,b=Buffer.alloc(256);b.writeUInt32LE(MAGIC);b.writeUInt32LE(error?3:s?.running?(s.transferring?2:1):0,4);if(s?.address)s.address.split('.').forEach((n,i)=>b[8+i]=Number(n));b.writeUInt32LE(s?.port||port,12);b.writeUInt32LE(s?.clients||0,16);b.writeBigUInt64LE(BigInt(s?.sent||0),24);b.writeBigUInt64LE(BigInt(s?.received||0),32);b.writeUInt32LE(s?.files||0,40);b.writeUInt32LE(seen,44);b.write((error||s?.error||'').slice(0,120),48);b.write((s?.activity||'Stopped').slice(0,80),176);await rpc.write(base+STATUS,b);lastWrite=Date.now();const summary=JSON.stringify({session:rpc.a.session,owner,active,...s,error:error||s?.error||''});if(summary!==lastState){await fs.writeFile(report,summary);lastState=summary;}}
  }
  await new Promise(r=>setTimeout(r,20));
 }}finally{await stop();}
}
module.exports={main,STATUS,REQUEST,MAGIC};
if(require.main===module)main(process.argv[2]).catch(e=>{console.error('FTP service: '+e.message);process.exitCode=1;});
