'use strict';

const CPU_RATE=1789773;
const LENGTHS=[10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,
  12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30];
const NOISE_PERIODS=[4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068];
const CHANNELS=[{base:0,enable:1},{base:4,enable:2},{base:8,enable:4},{base:12,enable:8}];

function create({rate=48000}={}){
 if(!Number.isInteger(rate)||rate<8000||rate>192000)throw Error('Invalid NES audio rate');
 const registers=new Uint8Array(24),lengths=new Uint16Array(4),envelopes=Array.from({length:3},()=>({start:false,divider:0,decay:0}));
 const sweep=Array.from({length:2},()=>({reload:false,divider:0}));
 const phases=new Float64Array(3);
 let noisePhase=0,noiseShift=1,quarterPhase=0,halfStep=0,hp90=0,hp90Input=0,hp440=0,hp440Input=0,lp=0;
 const highpass90=Math.exp(-2*Math.PI*90/rate),highpass440=Math.exp(-2*Math.PI*440/rate);
 const lowpass14k=1-Math.exp(-2*Math.PI*14000/rate);
 function enabled(index){return (registers[21]&CHANNELS[index].enable)!==0;}
 function timer(index){const offset=CHANNELS[index].base;return registers[offset+2]|((registers[offset+3]&7)<<8);}
 function volume(channel){const control=registers[CHANNELS[channel].base];return (control&16)?control&15:envelopes[channel===3?2:channel].decay;}
 function write(address,value){
  if(!Number.isInteger(address)||address<0x4000||address>0x4017||!Number.isInteger(value)||value<0||value>255)throw Error('Invalid NES audio register write');
  const offset=address-0x4000;registers[offset]=value;
  if(offset===0x15){for(let channel=0;channel<4;channel++)if(!enabled(channel))lengths[channel]=0;return;}
  if(offset===1||offset===5){sweep[offset===1?0:1].reload=true;return;}
  const channel=offset===3?0:offset===7?1:offset===11?2:offset===15?3:-1;
  if(channel<0)return;
  if(enabled(channel))lengths[channel]=LENGTHS[value>>3];
  if(channel<2){phases[channel]=0;envelopes[channel].start=true;}
  else if(channel===2)linearReload=true;
  else envelopes[2].start=true;
 }
 let linearCounter=0,linearReload=false;
 function quarterClock(){
  for(const [index,channel]of [0,1,3].entries()){
   const envelope=envelopes[index],control=registers[CHANNELS[channel].base],period=control&15;
   if(envelope.start){envelope.start=false;envelope.decay=15;envelope.divider=period;}
   else if(envelope.divider===0){envelope.divider=period;if(envelope.decay>0)envelope.decay--;else if(control&32)envelope.decay=15;}
   else envelope.divider--;
  }
  if(linearReload)linearCounter=registers[8]&127;
  else if(linearCounter>0)linearCounter--;
  if((registers[8]&128)===0)linearReload=false;
 }
 function halfClock(){
  for(let channel=0;channel<4;channel++){
   const control=registers[CHANNELS[channel].base];
   if(lengths[channel]&&!(control&(channel===2?128:32)))lengths[channel]--;
  }
  for(let channel=0;channel<2;channel++){
   const state=sweep[channel],reg=registers[channel*4+1],period=(reg>>4)&7,shift=reg&7;
   if(state.divider===0){
    if((reg&128)&&shift){const current=timer(channel),delta=current>>shift;
     const next=(reg&8)?current-delta-(channel===0?1:0):current+delta;
     if(current>=8&&next>=0&&next<=2047){registers[channel*4+2]=next&255;registers[channel*4+3]=(registers[channel*4+3]&248)|(next>>8);}
    }
    state.divider=period;
   }else state.divider--;
   if(state.reload){state.reload=false;state.divider=period;}
  }
 }
 function pulse(channel){
  if(!enabled(channel)||!lengths[channel])return 0;
  const t=timer(channel),control=registers[channel*4],sweepRegister=registers[channel*4+1],shift=sweepRegister&7;
  if(t<8||((sweepRegister&128)&&shift&&!(sweepRegister&8)&&t+(t>>shift)>2047))return 0;
  phases[channel]=(phases[channel]+CPU_RATE/(16*(t+1)*rate))%1;
  const duty=[.125,.25,.5,.75][control>>6];
  return phases[channel]<duty?volume(channel):0;
 }
 function triangle(){
  if(!enabled(2)||!lengths[2]||!linearCounter)return 0;
  const t=timer(2);if(t<2)return 0;
  phases[2]=(phases[2]+CPU_RATE/(32*(t+1)*rate))%1;
  const step=Math.floor(phases[2]*32);
  return step<16?15-step:step-16;
 }
 function noise(){
  const period=NOISE_PERIODS[registers[14]&15];
  noisePhase+=CPU_RATE/(period*rate);
  while(noisePhase>=1){noisePhase--;
   const tap=(registers[14]&128)?6:1;
   noiseShift=(noiseShift>>1)|(((noiseShift^(noiseShift>>tap))&1)<<14);
  }
  return enabled(3)&&lengths[3]&&!(noiseShift&1)?volume(3):0;
 }
 function render(frames){
  if(!Number.isInteger(frames)||frames<1||frames>rate)throw Error('Invalid NES audio frame count');
  const pcm=Buffer.allocUnsafe(frames*4);
  for(let i=0;i<frames;i++){
   quarterPhase+=240/rate;
   if(quarterPhase>=1){quarterPhase--;quarterClock();halfStep^=1;if(halfStep===0)halfClock();}
   const pulseSum=pulse(0)+pulse(1),tri=triangle(),n=noise(),dmc=registers[17]&127;
   const pulseOut=pulseSum?95.88/(8128/pulseSum+100):0;
   const tndInput=tri/8227+n/12241+dmc/22638;
   const tndOut=tndInput?159.79/(1/tndInput+100):0;
   const mixed=pulseOut+tndOut;
   hp90=highpass90*(hp90+mixed-hp90Input);hp90Input=mixed;
   hp440=highpass440*(hp440+hp90-hp440Input);hp440Input=hp90;
   lp+=lowpass14k*(hp440-lp);
   const sample=Math.max(-32768,Math.min(32767,Math.round(lp*32767*.85)));
   pcm.writeInt16LE(sample,i*4);pcm.writeInt16LE(sample,i*4+2);
  }
  return pcm;
 }
 function sync(snapshot){
  if(!Buffer.isBuffer(snapshot)||snapshot.length<24*4)throw Error('Invalid NES audio register snapshot');
  for(let i=0;i<24;i++)registers[i]=snapshot.readUInt32LE(i*4)&255;
  for(const envelope of envelopes)envelope.start=true;
  linearReload=true;
  for(let channel=0;channel<4;channel++){
   if(!enabled(channel))lengths[channel]=0;
   else if(lengths[channel]===0)lengths[channel]=LENGTHS[registers[CHANNELS[channel].base+3]>>3];
  }
  if(enabled(2)&&linearCounter===0)linearCounter=registers[8]&127;
 }
 return {write,render,sync,registers,lengths};
}

