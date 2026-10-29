const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{start}=require('../server/streaming/lib/hl2-stream.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+1500;while(!check()){if(Date.now()>end)throw Error('Stream fixture stalled');await wait(1);}}
function fixture(t,{failEncode=0}={}){
 let profile={mode:'lan',width:1920,height:1080,fps:0},sequence=0,busy=0,maxBusy=0,inFlight=0,maxInFlight=0,terminated=0;const encodes=[],sends=[],changes=[],errors=[],timers=new Set(),worker=new EventEmitter();
 worker.postMessage=f=>{const entry={seq:f.sequence,at:performance.now()};encodes.push(entry);busy++;maxBusy=Math.max(maxBusy,busy);const timer=setTimeout(()=>{timers.delete(timer);busy--;if(encodes.indexOf(entry)+1===failEncode){worker.emit('error',Error('Encoder failed'));return;}worker.emit('message',{bytes:Uint8Array.of(f.sequence),w:f.w,h:f.h,encodeMs:2});},2);timers.add(timer);};
 worker.terminate=async()=>{terminated++;for(const timer of timers)clearTimeout(timer);timers.clear();};
 const remote={report:{profile},video:{get latest(){return {w:remote.report.profile.width,h:remote.report.profile.height,rgba:Buffer.alloc(4),sequence:++sequence,at:performance.now()};}},async setProfile(next){changes.push(next);remote.report.profile=next;}};
 const stream={stats:{},prepareFrame(){throw Error('RUN13 must not pre-compress a future packet');},commitPrepared(){throw Error('RUN13 must not commit look-ahead packets');},prepare:async()=>{},push(bytes,w,h){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);sends.push({seq:bytes[0],w,h,at:performance.now(),resolve:()=>{inFlight--;resolve();},reject:error=>{inFlight--;reject(error);}});return promise;}};
 const pump=start({remote,stream,profileFor:()=>profile,workerFactory:()=>worker,onError:error=>errors.push(error)});
 t.after(async()=>{await pump.close();for(const send of sends)send.resolve();});
 return {pump,remote,stream,worker,encodes,sends,changes,errors,select:next=>profile={...profile,...next},get maxBusy(){return maxBusy;},get maxInFlight(){return maxInFlight;},get terminated(){return terminated;}};
}
test('RUN13 encodes one next frame during ACK wait and never grows an encode or upload queue',async t=>{
 const f=fixture(t);await until(()=>f.sends.length===1&&f.encodes.length===2);await wait(5);assert.equal(f.encodes.length,2);assert.equal(f.sends.length,1);assert.equal(f.maxBusy,1);assert.equal(f.sends[0].seq,2,'discard the frame captured before stream preparation');const prefetched=f.encodes[1].seq;
 f.sends[0].resolve();await until(()=>f.sends.length===2);assert.equal(f.sends[1].seq,prefetched);assert.equal(f.maxInFlight,1);assert.equal(f.stream.stats.encodeOverlap,true);
});
test('RUN13 discards the single prefetched frame after an unexpectedly slow ACK',async t=>{
 const f=fixture(t);await until(()=>f.sends.length===1&&f.encodes.length===2);const stale=f.encodes[1].seq;await wait(55);f.sends[0].resolve();await until(()=>f.sends.length===2);assert.ok(f.sends[1].seq>stale);assert.equal(f.maxBusy,1);assert.equal(f.maxInFlight,1);
});
test('even an FPS-only profile change discards the prepared frame before sending',async t=>{
 const f=fixture(t);await until(()=>f.sends.length===1&&f.encodes.length===2);const old=f.encodes[1].seq;f.select({fps:60});f.sends[0].resolve();await until(()=>f.sends.length===2);assert.equal(f.changes.length,1);assert.equal(f.changes[0].fps,60);assert.ok(f.sends[1].seq>old);assert.equal(f.maxInFlight,1);
});
test('worker failure during prefetch is reported without waiting for the outstanding ACK',async t=>{
 const f=fixture(t,{failEncode:2});await until(()=>f.errors.length===1);assert.match(f.errors[0].message,/Encoder failed/);assert.equal(f.sends.length,1);await f.pump.done;
});
test('close promptly stops pending ACK work and prevents further frame production',async t=>{
 const f=fixture(t);await until(()=>f.sends.length===1);const timeout=wait(100).then(()=>{throw Error('Close waited for an outstanding ACK');});await Promise.race([f.pump.close(),timeout]);const count=f.sends.length;await wait(10);assert.equal(f.sends.length,count);assert.equal(f.terminated,1);assert.deepEqual(f.errors,[]);
});
test('recoverable upload failure discards prefetch and retries with a fresh capture',async t=>{
 const f=fixture(t);await until(()=>f.sends.length===1&&f.encodes.length===2);const old=f.encodes[1].seq;f.sends[0].reject(Object.assign(Error('Reconnect'),{recoverable:true,retryAfterMs:1}));await until(()=>f.sends.length===2);assert.ok(f.sends[1].seq>old);assert.equal(f.maxInFlight,1);assert.deepEqual(f.errors,[]);
});
