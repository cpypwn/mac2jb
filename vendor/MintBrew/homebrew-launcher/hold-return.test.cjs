const test=require('node:test'),assert=require('node:assert/strict');
const {buttons,create,B,MINUS,HOLD_MS}=require('./hold-return.cjs');

test('B and Minus require a continuous hold and reset independently',()=>{
 const hold=create();
 assert.equal(hold.update(B,0),false);
 assert.equal(hold.update(B,HOLD_MS-1),false);
 assert.equal(hold.update(0,HOLD_MS-1),false);
 assert.equal(hold.update(B,1000),false);
 assert.equal(hold.update(B,1000+HOLD_MS),true);
 hold.reset();
 assert.equal(hold.update(MINUS,2000),false);
 assert.equal(hold.update(MINUS,2000+HOLD_MS),true);
 hold.reset();
 assert.equal(hold.update(B,3000),false);
 assert.equal(hold.update(B|MINUS,3400),false);
 assert.equal(hold.update(MINUS,3700),false);
 assert.equal(hold.update(MINUS,3400+HOLD_MS),true);
});

test('Button sampling follows connected handheld and detached pads',()=>{
 const state=Buffer.alloc(1024),extension=Buffer.alloc(960);
 state.writeUInt32LE(B,8);
 assert.equal(buttons(state,extension),0);
 state.writeUInt32LE(1,32);
 assert.equal(buttons(state,extension),B);
 state.writeUInt32LE(0,32);
 extension.writeUInt32LE(0x48425344,0);
 extension.writeUInt32LE(1,4);
 extension.writeUInt32LE(64,12);
 extension.writeUInt32LE(MINUS,640+2*64+8);
 extension.writeUInt32LE(1,640+2*64+32);
 assert.equal(buttons(state,extension),MINUS);
 extension.writeUInt32LE(0,640+2*64+32);
 assert.equal(buttons(state,extension),0);
});
