#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {spawn,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const commands = new Set(['status','call','verify-function','call-address','pair','read','write','query']);
const stages = [
  ['homebrew-launcher/inspect-display.cjs'],
  ['homebrew-launcher/inspect-compatibility.cjs'],
  ['homebrew-launcher/inspect-input.cjs'],
  ['homebrew-launcher/vulkan-copy.cjs','display'],
  ['homebrew-launcher/launcher.cjs','auto'],
  ['homebrew-launcher/launcher-check.cjs','auto']
];
const owners = [
  {role:'graphics', script:'homebrew-launcher/launcher-loop.cjs', args:['auto'], ready:'GPUBrewLauncher game event source ready.'},
  {role:'ftp', script:'sdk/host/ftp-service.cjs', args:[], ready:'SDK FTP service ready.'},
  {role:'audio', script:'homebrew-launcher/game-audio.cjs', args:[], ready:'Game sound effects ready.'}
];
const souljaOwners = [
  {role:'music',script:'homebrew-launcher/music.cjs',
    args:['homebrew-launcher/audio/intro.pcm','homebrew-launcher/audio/loop.pcm'],
    ready:'Homebrew Channel music started on the console audio output.',timeoutMs:600000},
  {role:'graphics',script:'homebrew-launcher/launcher-loop.cjs',args:['auto'],
    ready:'HBLauncher game event source ready.'},
  {role:'controls',script:'homebrew-launcher/music-controls.cjs',args:[],
    ready:'Launch-input music control ready.'},
  {role:'audio',script:'homebrew-launcher/game-audio.cjs',args:[],
    ready:'Game sound effects ready.'}
];
function applicationConfig(application='gpubrewlauncher',kind='gpu-app') {
  if(application==='mintbrew'){
    const manifest=require('../vendor/MintBrew/manifest.json');
    if(manifest.name!=='MintBrew'||typeof manifest.version!=='string'||
      !/^\d+\.\d+\.\d+$/.test(manifest.version))throw Error('Invalid MintBrew manifest.');
    return {id:application,vendor:'MintBrew',name:manifest.name,
      version:manifest.version,source:{format:'mintbrew-v1'},
      owners:owners.map(owner=>owner.role==='graphics'?{...owner,ready:'MintBrew game event source ready.'}:owner),
      frameReady:'MintBrew continuous native frame loop running.'};
  }
  if(application==='hblauncher')return {id:application,vendor:'HBLauncher',name:'HBLauncher',
    version:'0.2.0',source:{tag:'v0.2.0',commit:'b40723be04baa51e5d1f121a1e2242c4167b6cbc'},
    owners:owners.map(owner=>owner.role==='graphics'?{...owner,ready:'HBLauncher game event source ready.'}:owner),
    frameReady:'HBLauncher continuous native frame loop running.'};
  if(application==='custom-homebrew'&&kind==='launcher')
    return {id:application,vendor:'HBLauncher',name:'Custom launcher',version:'local',
      source:{format:'mac2jb.held-rpc-launcher'},owners:souljaOwners,
      frameReady:'HBLauncher continuous native frame loop running.'};
  if(!['gpubrewlauncher','custom-homebrew'].includes(application))throw Error('Unknown homebrew application: '+application);
  return {id:application,vendor:'GPUBrewLauncher',name:application==='custom-homebrew'?'Custom homebrew':'GPUBrewLauncher',
    version:'snapshot-f35ff64',source:{commit:'f35ff64ea4b9b42cf2a75095d24662fe250f03e4'},owners,
    frameReady:'GPUBrewLauncher continuous native frame loop running.'};
}
const check = (value, message) => {if (!value) throw Error(message);};
async function privatePath(file, directory = false) {
  const absolute = path.resolve(file), info = await fs.lstat(absolute);
  check(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()) &&
    info.uid === process.getuid() && (info.mode & 0o077) === 0 &&
    await fs.realpath(absolute) === absolute, 'Expected a private owned session path: ' + absolute);
  return absolute;
}
async function json(file) {await privatePath(file); return JSON.parse(await fs.readFile(file,'utf8'));}
function writeJSON(file, value, exclusive = false) {
  return fs.writeFile(file, JSON.stringify(value,null,2)+'\n', {mode:0o600,flag:exclusive?'wx':'w'});
}
async function validateRun(root, candidate, verifySession) {
  const directory = await privatePath(candidate,true);
  const runs = await fs.realpath(path.join(root,'vendor/ns2jb/runs')).catch(error=>{
    if(error.code==='ENOENT')return null;throw error;
  });
  if(path.dirname(directory)!==runs)
    await require('./rpc-attachment.cjs').validateManifest(root,directory);
  const proof = await verifySession(directory);
  const connection = await json(path.join(directory,'connection.json'));
  check(proof.root === directory && proof.session === path.basename(directory) &&
    Number.isSafeInteger(connection.port) && connection.port >= 1 && connection.port <= 65535 &&
    connection.addresses?.session === proof.session && connection.addresses?.target === 'switch2' &&
    connection.addresses?.platform === 2, 'The held native connection belongs to another session.');
  for (const name of ['scratch','main','sdk','backing','controller'])
    check(Number.isSafeInteger(connection.addresses[name]) && connection.addresses[name] >= 4096 &&
      connection.addresses[name] < 2 ** 39, 'Invalid held native address: ' + name);
  return {directory,proof,connection};
}
function proxyHandler({token, request, live = () => true}) {
  return async (req,res) => {
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== 'Bearer '+token) {
      res.writeHead(403).end();return;
    }
    try {
      check(live(), 'The original held RPC session is no longer available.');
      const parts=[];let length=0;
      for await (const part of req) {
        length+=part.length;check(length<=2*1024*1024,'Bridge request is too large');parts.push(part);
      }
      const body=JSON.parse(Buffer.concat(parts));
      check(body && typeof body==='object' && !Array.isArray(body) && commands.has(body.command),
        'Unknown homebrew bridge command');
      const reply=await request(body); // the original bridge serializes all native operations.
      if (!res.destroyed) {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify(reply,(_,value)=>typeof value==='bigint'?value.toString():value));
      }
    } catch(error) {
      if (!res.destroyed) res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}));
    }
  };
}
async function serveProxy(options) {
  const token=crypto.randomBytes(32).toString('hex');
  const server=http.createServer(proxyHandler({...options,token}));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {token,port:server.address().port,async close(){
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }};
}
function runtimeEnvironment(root, inherited = process.env, application='gpubrewlauncher', appsDirectory) {
  const selected=applicationConfig(application);
  const env={...inherited,
    PATH:[path.join(root,'homebrew/python/bin'),path.join(root,'homebrew/bin'),inherited.PATH||''].join(path.delimiter),
    SPIRV_VAL:path.join(root,'homebrew/bin/spirv-val'),
    PYTHONPATH:path.join(root,'homebrew/python-custom'),
    PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
    MAC2JB_HBLAUNCHER_FONT:path.join(root,'homebrew/fonts/DejaVuSans.ttf'),
    HB_APPS_DIR:appsDirectory||path.join(root,'vendor',selected.vendor,'apps')};
  delete env.PYTHONHOME;return env;
}
async function withRuntimeEnvironment(environment, operation) {
  const keys=['PATH','SPIRV_VAL','PYTHONPATH','PYTHONNOUSERSITE','PYTHONDONTWRITEBYTECODE','PYTHONHOME'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys) {
    if(environment[key]===undefined)delete process.env[key];
    else process.env[key]=environment[key];
  }
  try{return await operation();}
  finally{
    for(const key of keys) {
      if(previous[key]===undefined)delete process.env[key];
      else process.env[key]=previous[key];
    }
  }
}
async function stageCustomApp(root, folder, sessionDirectory, options={}) {
  check(typeof folder==='string'&&path.isAbsolute(folder)&&folder.length<=4096&&!/[\x00\r\n]/.test(folder),
    'Choose a local GPU homebrew app folder.');
  const readApp=options.readApp||require(path.join(root,'vendor/GPUBrewLauncher/homebrew-launcher/app-catalog.cjs')).readApp;
  const source=await readApp(folder);
  const manifest=source.manifest;
  const names=new Set(['app.json',manifest.shaders.vertex,manifest.shaders.fragment,manifest.shaders.compute,
    manifest.initialState,manifest.data,manifest.icon,
    ...(manifest.computeSequence?[manifest.computeSequence.begin,manifest.computeSequence.after]:[]),
    ...(manifest.memory?[manifest.memory.initial]:[]),...Object.values(manifest.audio?.effects||{})]);
  const library=path.join(sessionDirectory,'apps'),destination=path.join(library,source.id);
  await fs.mkdir(destination,{recursive:true,mode:0o700});
  for(const name of names) {
    check(typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&!name.split(/[\\/]/).includes('..'),
      'App asset path must stay inside its folder.');
    const output=path.resolve(destination,name);
    check(output.startsWith(destination+path.sep),'App asset path must stay inside its folder.');
    await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
    await fs.copyFile(path.resolve(source.root,name),output);
    await fs.chmod(output,0o600);
  }
  const staged=await readApp(destination);
  check(staged.id===source.id&&staged.fingerprint===source.fingerprint,
    'The selected homebrew package changed during staging. Choose it again.');
  return {library,app:{id:staged.id,name:staged.name,version:staged.version,fingerprint:staged.fingerprint}};
}
const launcherManifestName='mac2jb-launcher.json';
const launcherRequired=[
  ...stages.map(([script])=>script),
  ...souljaOwners.map(owner=>owner.script),
  'homebrew-launcher/audio/intro.pcm','homebrew-launcher/audio/loop.pcm',
  'homebrew-launcher/shaders/launcher.vert.spv',
  'homebrew-launcher/shaders/launcher.frag.spv',
  'homebrew-launcher/shaders/launcher.comp.spv',
  'smilebasic/reference/sdk-checks.cjs',
  'smilebasic/reference/sdk-checks.json',
  'smilebasic/engine/shared/sdk-functions.json',
  'smilebasic/engine/shared/frames.cjs',
  'smilebasic/engine/switch2/app/thread-code.json',
  'smilebasic/engine/switch2/app/timing-code.json'
];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function stageCustomLauncher(folder,sessionDirectory) {
  check(typeof folder==='string'&&path.isAbsolute(folder)&&folder.length<=4096&&!/[\x00\r\n]/.test(folder),
    'Choose a local launcher folder.');
  const requested=path.resolve(folder),sourceInfo=await fs.lstat(requested);
  check(sourceInfo.isDirectory()&&!sourceInfo.isSymbolicLink(),
    'Choose a real launcher folder, not a link.');
  const source=await fs.realpath(requested);
  const manifestFile=path.join(source,launcherManifestName),manifestInfo=await fs.lstat(manifestFile);
  check(manifestInfo.isFile()&&!manifestInfo.isSymbolicLink()&&manifestInfo.size<=65536,
    'Invalid launcher package manifest.');
  const manifestBytes=await fs.readFile(manifestFile),manifest=JSON.parse(manifestBytes);
  const inventory=manifest?.files;
  check(manifest?.format==='mac2jb.held-rpc-launcher'&&manifest.version===1&&
    manifest.profile==='souljalauncher-2'&&typeof manifest.name==='string'&&
    manifest.name.length>0&&manifest.name.length<=80&&!/[\x00-\x1f\x7f]/.test(manifest.name)&&
    inventory&&typeof inventory==='object'&&!Array.isArray(inventory),
    'Unsupported launcher package.');
  const entries=Object.entries(inventory),names=new Set();
  check(entries.length>=launcherRequired.length&&entries.length<=512,
    'Launcher package file inventory is invalid.');
  for(const [name,hash] of entries) {
    check(/^(homebrew-launcher|sdk|smilebasic|apps|scripts)\//.test(name)&&
      !/[\\\x00-\x1f\x7f]/.test(name)&&
      name.split('/').every(part=>part&&part!=='.'&&part!=='..')&&
      /^[a-f0-9]{64}$/.test(hash)&&!names.has(name.toLowerCase()),
      'Launcher package contains an unsafe file path or digest.');
    names.add(name.toLowerCase());
  }
  check(launcherRequired.every(name=>Object.hasOwn(inventory,name)),
    'Launcher package is missing a required runtime file.');
  const destination=path.join(sessionDirectory,'launcher');
  await fs.mkdir(destination,{mode:0o700});
  let bytesTotal=0;
  for(const [name,expected] of entries) {
    const input=path.join(source,name),info=await fs.lstat(input),real=await fs.realpath(input);
    check(info.isFile()&&!info.isSymbolicLink()&&real===input&&
      info.size>0&&info.size<=32*1024*1024,
      'Launcher package contains an invalid file: '+name);
    bytesTotal+=info.size;
    check(bytesTotal<=100*1024*1024,'Launcher package exceeds 100 MiB.');
    const bytes=await fs.readFile(input);
    check(digest(bytes)===expected,'Launcher package changed: '+name);
    const output=path.join(destination,name);
    await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
    await fs.writeFile(output,bytes,{flag:'wx',mode:0o600});
  }
  await fs.writeFile(path.join(destination,launcherManifestName),manifestBytes,{flag:'wx',mode:0o600});
  for(const [name,expected] of entries)
    check(digest(await fs.readFile(path.join(destination,name)))===expected,
      'Staged launcher package changed: '+name);
  return {folder:destination,launcher:{name:manifest.name,profile:manifest.profile,
    fingerprint:digest(manifestBytes),files:entries.length}};
}
async function validateCustomLauncher(root,folder) {
  const run=promisify(execFile),validator=path.join(root,'homebrew/bin/spirv-val');
  for(const stage of ['vert','frag','comp']) {
    const shader=path.join(folder,'homebrew-launcher/shaders/launcher.'+stage+'.spv');
    try{await run(validator,['--target-env','vulkan1.0',shader],{timeout:10000,maxBuffer:65536});}
    catch{throw Error('Launcher shader validation failed: '+stage);}
  }
  const apps=path.join(folder,'apps'),readApp=require(path.join(root,'vendor/HBLauncher/homebrew-launcher/app-catalog.cjs')).readApp;
  const entries=await fs.readdir(apps,{withFileTypes:true}),available=[];
  for(const entry of entries)if(entry.isDirectory()) {
    const directory=path.join(apps,entry.name);
    if(await fs.access(path.join(directory,'app.json')).then(()=>true,()=>false))
      available.push(await readApp(directory));
  }
  check(available.length>0,'Launcher package has no compatible GPU apps.');
}
async function checkRuntime(root) {
  for(const file of ['homebrew/python/bin/python3','homebrew/bin/spirv-val'])
    await fs.access(path.join(root,file),sync.constants.X_OK);
  for(const file of ['homebrew/fonts/DejaVuSans.ttf','homebrew/python-custom/sitecustomize.py'])
    check((await fs.lstat(path.join(root,file))).isFile(),'Missing packaged homebrew dependency: '+file);
}
async function preflightCustomApp(root, folder, options={}) {
  await (options.checkRuntime||checkRuntime)(root);
  const parent=path.join(root,'runs');
  await fs.mkdir(parent,{recursive:true,mode:0o700});
  await privatePath(parent,true);
  const directory=await fs.mkdtemp(path.join(await fs.realpath(parent),'custom-preflight-'));
  try {
    const environment=runtimeEnvironment(root,process.env,'custom-homebrew');
    const staged=await withRuntimeEnvironment(environment,()=>stageCustomApp(root,folder,directory,options));
    return {directory,appFolder:path.join(staged.library,staged.app.id),app:staged.app,
      cleanup:()=>fs.rm(directory,{recursive:true,force:true})};
  } catch(error) {await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});throw error;}
}
async function preflightCustomHomebrew(root,folder,options={}) {
  const rpcManifest=path.join(folder,'mac2jb-rpc-app.json');
  const ouncecakeImage=path.join(folder,'engine/oz-code/native.bin');
  if(await fs.lstat(rpcManifest).then(()=>true,error=>{
    if(error.code==='ENOENT')return false;throw error;
  })||await fs.lstat(ouncecakeImage).then(()=>true,error=>{
    if(error.code==='ENOENT')return false;throw error;
  }))return require('./custom-rpc-package.cjs').preflight(root,folder,options);
  const launcherFile=path.join(folder,launcherManifestName);
  if(!await fs.lstat(launcherFile).then(()=>true,error=>{
    if(error.code==='ENOENT')return false;throw error;
  }))return {...await preflightCustomApp(root,folder,options),kind:'gpu-app'};
  await (options.checkRuntime||checkRuntime)(root);
  const parent=path.join(root,'runs');
  await fs.mkdir(parent,{recursive:true,mode:0o700});
  await privatePath(parent,true);
  const directory=await fs.mkdtemp(path.join(await fs.realpath(parent),'custom-preflight-'));
  try {
    const staged=await stageCustomLauncher(folder,directory);
    const environment=runtimeEnvironment(root,process.env,'custom-homebrew',path.join(staged.folder,'apps'));
    await withRuntimeEnvironment(environment,()=>(
      options.validateLauncher||validateCustomLauncher)(root,staged.folder));
    return {directory,kind:'launcher',launcherFolder:staged.folder,app:staged.launcher,
      cleanup:()=>fs.rm(directory,{recursive:true,force:true})};
  } catch(error) {await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});throw error;}
}
function lines(stream, callback) {
  let pending='';
  stream.on('data',bytes=>{
    pending+=bytes.toString();
    let at;while((at=pending.search(/[\r\n]/))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(line)callback(line);}
    if(pending.length>65536){callback(pending.slice(0,65536));pending='';}
  });
  stream.on('end',()=>{if(pending)callback(pending);});
}
async function main(args = process.argv.slice(2), options = {}) {
  check(args.length===1,'Usage: gui-homebrew.cjs RUN_DIRECTORY');
  const selected=applicationConfig(options.application,options.customHomebrewKind), root=options.root||path.resolve(__dirname,'..');
  let vendor=path.join(root,'vendor',selected.vendor);
  const emit=options.emit||((type,fields={})=>process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type,...fields})+'\n'));
  const run=await validateRun(root,args[0],options.verifySession||require('./gui-dump.cjs').verifiedSession);
  await (options.checkRuntime||checkRuntime)(root);
  check(selected.id!=='custom-homebrew'||typeof options.customHomebrewPath==='string',
    'Choose a homebrew folder before launching.');
  const request=options.request||require(path.join(root,'vendor/ns2jb/rpc.cjs')).request;
  const parent=path.join(root,'runs');await fs.mkdir(parent,{recursive:true,mode:0o700});
  await privatePath(parent,true);
  const directory=await fs.mkdtemp(path.join(await fs.realpath(parent),selected.id+'-'));
  let custom,launcher,attempt;
  try {
    if(selected.id==='mintbrew'){
      const input=options.config||{};
      const config={...require('./gui-stremio.cjs').playerConfiguration(input),
        quality:require('../stremio/quality.cjs').qualityProfile(input.quality).id};
      await writeJSON(path.join(directory,'stremio-config.json'),config,true);
      await writeJSON(path.join(directory,'mintbrew-host.json'),
        {runDirectory:run.directory,sourceSession:run.proof.session},true);
    }
    if(selected.id==='custom-homebrew'&&options.customHomebrewKind==='launcher') {
      launcher=await stageCustomLauncher(options.customHomebrewPath,directory);
      vendor=launcher.folder;
      const environment=runtimeEnvironment(root,process.env,selected.id,path.join(vendor,'apps'));
      await withRuntimeEnvironment(environment,()=>(
        options.validateLauncher||validateCustomLauncher)(root,vendor));
      selected.name=launcher.launcher.name;
      selected.source={...selected.source,fingerprint:launcher.launcher.fingerprint};
    } else if(selected.id==='custom-homebrew') {
      const environment=runtimeEnvironment(root,process.env,selected.id);
      custom=await withRuntimeEnvironment(environment,()=>stageCustomApp(root,options.customHomebrewPath,directory,options));
    }
    const status=await request(run.directory,{command:'status'});
    check(status?.ready===true,'The existing native RPC connection is not ready.');
    attempt={
      application:selected.id,source:selected.name,...selected.source,started:new Date().toISOString()
    };
    await writeJSON(path.join(run.directory,'.mac2jb-hblauncher-attempt.json'),attempt,true);
  } catch(error) {await fs.rm(directory,{recursive:true,force:true});throw error;}
  const report={session:path.basename(directory),sourceSession:run.proof.session,sourceDirectory:run.directory,
    application:selected.id,version:selected.version,source:selected.source,started:new Date().toISOString(),status:'preparing',stages:[],children:[],resourcesRetained:true};
  if(custom)report.customApp=custom.app;
  if(launcher)report.customLauncher=launcher.launcher;
  const reportFile=path.join(directory,'mac2jb-homebrew.json');
  const save=()=>writeJSON(reportFile,report);
  let proxy,stopping=false,running=false,failure,monitor,stopResolve;
  let nativeMutationStarted=false,cleanupUnsafe=false;
  const stopRequested=new Promise(resolve=>{stopResolve=resolve;});
  const children=new Set();
  function stop(){if(!stopping){stopping=true;stopResolve();}}
  const fail=error=>{failure ||= error;stop();};
  const safeEmit=(type,fields={})=>{
    try{emit(type,{path:directory,...fields});}catch(error){if(error.code!=='EPIPE')throw error;stop();}
  };
  const stdoutError=error=>{if(error.code!=='EPIPE')failure ||= error;stop();};
  process.stdout.on('error',stdoutError);
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  function live(){
    try{
      const current=JSON.parse(sync.readFileSync(path.join(run.directory,'result.json'),'utf8'));
      const connection=JSON.parse(sync.readFileSync(path.join(run.directory,'connection.json'),'utf8'));
      return current.verified===true && !current.error && current.rpc?.mode==='held' &&
        current.rpc?.state==='listening' && connection.port===run.connection.port &&
        connection.addresses?.session===run.proof.session &&
        current.fs?.verified===true && current.fs?.restored===true &&
        current.fs?.retainedEndpoint?.ready===true && current.fs?.cleanup?.deferred===true;
    }catch{return false;}
  }
  function start(script,extra=[],readyText,role='prepare'){
    check(!stopping,selected.name+' launch was stopped.');
    const child=spawn(process.execPath,[path.join(vendor,script),directory,...extra],{
      cwd:vendor,env:runtimeEnvironment(root,process.env,selected.id,
        custom?.library||(launcher?path.join(vendor,'apps'):undefined)),stdio:['ignore','pipe','pipe']
    });
    const state={child,script,role,closed:false,ready:false,frameReady:false,output:''};children.add(state);
    let readyResolve,readyReject;
    state.readiness=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    state.readiness.catch(()=>{});
    const observe=line=>{
      if(selected.id==='mintbrew'&&role==='graphics'&&line.startsWith('MAC2JB_STREMIO_ACCOUNT ')){
        try{
          const watchProgress=JSON.parse(line.slice('MAC2JB_STREMIO_ACCOUNT '.length));
          check(watchProgress&&typeof watchProgress==='object'&&!Array.isArray(watchProgress),
            'Invalid Stremio account progress.');
          safeEmit('account-progress',{watchProgress});
        }catch(error){fail(error);}
        return;
      }
      state.output=(state.output+line+'\n').slice(-32768);
      if(readyText && line.trim()===readyText){state.ready=true;readyResolve();}
      if(line.trim()===selected.frameReady)state.frameReady=true;
      safeEmit('progress',{message:script+': '+line});
    };
    lines(child.stdout,observe);lines(child.stderr,observe);
    state.done=new Promise(resolve=>{
      child.once('error',error=>{state.closed=true;readyReject(error);resolve({code:null,error});});
      child.once('close',(code,signal)=>{
        state.closed=true;state.outcome={code,signal};children.delete(state);
        readyReject(Error(script+' ended before readiness.'));
        if(role!=='prepare'&&!stopping)fail(Error(script+' ended unexpectedly: '+(signal||code)));
        resolve(state.outcome);
      });
    });
    return state;
  }
  async function wait(promise,label,timeoutMs){
    let timer;
    try{return await Promise.race([promise,stopRequested.then(()=>{throw Error(selected.name+' stopped during '+label);}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out.')),
        options.startTimeoutMs||timeoutMs||300000);})]);}
    finally{clearTimeout(timer);}
  }
  async function end(state){
    if(!state||state.closed)return;
    let timer,timedOut=false;
    state.child.kill('SIGTERM');
    const outcome=await Promise.race([state.done,new Promise(resolve=>{
      timer=setTimeout(()=>{timedOut=true;state.child.kill('SIGKILL');resolve({code:null});},options.stopTimeoutMs||90000);
    })]);clearTimeout(timer);
    if(timedOut||outcome.error||outcome.code!==0) {
      cleanupUnsafe=true;
      failure ||= Error(selected.name+' '+state.role+' did not confirm a clean stop. Restart the console.');
    }
    if(timedOut)await state.done;
  }
  let graphics;const activeOwners=new Map();
  try{
    proxy=await (options.serveProxy||serveProxy)({live,request:body=>{
      if(!['status','read','query'].includes(body.command))nativeMutationStarted=true;
      return request(run.directory,body);
    }});
    await fs.mkdir(path.join(directory,'shared'),{mode:0o700});
    const bridgeSource=launcher?path.join(root,'vendor/HBLauncher'):vendor;
    await fs.copyFile(path.join(bridgeSource,'smilebasic/engine/shared/rpc.cjs'),path.join(directory,'shared/rpc.cjs'));
    await fs.chmod(path.join(directory,'shared/rpc.cjs'),0o600);
    await writeJSON(path.join(directory,'connection.json'),{
      port:proxy.port,token:proxy.token,addresses:{...run.connection.addresses,session:report.session}});
    await save();safeEmit('started',{message:'Attaching '+selected.name+' to the existing RPC session.'});
    monitor=setInterval(()=>{if(!live())fail(Error('The original held RPC session ended. Restart the console.'));},500);
    monitor.unref();
    for(const [script,...extra]of stages){
      if(script==='homebrew-launcher/vulkan-copy.cjs')nativeMutationStarted=true;
      safeEmit('progress',{message:'Preparing '+script});
      const state=start(script,extra);const outcome=await wait(state.done,script);
      check(!outcome.error&&outcome.code===0&&!outcome.signal,selected.name+' preparation failed: '+script);
      report.stages.push({script,completed:new Date().toISOString()});await save();
    }
    for(const owner of selected.owners){
      const state=start(owner.script,owner.args,owner.ready,owner.role);
      activeOwners.set(owner.role,state);if(owner.role==='graphics')graphics=state;
      await wait(state.readiness,owner.role+' readiness',owner.timeoutMs);
      report.children.push({role:owner.role,script:owner.script});await save();
    }
    // this second marker proves the console frame worker actually started.
    await wait((async()=>{while(!graphics.frameReady){
      check(!graphics.closed,'The graphics worker ended before its frame loop started.');
      await new Promise(resolve=>setTimeout(resolve,20));
    }})(),'console graphics readiness');
    check(live(),'The original RPC session ended during launcher preparation.');
    running=true;report.status='running';await save();
    safeEmit('running',{message:selected.name+' is running. Keep SmileBASIC and mac2jb open.'});
    await stopRequested;
  }catch(error){failure ||= error;stop();}
  finally{
    clearInterval(monitor);stopping=true;
    // owners finish while graphics and the original rpc remain live.
    for(const role of launcher?['controls','audio','music','graphics']:['ftp','audio','graphics'])
      await end(activeOwners.get(role));
    for(const state of [...children])await end(state);
    if(running){
      try{
        const loop=await json(path.join(directory,'launcher-auto-loop.json'));
        const sound=await json(path.join(directory,'game-audio.json'));
        check(loop.session===report.session&&loop.completed&&!loop.error&&loop.threadRunning===false&&
          sound.session===report.session&&sound.completed&&!sound.error&&!sound.stopError,
        selected.name+' did not verify its graphics and audio shutdown.');
        report.shutdown={graphics:{completed:loop.completed,threadRunning:loop.threadRunning},
          audio:{completed:sound.completed}};
        if(launcher) {
          const music=await json(path.join(directory,'music.json'));
          check(music.session===report.session&&music.uploadVerified===true&&music.ready===true&&
            music.completed&&!music.error&&!music.stopError&&music.playing===false,
            selected.name+' did not verify its music shutdown.');
          report.shutdown.music={completed:music.completed,playing:music.playing};
        }
      }catch(error){failure ||= error;}
    }
    await proxy?.close();
    report.completed=new Date().toISOString();report.status=failure?'failed':'stopped';
    if(failure)report.error=failure.message;await save();
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
    process.stdout.removeListener('error',stdoutError);
    let retrySafe=Boolean(failure&&!nativeMutationStarted&&!cleanupUnsafe&&live());
    if(retrySafe){
      const markerFile=path.join(run.directory,'.mac2jb-hblauncher-attempt.json');
      try{
        const current=await json(markerFile);
        check(JSON.stringify(current)===JSON.stringify(attempt),'The launch attempt marker changed.');
        await fs.unlink(markerFile);
      }catch{retrySafe=false;}
    }
    if(failure)safeEmit('failed',{retrySafe,message:failure.message+(retrySafe?
      ' The held RPC session is still available; choose another app or retry.':
      ' This launch was not retried. Finish RPC and restart the console.')});
    else safeEmit('stopped',{message:selected.name+' stopped. Graphics allocations remain owned by this console session.'});
  }
  if(failure){failure.homebrewReported=true;throw failure;}
  return {directory,stopped:true};
}
module.exports={main,validateRun,proxyHandler,serveProxy,runtimeEnvironment,stageCustomApp,
  stageCustomLauncher,preflightCustomApp,preflightCustomHomebrew,stages,owners,souljaOwners,applicationConfig};
if(require.main===module)main().catch(error=>{
  if(error.homebrewReported){process.exitCode=1;return;}
  try{process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',
    message:error.message+' This launch was not retried. Finish RPC and restart the console.'})+'\n');}catch{}
  process.exitCode=1;
});
