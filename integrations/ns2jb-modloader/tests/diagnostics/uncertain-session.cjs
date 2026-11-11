'use strict';
const assert=require('node:assert/strict');
const {guardSession}=require('../../lib/game-files/uncertain.cjs');
(async()=>{
 for(const message of ['Console response timed out','read ECONNRESET','write EPIPE']){
  const calls=[];const original=Error(message);
  const session=guardSession({async call(){calls.push('call');throw original;},async write(){calls.push('write');},async cleanup(){calls.push('cleanup');},async initialize(){try{await this.call();}finally{await this.write();}}});
  await assert.rejects(session.initialize(),error=>error===original&&error.nativeRequestUncertain);
  await session.cleanup();await assert.rejects(session.call(),error=>error===original);
  assert.deepEqual(calls,['call']);
 }
 const calls=[];const session=guardSession({async call(){calls.push('call');throw Error('Known completed native error: 0x202');},async cleanup(){calls.push('cleanup');}});
 await assert.rejects(session.call(),/Known completed/);await session.cleanup();assert.deepEqual(calls,['call','cleanup']);assert(!session.uncertainError);
 console.log('Uncertain SDK requests: timeout/disconnect leaves buffers and handles owned, does not restore scratch or replay, completed failures still clean up: passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
