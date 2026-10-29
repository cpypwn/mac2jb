const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const blitbun=require('../integrations/blitbun/prepare.cjs');
const vacootube=require('../integrations/vacootube/prepare.cjs');
const izlauncher=require('./prepare-izlauncher.cjs');

test('mac stream modules accept connected handheld ethernet in the host and console gates',async t=>{
  const source=blitbun.sourceFiles(root),patched=blitbun.overlay(source,root);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-stream-route-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const vacooSource=path.join(temporary,'source'),vacooOverlay=path.join(temporary,'overlay'),staged=path.join(temporary,'staged');
  for(const name of ['module.json','server/streaming/application-host.cjs','server/streaming/lib/route-gate.cjs',
    'server/streaming/lib/pc-stream-delta.cjs','server/streaming/run16/lib/pc-stream-delta.cjs',
    'switch/modules/pc-screen-input.glsl',
    'switch/modules/pc-screen-draw.glsl']){
    const target=path.join(vacooSource,name);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(root,'integrations/vacootube/upstream',name),target);
  }
  fs.mkdirSync(path.join(vacooSource,'server/local-package'),{recursive:true});
  fs.mkdirSync(path.join(vacooOverlay,'server/local-package'),{recursive:true});
  fs.writeFileSync(path.join(vacooOverlay,'server/local-package/vacootube-audio'),'fixture');
  await vacootube.copySource(vacooSource,vacooOverlay,staged);
  const blitRoute=patched.get('server/lib/route-gate.cjs').toString();
  const vacooRoute=fs.readFileSync(path.join(staged,'server/streaming/lib/route-gate.cjs'),'utf8');
  const blitShader=patched.get('switch/modules/pc-screen-input.glsl').toString();
  const vacooShader=fs.readFileSync(path.join(staged,'switch/modules/pc-screen-input.glsl'),'utf8');
  const blitDraw=patched.get('switch/modules/pc-screen-draw.glsl').toString();
  const vacooDraw=fs.readFileSync(path.join(staged,'switch/modules/pc-screen-draw.glsl'),'utf8');
  const blitReceiver=patched.get('server/lib/pc-stream-delta.cjs').toString();
  const vacooReceiver=fs.readFileSync(path.join(staged,'server/streaming/lib/pc-stream-delta.cjs'),'utf8');
  const vacooAdvancedReceiver=fs.readFileSync(path.join(staged,'server/streaming/run16/lib/pc-stream-delta.cjs'),'utf8');
  const vacooHost=fs.readFileSync(path.join(staged,'server/streaming/application-host.cjs'),'utf8');
  assert.equal(blitRoute,vacooRoute);
  const blitHost=patched.get('server/application-host.cjs').toString();
  assert.match(blitHost,/action===2\?'doom'/);
  assert.match(blitHost,/action===2\?'doom':action===3\?'half-life-2'/);
  assert.match(blitHost,/require\('\.\/lib\/mac-doom\.cjs'\)\.create/);
  assert.match(blitHost,/require\('\.\/lib\/mac-doom\.cjs'\)\.start/);
  assert.doesNotMatch(blitHost,/action===2\?'share-game'/);
  const shell=izlauncher.overlay(izlauncher.sourceFiles(root));
  const shellMenu=shell.get('shells/izlauncher/app/shaders/app-menu.glsl').toString();
  assert.match(shellMenu,/70u,82u,69u,69u,68u,79u,79u,77u/);
  assert.match(shellMenu,/bool close=tap&&menu!=0u&&all\(lessThanEqual\(abs\(p-vec2\(492,90\)\),vec2\(30\)\)\)/);
  assert.match(shellMenu,/\|\|badge\|\|close\)\{menu=menu==0u\?1u:0u/);
  assert.match(shellMenu,/\(pressed&\(HB_B\|HB_X\)\)!=0u/);
  const closeStartMenu='if(start&&menu==0u){c.atlas[CB+1u]=0u;c.library.w=held?1u:0u;}';
  assert.ok(blitShader.includes(closeStartMenu));
  assert.doesNotMatch(blitShader,/if\(start&&\(pressed&HB_B\)/);
  assert.equal(blitShader,vacooShader);
  assert.equal(blitDraw,vacooDraw);
  assert.match(vacooHost,/require\('\.\/lib\/mac-panel\.cjs'\)\.openPanel\(url\)/);
  assert.match(blitShader,/mode==0u\?\(type==1u\|\|type==2u\)/);
  assert.match(blitDraw,/if\(!displayReady&&menu==0u&&c\.atlas\[SB\+38u\]==0u\)return background/);
  assert.match(blitDraw,/streamStartText\(p,vec2\(860,512\),8\.0,0\)/);
  for(const receiver of [blitReceiver,vacooReceiver,vacooAdvancedReceiver]){
    assert.match(receiver,/const host=await require\('\.\/mac-stream-host\.cjs'\)\.select\(consoleIP\);report\.hostIP=host/);
    assert.doesNotMatch(receiver,/HB_STREAM_HOST\|\|'10\.42\.0\.1'/);
  }
  const helper=fs.readFileSync(path.join(root,'integrations/mac-stream-host.cjs'));
  assert.deepEqual(patched.get('server/lib/mac-stream-host.cjs'),helper);
  for(const folder of ['server/streaming/lib','server/streaming/run16/lib'])
    assert.deepEqual(fs.readFileSync(path.join(staged,folder,'mac-stream-host.cjs')),helper);
  const file=path.join(temporary,'route-gate.cjs');fs.writeFileSync(file,blitRoute);
  const gate=require(file),now=Date.parse('2026-10-27T22:33:43.000Z');
  const state={at:new Date(now).toISOString(),stale:false,mode:'handheld',
    network:{type:'ethernet',connected:true,ip:'192.168.1.119'}};
  assert.equal(gate.describe(state,{now}).ready,true);
  assert.equal(gate.describe({...state,network:{...state.network,type:'wifi'}},{now}).ready,true);
  assert.equal(gate.describe({...state,network:{...state.network,connected:false}},{now}).ready,false);
  assert.equal(gate.describe(state,{now:now+6001}).ready,false);
  assert.equal(gate.describe({...state,mode:'docked',network:{...state.network,type:'wifi'}},{now}).ready,false);
});

test('mac stream receiver selects the local route for an attached RPC session',async()=>{
  const {select}=require('../integrations/mac-stream-host.cjs');
  assert.equal(await select('127.0.0.1','127.0.0.1'),'127.0.0.1');
  assert.equal(await select('127.0.0.1',''),'127.0.0.1');
  await assert.rejects(select('0.0.0.0',''),/Invalid console stream address/);
  await assert.rejects(select('127.0.0.1','0.0.0.0'),/Invalid PC stream host/);
});