function replay(apu,snapshot,ring,lastSequence){
 if(!Buffer.isBuffer(snapshot)||snapshot.length!==104||!Number.isInteger(lastSequence)||lastSequence<0||lastSequence>0xffffffff)
  throw Error('Invalid NES audio mailbox');
 const next=snapshot.readUInt32LE(96),delta=(next-lastSequence)>>>0;
 if(delta===0)return {sequence:next,missed:0};
 if(delta>64){apu.sync(snapshot);return {sequence:next,missed:delta};}
 if(!Buffer.isBuffer(ring)||ring.length!==64*12)throw Error('Invalid NES audio event ring');
 for(let n=1;n<=delta;n++){
  const sequence=(lastSequence+n)>>>0,at=(((sequence-1)>>>0)%64)*12;
  if(ring.readUInt32LE(at+8)!==sequence){apu.sync(snapshot);return {sequence:next,missed:delta};}
 }
 for(let n=1;n<=delta;n++){
  const sequence=(lastSequence+n)>>>0,at=(((sequence-1)>>>0)%64)*12;
  apu.write(ring.readUInt32LE(at),ring.readUInt32LE(at+4)&255);
 }
 return {sequence:next,missed:0};
}

module.exports={create,replay,CPU_RATE,LENGTHS,NOISE_PERIODS};
