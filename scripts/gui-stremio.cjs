#!/usr/bin/env node
'use strict';
// Private, one-shot GPU media client attached to the already held Kurumuz run.
process.umask(0o077);
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {validateRun,serveProxy,runtimeEnvironment,stages}=require('./gui-homebrew.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{if(!value)throw Error(message);};
function configureRuntime(root){
 const env=runtimeEnvironment(root);
 // GPU package validation runs in this process; stage-child environments alone
 // do not reach app-catalog's Python and spirv-val subprocesses.
 delete process.env.PYTHONHOME;
 Object.assign(process.env,env);
 return env;
}
async function checkRuntime(root=path.resolve(__dirname,'..')){
 const env=configureRuntime(root),python=path.join(root,'homebrew/python/bin/python3');
 try{
  const {constants}=require('node:fs');
  await fs.access(env.SPIRV_VAL,constants.X_OK);
  await fs.access(python,constants.X_OK);
  await fs.access(env.MAC2JB_HBLAUNCHER_FONT,constants.R_OK);
  await fs.access(path.join(env.PYTHONPATH,'sitecustomize.py'),constants.R_OK);
 }catch{throw Error('The app is missing a bundled Stremio tool. Extract a fresh copy of the test build.');}
 const app=await require(path.join(root,'vendor/GPUBrewLauncher/homebrew-launcher/app-catalog.cjs'))
  .readApp(path.join(root,'stremio/app'));
 check(app.id==='stremio-experimental'&&app.files.memory?.allocationBytes===require('../stremio/protocol.cjs').MEMORY_BYTES,
  'The bundled Stremio display package is invalid.');
 return {ready:true,python,spirvVal:env.SPIRV_VAL,pythonPath:env.PYTHONPATH,
  font:env.MAC2JB_HBLAUNCHER_FONT,appId:app.id,memoryBytes:app.files.memory.allocationBytes};
}
async function configuration(input=process.stdin){
 return new Promise((resolve,reject)=>{
  let bytes='';input.setEncoding('utf8');const timer=setTimeout(()=>finish(Error('The Stremio configuration did not arrive.')),5000);
  function finish(error,value){clearTimeout(timer);input.removeListener('data',data);input.removeListener('end',end);input.pause();error?reject(error):resolve(value);}
  function data(chunk){bytes+=chunk.toString();if(Buffer.byteLength(bytes)>4*1024*1024)return finish(Error('The player configuration is too large.'));
   if(bytes.includes('\n'))try{const value=JSON.parse(bytes.split('\n')[0]);check(value&&typeof value==='object'&&!Array.isArray(value),'Invalid player configuration');finish(null,value);}catch{finish(Error('Invalid player configuration'));}}
  function end(){if(bytes.trim())finish(Error('The player configuration was incomplete.'));else finish(null,{});}input.on('data',data);input.once('end',end);input.resume();
 });
}
function playerConfiguration(config){
 check(config&&typeof config==='object'&&!Array.isArray(config),'Invalid player configuration');
 check(config.addonUrls===undefined||Array.isArray(config.addonUrls)&&config.addonUrls.length<=32,'Invalid add-on configuration');
 check(config.libraryItems===undefined||Array.isArray(config.libraryItems)&&config.libraryItems.length<=500&&
  config.libraryItems.every(item=>item&&typeof item==='object'&&!Array.isArray(item)),'Invalid library configuration');
 const {manifestURL}=require('../stremio/addons.cjs');
 return {addonUrls:(config.addonUrls||[]).map(value=>manifestURL(value).href),libraryItems:config.libraryItems||[]};
}
function createShutdown({getGraphics,onFailure,isStopping=()=>false}){
 let abortTask;
 function record(error,native=false){
  if(isStopping()&&!native&&error.cleanupBlocked!==true&&error.code==='STREMIO_RECEIVER_CANCELLED')return;
  onFailure(error,native);
 }
 function abort(){
  const graphics=getGraphics();
  if(!abortTask&&graphics?.abortPending)
   abortTask=Promise.resolve().then(()=>graphics.abortPending()).catch(error=>record(error));
  return abortTask;
 }
 return {abort,record,async close({pipeline,audio}){
  // Interrupt a pending media ACK before pipeline.close waits for its decoder/display callbacks.
  abort();
  for(const [owner,native] of [[pipeline,false],[audio,true],[getGraphics(),false]])
   if(owner)try{await owner.close();}catch(error){record(error,native);}
  await abortTask;
 }};
}
async function main(args=process.argv.slice(2),options={}){
 const root=options.root||path.resolve(__dirname,'..');
 if(args.length===1&&args[0]==='--check-runtime'){
  const result=await checkRuntime(root);process.stdout.write(JSON.stringify(result)+'\n');return result;
 }
 check(args.length===1||(args.length===3&&args[1]==='--quality'),'Usage: gui-stremio.cjs RUN_DIRECTORY [--quality 720p|540p|360p|180p] (configuration on stdin)');
 const quality=require('../stremio/quality.cjs').qualityProfile(args.length===3?args[2]:undefined).id;
 const config=options.config||await configuration();
 const {addonUrls,libraryItems}=playerConfiguration(config);
 await checkRuntime(root);
 await require('../stremio/decoder.cjs').tools();
 const run=await validateRun(root,args[0],require('./gui-dump.cjs').verifiedSession);
 const originalRequest=require(path.join(root,'vendor/ns2jb/rpc.cjs')).request;
 check((await originalRequest(run.directory,{command:'status'})).ready,'The original held RPC is no longer ready.');
 await fs.writeFile(path.join(run.directory,'.mac2jb-hblauncher-attempt.json'),JSON.stringify({application:'Stremio',started:new Date().toISOString()}),{flag:'wx',mode:0o600});
 const parent=path.join(root,'runs');await fs.mkdir(parent,{recursive:true,mode:0o700});
 const directory=await fs.mkdtemp(path.join(await fs.realpath(parent),'stremio-'));
 const report={session:path.basename(directory),sourceSession:run.proof.session,started:new Date().toISOString(),status:'preparing',resourcesRetained:true,stages:[],media:{}};
 const save=()=>fs.writeFile(path.join(directory,'stremio-session.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 let stopping=false,failure,proxy,child,graphics,audio,pipeline,monitor,stopResolve,cleanupBlocked=false;
 const stopPromise=new Promise(resolve=>{stopResolve=resolve;});
 function remember(error,native=false){failure ||= error;cleanupBlocked ||= native||error.cleanupBlocked===true;}
 const shutdown=createShutdown({getGraphics:()=>graphics,onFailure:remember,isStopping:()=>stopping});
 const emit=(type,fields={})=>{try{process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type,path:directory,...fields})+'\n');}catch{stop();}};
 function stop(){if(!stopping){stopping=true;stopResolve();}shutdown.abort();}
 function fatal(error){shutdown.record(error);stop();}
 function live(){try{const value=JSON.parse(require('node:fs').readFileSync(path.join(run.directory,'result.json'),'utf8'));return value.verified===true&&value.rpc?.mode==='held'&&value.rpc?.state==='listening'&&!value.error;}catch{return false;}}
 const pipeError=error=>{if(error.code!=='EPIPE')failure ||= error;stop();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);process.stdout.on('error',pipeError);
 async function stage(script,extra){
  check(!stopping,'Player preparation stopped');emit('progress',{message:'Preparing the player display: '+path.basename(script)});
  child=spawn(process.execPath,[path.join(root,'vendor/GPUBrewLauncher',script),directory,...extra],{cwd:path.join(root,'vendor/GPUBrewLauncher'),env:runtimeEnvironment(root),stdio:['ignore','pipe','pipe']});
  const current=child;let pending='';for(const stream of [current.stdout,current.stderr])stream.on('data',bytes=>{
   pending=(pending+bytes.toString()).slice(-16384);let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line)emit('progress',{message:line.slice(0,2048)});}
  });
  let timer;const abort=()=>{if(child===current)current.kill('SIGTERM');};
  const cancelled=stopPromise.then(abort);
  const result=await new Promise(resolve=>{timer=setTimeout(()=>{current.kill('SIGKILL');resolve({code:null});},300000);current.once('error',error=>resolve({error}));current.once('close',(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer);child=undefined;
  check(!result.error&&result.code===0&&!result.signal&&!stopping,'Player display preparation did not complete. Restart the console.');
  report.stages.push(script);await save();
 }
 try{
  proxy=await serveProxy({live,request:body=>originalRequest(run.directory,body)});
  await fs.mkdir(path.join(directory,'shared'),{mode:0o700});
  await fs.copyFile(path.join(root,'vendor/GPUBrewLauncher/smilebasic/engine/shared/rpc.cjs'),path.join(directory,'shared/rpc.cjs'));
  await fs.chmod(path.join(directory,'shared/rpc.cjs'),0o600);
  await fs.writeFile(path.join(directory,'connection.json'),JSON.stringify({port:proxy.port,token:proxy.token,addresses:{...run.connection.addresses,session:report.session}}),{mode:0o600});
  await save();emit('started',{message:'Preparing the Mac-assisted Stremio player.'});
  monitor=setInterval(()=>{if(!live())fatal(Error('The original held RPC ended. Restart the console.'));},1000);monitor.unref();
  for(const [script,...extra]of stages)await stage(script,extra);
  const rpc=require(path.join(directory,'shared/rpc.cjs'));
  graphics=await require('../stremio/graphics.cjs').create({rpc,directory,appDirectory:path.join(root,'stremio/app')});
  check(!stopping,'Player preparation stopped.');
  audio=await require('../stremio/audio.cjs').create({rpc,directory});
  check(!stopping,'Player preparation stopped.');
  const sourcePreferences=options.sourcePreferences||await require('../stremio/source-preferences.cjs').SourcePreferences.load(
   path.join(os.homedir(),'Library','Application Support','mac2jb','stremio-last-sources.json'));
 pipeline=await require('../stremio/pipeline.cjs').create({graphics,audio,addonUrls,libraryItems,sourcePreferences,directory,root,quality,onFatal:fatal,
   onProgress:message=>emit('progress',{message}),onAccountProgress:watchProgress=>emit('account-progress',{watchProgress})});
  check(!stopping&&live(),'The held session ended during player preparation.');
  report.status='running';report.quality=quality;await save();emit('running',{message:'Stremio ready at '+quality+'. Use the left stick or D-pad to browse. X or + opens playback controls. Keep this Mac and SmileBASIC open.'});
  await stopPromise;
 }catch(error){shutdown.record(error);stop();}
 finally{
  clearInterval(monitor);stopping=true;
  if(child)child.kill('SIGTERM');
  await shutdown.close({pipeline,audio});
  try{await proxy?.close();}catch(error){failure ||= error;}
  report.status=failure?'failed':'stopped';report.completed=new Date().toISOString();report.cleanupBlocked=cleanupBlocked;if(failure)report.error=failure.message;await save();
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  if(failure)emit('failed',{cleanupBlocked,message:failure.message+' No native request was retried. '+(cleanupBlocked?'Restart the console before releasing retained resources.':'Finish session and restart the console.')});
  else emit('stopped',{message:'The player stopped. Restart the console to release retained graphics allocations.'});
 }
 if(failure){failure.homebrewReported=true;failure.cleanupBlocked=cleanupBlocked;throw failure;}
}
module.exports={main,configuration,playerConfiguration,configureRuntime,checkRuntime,createShutdown};
if(require.main===module)main().catch(error=>{
 if(process.argv[2]==='--check-runtime'){console.error(error.message);process.exitCode=1;return;}
 if(!error.homebrewReported)try{process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',message:error.message+' Finish session and restart the console.'})+'\n');}catch{}
 process.exitCode=1;
});
