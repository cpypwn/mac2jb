const test=require('node:test');
const assert=require('node:assert/strict');
const clock=require('../vendor/MintBrew/homebrew-launcher/frame-clock.cjs');
const {frame}=require('../vendor/MintBrew/sdk/native/repeating.cjs');
const code=require('../vendor/MintBrew/smilebasic/engine/switch2/app/thread-code.json').functions;
const timing=require('../vendor/MintBrew/smilebasic/engine/switch2/app/timing-code.json').functions;

test('each frame copies its own native counter result into the gpu clock mailbox',()=>{
 const base=0x500000000,sdk=0x600000000,mapped=0x700000000,calls=[];
 const slots=[];
 for(let i=0;i<3;i++){
  slots.push(clock.append(calls,{base,sdk,mapped,tickOffset:timing.tick.offset}));
  calls.push({function:sdk+timing.tick.offset,args:[0,0,0,0]});
 }
 const program=frame({base,sdk,calls,code});
 slots.forEach((slot,i)=>{
  const at=i*3;
  assert.equal(slot.result,program.addresses[at]);
  assert.equal(calls[at].function,sdk+timing.tick.offset);
  assert.deepEqual(calls[at+1].args,[mapped+clock.CLOCK_OFFSET,slot.result,8,0]);
 });
 assert.equal(new Set(slots.map(slot=>slot.result)).size,3);
});

test('clock frequency is written to the upstream mailbox only when qualified',async()=>{
 const writes=[];
 const rpc={write:async(address,bytes)=>writes.push({address,bytes:Buffer.from(bytes)})};
 const mapped=0x700000000;
 await clock.initialize(rpc,mapped,31250000);
 assert.equal(writes.length,1);
 assert.equal(writes[0].address,mapped+clock.CLOCK_OFFSET+8);
 assert.equal(writes[0].bytes.readUInt32LE(),31250000);
 await clock.initializeMailbox(rpc,mapped+0x1000,31250000);
 assert.equal(writes[1].address,mapped+0x1008);
 await assert.rejects(clock.initialize(rpc,mapped,0),/Unsupported frame clock frequency/);
 assert.equal(writes.length,2);
});
