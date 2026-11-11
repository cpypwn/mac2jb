'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {finishFailedCapture}=require('../lib/native-capture.cjs');

test('pending native capture does not close its RPC client or authorize retry',async()=>{
 let closes=0;
 const client={pending:true,close:async()=>{closes++;}};
 const error=Error('Native worker is pending');
 assert.equal(await finishFailedCapture(client,error),false);
 assert.equal(closes,0);
 assert.notEqual(error.retrySafe,true);
});

test('capture failure permits retry only after the client closes',async()=>{
 const closed={pending:false,close:async()=>{}};
 const safe=Error('Unsupported FS mapping');
 assert.equal(await finishFailedCapture(closed,safe),true);
 assert.equal(safe.retrySafe,true);
 const failed={pending:false,close:async()=>{throw Error('close failed');}};
 const uncertain=Error('Unsupported FS mapping');
 assert.equal(await finishFailedCapture(failed,uncertain),false);
 assert.notEqual(uncertain.retrySafe,true);
});
