const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const blitbun=require('../integrations/blitbun/prepare.cjs');
const archive=require('../vendor/IZ2S-Platform/core/archive.cjs');

function packagedDoom(t){
  const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-freedoom-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const {pkg}=blitbun.packageBytes(root,archive);
  for(const file of pkg.files.filter(entry=>entry.name==='server/lib/mac-doom.cjs'||entry.name.startsWith('server/doom/'))){
    const target=path.join(folder,file.name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes);
  }
  const session=path.join(folder,'session');fs.mkdirSync(session);
  return {doom:require(path.join(folder,'server/lib/mac-doom.cjs')),session};
}

test('browser capture clears the Doom controller setting before changing sources',()=>{
  const {pkg}=blitbun.packageBytes(path.resolve(__dirname,'..'),archive);
  const page=pkg.files.find(file=>file.name==='server/lib/pc-screen.html').bytes.toString();
  for(const [,code] of page.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g))
    if(code.trim())new vm.Script(code);
  assert.match(page,/\$\('start'\)\.disabled=busy\|\|currentSource==='doom'/);
  assert.match(page,/\$\('launch'\)\.disabled=busy\|\|currentSource==='doom'/);
  assert.match(page,/!d\.consoleVideoVisible\?'Preparing Freedoom video on Switch/);
  assert.match(page,/fetch\('\/status',\{cache:'no-store'\}\)/);
  const expression=page.match(/controller:([^,]+),stats:/)?.[1];
  assert.ok(expression);
  const selected=new Function('launch','$',`return ${expression}`);
  const checked=()=>({checked:true});
  assert.equal(selected(true,checked),'gamepad');
  assert.equal(selected('browser',checked),'off');
});

test('packaged Freedoom engine sustains RGB565 frames without a Doom installation or RPC',{timeout:15000},async t=>{
  const {doom,session}=packagedDoom(t);
  const remote=await doom.create(session,{capture:true,headless:true,audio:false});
  t.after(()=>remote.close());
  assert.equal(remote.report.game,'Freedoom Phase 1');
  assert.equal(remote.report.frames,1);
  let frame;
  for(let index=0;index<160;index++)frame=await remote.nextFrame();
  assert.equal(frame.length,320*200*2);
  assert.equal(frame.some(byte=>byte!==0),true);
  assert.equal(remote.video.latest.rgba.length,320*200*4);
  const delayed=remote.nextFrame(20);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
  assert.equal((await delayed).length,320*200*2);
  assert.equal(remote.report.timeout,undefined);
  let uploads=0;
  const pump=doom.start({remote,stream:{stats:{},waitForRoute:async()=>{},push:async(bytes,w,h,format)=>{
    assert.equal(bytes.length,320*200*2);assert.deepEqual([w,h,format],[320,200,0]);uploads++;
  }},onError:error=>{throw error;}});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{clearInterval(check);reject(Error('Freedoom pump did not stream two frames'));},5000);
    const check=setInterval(()=>{if(uploads>=2){clearTimeout(timeout);clearInterval(check);resolve();}},10);
  });
  await pump.close();await remote.close();
  assert.equal(remote.report.exited,true);
  assert.equal(fs.existsSync(path.join(session,'doom-host.log')),true);
});

test('Freedoom frame timeout records a useful engine diagnostic',{timeout:5000},async t=>{
  const {doom,session}=packagedDoom(t);
  const launch=()=>{
    const child=new EventEmitter();child.pid=1234;child.stdin=new PassThrough();child.stdio=[child.stdin,null,null,new PassThrough()];
    child.kill=signal=>{queueMicrotask(()=>child.emit('exit',null,signal));return true;};
    return child;
  };
  await assert.rejects(doom.create(session,{launch,frameTimeoutMs:25}),/did not produce a frame/);
  const report=JSON.parse(fs.readFileSync(path.join(session,'doom-engine.json')));
  assert.equal(report.timeout.sequence,1);
  assert.equal(report.timeout.frameBytesReceived,0);
  assert.equal(report.timeout.childPid,1234);
  assert.ok(report.timeout.elapsedMs>0);
});
