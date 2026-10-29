const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const protocol=require('./protocol.cjs');
const layout=require('../../vendor/MintBrew/sdk/host/layout.cjs');
const runFile=promisify(execFile);
const check=(value,message)=>{if(!value)throw Error(message);};
const blocked=error=>Boolean(error?.cleanupBlocked||error?.errors?.some(blocked));
const recoverableContentError=error=>!blocked(error)&&!(error instanceof AggregateError)&&
 error?.code!=='FTP_CANCELLED'&&Boolean(error?.nativeResult||
  /^(Invalid RomFS:|Invalid FTP index:|Could not prepare |No installed base Program content was found|Content requires an original-content mount)/.test(error?.message||''));

function ipv4(data){
 check(Buffer.isBuffer(data)&&data.length>=layout.FIELD.network+24,
  'Switch network status was truncated');
 check(data.readUInt32LE(layout.FIELD.magic)===layout.MAGIC&&
  data.readUInt32LE(layout.FIELD.version)===layout.VERSION&&
  (data.readUInt32LE(layout.FIELD.flags)&layout.FLAGS.network)!==0&&
  data.readUInt32LE(layout.FIELD.network)===0,
  'The Switch does not have a ready IPv4 connection');
 const address=[...data.subarray(layout.FIELD.network+20,layout.FIELD.network+24)].join('.');
 check(net.isIPv4(address)&&!address.startsWith('127.')&&
  !address.startsWith('0.')&&Number(address.split('.')[0])<224,
  'The Switch reported an unusable IPv4 address');
 return address;
}

