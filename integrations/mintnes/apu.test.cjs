'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {create,replay,CPU_RATE}=require('./apu.cjs');

function peak(pcm,start=0){let value=0;for(let i=start*4;i<pcm.length;i+=4)value=Math.max(value,Math.abs(pcm.readInt16LE(i)));return value;}
function crossings(pcm){let count=0,last=pcm.readInt16LE(0);for(let i=4;i<pcm.length;i+=4){const value=pcm.readInt16LE(i);if((value>0)!==(last>0))count++;last=value;}return count;}

test('pulse register writes produce a pitched stereo waveform and status gates it',()=>{
 const apu=create(),timer=Math.round(CPU_RATE/(16*440)-1);
 apu.write(0x4015,1);apu.write(0x4000,0xbf);apu.write(0x4002,timer&255);apu.write(0x4003,0xf8|(timer>>8));
 const sound=apu.render(4800);
 assert.ok(peak(sound)>1000);assert.ok(crossings(sound)>=80&&crossings(sound)<=95);
 for(let i=0;i<sound.length;i+=4)assert.equal(sound.readInt16LE(i),sound.readInt16LE(i+2));
 apu.write(0x4015,0);assert.equal(peak(apu.render(4800),4700),0);
});

test('identical high timer writes retrigger length and envelope',()=>{
 const apu=create();apu.write(0x4015,1);apu.write(0x4000,0x8f);apu.write(0x4002,0x60);apu.write(0x4003,0x18);
 apu.render(4800);assert.equal(apu.lengths[0],0);
 apu.write(0x4003,0x18);assert.equal(apu.lengths[0],2);
 assert.ok(peak(apu.render(500))>0);
});

test('triangle and noise channels render and a snapshot can recover after dropped events',()=>{
 const apu=create();apu.write(0x4015,0x0c);apu.write(0x4008,0xff);apu.write(0x400a,0x20);apu.write(0x400b,0xf8);
 apu.write(0x400c,0x3f);apu.write(0x400e,0x06);apu.write(0x400f,0xf8);
 assert.ok(peak(apu.render(4800))>1000);
 const snapshot=Buffer.alloc(96);for(let i=0;i<24;i++)snapshot.writeUInt32LE(apu.registers[i],i*4);
 const recovered=create();recovered.sync(snapshot);assert.ok(peak(recovered.render(2400))>1000);
});

test('silence remains silent and frame input is bounded',()=>{
 const apu=create();assert.equal(peak(apu.render(4800)),0);
 assert.throws(()=>apu.render(0),/frame count/);
 assert.throws(()=>apu.write(0x4018,0),/register write/);
});

test('APU mailbox replays repeated writes in order and recovers when ring data is missing',()=>{
 const apu=create(),ring=Buffer.alloc(64*12),snapshot=Buffer.alloc(104);
 const writes=[[0x4015,1],[0x4000,0xbf],[0x4002,0x60],[0x4003,0x18],[0x4003,0x18]];
 for(let i=0;i<writes.length;i++){
  const at=i*12;ring.writeUInt32LE(writes[i][0],at);ring.writeUInt32LE(writes[i][1],at+4);ring.writeUInt32LE(i+1,at+8);
  snapshot.writeUInt32LE(writes[i][1],(writes[i][0]-0x4000)*4);
 }
 snapshot.writeUInt32LE(writes.length,96);
 assert.deepEqual(replay(apu,snapshot,ring,0),{sequence:5,missed:0});
 assert.equal(apu.lengths[0],2);assert.ok(peak(apu.render(500))>0);
 ring.writeUInt32LE(99,4*12+8);
 const recovered=create();assert.deepEqual(replay(recovered,snapshot,ring,0),{sequence:5,missed:5});
 assert.ok(peak(recovered.render(500))>0);
});
