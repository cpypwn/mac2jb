const test=require('node:test'),assert=require('node:assert/strict');
const {KEY,WIDTH,HEIGHT,FRAME_BYTES,decodeButtons,keyTransitions,start}=require('../integrations/blitbun/mac-doom.cjs');

function packet({mode=2,menu=0,flags=2,slots=[]}={}){
  const bytes=Buffer.alloc(396);
  bytes.writeUInt32LE(mode,328);
  bytes.writeUInt32LE(flags,332);
  bytes.writeUInt32LE(menu,336);
  for(const [index,{buttons=0,lx=0,ly=0,rx=0}] of slots.entries()){
    const at=8+index*64;
    bytes.writeUInt32LE(buttons,at+8);
    bytes.writeInt32LE(lx,at+16);
    bytes.writeInt32LE(ly,at+20);
    bytes.writeInt32LE(rx,at+24);
    bytes.writeUInt32LE(1,at+32);
  }
  return bytes;
}

test('freedoom maps live switch buttons and sticks across controller slots',()=>{
  const buttons=(1<<0)|(1<<1)|(1<<10);
  const decoded=decodeButtons(packet({slots:[{buttons,ly:-15000},{buttons:1<<6,rx:16000}]}));
  assert.deepEqual(decoded,[KEY.enter,KEY.up,KEY.right,KEY.strafeLeft,KEY.use,KEY.fire].sort((a,b)=>a-b));
  assert.deepEqual(decodeButtons(packet({slots:[{buttons:1<<2}]})),[KEY.shotgun]);
  assert.throws(()=>decodeButtons(Buffer.alloc(395)),/Invalid Doom input packet/);
});

test('freedoom releases held controls when route or console menu stops gameplay',()=>{
  const held=packet({slots:[{buttons:1<<0,ly:-16000}]});
  const first=keyTransitions([],held);
  assert.deepEqual(first.events,[{key:KEY.fire,pressed:true},{key:KEY.up,pressed:true}]);
  assert.deepEqual(keyTransitions(first.next,held).events,[]);
  for(const blocked of [packet({slots:[{buttons:1<<0}],mode:1}),
    packet({slots:[{buttons:1<<0}],menu:1}),packet({slots:[{buttons:1<<0}],flags:0}),
    packet()]){
    const released=keyTransitions(first.next,blocked);
    assert.deepEqual(released.next,[]);
    assert.deepEqual(released.events,[{key:KEY.fire,pressed:false},{key:KEY.up,pressed:false}]);
  }
});

test('freedoom stream sends rgb565 frames and stops during a route wait',{timeout:2000},async()=>{
  let routeCalls=0,frameCalls=0,streamError,pump,stats;
  const frame=Buffer.alloc(FRAME_BYTES,0x5a);
  let notifyRouteWait;
  const waiting=new Promise(resolve=>{notifyRouteWait=resolve;});
  const pushed=new Promise(resolve=>{
    const stream={stats:{},waitForRoute:({signal})=>{
      if(routeCalls++===0)return Promise.resolve();
      notifyRouteWait();
      return new Promise((_,reject)=>{
        const fail=()=>{const error=Error('Route wait stopped');error.name='AbortError';reject(error);};
        if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});
      });
    },push:async(bytes,width,height,format,metrics)=>{
      assert.equal(bytes,frame);
      assert.deepEqual([width,height,format],[WIDTH,HEIGHT,0]);
      assert.equal(bytes.length,128000);
      assert.equal(metrics.readUInt32LE(),0x495a4d35);
      resolve(stream.stats);
    }};
    const remote={nextFrame:async()=>{frameCalls++;return frame;}};
    stats=stream.stats;
    pump=start({remote,stream,onError:error=>{streamError=error;}});
  });
  await Promise.all([pushed,waiting]);
  await pump.close();
  assert.equal(frameCalls,1);
  assert.equal(routeCalls,2);
  assert.equal(streamError,undefined);
  assert.equal(stats.source,'doom');
  assert.equal(stats.game,'Freedoom Phase 1');
});
