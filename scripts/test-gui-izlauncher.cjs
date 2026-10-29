#!/usr/bin/env node
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PassThrough}=require('node:stream');
const {main,argumentsFor,verifyProcessIdentity,frameProof,stages,owners,FRAME_READY,REVISION}=require('./gui-izlauncher.cjs');
function fixture(t,options={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-izlauncher-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'vendor/ns2jb/runs/switch2-source'),runtime=path.join(root,'homebrew/IZ2S-Platform');
  const processFolder=path.join(directory,'switch2/process');fs.mkdirSync(processFolder,{recursive:true,mode:0o700});
  const rpcFile=path.join(root,'vendor/GPUBrewLauncher/smilebasic/engine/shared/rpc.cjs');fs.mkdirSync(path.dirname(rpcFile),{recursive:true});
  fs.writeFileSync(rpcFile,'// Frozen older RPC facade: no unsupported batch commands.\n');
  const addresses={session:'switch2-source',target:'switch2',platform:2,scratch:4096,main:8192,sdk:12288,backing:16384,controller:20480};
  fs.writeFileSync(path.join(directory,'connection.json'),JSON.stringify({port:12345,addresses}));
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({verified:true,fs:{verified:true,restored:true,
    cleanup:{deferred:true},retainedEndpoint:{ready:true}},rpc:{mode:'held',state:'listening'}}));
  const qualification={session:'switch2-source',report:path.join(directory,'acquisition.json'),verified:true,
    cleanup:{finished:true},app:{result:0,programId:options.demo?'0100b4b00f9f6000':'0100c9100b06a000'}};
  const qualificationFile=path.join(processFolder,'switch2-source-qualification-1000.json');
  fs.writeFileSync(qualificationFile,JSON.stringify(qualification));
  const trace=path.join(root,'order.jsonl');
  const log=value=>fs.appendFileSync(trace,JSON.stringify(value)+'\n');
  for(const item of [...stages.map(([script,...args])=>({script,args,role:'prepare'})),...owners]) {
    const file=path.join(runtime,item.script);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,`
const fs=require('node:fs'),path=require('node:path');
const directory=process.argv[2],session=path.basename(directory),item=${JSON.stringify(item)},options=${JSON.stringify(options)},trace=${JSON.stringify(trace)};
const log=value=>fs.appendFileSync(trace,JSON.stringify(value)+'\\n');
const write=(name,value)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value));
const loop=()=>({session,continuous:true,frameSha256:'a'.repeat(64),threadRunning:true});
log({event:'start',script:item.script,args:process.argv.slice(3),pid:process.pid});
if(options.failStage===item.script)process.exit(1);
if(item.role==='prepare'){
  if(options.stallStage===item.script){process.on('SIGTERM',()=>{log({event:'stop',role:'prepare'});process.exit(0)});console.log('STAGE_READY');setInterval(()=>{},1000);}
  else {
    if(item.script.includes('/prepare.cjs'))write('launcher-auto.json',{session,ready:true,firstShaderFramePresented:true,scratchRestored:true});
    if(item.script.includes('/check-input.cjs'))write('launcher-auto-check.json',{session,passed:true,scratchRestored:true});
  }
}else{
  if(item.role==='graphics'){
    write('launcher-auto-loop.json',{...loop(),...(options.badFrameProof?{threadRunning:false}:{})});
    write('app-runtime.json',{session,catalog:{apps:[{id:'iz-exchange',effects:options.audio?{1:'effect.pcm'}:{}}]}});
    console.log(options.frameMarker||${JSON.stringify(FRAME_READY)});
  }
  if(item.role==='audio')write('game-audio.json',{session});
  process.on('SIGTERM',()=>{log({event:'stop',role:item.role});if(options.stallStop===item.role)return;
    setTimeout(()=>{
      if(item.role==='graphics')write('launcher-auto-loop.json',{...loop(),threadRunning:!!options.badGraphicsStop,completed:'now'});
      if(item.role==='audio')write('game-audio.json',{session,completed:'now',...(options.badAudioStop?{stopError:'not stopped'}:{})});
      log({event:'joined',role:item.role});process.exit(options.badExit===item.role?1:0);
    },options.stopMs||10);
  });
  console.log(item.ready);setInterval(()=>{},1000);
  if(options.exitOwner===item.role)setTimeout(()=>process.exit(1),60);
}
`);
  }
  const events=[],requests=[],controller=new AbortController();
  const api={root,signal:controller.signal,verifySession:async candidate=>({root:candidate,session:path.basename(candidate),reportFile:qualification.report}),
    verifyRuntime:async()=>{},runtimeEnvironment:()=>process.env,
    request:async(run,body)=>{requests.push({run,body});return {ready:true};},
    serveProxy:async()=>({port:23456,token:'ab'.repeat(32),close:async()=>log({event:'proxy-close'})}),
    startTimeoutMs:2000,stopTimeoutMs:250,monitorMs:20,
    emit:(type,value)=>{events.push({type,...value});if(type==='running')setImmediate(()=>controller.abort());}};
  return {root,directory,runtime,qualification,qualificationFile,trace,events,requests,api,addresses,controller,log};
}
const args=f=>[f.directory];
const trace=f=>fs.readFileSync(f.trace,'utf8').trim().split('\n').map(JSON.parse);
test('CLI attaches to one existing run without selecting or replacing its edition or host',()=>{
  assert.equal(argumentsFor(['/run']),'/run');
  for(const values of [[],['/run','--edition','demo'],['/run','--edition','full'],['/run','extra']])
    assert.throws(()=>argumentsFor(values),/Usage/);
});
test('selected modules are prepared before graphics and live load requests reach the package queue',{timeout:10000},async t=>{
  const f=fixture(t),input=new PassThrough(),seen=[];
  f.api.input=input;
  f.api.runtimeEnvironment=()=>({...process.env});
  f.api.validateModules=async(root,ids)=>{seen.push(['validate',root,ids]);};
  f.api.prepareModules=async(runtime,ids,apps)=>{seen.push(['prepare',runtime,ids,apps]);};
  f.api.queueModules=async(root,state,ids)=>{seen.push(['queue',root,state,ids]);};
  f.api.emit=(type,value)=>{
    f.events.push({type,...value});
    if(type==='running')input.write('invalid json\n'+JSON.stringify({action:'load-modules',ids:['blitbun']})+'\n');
    if(type==='module-progress'&&value.message?.startsWith('Queued 1 IZlauncher module'))f.controller.abort();
  };
  const result=await main([f.directory,'--modules','["blitbun"]'],f.api);
  assert.equal(result.stopped,true);
  assert.deepEqual(seen.map(row=>row[0]),['validate','prepare','queue']);
  assert.deepEqual(seen[0][2],['blitbun']);
  assert.deepEqual(seen[1][2],['blitbun']);
  assert.deepEqual(seen[2][3],['blitbun']);
  assert.equal(seen[2][1],f.root);
  assert.equal(seen[2][2],path.join(result.directory,'state'));
  assert.deepEqual(f.events.filter(event=>event.type==='module-progress').map(event=>event.message),
    ['Invalid IZlauncher module request.','Queued 1 IZlauncher module from this Mac.']);
  assert.equal(f.events.some(event=>event.type==='progress'&&event.message?.startsWith('Queued 1 IZlauncher module')),false);
  input.destroy();
});
test('the current IZlauncher run publishes a verified local panel address',{timeout:10000},async t=>{
  const f=fixture(t),input=new PassThrough(),url='http://127.0.0.1:53674/#'+'a'.repeat(48);
  f.api.input=input;
  f.api.emit=(type,value)=>{
    f.events.push({type,...value});
    if(type==='running')fs.writeFileSync(path.join(value.path,'pc-screen-local.json'),JSON.stringify({url,port:53674}),{mode:0o600});
    if(type==='panel')f.controller.abort();
  };
  const result=await main(args(f),f.api);
  assert.deepEqual(f.events.filter(event=>event.type==='panel'),[{type:'panel',path:result.directory,url}]);
  input.destroy();
});
test('real process proof rejects unknown, foreign, failed and unclean qualification before RPC or exclusivity',async t=>{
  const f=fixture(t);
  const invalid=[{app:{result:0,programId:'unknown'}},
    {app:{result:1,programId:f.qualification.app.programId}},{verified:false},{session:'foreign'},{report:'/elsewhere'},
    {cleanup:{finished:false}},{error:'failed'},{cleanupError:'pending'}];
  for(const changed of invalid){fs.writeFileSync(f.qualificationFile,JSON.stringify({...f.qualification,...changed}));
    await assert.rejects(main(args(f),f.api),/process identity/);}
  assert.equal(f.requests.length,0);assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),false);
});
test('latest process proof must qualify and cannot be replaced by an older successful proof',async t=>{
  const f=fixture(t),newer=f.qualificationFile.replace('1000','2000');fs.writeFileSync(newer,JSON.stringify({...f.qualification,verified:false}));
  await assert.rejects(main(args(f),f.api),/process identity/);
  fs.unlinkSync(newer);fs.unlinkSync(f.qualificationFile);await assert.rejects(main(args(f),f.api),/process qualification/);
  fs.symlinkSync(path.join(f.directory,'result.json'),f.qualificationFile);await assert.rejects(main(args(f),f.api),/private owned/);
});
test('upstream copied directory modes are accepted inside a private run; writable or public proof files are rejected',async t=>{
  const f=fixture(t),run={directory:f.directory,proof:await f.api.verifySession(f.directory)},folder=path.dirname(f.qualificationFile);
  fs.chmodSync(folder,0o755);assert.equal((await verifyProcessIdentity(run)).programId,f.qualification.app.programId);
  fs.chmodSync(folder,0o777);await assert.rejects(verifyProcessIdentity(run),/private owned/);fs.chmodSync(folder,0o755);
  fs.chmodSync(f.qualificationFile,0o644);await assert.rejects(verifyProcessIdentity(run),/private owned/);
});
test('runtime failure or absent live RPC does not consume the console attempt',async t=>{
  const f=fixture(t);
  await assert.rejects(main(args(f),{...f.api,verifyRuntime:async()=>{throw Error('runtime invalid');}}),/runtime invalid/);
  assert.equal(f.requests.length,0);
  await assert.rejects(main(args(f),{...f.api,request:async()=>({ready:false})}),/not ready/);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),false);
});
for(const {audio,demo} of [{audio:false,demo:false},{audio:true,demo:false},{audio:false,demo:true}])
test('base shell attaches once, validates frame evidence and joins only owned workers; '+JSON.stringify({audio,demo}),{timeout:10000},async t=>{
  const f=fixture(t,{audio,demo}),original=fs.readFileSync(path.join(f.directory,'connection.json'));
  const result=await main(args(f),f.api);assert.equal(result.stopped,true);
  assert.deepEqual(fs.readFileSync(path.join(f.directory,'connection.json')),original);
  const connection=JSON.parse(fs.readFileSync(path.join(result.directory,'connection.json')));
  assert.deepEqual(connection,{port:23456,token:'ab'.repeat(32),addresses:{...f.addresses,session:path.basename(result.directory)}});
  assert.equal(fs.statSync(path.join(result.directory,'connection.json')).mode&0o077,0);
  assert.match(fs.readFileSync(path.join(result.directory,'shared/rpc.cjs'),'utf8'),/no unsupported batch/);
  const rows=trace(f),started=rows.filter(row=>row.event==='start');
  assert.deepEqual(started.slice(0,6).map(row=>[row.script,...row.args]),stages);
  assert.deepEqual(started.slice(6).map(row=>row.script),owners.slice(0,audio?3:2).map(row=>row.script));
  assert.equal(started.some(row=>/engines\/host|console-runner|\/run\.cjs/.test(row.script)),false);
  const roles=audio?['ftp','audio','graphics']:['ftp','graphics'];
  assert.deepEqual(rows.filter(row=>row.event==='stop').map(row=>row.role),roles);
  assert.deepEqual(rows.filter(row=>row.event==='joined').map(row=>row.role),roles);assert.equal(rows.at(-1).event,'proxy-close');
  assert.deepEqual(f.requests,[{run:f.directory,body:{command:'status'}}]);
  assert.equal(f.events.at(-1).type,'stopped');assert.ok(f.events.some(row=>row.type==='running'));
  const report=JSON.parse(fs.readFileSync(path.join(result.directory,'mac2jb-homebrew.json')));
  assert.equal(report.source.commit,REVISION);assert.equal(report.shutdown.graphics.threadRunning,false);assert.equal(report.cleanupBlocked,false);
  assert.equal(report.identity.programId,demo?'0100b4b00f9f6000':'0100c9100b06a000');
  assert.equal(!!report.shutdown.audio,audio);await frameProof(result.directory,report.session,true);
  const marker=JSON.parse(fs.readFileSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')));assert.equal(marker.application,'izlauncher');
  await assert.rejects(main(args(f),f.api),/EEXIST/);
});
for(const options of [{frameMarker:'GPUBrewLauncher continuous native frame loop running.'},{badFrameProof:true}])
test('a stdout marker alone cannot establish IZlauncher console readiness: '+JSON.stringify(options),{timeout:10000},async t=>{
  const f=fixture(t,options);await assert.rejects(main(args(f),{...f.api,startTimeoutMs:150}),/graphics readiness|frame worker/);
  assert.equal(f.events.some(row=>row.type==='running'),false);assert.equal(f.events.at(-1).type,'failed');
});
test('cancel during read-only preparation joins the stage and never starts another stage',{timeout:10000},async t=>{
  const f=fixture(t,{stallStage:stages[0][0]});
  f.api.emit=(type,value)=>{f.events.push({type,...value});if(value.message?.endsWith('STAGE_READY'))f.controller.abort();};
  await assert.rejects(main(args(f),f.api),/stopped during/);
  assert.equal(trace(f).filter(row=>row.event==='start').length,1);assert.equal(f.events.at(-1).cleanupBlocked,false);
});
test('failed mutating preparation keeps the one-app marker and blocks releasing retained resources',{timeout:10000},async t=>{
  const f=fixture(t,{failStage:stages[4][0]});await assert.rejects(main(args(f),f.api),/preparation failed/);
  assert.equal(trace(f).filter(row=>row.event==='start'&&row.script===stages[4][0]).length,1);
  assert.equal(f.events.at(-1).cleanupBlocked,true);assert.equal(f.events.some(row=>row.type==='running'),false);
  assert.equal(fs.existsSync(path.join(f.directory,'.mac2jb-hblauncher-attempt.json')),true);
});
for(const options of [{badGraphicsStop:true},{audio:true,badAudioStop:true},{badExit:'ftp'},{stallStop:'graphics'}])
test('unconfirmed owner cleanup is a blocked failure: '+JSON.stringify(options),{timeout:10000},async t=>{
  const f=fixture(t,options);await assert.rejects(main(args(f),f.api),/shutdown|clean stop/);
  assert.equal(f.events.at(-1).type,'failed');assert.equal(f.events.at(-1).cleanupBlocked,true);
  assert.equal(f.events.some(row=>row.type==='stopped'),false);assert.equal(trace(f).at(-1).event,'proxy-close');
});
test('source session loss joins workers and does not signal or rewrite the original host',{timeout:10000},async t=>{
  const f=fixture(t);f.api.emit=(type,value)=>{f.events.push({type,...value});if(type==='running'){
    const file=path.join(f.directory,'result.json'),result=JSON.parse(fs.readFileSync(file));result.rpc.state='closed';fs.writeFileSync(file,JSON.stringify(result));}};
  await assert.rejects(main(args(f),f.api),/original held RPC session ended/);
  assert.deepEqual(trace(f).filter(row=>row.event==='joined').map(row=>row.role),['ftp','graphics']);
  assert.equal(trace(f).at(-1).event,'proxy-close');assert.equal(f.events.at(-1).type,'failed');
});
test('an unexpected native worker exit stops its siblings and blocks releasing the original RPC',{timeout:10000},async t=>{
  const f=fixture(t,{exitOwner:'graphics'});f.api.emit=(type,value)=>f.events.push({type,...value});
  await assert.rejects(main(args(f),f.api),/ended unexpectedly/);
  assert.ok(trace(f).some(row=>row.event==='joined'&&row.role==='ftp'));
  assert.equal(f.events.at(-1).cleanupBlocked,true);assert.equal(f.events.some(row=>row.type==='stopped'),false);
});
test('an uncertain native request is not replayed and cannot become a clean stop',{timeout:10000},async t=>{
  const f=fixture(t);let forward,attempts=0;
  f.api.request=async(run,body)=>{if(body.command==='call'){attempts++;throw Error('Native request uncertain');}return {ready:true};};
  f.api.serveProxy=async options=>{forward=options.request;return {port:23456,token:'ab'.repeat(32),close:async()=>f.log({event:'proxy-close'})};};
  f.api.emit=(type,value)=>{f.events.push({type,...value});if(type==='running')forward({command:'call',offset:1,args:[]}).catch(()=>{});};
  await assert.rejects(main(args(f),f.api),/Native request uncertain/);
  assert.equal(attempts,1);assert.equal(f.events.at(-1).cleanupBlocked,true);assert.equal(f.events.some(row=>row.type==='stopped'),false);
});
test('outstanding forwarded native delivery drains before proxy close and completion',{timeout:10000},async t=>{
  const f=fixture(t);let forward,delivered=false;
  f.api.request=async(run,body)=>{if(body.command==='read'){await new Promise(resolve=>setTimeout(resolve,100));delivered=true;f.log({event:'rpc-drained'});}return {ready:true};};
  f.api.serveProxy=async options=>{forward=options.request;return {port:23456,token:'ab'.repeat(32),close:async()=>{assert.equal(delivered,true);f.log({event:'proxy-close'});}};};
  f.api.emit=(type,value)=>{f.events.push({type,...value});if(type==='running'){forward({command:'read',address:4096,length:8});f.controller.abort();}};
  await main(args(f),f.api);assert.equal(trace(f).at(-1).event,'proxy-close');assert.equal(f.events.at(-1).type,'stopped');
});
