const dgram=require('node:dgram'),net=require('node:net');

async function select(consoleIP,configured=process.env.HB_STREAM_HOST){
  if(!net.isIPv4(consoleIP)||consoleIP==='0.0.0.0')throw Error('Invalid console stream address');
  if(configured){
    if(!net.isIPv4(configured)||configured==='0.0.0.0')throw Error('Invalid PC stream host');
    return configured;
  }
  const socket=dgram.createSocket('udp4');
  try{
    await new Promise((resolve,reject)=>socket.connect(9,consoleIP,error=>error?reject(error):resolve()));
    const host=socket.address().address;
    if(!net.isIPv4(host)||host==='0.0.0.0')throw Error('Could not identify the Mac address for the console route');
    return host;
  }finally{socket.close();}
}

module.exports={select};
