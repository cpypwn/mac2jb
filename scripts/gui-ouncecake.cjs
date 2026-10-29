#!/usr/bin/env node
'use strict';
// OunceCake owns one selected game/FTP attempt inside this app's existing held run.
process.umask(0o077);
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const PIN='e3bcbd229be2229d44f036455adddda921ade3b2';
const NATIVE_SHA='9af1776daae66e5566b9fb52e9017b6b78203e4c93d3b63d7000f0196eb5ff1e';
const check=(value,message)=>{if(!value)throw Error(message);};
const blocked=error=>Boolean(error?.cleanupBlocked||error?.errors?.some(blocked));
async function verifySnapshot(root){
 const vendor=path.join(root,'vendor/OunceCake');
 const provenance=JSON.parse(await fs.readFile(path.join(root,'packaging/OunceCake-provenance.json'),'utf8'));
 check(provenance.commit===PIN&&provenance.nativeImage?.sha256===NATIVE_SHA,'The bundled OunceCake provenance changed.');
 const rows=(await fs.readFile(path.join(root,'packaging/OunceCake-SHA256SUMS'),'utf8')).trim().split('\n');
 const names=new Set();
 for(const row of rows){
  const match=/^([a-f0-9]{64})  (.+)$/.exec(row);
  check(match&&!path.isAbsolute(match[2])&&!match[2].split(/[\\/]/).some(part=>!part||part==='.'||part==='..')&&!names.has(match[2]),'Invalid OunceCake manifest.');
  names.add(match[2]);const file=path.join(vendor,match[2]),info=await fs.lstat(file);
  check(info.isFile()&&!info.isSymbolicLink()&&info.size<=2*1024*1024&&await fs.realpath(file)===file,'Invalid bundled OunceCake source.');
  check(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')===match[1],'Changed bundled OunceCake file: '+match[2]);
 }
 check(names.size===17&&names.has('LICENSE')&&names.has('engine/oz-code/native.bin'),'Incomplete OunceCake snapshot.');
 const upstream=(await fs.readFile(path.join(root,'packaging/OunceCake-upstream-SHA256SUMS'),'utf8')).trim().split('\n');
 check(upstream.length===17&&upstream.includes(NATIVE_SHA+'  engine/oz-code/native.bin'),'Missing pinned OunceCake upstream inventory.');
 const image=await fs.readFile(path.join(vendor,'engine/oz-code/native.bin'));
 check(image.length===10813&&crypto.createHash('sha256').update(image).digest('hex')===NATIVE_SHA,'Changed OunceCake native image.');
 return {vendor,image,ready:true,application:'OunceCake',version:'1.0.0',commit:PIN,files:names.size,nativeImageSha256:NATIVE_SHA};
}
async function privateJSON(file,run){
 check(typeof file==='string'&&path.isAbsolute(file)&&file.startsWith(run+path.sep),'OunceCake proof escaped its held run.');
 const info=await fs.lstat(file);
 check(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o077)===0&&info.size<=8*1024*1024&&await fs.realpath(file)===file,'OunceCake requires private owned proof files.');
 return JSON.parse(await fs.readFile(file,'utf8'));
}
async function validateAttachment(run){
 const directory=run.directory,session=run.proof.session,reportFile=run.proof.reportFile,engine=path.join(directory,'switch2');
 const current=await privateJSON(path.join(engine,'current-acquisition.json'),directory);
 const root=await privateJSON(path.join(engine,'ro/root/current-root.json'),directory);
 const proof=await privateJSON(root.proof,directory),report=await privateJSON(reportFile,directory);
 const layout=await privateJSON(path.join(engine,'ro',session+'-layout.json'),directory);
 const address=value=>Number.isSafeInteger(value)&&value>=2**32&&value<2**39;
 check(current.session===session&&current.report===reportFile&&path.isAbsolute(current.socketPath)&&
  current.socketPath===report.memoryControl?.socketPath&&root.session===session&&root.report===reportFile&&root.pid===1&&
  Number.isSafeInteger(root.rootHandle)&&root.rootHandle>0&&root.rootHandle<0xffff8000&&address(root.rootAddress)&&
  proof.session===session&&proof.report===reportFile&&proof.success===true&&proof.cloneIdentityVerified===true&&!proof.error&&
  proof.rootHandle===root.rootHandle&&proof.rootAddress===root.rootAddress&&layout.session===session&&layout.report===reportFile&&
  Number.isSafeInteger(layout.count)&&layout.count>0&&layout.count<=0x10000&&address(layout.table)&&address(layout.rootVptr),
 'OunceCake requires this session’s verified promoted FS root and matching retained endpoint.');
 return {current,root,proof,layout};
}
function validateConfiguration(value){
 check(value&&typeof value==='object'&&!Array.isArray(value)&&net.isIPv4(value.consoleAddress)&&value.port===2121,'Enter the console’s IPv4 address and FTP port2121.');
 return {consoleAddress:value.consoleAddress,port:2121};
}
function catalogEntries(games){
 check(Array.isArray(games)&&games.length<=1000,'OunceCake requires a bounded game catalog.');
 check(games.length>0,'No games were found. Check that the game is installed or its game card is inserted.');
 const ids=new Set();
 const output=games.map(game=>{
  check(game&&/^[0-9a-f]{16}$/.test(game.title)&&!ids.has(game.title)&&Array.isArray(game.storages)&&game.storages.length>0&&
   game.storages.every(id=>[2,4,5].includes(id)),'OunceCake returned invalid game metadata.');
  ids.add(game.title);let name='';
  for(const char of String(game.name||'Unknown title').replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g,' ').trim()){
   if(Buffer.byteLength(name+char)>160)break;name+=char;
  }
  return {titleId:game.title,name:name||'Unknown title',storages:[...new Set(game.storages)]};
 });
 check(Buffer.byteLength(JSON.stringify(output))<=512*1024,'OunceCake game catalog is too large.');return output;
}
async function main(args=process.argv.slice(2),options={}){
 const root=options.root||path.resolve(__dirname,'..');
 const snapshot=await (options.verifySnapshot||verifySnapshot)(root);
 const label=snapshot.application||'OunceCake';
 if(args.length===1&&args[0]==='--self-test'){
  for(const name of ['session','content','mounts','ftp'])require(path.join(snapshot.vendor,'engine',name+'.cjs'));
  const {vendor,image,...result}=snapshot;process.stdout.write(JSON.stringify(result)+'\n');return result;
 }
 check(args.length===1,'Usage: gui-ouncecake.cjs RUN_DIRECTORY (configuration and game selection on stdin)');
 const input=options.input||process.stdin,output=options.emit||((type,fields)=>process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type,...fields})+'\n'));
 let stopping=false,cleanupBlocked=false,failure,attachment,server,directory,report,waiting=false,selected=false,outputClosed=false;
 let configurationResolve,configurationReject,selectionResolve,stopResolve,monitor;
 const configured=new Promise((resolve,reject)=>{configurationResolve=resolve;configurationReject=reject;});
 const selection=new Promise(resolve=>{selectionResolve=resolve;}),stopped=new Promise(resolve=>{stopResolve=resolve;});
 const titles=new Set();let pending='',configDone=false;
 function emit(type,fields={}){if(outputClosed)return;try{output(type,{path:directory,...fields});}catch(error){outputClosed=true;stop();}}
 function stop(){stopping=true;stopResolve();selectionResolve(null);if(!configDone)configurationReject(Error('OunceCake configuration stopped.'));}
 function line(text){
  let value;try{check(Buffer.byteLength(text)<=8192,'OunceCake control line is too large.');value=JSON.parse(text);check(value&&typeof value==='object'&&!Array.isArray(value),'Invalid OunceCake action.');}
  catch(error){if(!configDone)configurationReject(error);else emit('progress',{message:'Invalid OunceCake action was ignored.'});return;}
  if(!configDone){try{const config=validateConfiguration(value);configDone=true;configurationResolve(config);}catch(error){configurationReject(error);}return;}
  if(value.action==='select-game'&&waiting&&!selected&&titles.has(value.titleId)){
   selected=true;waiting=false;selectionResolve(value.titleId);
  }else emit('progress',{message:'Choose one game from the current catalog; this session cannot launch again.'});
 }
 const data=bytes=>{pending+=bytes;let at;while((at=pending.indexOf('\n'))>=0){const item=pending.slice(0,at);pending=pending.slice(at+1);line(item);}if(Buffer.byteLength(pending)>8192){pending='';stop();}};
 const ended=()=>stop(),pipeError=()=>{outputClosed=true;stop();};
 input.setEncoding('utf8');input.on('data',data);input.once('end',ended);input.resume();
 process.on('SIGTERM',stop);process.on('SIGINT',stop);process.stdout.on('error',pipeError);
 const configurationTimer=setTimeout(()=>configurationReject(Error('OunceCake configuration did not arrive.')),5000);configurationTimer.unref();
 const save=async()=>{if(directory)await fs.writeFile(path.join(directory,'ouncecake-session.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});};
 let run,isLive;
 try{
  const config=await configured;clearTimeout(configurationTimer);
  const validate=options.validateRun||((root,candidate)=>require('./gui-homebrew.cjs').validateRun(root,candidate,require('./gui-dump.cjs').verifiedSession));
  run=await validate(root,args[0]);await (options.validateAttachment||validateAttachment)(run);
  const parent=path.join(root,'runs');await fs.mkdir(parent,{recursive:true,mode:0o700});
  const info=await fs.lstat(parent);check(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o077)===0,'OunceCake output must be a private owned directory.');
  directory=await fs.mkdtemp(path.join(await fs.realpath(parent),'ouncecake-'));
  report={session:path.basename(directory),sourceSession:run.proof.session,
   application:label,version:snapshot.version||'local',commit:snapshot.commit||null,
   customPackageFingerprint:snapshot.customPackageFingerprint||null,
   nativeImageSha256:snapshot.nativeImageSha256,status:'preparing',
   started:new Date().toISOString(),consoleAddress:config.consoleAddress,port:2121};await save();
  isLive=options.isLive||(()=>{try{const value=JSON.parse(sync.readFileSync(path.join(run.directory,'result.json'),'utf8'));return value.verified===true&&value.rpc?.mode==='held'&&value.rpc?.state==='listening'&&!value.error;}catch{return false;}});
  check(isLive(),'The original held session is no longer live.');
  const marker=JSON.stringify({application:label,started:report.started});
  // Share the existing one-application marker with the GPU launcher and Stremio.
  await fs.writeFile(path.join(run.directory,'.mac2jb-hblauncher-attempt.json'),marker,{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(run.directory,'.mac2jb-ouncecake-attempt.json'),marker,{flag:'wx',mode:0o600});
  const modules=options.modules||Object.fromEntries(['session','content','mounts','ftp'].map(name=>[name,require(path.join(snapshot.vendor,'engine',name+'.cjs'))]));
  emit('started',{message:'Preparing '+label+' game export. Keep SmileBASIC and mac2jb open.'});
  monitor=setInterval(()=>{if(!isLive())stop();},1000);monitor.unref();
  try{attachment=await modules.session.attachGame(run.directory);}
  catch(error){error.cleanupBlocked=true;throw error;}
  check(attachment.live.session===run.proof.session,'OunceCake attached to a different native session.');
  if(!stopping){
   emit('progress',{message:'Reading installed games.'});
   const games=catalogEntries(await modules.content.discoverGames({...attachment,shouldStop:()=>stopping}));
   if(!stopping){games.forEach(game=>titles.add(game.titleId));waiting=true;report.status='choosing';await save();emit('catalog',{games,message:'Choose the game to expose through read-only FTP.'});}
   const title=stopping?null:await selection;
   if(title&&!stopping){
    report.titleId=title;report.status='mounting';await save();emit('progress',{message:'Preparing the selected game, updates and DLC. This can take several minutes.'});
    let prepared;try{prepared=await modules.mounts.prepareGame({attachment,title,shouldStop:()=>stopping});}
    catch(error){error.cleanupBlocked=true;throw error;}
    if(!stopping){
     server=await modules.ftp.deployFtp({attachment,image:snapshot.image,...prepared,port:2121});
     check(!stopping&&isLive(),'The original held session ended during FTP startup.');
     report.status='running';await save();emit('running',{host:config.consoleAddress,port:2121,ftpURL:'ftp://'+config.consoleAddress+':2121',message:'OunceCake read-only FTP is running. Use Binary/Image mode.'});
     await stopped;
    }
   }
  }
 }catch(error){failure=error;cleanupBlocked=blocked(error);}
 finally{
  clearTimeout(configurationTimer);clearInterval(monitor);waiting=false;
  if(server&&!cleanupBlocked){try{check(isLive(),'The held native session ended before FTP cleanup.');report.shutdown=await server.close();check(report.shutdown?.nativeStopped===true&&report.shutdown?.joined===true&&report.shutdown?.mappingsCleared===true,'OunceCake did not prove native cleanup.');}
   catch(error){failure ||= error;cleanupBlocked=true;}}
  if(attachment&&!cleanupBlocked){try{await attachment.close();check(attachment.s.base===0&&attachment.s.handles.size===0&&attachment.s.threads.size===0,'OunceCake attachment cleanup was deferred.');}
   catch(error){failure ||= error;cleanupBlocked=true;}}
  if(report){report.status=cleanupBlocked?'cleanup-blocked':failure?'failed':'stopped';report.completed=new Date().toISOString();report.cleanupBlocked=cleanupBlocked;if(failure)report.error=failure.message;
   try{await save();}catch(error){failure ||= error;}}
  if(cleanupBlocked){
   emit('failed',{cleanupBlocked:true,message:label+' could not verify native shutdown or restoration. RPC and resources remain held. Restart the console before closing this session.'});
   // Signals/EOF cannot make uncertain native resources safe to free. The parent
   // retains the original RPC and terminates this helper after console disconnect.
   if(options.waitBlocked)await options.waitBlocked();
   else await new Promise(resolve=>{const timer=setInterval(()=>{if(!isLive||!isLive()){clearInterval(timer);resolve();}},1000);});
  }else if(failure)emit('failed',{cleanupBlocked:false,message:failure.message+' This launch was not retried. Finish RPC and restart the console.'});
  else emit('stopped',{message:label+' native FTP stopped, executable mappings removed and owned handles released.'});
  input.removeListener('data',data);input.removeListener('end',ended);input.pause();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);process.stdout.removeListener('error',pipeError);
 }
 if(failure||cleanupBlocked){const error=failure||Error('OunceCake cleanup was blocked.');error.homebrewReported=true;error.cleanupBlocked=cleanupBlocked;throw error;}
 return {directory,stopped:true};
}
module.exports={main,verifySnapshot,validateAttachment,validateConfiguration,catalogEntries,blocked};
if(require.main===module)main().catch(error=>{if(!error.homebrewReported){if(process.argv[2]==='--self-test')console.error(error.message);else try{process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',cleanupBlocked:blocked(error),message:error.message+' This launch was not retried.'})+'\n');}catch{}}process.exitCode=1;});
