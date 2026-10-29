#!/usr/bin/env node
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {main,validateRun,proxyHandler,runtimeEnvironment,stageCustomApp,stageCustomLauncher,
  preflightCustomApp,preflightCustomHomebrew,stages,owners,souljaOwners,applicationConfig}=require('./gui-homebrew.cjs');
function fixture(t,options={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-homebrew-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const application=applicationConfig(options.application,options.customHomebrewKind),
    directory=path.join(root,'vendor/ns2jb/runs/switch2-source'),vendor=path.join(root,'vendor',application.vendor);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(vendor,'smilebasic/engine/shared'),{recursive:true});
  fs.writeFileSync(path.join(vendor,'smilebasic/engine/shared/rpc.cjs'),'// exact mocked upstream RPC module\n',{mode:0o600});
  const addresses={session:'switch2-source',target:'switch2',platform:2,scratch:4096,main:8192,sdk:12288,backing:16384,controller:20480};
  fs.writeFileSync(path.join(directory,'connection.json'),JSON.stringify({port:12345,addresses}),{mode:0o600});
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({verified:true,fs:{verified:true,restored:true,
    cleanup:{deferred:true},retainedEndpoint:{ready:true}},rpc:{mode:'held',state:'listening'}}),{mode:0o600});
  const trace=path.join(root,'order.txt'),all=[...stages.map(value=>({script:value[0],role:'prepare',args:value.slice(1)})),...application.owners];
  for(const item of all){
    const file=path.join(vendor,item.script);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,[
      "const fs=require('fs'),path=require('path');const directory=process.argv[2];",
      'const options='+JSON.stringify(options)+',item='+JSON.stringify(item)+',trace='+JSON.stringify(trace)+',frameReady='+JSON.stringify(application.frameReady)+';',
      "const log=value=>fs.appendFileSync(trace,JSON.stringify(value)+'\\n');",
      "const session=path.basename(directory);log({event:'start',script:item.script,args:process.argv.slice(3),appsDirectory:process.env.HB_APPS_DIR});",
      "if(options.failStage===item.script)process.exit(1);",
      "if(item.role==='prepare'){",
      "if(options.stallStage===item.script){process.on('SIGTERM',()=>{log({event:'stop',role:'prepare'});process.exit(0);});console.log('STAGE_READY');setInterval(()=>{},1000);}",
      'else process.exit(0);',
      '}else{',
      "if(item.role==='graphics'){fs.writeFileSync(path.join(directory,'launcher-auto-loop.json'),JSON.stringify({session,threadRunning:true}));console.log(options.frameMarker||frameReady);}",
      "if(item.role==='audio')fs.writeFileSync(path.join(directory,'game-audio.json'),JSON.stringify({session}));",
      "if(item.role==='music')fs.writeFileSync(path.join(directory,'music.json'),JSON.stringify({session,uploadVerified:true,ready:true,playing:true}));",
      "process.on('SIGTERM',()=>{log({event:'stop',role:item.role});setTimeout(()=>{",
      "if(item.role==='graphics')fs.writeFileSync(path.join(directory,'launcher-auto-loop.json'),JSON.stringify({session,threadRunning:false,completed:'now'}));",
      "if(item.role==='audio')fs.writeFileSync(path.join(directory,'game-audio.json'),JSON.stringify({session,completed:'now',...(options.badAudioStop?{stopError:'audio did not stop'}:{})}));",
      "if(item.role==='music')fs.writeFileSync(path.join(directory,'music.json'),JSON.stringify({session,uploadVerified:true,ready:true,completed:'now',playing:options.badMusicStop===true}));",
      "process.exit(0);},options.stopMs||10);});console.log(item.ready);setInterval(()=>{},1000);}",
    ].join('\n'),{mode:0o600});
  }
  const events=[],requests=[];
  const api={root,verifySession:async candidate=>({root:candidate,session:path.basename(candidate)}),
    checkRuntime:async()=>{},request:async(run,body)=>{requests.push({run,body});return {ready:true};},
    serveProxy:async()=>({port:23456,token:'ab'.repeat(32),close:async()=>{fs.appendFileSync(trace,JSON.stringify({event:'proxy-close'})+'\n');}}),
    startTimeoutMs:2000,stopTimeoutMs:500,...(options.application?{application:options.application}:{}),
    ...(options.customHomebrewKind?{customHomebrewKind:options.customHomebrewKind}:{}),
    validateLauncher:async()=>{},
    emit:(type,value)=>{events.push({type,...value});if(type==='running')setImmediate(()=>process.emit('SIGTERM'));}};
  return {root,directory,vendor,trace,events,requests,api,addresses};
}
function launcherPackage(root,vendor) {
  const source=path.join(root,'selected-launcher');
  fs.cpSync(vendor,source,{recursive:true});
  for(const name of [
    'homebrew-launcher/audio/intro.pcm','homebrew-launcher/audio/loop.pcm',
    'homebrew-launcher/shaders/launcher.vert.spv',
    'homebrew-launcher/shaders/launcher.frag.spv',
    'homebrew-launcher/shaders/launcher.comp.spv',
    'smilebasic/reference/sdk-checks.cjs',
    'smilebasic/reference/sdk-checks.json',
    'smilebasic/engine/shared/sdk-functions.json',
    'smilebasic/engine/shared/frames.cjs',
    'smilebasic/engine/switch2/app/thread-code.json',
    'smilebasic/engine/switch2/app/timing-code.json',
    'apps/hello-world/app.json']) {
    const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,name);
  }
  const files={};
  function inventory(folder,prefix='') {
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      const name=prefix+entry.name,file=path.join(folder,entry.name);
      if(entry.isDirectory())inventory(file,name+'/');
      else files[name]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  inventory(source);
  fs.writeFileSync(path.join(source,'mac2jb-launcher.json'),JSON.stringify({
    format:'mac2jb.held-rpc-launcher',version:1,profile:'souljalauncher-2',
    name:'SouljaLauncher 2',files}));
  return source;
}
test('runtime tools are portable and Python user configuration is excluded',()=>{
  const env=runtimeEnvironment('/private/runtime',{PATH:'/usr/bin',PYTHONPATH:'/user/modules',PYTHONHOME:'/user/python'});
  assert.equal(env.PATH,'/private/runtime/homebrew/python/bin:/private/runtime/homebrew/bin:/usr/bin');
  assert.equal(env.SPIRV_VAL,'/private/runtime/homebrew/bin/spirv-val');
  assert.equal(env.PYTHONPATH,'/private/runtime/homebrew/python-custom');assert.equal(env.PYTHONHOME,undefined);
  assert.equal(env.PYTHONNOUSERSITE,'1');assert.equal(env.PYTHONDONTWRITEBYTECODE,'1');
  assert.equal(env.MAC2JB_HBLAUNCHER_FONT,'/private/runtime/homebrew/fonts/DejaVuSans.ttf');
});
test('GPUBrewLauncher selects its pinned snapshot, own assets and exact graphics markers',()=>{
  const selected=applicationConfig('gpubrewlauncher');
  assert.equal(selected.vendor,'GPUBrewLauncher');assert.equal(selected.version,'snapshot-f35ff64');
  assert.equal(selected.source.commit,'f35ff64ea4b9b42cf2a75095d24662fe250f03e4');
  assert.equal(selected.owners.find(owner=>owner.role==='graphics').ready,'GPUBrewLauncher game event source ready.');
  assert.equal(selected.frameReady,'GPUBrewLauncher continuous native frame loop running.');
  assert.deepEqual(selected.owners.filter(owner=>owner.role!=='graphics'),owners.filter(owner=>owner.role!=='graphics'));
  assert.equal(applicationConfig().frameReady,'GPUBrewLauncher continuous native frame loop running.');
  assert.equal(runtimeEnvironment('/private/runtime').HB_APPS_DIR,'/private/runtime/vendor/GPUBrewLauncher/apps');
});
test('MintBrew uses its merged app library and distinct graphics readiness',()=>{
  const selected=applicationConfig('mintbrew');
  assert.equal(selected.vendor,'MintBrew');
  assert.equal(selected.name,'MintBrew');
  assert.equal(selected.source.format,'mintbrew-v1');
  assert.equal(selected.owners.find(owner=>owner.role==='graphics').ready,
    'MintBrew game event source ready.');
  assert.equal(selected.frameReady,'MintBrew continuous native frame loop running.');
  assert.equal(runtimeEnvironment('/private/runtime',{},'mintbrew').HB_APPS_DIR,
    '/private/runtime/vendor/MintBrew/apps');
});
test('custom homebrew uses GPUBrewLauncher with an isolated selected-app library',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-custom-app-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'selected'),session=path.join(root,'session');
  fs.mkdirSync(path.join(source,'assets'),{recursive:true});fs.mkdirSync(session);
  const manifest={id:'my-app',name:'My App',version:'1.0',shaders:{vertex:'vertex.spv',fragment:'fragment.spv',compute:'compute.spv'},
    initialState:'assets/state.bin',data:'assets/data.bin',icon:'assets/icon.png'};
  fs.writeFileSync(path.join(source,'app.json'),JSON.stringify(manifest));
  for(const name of ['vertex.spv','fragment.spv','compute.spv','assets/state.bin','assets/data.bin','assets/icon.png'])
    fs.writeFileSync(path.join(source,name),name);
  fs.writeFileSync(path.join(source,'private-note.txt'),'not part of the package');
  const names=['app.json',...Object.values(manifest.shaders),manifest.initialState,manifest.data,manifest.icon];
  const readApp=async directory=>{
    const content=JSON.parse(fs.readFileSync(path.join(directory,'app.json')));
    const fingerprint=crypto.createHash('sha256');
    for(const name of names)fingerprint.update(fs.readFileSync(path.join(directory,name)));
    return {root:fs.realpathSync(directory),id:content.id,name:content.name,version:content.version,
      manifest:content,fingerprint:fingerprint.digest('hex')};
  };
  const selected=applicationConfig('custom-homebrew');
  assert.equal(selected.vendor,'GPUBrewLauncher');assert.equal(selected.name,'Custom homebrew');
  assert.equal(selected.frameReady,applicationConfig('gpubrewlauncher').frameReady);
  const staged=await stageCustomApp(root,source,session,{readApp});
  assert.equal(staged.app.id,'my-app');assert.equal(staged.app.name,'My App');
  assert.equal(runtimeEnvironment(root,{},'custom-homebrew',staged.library).HB_APPS_DIR,staged.library);
  assert.deepEqual(fs.readFileSync(path.join(staged.library,'my-app/assets/data.bin')),
    fs.readFileSync(path.join(source,'assets/data.bin')));
  assert.equal(fs.existsSync(path.join(staged.library,'my-app/private-note.txt')),false);
  const prepared=await preflightCustomApp(root,source,{readApp,checkRuntime:async()=>{}});
  assert.equal(fs.readFileSync(path.join(prepared.appFolder,'assets/data.bin'),'utf8'),'assets/data.bin');
  assert.equal(fs.existsSync(path.join(source,'private-note.txt')),true);
  await prepared.cleanup();
  assert.equal(fs.existsSync(prepared.directory),false);
  await assert.rejects(stageCustomApp(root,'relative/app',path.join(root,'other'),{readApp}),/local GPU homebrew/);
  let calls=0;
  await assert.rejects(stageCustomApp(root,source,path.join(root,'changed'),{readApp:async directory=>{
    const app=await readApp(directory);
    if(++calls===1)fs.writeFileSync(path.join(source,'assets/data.bin'),'changed while staging');
    return app;
  }}),/changed during staging/);
});
test('custom homebrew helper runs only the selected package through the held RPC',async t=>{
  const f=fixture(t,{application:'custom-homebrew'}),source=path.join(f.root,'my-gpu-app');
  fs.mkdirSync(source);
  const manifest={id:'my-gpu-app',name:'My GPU App',version:'1.2',shaders:{vertex:'a.spv',fragment:'b.spv',compute:'c.spv'},
    initialState:'state.bin',data:'data.bin',icon:'icon.png'};
  fs.writeFileSync(path.join(source,'app.json'),JSON.stringify(manifest));
  for(const name of ['a.spv','b.spv','c.spv','state.bin','data.bin','icon.png'])fs.writeFileSync(path.join(source,name),name);
  f.api.customHomebrewPath=source;
  f.api.readApp=async directory=>({root:fs.realpathSync(directory),id:manifest.id,name:manifest.name,
    version:manifest.version,manifest,fingerprint:'selected-package'});
  const result=await main([f.directory],f.api);
  const report=JSON.parse(fs.readFileSync(path.join(result.directory,'mac2jb-homebrew.json')));
  assert.deepEqual(report.customApp,{id:manifest.id,name:manifest.name,version:manifest.version,fingerprint:'selected-package'});
  const library=path.join(result.directory,'apps');
  const started=fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.event==='start');
  assert.equal(started.length,9);
  assert.ok(started.every(row=>row.appsDirectory===library));
  assert.equal(fs.readFileSync(path.join(library,manifest.id,'data.bin'),'utf8'),'data.bin');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json'))).application,'custom-homebrew');
});
test('custom launcher uses the held RPC with its own music and no FTP owner',{timeout:10000},async t=>{
  const f=fixture(t,{application:'custom-homebrew',customHomebrewKind:'launcher'});
  const source=launcherPackage(f.root,f.vendor);
  const prepared=await preflightCustomHomebrew(f.root,source,{
    checkRuntime:async()=>{},validateLauncher:async()=>{}});
  assert.equal(prepared.kind,'launcher');
  assert.equal(prepared.app.name,'SouljaLauncher 2');
  assert.equal(prepared.app.files,Object.keys(JSON.parse(fs.readFileSync(path.join(source,'mac2jb-launcher.json'))).files).length);
  await prepared.cleanup();
  const alias=path.join(f.root,'launcher-parent-alias');
  fs.symlinkSync(path.dirname(source),alias,'dir');
  const throughAlias=await preflightCustomHomebrew(f.root,path.join(alias,path.basename(source)),{
    checkRuntime:async()=>{},validateLauncher:async()=>{}});
  await throughAlias.cleanup();
  f.api.customHomebrewPath=source;
  const result=await main([f.directory],f.api);
  const report=JSON.parse(fs.readFileSync(path.join(result.directory,'mac2jb-homebrew.json')));
  assert.equal(report.customLauncher.name,'SouljaLauncher 2');
  assert.equal(report.shutdown.music.playing,false);
  assert.deepEqual(f.requests,[{run:f.directory,body:{command:'status'}}]);
  const trace=fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
  const started=trace.filter(row=>row.event==='start');
  assert.deepEqual(started.slice(0,6).map(row=>[row.script,...row.args]),stages);
  assert.deepEqual(started.slice(6).map(row=>row.script),souljaOwners.map(owner=>owner.script));
  assert.equal(started.some(row=>/ftp-service|smilebasic\/host|start-launcher/.test(row.script)),false);
  assert.deepEqual(trace.filter(row=>row.event==='stop').map(row=>row.role),
    ['controls','audio','music','graphics']);
  assert.ok(started.every(row=>row.appsDirectory===path.join(result.directory,'launcher/apps')));
  assert.equal(f.events.at(-1).type,'stopped');
  fs.appendFileSync(path.join(source,'homebrew-launcher/music.cjs'),'changed');
  const changedSession=path.join(f.root,'changed-session');fs.mkdirSync(changedSession);
  await assert.rejects(stageCustomLauncher(source,changedSession),/package changed/);
});
test('unverified launcher does not contact the held RPC or reserve its launch',async t=>{
  const f=fixture(t,{application:'custom-homebrew',customHomebrewKind:'launcher'});
  const source=launcherPackage(f.root,f.vendor);
  fs.appendFileSync(path.join(source,'homebrew-launcher/music.cjs'),'changed');
  await assert.rejects(preflightCustomHomebrew(f.root,source,{
    checkRuntime:async()=>{},validateLauncher:async()=>{}}),/package changed/);
  assert.equal(f.requests.length,0);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),false);
});
test('read-only preparation failure releases its attempt for another held-RPC launch',async t=>{
  const f=fixture(t,{failStage:stages[0][0]});
  await assert.rejects(main([f.directory],f.api),/preparation failed/);
  assert.equal(f.events.at(-1).retrySafe,true);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),false);
  const stageFile=path.join(f.vendor,stages[0][0]);
  fs.writeFileSync(stageFile,fs.readFileSync(stageFile,'utf8').replace(
    "if(options.failStage===item.script)process.exit(1);",''));
  const result=await main([f.directory],f.api);
  assert.equal(result.stopped,true);
  assert.equal(f.events.at(-1).type,'stopped');
});
test('failure after native preparation begins keeps the one-attempt gate',async t=>{
  const f=fixture(t,{failStage:'homebrew-launcher/vulkan-copy.cjs'});
  await assert.rejects(main([f.directory],f.api),/preparation failed/);
  assert.equal(f.events.at(-1).retrySafe,false);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),true);
});
test('an unexpected mutating RPC during inspection prevents a retry',async t=>{
  const f=fixture(t,{failStage:stages[0][0]});
  const original=f.api.serveProxy;
  f.api.serveProxy=async options=>{
    await options.request({command:'write',address:0,bytes:''});
    return original(options);
  };
  await assert.rejects(main([f.directory],f.api),/preparation failed/);
  assert.equal(f.events.at(-1).retrySafe,false);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),true);
});
test('HBLauncher selects its frozen release, separate app library and exact readiness markers',()=>{
  const selected=applicationConfig('hblauncher');
  assert.equal(selected.vendor,'HBLauncher');assert.equal(selected.version,'0.2.0');
  assert.equal(selected.source.tag,'v0.2.0');assert.equal(selected.source.commit,'b40723be04baa51e5d1f121a1e2242c4167b6cbc');
  assert.equal(selected.owners.find(owner=>owner.role==='graphics').ready,'HBLauncher game event source ready.');
  assert.equal(selected.frameReady,'HBLauncher continuous native frame loop running.');
  assert.equal(runtimeEnvironment('/private/runtime',{},'hblauncher').HB_APPS_DIR,'/private/runtime/vendor/HBLauncher/apps');
  assert.equal(applicationConfig().vendor,'GPUBrewLauncher');
});
test('unsupported launcher selection cannot contact RPC or consume the one-app gate',async t=>{
  const f=fixture(t);
  for(const application of ['unavailable','unknown-launcher']) {
    await assert.rejects(main([f.directory],{...f.api,application}),/Unknown homebrew application/);
    assert.throws(()=>runtimeEnvironment(f.root,{},application),/Unknown homebrew application/);
  }
  assert.equal(f.requests.length,0);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),false);
});
async function exchange(handler,{token='secret',body={command:'status'},method='POST',url='/'}={}){
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  const req=Readable.from([bytes]);Object.assign(req,{method,url,headers:{authorization:'Bearer '+token}});
  const res={status:200,headers:{},destroyed:false,writeHead(status){this.status=status;return this;},
    setHeader(name,value){this.headers[name]=value;},end(value=''){this.body=value;return this;}};
  await handler(req,res);return res;
}
test('authenticated proxy only forwards supported, bounded requests once',async()=>{
  const requests=[];const handler=proxyHandler({token:'secret',request:async body=>{requests.push(body);return {result:7n};}});
  assert.equal((await exchange(handler,{token:'wrong'})).status,403);
  assert.equal((await exchange(handler,{method:'GET'})).status,403);
  assert.equal((await exchange(handler,{url:'/other'})).status,403);
  assert.equal(requests.length,0);
  const good=await exchange(handler,{body:{command:'call',offset:16,args:[1]}});
  assert.equal(good.status,200);assert.equal(JSON.parse(good.body).result,'7');assert.equal(requests.length,1);
  for(const body of [null,[],{command:'spawn'},Buffer.alloc(2*1024*1024+1,32),Buffer.from('{broken')])
    assert.equal((await exchange(handler,{body})).status,400);
  assert.equal(requests.length,1);
  const failed=proxyHandler({token:'secret',request:async()=>{requests.push('failed');throw Error('uncertain native request');}});
  assert.equal((await exchange(failed)).status,400);assert.equal(requests.filter(value=>value==='failed').length,1);
  const ended=proxyHandler({token:'secret',live:()=>false,request:async()=>{throw Error('must not forward');}});
  assert.match((await exchange(ended)).body,/no longer available/);
});
test('attach uses existing held connection, separate authenticated metadata and exact setup order',{timeout:10000},async t=>{
  const f=fixture(t),original=fs.readFileSync(path.join(f.directory,'connection.json'));
  const result=await main([f.directory],f.api);
  assert.equal(result.stopped,true);assert.deepEqual(fs.readFileSync(path.join(f.directory,'connection.json')),original);
  const connection=JSON.parse(fs.readFileSync(path.join(result.directory,'connection.json')));
  assert.equal(connection.port,23456);assert.equal(connection.token,'ab'.repeat(32));
  assert.deepEqual(connection.addresses,{...f.addresses,session:path.basename(result.directory)});
  assert.equal(fs.statSync(path.join(result.directory,'connection.json')).mode&0o077,0);
  assert.equal(fs.readFileSync(path.join(result.directory,'shared/rpc.cjs'),'utf8'),'// exact mocked upstream RPC module\n');
  assert.deepEqual(f.requests,[{run:f.directory,body:{command:'status'}}]);
  const trace=fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse),started=trace.filter(row=>row.event==='start');
  assert.deepEqual(started.slice(0,6).map(row=>[row.script,...row.args]),stages);
  assert.deepEqual(started.slice(6).map(row=>row.script),owners.map(row=>row.script));
  assert.equal(started.some(row=>/start-launcher|smilebasic\/host|pico/i.test(row.script)),false);
  assert.deepEqual(trace.filter(row=>row.event==='stop').map(row=>row.role),['ftp','audio','graphics']);
  assert.equal(trace.at(-1).event,'proxy-close');
  assert.ok(f.events.some(row=>row.type==='running'));assert.equal(f.events.at(-1).type,'stopped');
  await assert.rejects(main([f.directory],f.api),/EEXIST/);
});
for(const application of ['hblauncher','gpubrewlauncher','mintbrew'])
test(application+' entry attaches once to the same held proof and preserves shutdown ownership order',{timeout:10000},async t=>{
  const selected=applicationConfig(application),f=fixture(t,{application}),original=fs.readFileSync(path.join(f.directory,'connection.json'));
  const result=await require('./gui-'+application+'.cjs').main([f.directory],{...f.api,application:'unavailable'});
  assert.equal(result.stopped,true);assert.deepEqual(fs.readFileSync(path.join(f.directory,'connection.json')),original);
  const report=JSON.parse(fs.readFileSync(path.join(result.directory,'mac2jb-homebrew.json')));
  assert.equal(report.application,application);assert.equal(report.source.commit,selected.source.commit);
  assert.equal(report.sourceSession,'switch2-source');assert.equal(report.resourcesRetained,true);
  const connection=JSON.parse(fs.readFileSync(path.join(result.directory,'connection.json')));
  assert.deepEqual(connection.addresses,{...f.addresses,session:path.basename(result.directory)});
  assert.equal(connection.port,23456);assert.equal(connection.token,'ab'.repeat(32));
  const trace=fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse),started=trace.filter(row=>row.event==='start');
  assert.deepEqual(started.slice(0,6).map(row=>[row.script,...row.args]),stages);
  assert.equal(started.some(row=>/start-launcher|smilebasic\/host|pico/.test(row.script)),false);
  assert.deepEqual(trace.filter(row=>row.event==='stop').map(row=>row.role),['ftp','audio','graphics']);assert.equal(trace.at(-1).event,'proxy-close');
  assert.ok(f.events.some(row=>row.type==='running'&&row.message.includes(selected.name)));
  assert.equal(f.events.at(-1).type,'stopped');assert.match(f.events.at(-1).message,/allocations remain owned/);
  const marker=JSON.parse(fs.readFileSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')));
  assert.equal(marker.application,application);await assert.rejects(main([f.directory],f.api),/EEXIST/);
});
for(const application of ['hblauncher','gpubrewlauncher','mintbrew'])
test(application+' requires its own exact native frame marker before reporting running',{timeout:10000},async t=>{
  const other=application==='hblauncher'?'gpubrewlauncher':'hblauncher';
  const f=fixture(t,{application,frameMarker:applicationConfig(other).frameReady});
  await assert.rejects(main([f.directory],{...f.api,startTimeoutMs:200}),/console graphics readiness timed out/);
  assert.equal(f.events.some(row=>row.type==='running'),false);assert.equal(f.events.at(-1).type,'failed');
  assert.equal(fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.event==='start').length,9);
});
for(const application of ['hblauncher','gpubrewlauncher','mintbrew'])
test(application+' stage failure stops once and never retries or reaches live rendering',{timeout:10000},async t=>{
  const f=fixture(t,{application,failStage:'homebrew-launcher/inspect-input.cjs'});
  await assert.rejects(main([f.directory],f.api),/preparation failed/);
  const trace=fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(trace.filter(row=>row.event==='start'&&row.script==='homebrew-launcher/inspect-input.cjs').length,1);
  assert.equal(trace.some(row=>row.role==='graphics'),false);assert.equal(f.events.at(-1).type,'failed');
});
test('cancelling an in-flight setup stage stops it without replaying RPC or setup',{timeout:10000},async t=>{
  const f=fixture(t,{stallStage:'homebrew-launcher/inspect-display.cjs'});
  f.api.emit=(type,value)=>{f.events.push({type,...value});if(value.message?.includes('STAGE_READY'))process.emit('SIGTERM');};
  await assert.rejects(main([f.directory],f.api),/stopped during/);
  const trace=fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(trace.filter(row=>row.event==='start').length,1);assert.equal(f.requests.length,1);
  assert.equal(f.events.some(row=>row.type==='running'),false);assert.equal(f.events.at(-1).type,'failed');
});
for(const application of ['hblauncher','gpubrewlauncher','mintbrew'])
test(application+' unconfirmed audio shutdown cannot claim homebrew stopped cleanly',{timeout:10000},async t=>{
  const f=fixture(t,{application,badAudioStop:true});await assert.rejects(main([f.directory],f.api),/shutdown/);
  assert.equal(f.events.at(-1).type,'failed');assert.equal(f.events.some(row=>row.type==='stopped'),false);
});
test('foreign runs, wrong native identity and public connection files cannot attach',async t=>{
  const f=fixture(t);
  await assert.rejects(validateRun(f.root,f.root,f.api.verifySession),/current held run/);
  const connection=path.join(f.directory,'connection.json'),original=JSON.parse(fs.readFileSync(connection));
  fs.writeFileSync(connection,JSON.stringify({...original,addresses:{...original.addresses,session:'wrong'}}));
  await assert.rejects(validateRun(f.root,f.directory,f.api.verifySession),/another session/);
  fs.writeFileSync(connection,JSON.stringify(original));fs.chmodSync(connection,0o644);
  await assert.rejects(validateRun(f.root,f.directory,f.api.verifySession),/private owned/);
});