function create({rpc,menu,gpu,app,directory,root,runDirectory,sourceSession,
 onProgress=()=>{},onFatal=()=>{},onGameList=async()=>{},modules,verifyHeld,rasterGames,liveCheck}={}){
 check(rpc&&menu&&gpu&&app&&typeof directory==='string'&&typeof root==='string'&&
  typeof runDirectory==='string'&&typeof sourceSession==='string',
  'OunceCake requires the held MintBrew session');
 check(app.id==='ouncecake'&&app.manifest?.service==='ouncecake-v1'&&
  app.fingerprint===gpu.fingerprint&&gpu.privateStorage?.bytes===protocol.STORAGE_BYTES&&
  Number.isSafeInteger(gpu.privateStorage.mapped)&&gpu.privateStorage.mapped>0,
  'OunceCake app identity or private storage differs');
 const mapped=gpu.privateStorage.mapped;
 const vendor=path.join(root,'vendor/OunceCake');
 const engine=modules||{
  session:require(path.join(vendor,'engine/session.cjs')),
  content:require(path.join(vendor,'engine/content.cjs')),
  mounts:require(path.join(vendor,'engine/mounts.cjs')),
  ftp:require(path.join(vendor,'engine/ftp.cjs')),
 };
 let started=false,stopping=false,selected=false,status=protocol.STATES.reading;
 let task,attachment,server,run,games=[],failure,closing,nativeImage,baselineHandles;
 const report={session:rpc.a.session,sourceSession,started:new Date().toISOString(),status:'reading',
  resourcesRetained:true};
 const save=()=>fs.writeFile(path.join(directory,'mintbrew-ouncecake.json'),
  JSON.stringify(report,null,2)+'\n',{mode:0o600});
 const publish=async(state,message='',count=games.length)=>{
  status=state;report.status=Object.keys(protocol.STATES).find(key=>protocol.STATES[key]===state);
  await rpc.write(mapped,protocol.header(state,count,message));await save();
 };
 const live=liveCheck||(async()=>{
  try{
   const current=JSON.parse(await fs.readFile(path.join(runDirectory,'result.json'),'utf8'));
   return current.verified===true&&!current.error&&current.rpc?.mode==='held'&&
    current.rpc?.state==='listening'&&current.fs?.verified===true&&
    current.fs?.restored===true&&current.fs?.retainedEndpoint?.ready===true;
  }catch{return false;}
 });
 const fail=async(error)=>{
  if(server&&!await live())error.cleanupBlocked=true;
  failure ||= error;report.error=error.message;report.cleanupBlocked ||= blocked(error);
  if(!report.cleanupBlocked){
   try{await publish(protocol.STATES.error,error.message);}catch(writeError){failure=writeError;report.cleanupBlocked=true;}
  }
  onProgress('OunceCake: '+error.message);
  if(report.cleanupBlocked)onFatal(failure);
  await save().catch(()=>{});
 };
 const track=operation=>{
  task=operation.catch(async error=>{
   try{await fail(error);}catch(handlerError){
    handlerError.cleanupBlocked=true;failure=handlerError;report.cleanupBlocked=true;
    try{onFatal(handlerError);}catch{}await save().catch(()=>{});
   }
  });
 };
 async function resumeTitleFtp(){
  if(stopping)return;
  try{await onGameList();}catch(error){onProgress('MintFTP: '+error.message);}
 }
 async function stopServer(){
  if(server){
   try{
    check(await live(),'OunceCake lost its held session before FTP shutdown');
    const proof=await server.close();
    check(proof?.nativeStopped===true&&proof?.joined===true&&proof?.mappingsCleared===true,
     'OunceCake could not prove native FTP shutdown');
    (report.shutdowns ||= []).push(proof);server=null;
   }catch(error){error.cleanupBlocked=true;report.cleanupBlocked=true;failure=error;await save();throw error;}
  }
 }
 async function releaseSelectedHandles(){
  check(attachment&&baselineHandles,'OunceCake game attachment is unavailable');
  try{
   check(!server,'OunceCake FTP must stop before game handles close');
   check(attachment.s.threads.size===0,'OunceCake game worker did not stop');
   for(const handle of [...attachment.s.handles].reverse()){
    if(!baselineHandles.has(handle))await attachment.s.close(handle);
   }
   check([...attachment.s.handles].every(handle=>baselineHandles.has(handle)),
    'OunceCake selected-game handles remain open');
  }catch(error){error.cleanupBlocked=true;report.cleanupBlocked=true;failure=error;await save();throw error;}
 }
 async function releaseGameOwned(){
  await stopServer();
  await releaseSelectedHandles();
 }
 async function releaseOwned(){
  await stopServer();
  if(attachment){
   try{
    await attachment.close();
    check(attachment.s.base===0&&attachment.s.handles.size===0&&attachment.s.threads.size===0,
     'OunceCake attachment cleanup was deferred');
    attachment=null;
   }catch(error){error.cleanupBlocked=true;report.cleanupBlocked=true;failure=error;await save();throw error;}
  }
 }
 async function verify(){
  if(verifyHeld){const result=await verifyHeld();run=result.run;
   check(run?.proof?.session===sourceSession&&run?.connection?.addresses?.session===sourceSession,
    'OunceCake test session identity changed');return result.snapshot;}
  const expected=path.join(root,'vendor/MintBrew/apps/ouncecake');
  check(await fs.realpath(app.root)===await fs.realpath(expected),
   'OunceCake service cannot run from a custom app folder');
  require('./prepare.cjs').verifyMintBrew(root,path.join(root,'vendor/MintBrew'));
  const snapshot=await require(path.join(root,'scripts/gui-ouncecake.cjs')).verifySnapshot(root);
  const validate=require(path.join(root,'scripts/gui-homebrew.cjs')).validateRun;
  run=await validate(root,runDirectory,require(path.join(root,'scripts/gui-dump.cjs')).verifiedSession);
  check(run.proof.session===sourceSession&&run.connection.addresses.session===sourceSession,
   'OunceCake held session identity changed');
  await require(path.join(root,'scripts/gui-ouncecake.cjs')).validateAttachment(run);
  check(await live(),'OunceCake requires a live held RPC session');
  return snapshot;
 }
 async function discover(){
  const snapshot=await verify();
  nativeImage=snapshot.image;
  if(stopping)return;
  attachment=await engine.session.attachGame(run.directory);
  check(attachment.live.session===sourceSession,'OunceCake attached to another session');
  if(stopping)return;
  onProgress('OunceCake: reading installed games');
  games=require(path.join(root,'scripts/gui-ouncecake.cjs')).catalogEntries(
   await engine.content.discoverGames({...attachment,shouldStop:()=>stopping}));
  if(stopping)return;
  check(games.length<=protocol.MAX_GAMES,'OunceCake game list exceeds its display capacity');
  check(attachment.s.threads.size===0,'OunceCake discovery left a native worker running');
  baselineHandles=new Set(attachment.s.handles);
  if(stopping)return;
  let image;
  if(rasterGames)image=await rasterGames(games);
  else{
   const input=path.join(directory,'ouncecake-games.json');
   const output=path.join(directory,'ouncecake-games.bin');
   await fs.writeFile(input,JSON.stringify(games),{flag:'wx',mode:0o600});
   await runFile('python3',[path.join(__dirname,'raster.py'),input,output],
    {timeout:60000,maxBuffer:65536});
   image=await fs.readFile(output);
  }
  check(image.length===games.length*protocol.TILE_BYTES&&
   protocol.HEADER_BYTES+image.length<=protocol.STORAGE_BYTES,
   'OunceCake game raster size differs');
  if(stopping)return;
  await rpc.write(mapped+protocol.HEADER_BYTES,image);
  report.games=games.length;report.imageSha256=require('node:crypto').createHash('sha256').update(image).digest('hex');
  await publish(protocol.STATES.catalog,'',games.length);
  onProgress('OunceCake: choose a game on the Switch');
  report.nativeImageSha256=snapshot.nativeImageSha256;await save();
 }
 function start(){
  check(!started&&!stopping,'OunceCake has already started');started=true;
  track(discover());
  return Promise.resolve();
 }
 async function select(index){
  check(started&&!stopping&&!selected&&status===protocol.STATES.catalog&&
   Number.isInteger(index)&&index>=0&&index<games.length,
   'OunceCake game selection is unavailable');
  selected=true;report.titleId=games[index].titleId;delete report.error;
  await publish(protocol.STATES.preparing,'Preparing '+games[index].name);
  const previous=task;
  track((async()=>{
   await previous;
   if(stopping)return;
   check(await live(),'The held RPC session ended before game preparation');
   const network=await rpc.read(menu.controls.mapped+layout.OFFSET,
    layout.FIELD.network+24);
   const address=ipv4(network);
   check(Buffer.isBuffer(nativeImage)&&nativeImage.length>0,'OunceCake native image is unavailable');
   check(attachment&&baselineHandles,'OunceCake game attachment is unavailable');
   if(stopping)return;
   let prepared;
   try{prepared=await engine.mounts.prepareGame({attachment,title:games[index].titleId,
    shouldStop:()=>stopping});}
   catch(error){
    if(stopping&&error.code==='FTP_CANCELLED'){
     if(server||!attachment||attachment.s.threads.size!==0){
      const unsafe=Error('OunceCake cancellation left a native worker active');
      unsafe.cleanupBlocked=true;throw unsafe;
     }
     return;
    }
    if(recoverableContentError(error)&&!server&&attachment&&attachment.s.threads.size===0){
     await releaseSelectedHandles();
     if(stopping)return;
     selected=false;report.titleId=null;report.error=error.message;
     await publish(protocol.STATES.catalog,error.message,games.length);
     await resumeTitleFtp();
     onProgress('OunceCake: '+error.message);
     return;
    }
    error.cleanupBlocked=true;throw error;
   }
   if(stopping)return;
   check(await live(),'The held RPC session ended before FTP deployment');
   server=await engine.ftp.deployFtp({attachment,image:nativeImage,...prepared,port:2121});
   if(stopping)return;
   check(await live(),'The held RPC session ended during FTP startup');
   report.ftpURL='ftp://'+address+':2121';
   await publish(protocol.STATES.running,'FTP://'+address+':2121');
   onProgress('OunceCake: '+report.ftpURL);
  })());
 }
 async function back(){
  check(started&&!stopping&&selected&&status===protocol.STATES.running,
   'OunceCake FTP is not running');
  await publish(protocol.STATES.closing,'Stopping the read-only FTP worker...');
  const previous=task;
  track((async()=>{
   await previous;
   await releaseGameOwned();
   if(stopping)return;
   selected=false;report.titleId=null;report.ftpURL=null;
   await publish(protocol.STATES.catalog,'',games.length);
   await resumeTitleFtp();
   onProgress('OunceCake: choose another game on the Switch');
  })());
 }
 function close(){
  if(closing)return closing;
  closing=(async()=>{
   stopping=true;
   await task;
   if(report.cleanupBlocked)throw failure||Object.assign(Error('OunceCake native cleanup is uncertain'),{cleanupBlocked:true});
   await releaseOwned();
   report.status='stopped';report.completed=new Date().toISOString();await save();
  })();
  return closing;
 }
 return {start,select,back,close,get report(){return {...report};}};
}
module.exports={create,ipv4};
