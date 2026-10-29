const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');

for(const rejectAppend of [false,true])test(rejectAppend?
 'NES AudioOut rejection mutes sound without ending its owner':
 'NES audio refills released buffers without a played-sample counter',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mintnes-audio-fallback-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.mkdir(path.join(directory,'shared'));
 const symbols=path.join(__dirname,'audio-symbols.json');
 await fs.writeFile(path.join(directory,'shared/rpc.cjs'),`
  const symbols=require(${JSON.stringify(symbols)}),slots=new Map(),queue=[],sdk=0x10000000;
  const name=address=>symbols.find(item=>sdk+item.offset===address)?.name||'';
  let frame=0;
  module.exports={a:{session:'test-session',sdk,scratch:0x200000},
   async request(){return {};},
   async read(address,count){
    if(address===0x30010000){const snapshot=Buffer.alloc(104);snapshot.writeUInt32LE(++frame,100);return snapshot;}
    return Buffer.from(slots.get(address)?.subarray(0,count)||Buffer.alloc(count));},
   async write(address,bytes){slots.set(address,Buffer.from(bytes));},
   async call(address,args){if(address===5732112){const pointer=Buffer.alloc(8);pointer.writeBigUInt64LE(0x40000000n);slots.set(args[0],pointer);}return {result:0n};},
   async callAddress(address,args){const functionName=name(address);
    if(functionName.includes('GetAudioOutPlayedSampleCount'))throw Error('counter unsupported by this console');
    if(functionName.includes('GetAudioOutSampleRate'))return {result:48000n};
    if(functionName.includes('GetAudioOutChannelCount')||functionName.includes('GetAudioOutSampleFormat'))return {result:2n};
    if(functionName.includes('GetReleasedAudioOutBuffer')){
     return {result:queue.length&&Date.now()-queue[0].time>=60?BigInt(queue.shift().descriptor):0n};}
    if(functionName.includes('AppendAudioOutBuffer')){
     if(${rejectAppend})throw Error('NES audio buffer rejected by console');
     queue.push({descriptor:args[1],time:Date.now()});return {result:1n};}
    if(functionName.includes('FlushAudioOutBuffers'))queue.length=0;
    return {result:0n};}
  };
 `);
 await fs.writeFile(path.join(directory,'game-audio-source.json'),JSON.stringify({
  session:'test-session',mapped:0x30000000,
  package:{id:'mintnes',fingerprint:'mintnes-test',effects:{}},
  apuMapped:0x30010000,apuBytes:104,apuEventsMapped:0x30010100,apuEventsBytes:768
 }));
 const child=spawn(process.execPath,[path.join(__dirname,'game-audio.cjs'),directory],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
 let output='',errors='';child.stderr.on('data',bytes=>errors+=bytes);child.stdout.on('data',bytes=>output+=bytes);
 const ready=new Promise((resolve,reject)=>{
  child.stdout.on('data',()=>{if(output.includes('Game sound effects ready.'))resolve();});
  child.once('exit',code=>reject(Error('audio owner exited before ready: '+code+' '+errors)));
 });
 let timer;
 try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('audio owner readiness timed out: '+errors)),5000);})]);}
 finally{clearTimeout(timer);}
 const until=Date.now()+4000;
 let report;
 while(Date.now()<until){report=JSON.parse(await fs.readFile(path.join(directory,'game-audio.json')));
  if(rejectAppend?report.nes?.disabled:report.nes?.submittedChunks>=5)break;
  await new Promise(resolve=>setTimeout(resolve,30));}
 child.kill('SIGTERM');
 const code=await new Promise(resolve=>child.once('close',resolve));
 assert.equal(code,0,errors);
 report=JSON.parse(await fs.readFile(path.join(directory,'game-audio.json')));
 assert.equal(report.ready,true);
 if(rejectAppend){assert.equal(report.nes.disabled,true);assert.match(report.nes.error,/buffer rejected/);}
 else{assert.equal(report.nes.disabled,undefined);
  assert.ok(report.nes.submittedChunks>=5,'released descriptors should be reused');
  assert.ok(report.nes.queuedBuffers<=4,'queue should remain bounded');}
 assert.ok(report.completed);
 assert.equal(report.error,undefined);
});
