const fs=require('node:fs/promises'),path=require('node:path');
const symbols=require('./audio-symbols.json');
const nesApu=()=>require('../../../integrations/mintnes/apu.cjs');
const check=(v,m)=>{if(!v)throw Error(m);};
const NES_FRAMES=2400,NES_SLOT_BYTES=16384,NES_EVENT_COUNT=64,NES_QUEUE_TARGET=4;
function synth(kind,style='mintbrew'){
 if(kind===8){
  const light=style==='stremio',rate=48000,frames=light?960:1440,pcm=Buffer.alloc(frames*4);let seed=0x6d696e74;
  for(let i=0;i<frames;i++){
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;
   const t=i/rate,envelope=Math.pow(1-i/frames,light?4:5),noise=((seed>>>16)/32768-1)*(light?.08:.42);
   const attack=light?Math.min(1,i/48):1;
   const sample=Math.round(32767*(light?.055:.13)*attack*envelope*
    (Math.sin(2*Math.PI*(light?1650-300*t:950+1700*t)*t)+noise));
   pcm.writeInt16LE(sample,i*4);pcm.writeInt16LE(sample,i*4+2);
  }
  return pcm;
 }
 const rate=48000,duration=[0,.035,.065,.11,.32,.45,.08,.18][kind],frames=Math.ceil(rate*duration),pcm=Buffer.alloc(frames*4);
 for(let i=0;i<frames;i++){
  const t=i/rate,u=t/duration,attack=Math.min(1,t/.004),envelope=attack*Math.pow(1-u,1.7);
  let frequency=kind===1?240:kind===2?440+u*230:kind===3?140-u*65:kind===5?440*Math.pow(.23,u):kind===6?660:523.25;
  if(kind===4)frequency=[523.25,659.25,783.99,1046.5][Math.min(3,Math.floor(u*4))];
  if(kind===7)frequency=[392,523.25,659.25][Math.min(2,Math.floor(u*3))];
  const fundamental=Math.sin(2*Math.PI*frequency*t),overtone=Math.sin(4*Math.PI*frequency*t)*.18;
  const sample=Math.round(32767*.19*envelope*(fundamental+overtone));pcm.writeInt16LE(sample,i*4);pcm.writeInt16LE(sample,i*4+2);
 }
 return pcm;
}
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),source=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 check(source.session===rpc.a.session,'Game audio belongs to another session');
 const file=path.join(directory,'game-audio.json'),report={session:rpc.a.session,started:new Date().toISOString(),functions:{},resourcesRetained:true,played:0,history:[]};await fs.writeFile(file,'{}',{flag:'wx'});
 const save=()=>fs.writeFile(file,JSON.stringify(report,null,2));const sdkImage=require('../smilebasic/reference/sdk-checks.cjs');
 async function call(name,...args){
  if(!report.functions[name]){const matches=symbols.filter(s=>s.name.includes(name));check(matches.length===1,'Ambiguous sound symbol '+name);const s=matches[0],address=rpc.a.sdk+s.offset;await rpc.request({command:'verify-function',address,hex:sdkImage.bytes(s.offset,Math.min(32,s.size)).toString('hex')});report.functions[name]=address;}
  return (await rpc.callAddress(report.functions[name],args)).result;
 }
 let stop=false,audio,started=false;process.on('SIGINT',()=>stop=true);process.on('SIGTERM',()=>stop=true);
 try{
  const bytes=65536+31*131072+8*NES_SLOT_BYTES,temp=rpc.a.scratch+0x10000,saved=await rpc.read(temp,8);let base;
  try{check((await rpc.call(5732112,[temp,65536,bytes])).result===0n,'Sound allocation failed');base=Number((await rpc.read(temp,8)).readBigUInt64LE());}finally{await rpc.write(temp,saved);}
  check(Number.isSafeInteger(base)&&base>0&&base%65536===0,'Invalid sound allocation');audio=base;report.audio=audio;report.base=base;
  await rpc.write(base,Buffer.alloc(65536));let sounds={};
  const param=base+0x300;await call('InitializeAudioOutParameter',param);const params=await rpc.read(param,8);params.writeUInt32LE(48000);params.writeUInt16LE(2,4);await rpc.write(param,params);
  check((await call('OpenDefaultAudioOutEPNS0_8AudioOutER',audio,param))===0n,'Game audio output failed');
  check((await call('GetAudioOutSampleRate',audio))===48000n&&(await call('GetAudioOutChannelCount',audio))===2n&&(await call('GetAudioOutSampleFormat',audio))===2n,'Unexpected game audio format');
  const descriptorList=Array.from({length:8},(_,i)=>base+0x400+i*0x40),descriptors=new Set(descriptorList),free=new Set(descriptors),pending=new Set();
  async function release(){for(let i=0;i<8&&pending.size;i++){const address=await call('GetReleasedAudioOutBuffer',audio);if(address===0n)break;check(descriptors.has(Number(address)),'Unknown sound descriptor');pending.delete(Number(address));free.add(Number(address));}}
  async function play(kind){
   if(!sounds[kind]||free.size===0||free.size<6)return;
   if((kind===1||kind===2)&&free.size<8)return;
   const descriptor=free.values().next().value,sound=sounds[kind];await call('SetAudioOutBufferInfo',descriptor,sound.address,131072,sound.bytes);
   check((await call('AppendAudioOutBuffer',audio,descriptor))===1n,'Sound buffer rejected');free.delete(descriptor);pending.add(descriptor);if(!started){check((await call('StartAudioOut',audio))===0n,'Sound playback failed');started=true;}report.played++;report.history.push({kind,time:new Date().toISOString()});report.history=report.history.slice(-64);await save();
  }
  let sequence=-1,token=null,nes=null,lastApuSave=0;
  async function muteNes(error){
   const reason=error?.message||String(error);
   report.nes={...report.nes,disabled:true,error:reason};nes=null;
   console.error('MintNES audio muted: '+reason);
   if(started){
    try{
     check((await call('StopAudioOut',audio))===0n,'NES audio pause failed');started=false;
     await call('FlushAudioOutBuffers',audio);await release();
     pending.clear();free.clear();for(const descriptor of descriptors)free.add(descriptor);
    }catch(cleanupError){report.nes.cleanupError=cleanupError?.message||String(cleanupError);}
   }
   await save();
  }
  async function loadEffects(packageInfo,current){
   if(started){check((await call('StopAudioOut',audio))===0n,'Sound pause failed');started=false;}
   await call('FlushAudioOutBuffers',audio);await release();check(Number(await call('GetAudioOutBufferCount',audio))===0,'Sound queue did not drain');pending.clear();free.clear();for(const descriptor of descriptors)free.add(descriptor);sounds={};nes=null;
   for(const [key,file]of Object.entries(packageInfo?.effects||{})){
    const kind=Number(key);check(Number.isInteger(kind)&&kind>=1&&kind<=31,'Invalid sound event id');const pcm=await fs.readFile(file);check(pcm.length>0&&pcm.length<=131072&&pcm.length%4===0,'Invalid package PCM');
    const address=base+65536+(kind-1)*131072,bytes=Buffer.alloc(131072);pcm.copy(bytes);await rpc.write(address,bytes);check((await rpc.read(address,bytes.length)).equals(bytes),'Sound upload differs');sounds[kind]={address,bytes:pcm.length};
   }
   token=packageInfo?.fingerprint||null;
   sequence=(await rpc.read(source.mapped+976,4)).readUInt32LE();
   if(packageInfo?.id==='mintnes'){
    try{
     check(Number.isSafeInteger(current.apuMapped)&&current.apuMapped>0&&current.apuBytes===104,'Invalid NES audio register mailbox');
     check(Number.isSafeInteger(current.apuEventsMapped)&&current.apuEventsMapped>0&&current.apuEventsBytes===NES_EVENT_COUNT*12,'Invalid NES audio event mailbox');
     nes={mapped:current.apuMapped,bytes:current.apuBytes,eventsMapped:current.apuEventsMapped,
      eventsBytes:current.apuEventsBytes,apu:nesApu().create(),lastSequence:0,lastFrame:0,lastAdvance:Date.now(),
      chunks:0,underruns:0,missedEvents:0,hadQueue:false};
     report.nes={mode:'gpu-register-bridge',channels:'pulse 1, pulse 2, triangle, noise',dmcSamples:false};
    }catch(error){await muteNes(error);}
   }else delete report.nes;
   report.package=packageInfo?{id:packageInfo.id,fingerprint:token,effects:Object.keys(sounds)}:null;await save();
  }
  async function pollNes(){
   const snapshot=await rpc.read(nes.mapped,nes.bytes),next=snapshot.readUInt32LE(96),frame=snapshot.readUInt32LE(100);
   if(frame!==nes.lastFrame){nes.lastFrame=frame;nes.lastAdvance=Date.now();}
   const delta=(next-nes.lastSequence)>>>0;
   const ring=delta>0&&delta<=NES_EVENT_COUNT?await rpc.read(nes.eventsMapped,nes.eventsBytes):null;
   const replayed=nesApu().replay(nes.apu,snapshot,ring,nes.lastSequence);
   nes.lastSequence=replayed.sequence;nes.missedEvents+=replayed.missed;
   if(frame===0||Date.now()-nes.lastAdvance>350){
    if(started){check((await call('StopAudioOut',audio))===0n,'NES audio pause failed');started=false;await call('FlushAudioOutBuffers',audio);await release();pending.clear();free.clear();for(const descriptor of descriptors)free.add(descriptor);
     nes.hadQueue=false;}
    return;
   }
   await release();
   if(started&&!pending.size&&nes.hadQueue)nes.underruns++;
   while(free.size&&pending.size<NES_QUEUE_TARGET){
    const descriptor=free.values().next().value,index=descriptorList.indexOf(descriptor);
    const address=base+65536+31*131072+index*NES_SLOT_BYTES,pcm=nes.apu.render(NES_FRAMES);
    await rpc.write(address,pcm);
    await call('SetAudioOutBufferInfo',descriptor,address,NES_SLOT_BYTES,pcm.length);
    check((await call('AppendAudioOutBuffer',audio,descriptor))===1n,'NES audio buffer rejected');
    free.delete(descriptor);pending.add(descriptor);nes.chunks++;nes.hadQueue=true;
   }
   if(!started&&pending.size){check((await call('StartAudioOut',audio))===0n,'NES audio playback failed');started=true;}
   if(Date.now()-lastApuSave>1000){report.nes={...report.nes,frames:frame,registerSequence:next,
    submittedChunks:nes.chunks,queuedBuffers:pending.size,underruns:nes.underruns,missedEvents:nes.missedEvents};lastApuSave=Date.now();await save();}
  }
  await loadEffects(source.package||null,source);
  report.ready=true;await save();console.log('Game sound effects ready.');
  while(!stop){
   const current=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));check(current.session===rpc.a.session,'Sound source session changed');
   if((current.package?.fingerprint||null)!==token)await loadEffects(current.package||null,current);
   if(nes)try{await pollNes();}catch(error){await muteNes(error);}
   else{await release();const state=await rpc.read(source.mapped+784,208),next=state.readUInt32LE(192),kind=state.readUInt32LE(196);
    if(next!==sequence){sequence=next;if(next!==0)await play(kind);}}
   await new Promise(resolve=>setTimeout(resolve,nes?20:50));
  }
 }catch(error){report.error=error.stack;console.error(error);process.exitCode=1;}
 finally{if(started)try{await call('StopAudioOut',audio);}catch(error){report.stopError=error.message;}report.completed=new Date().toISOString();await save();}
}
module.exports={synth};
if(require.main===module)main(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
