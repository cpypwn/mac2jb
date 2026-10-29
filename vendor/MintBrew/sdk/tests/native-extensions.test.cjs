const test=require('node:test'),assert=require('node:assert/strict');
const ipc=require('../native/ipc.cjs'),jcms=require('../host/joy-mouse.cjs'),haptics=require('../host/haptics.cjs');
test('CMIF request places PID and copied handles before aligned command data',()=>{
 const payload=Buffer.alloc(16);payload.writeBigUInt64LE(209n);payload.writeBigUInt64LE(16384n,8);
 const b=ipc.encode(3110,payload,{pid:true,handles:[123]});assert.equal(b.readUInt32LE(),4);assert.equal(b.readUInt32LE(4),0x8000000c);assert.equal(b.readUInt32LE(8),3);assert.equal(b.readBigUInt64LE(12),0n);assert.equal(b.readUInt32LE(20),123);assert.equal(b.readUInt32LE(32),0x49434653);assert.equal(b.readUInt32LE(40),3110);assert.deepEqual(b.subarray(48,64),payload);
 assert.throws(()=>ipc.encode(-1));assert.throws(()=>ipc.encode(0,Buffer.alloc(2049)));assert.throws(()=>ipc.encode(0,Buffer.alloc(0),{handles:[0]}));
});
test('CMIF decode preserves native errors and rejects missing response header',()=>{
 const b=Buffer.alloc(4096);b.writeUInt32LE(8,4);b.writeUInt32LE(0x4f434653,16);b.writeUInt32LE(1546,24);assert.equal(ipc.decode(b).result,1546);b.writeUInt32LE(0,16);assert.throws(()=>ipc.decode(b));
});
test('Jcms decoder orders signed samples and drops inconsistent ring records',()=>{
 const b=Buffer.alloc(jcms.BYTES),base=jcms.STRIDE;b.writeUInt32LE(2,base+16);b.writeUInt32LE(2,base+24);
 for(let i=1;i<=2;i++){const o=base+32+i*40;b.writeBigUInt64LE(BigInt(i*2),o);b.writeBigUInt64LE(5000000n,o+8);b.writeBigUInt64LE(BigInt(i),o+16);b.writeInt32LE(-12*i,o+24);b.writeInt32LE(7*i,o+28);b.writeUInt32LE(3,o+32);}
 assert.deepEqual(jcms.samples(b,0,1).map(s=>[s.sequence,s.dx,s.dy]),[['2',-24,14],['1',-12,7]]);
 b.writeBigUInt64LE(3n,base+32+2*40);assert.equal(jcms.samples(b,0,1).length,1);b.writeUInt32LE(17,base+16);assert.throws(()=>jcms.samples(b,0,1),/header/);assert.throws(()=>jcms.samples(b,8,0));
});
test('haptic envelopes validate independent bands, duration and device selection',()=>{
 const v=haptics.validate({side:2,steps:[{milliseconds:100,lowAmplitude:.7,lowFrequency:80,highAmplitude:.2,highFrequency:640}]});assert.equal(v.steps[0].lowAmplitude,.7);
 for(const options of [{side:3,steps:[]},{steps:[{milliseconds:501}]},{steps:[{milliseconds:20,amplitude:NaN}]},{steps:[{milliseconds:20,highFrequency:2000}]},{steps:Array.from({length:5},()=>({milliseconds:500}))}])assert.throws(()=>haptics.validate(options));
});
test('a failed native haptic start still stops every selected device',async()=>{
 const sent=[],api={base:0x1000,functions:{vibrationSend:4,vibrationRead:8},rpc:{a:{sdk:0}},hapticWorker:{async run(){throw Error('start interrupted');}},async write(){},async read(){return Buffer.from([1]);},async result(name,args){if(name==='vibrationSend')sent.push(args[0]);return 0;}};
 await assert.rejects(haptics.play(api,[10,20],{side:2,steps:[{milliseconds:1}]}),/interrupted/);assert.deepEqual(sent,[10,20]);
});
test('repeating frame persists results outside restored memory and loads a 64-bit stop selector',()=>{
 const code=require('../../smilebasic/engine/switch2/app/thread-code.json').functions;
 const p=require('../native/repeating.cjs').frame({base:0x1000000,sdk:0x2000000,calls:[{function:0x2000000+code.sleep.offset,args:[10000000]}],code});
 assert.ok(p.live+p.frame.length<p.snapshot);assert.ok(p.snapshot+p.frame.length<p.results);assert.equal(p.addresses[0],p.results);
 assert.equal(p.frame.readBigUInt64LE(p.proof.stackOffset+0x118),BigInt(p.results));assert.equal(p.stop.readBigUInt64LE(0x58),BigInt(0x2000000+code.exit.offset));
 const index=p.proof.logicalResultIndices.at(-1);assert.equal(p.frame.readBigUInt64LE(p.proof.stackOffset+(index-1)*0x140+0x20),8n,'selector copy is eight bytes');
});
