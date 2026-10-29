const fs=require('node:fs/promises'),path=require('node:path'),dgram=require('node:dgram'),crypto=require('node:crypto'),net=require('node:net');
async function main(directory,host){
 if(!net.isIPv4(host))throw Error('Supply the PC LAN IPv4 address');directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 const defs=require('../native/service-functions.json'),api=await require('../native/client.cjs').create(rpc,Object.fromEntries(Object.entries(defs).filter(([k])=>['socket','sendto','recv','socketClose','errno','socketInitialized'].includes(k))));
 const worker=await require('../../homebrew-launcher/native-six.cjs').create(rpc,directory),server=dgram.createSocket('udp4');
 await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,host,resolve);});let received;
 server.on('message',(bytes,peer)=>{received=Buffer.from(bytes);server.send(bytes,peer.port,peer.address);});
 const nonce=crypto.randomBytes(32),report={session:rpc.a.session,nonce:nonce.toString('hex'),host,port:server.address().port};let socket=-1;
 try{
  if(await api.result('socketInitialized')!==1)throw Error('Console sockets not initialized');socket=Number(BigInt.asIntN(32,await api.call('socket',[2,2,17])));if(socket<0)throw Error('UDP socket failed');
  const address=Buffer.alloc(16);address[0]=16;address[1]=2;address.writeUInt16BE(report.port,2);host.split('.').forEach((n,i)=>address[4+i]=+n);await api.write(0,address);await api.write(256,nonce);
  report.sent=Number(BigInt.asIntN(64,await worker.call(api.functions.sendto,[socket,api.base+256,nonce.length,0,api.base,16])));
  const until=Date.now()+5000;report.received=-1;
  while(Date.now()<until){const result=Number(BigInt.asIntN(64,await api.call('recv',[socket,api.base+512,64,0x80])));if(result>=0){report.received=result;break;}report.errno=await api.result('errno');await new Promise(r=>setTimeout(r,25));}
  const bytes=report.received>0?await api.read(512,report.received):Buffer.alloc(0);report.consoleEchoMatches=bytes.equals(nonce);report.hostReceivedMatches=received?.equals(nonce)||false;
  if(!report.consoleEchoMatches||!report.hostReceivedMatches)throw Error('UDP echo did not match');
 }finally{if(socket>=0)report.close=await api.result('socketClose',[socket]);server.close();report.completed=new Date().toISOString();await fs.writeFile(path.join(directory,'sdk-network-probe.json'),JSON.stringify(report,null,2),{mode:0o600});}
 console.log(JSON.stringify(report,null,2));
}
module.exports={main};if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});
