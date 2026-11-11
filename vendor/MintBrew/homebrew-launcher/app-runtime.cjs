const fs=require('node:fs/promises'),path=require('node:path');
const catalogTools=require('./app-catalog.cjs');
const {prepare}=require('./gpu-app.cjs');
const {synth}=require('./game-audio.cjs');
const check=(v,m)=>{if(!v)throw Error(m);};
const MINTFTP_GAME_REQUEST=0x4d465447;
async function atomic(file,value){const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2));await fs.rename(temp,file);}
async function dispatchServiceRequest(rpc,mapped,service,request){
 if(!request||typeof service?.select!=='function')return false;
 await rpc.write(mapped+1012,Buffer.alloc(4));
 if(request===0xffffffff){
  check(typeof service.back==='function','App cannot close an active connection');
  await service.back();
 }else await service.select(request-1);
 return true;
}
async function create({rpc,menu,directory,root=path.resolve(__dirname,'../../..'),config={},
 onProgress=()=>{},onAccountProgress=()=>{},onFatal=()=>{},prepareApp=prepare,createOunceCake,createMintFtp,createMintNes}){
 const mapped=menu.controls.mapped,cache=new Map();let generation=0,refreshSeen=0,menuState=await rpc.read(mapped,1024);
 let catalog,menuData,retainedFtp=null;const runtime={active:null,report:{session:rpc.a.session,started:new Date().toISOString(),transitions:[],generation:0,resourcesRetained:true}};
 const save=()=>atomic(path.join(directory,'app-runtime.json'),runtime.report);
 async function audio(app,gpu){
  let effects={};
  if(!app||app.id==='stremio-experimental'){
   const style=app?'stremio':'mintbrew';
   const tick=path.join(directory,style+'-navigation-tick.pcm');
   await fs.writeFile(tick,synth(8,style));effects[8]=tick;
  }
  if(app){
   const folder=path.join(directory,'loaded-apps',app.id+'-'+app.fingerprint.slice(0,16));await fs.mkdir(folder,{recursive:true});
   for(const [id,bytes]of Object.entries(app.effectData)){const out=path.join(folder,id+'.pcm');await fs.writeFile(out,bytes);effects[id]=out;}
  }
  const nes=app?.id==='mintnes'&&gpu?.privateStorage?
   require(path.join(root,'vendor/MintBrew/apps/mintnes/layout.cjs')):null;
  await atomic(path.join(directory,'game-audio-source.json'),{session:rpc.a.session,mapped,
   package:app?{id:app.id,fingerprint:app.fingerprint,effects}:{id:'mintbrew-menu',fingerprint:'mintbrew-menu-tick-v1',effects},
   ...(nes?{apuMapped:gpu.privateStorage.mapped+nes.apuBase*4,
    apuBytes:(nes.apuFrame-nes.apuBase+1)*4,
    apuEventsMapped:gpu.privateStorage.mapped+nes.apuEventBase*4,
    apuEventsBytes:nes.apuEventCount*3*4}:{}),
   ...(retainedFtp?{ftpOwner:{id:retainedFtp.id,fingerprint:retainedFtp.fingerprint}}:{})});
 }
 async function rescan(state,upload=true){
  const selected=catalog?.apps[state.readUInt32LE(80)]?.id;
  const next=await catalogTools.scan(menu.catalog.root),bytes=await catalogTools.raster(next,directory,'catalog-'+(++generation));
  const font=await fs.readFile(path.join(__dirname,'shaders/launcher-text.bin'));check(font.length===catalogTools.ATLAS_BYTES,'Menu type atlas changed size');
  menuData=Buffer.concat([font,bytes]);check(menuData.length+1024<=menu.controls.bytes,'Catalog exceeds GPU storage');catalog=next;
  let index=selected?catalog.apps.findIndex(a=>a.id===selected):-1;if(index<0)index=Math.min(state.readUInt32LE(80),Math.max(0,catalog.apps.length-1));
  state.writeUInt32LE(index,80);state.writeFloatLE(index,68);state.writeUInt32LE(catalog.apps.length,112);state.writeUInt32LE(catalog.apps.length,1020);state.writeUInt32LE(0,116);
  state.writeFloatLE(0,96);state.writeFloatLE(0,100);state.writeFloatLE(state.readFloatLE(108)+1,108);state.writeUInt32LE(0,1012);state.writeUInt32LE(0,1016);
  refreshSeen=state.readFloatLE(104);menuState=state;
  if(upload){await rpc.write(mapped+1024,menuData);await rpc.write(mapped,menuState);}
  runtime.report.catalog=catalogTools.summary(catalog);runtime.report.generation=generation;await save();
 }
 async function returnToMenu(error,{keepFtp=false}={}){
  await runtime.active?.service?.close();
  if(!keepFtp&&retainedFtp){const ftp=retainedFtp;retainedFtp=null;await ftp.service.close();}
  runtime.active=null;runtime.report.active=null;
  menuState.writeFloatLE(1,960);menuState.writeFloatLE(0,964);menuState.writeUInt32LE(0,784);menuState.writeUInt32LE(error?1:0,92);
  menuState.writeUInt32LE(0,976);menuState.writeUInt32LE(0,980);
  await rescan(menuState);await audio(null);runtime.report.transitions.push({event:'return',error:error?.message,time:new Date().toISOString()});await save();
  return menu.commands[0];
 }
 runtime.afterBatch=async({returnRequested=false,failure}={})=>{
  const state=await rpc.read(mapped,1024);
  if(runtime.active){
   if(!returnRequested&&!failure&&runtime.active.app.id==='mintftp'&&
      state.readUInt32LE(784)===MINTFTP_GAME_REQUEST&&state.readUInt32LE(1016)!==0){
    check(!retainedFtp,'MintFTP game handoff is already active');
    if(!catalog.apps.some(app=>app.id==='ouncecake'))
     return returnToMenu(Error('OunceCake is unavailable in MintBrew'));
    retainedFtp={id:runtime.active.app.id,fingerprint:runtime.active.app.fingerprint,
     service:runtime.active.service.handoff()};
    runtime.active.service=null;
    await returnToMenu(undefined,{keepFtp:true});
    const index=catalog.apps.findIndex(app=>app.id==='ouncecake');
    check(index>=0,'OunceCake was removed during the game handoff');
    const request=Buffer.alloc(4);request.writeUInt32LE(index+1);await rpc.write(mapped+1012,request);
    runtime.report.transitions.push({event:'handoff',from:'mintftp',to:'ouncecake',time:new Date().toISOString()});await save();
    return runtime.afterBatch();
   }
   if(returnRequested||state.readUInt32LE(1016)!==0)return returnToMenu(failure);
   const selected=state.readUInt32LE(1012);
   if(retainedFtp&&runtime.active.app.id==='ouncecake'&&selected!==0&&selected!==0xffffffff)
    await retainedFtp.service.stopForGame();
   await dispatchServiceRequest(rpc,mapped,runtime.active.service,selected);
   await runtime.active.service?.afterBatch?.(state);
   return runtime.active.gpu.commands[0];
  }
  const request=state.readUInt32LE(1012);
  if(request!==0){
   menuState=state;const selected=catalog.apps[request-1];
   try{
    check(selected,'The selected app is no longer in the catalog');
    const app=await catalogTools.readApp(selected.root);check(app.fingerprint===selected.fingerprint,'App changed; tap Refresh before opening it');
    if(app.id==='stremio-experimental'){
      await require(path.join(root,'scripts/gui-stremio.cjs')).checkRuntime(root);
      await require(path.join(root,'stremio/decoder.cjs')).tools();
    }
    let gpu=cache.get(app.fingerprint);
    if(!gpu){check(cache.size<64,'This session has retained 64 app versions; start a fresh session to load another');gpu=await prepareApp(rpc,menu,app,directory);check(gpu.ready&&gpu.scratchRestored,'App preparation incomplete');cache.set(app.fingerprint,gpu);}
    const bytes=Buffer.alloc(menu.controls.bytes);app.files.state.bytes.copy(bytes);app.files.data.bytes.copy(bytes,1024);
    bytes.writeUInt32LE(0,1012);bytes.writeUInt32LE(0,1016);
    if(app.manifest.transition==='none')bytes.writeFloatLE(0,960);
    if(app.files.memory){check(gpu.privateStorage?.bytes===app.files.memory.allocationBytes,'App private storage differs');const initial=Buffer.alloc(gpu.privateStorage.bytes);app.files.memory.bytes.copy(initial);await rpc.write(gpu.privateStorage.mapped,initial);}
    await rpc.write(mapped,bytes);await audio(app,gpu);
    runtime.active={app,gpu};
    if(app.id==='stremio-experimental')runtime.active.service=
      require(path.join(root,'integrations/mintbrew-stremio/adapter.cjs')).create({
        rpc,menu,gpu,directory,root,config,onProgress,onAccountProgress,onFatal});
    if(app.id==='ouncecake'&&app.manifest.service==='ouncecake-v1'){
      const host=JSON.parse(await fs.readFile(path.join(directory,'mintbrew-host.json'),'utf8'));
      const factory=createOunceCake||require(path.join(root,'integrations/mintbrew-ouncecake/service.cjs')).create;
      runtime.active.service=factory({
        rpc,menu,gpu,directory,root,app,runDirectory:host.runDirectory,
        sourceSession:host.sourceSession,onProgress,onFatal,
        onGameList:()=>retainedFtp?.service.resumeForList()});
    }
    if(app.id==='mintftp')runtime.active.service=
      (createMintFtp||require(path.join(root,'integrations/mintbrew-file-explorer/service.cjs')).create)({rpc,menu});
    if(app.id==='mintnes'){
      const nesService=createMintNes||require(path.join(root,'integrations/mintnes/service.cjs')).create;
      runtime.active.service=await nesService({rpc,gpu,app,onProgress});
    }
    runtime.report.active={id:app.id,fingerprint:app.fingerprint};runtime.report.transitions.push({event:'launch',id:app.id,fingerprint:app.fingerprint,time:new Date().toISOString()});await save();
    return gpu.commands[0];
   }catch(error){
    // a failed scratch restoration means the native session must not be reused.
    if(/restore scratch/.test(error.message))throw error;
    return returnToMenu(error);
   }
  }
  if(state.readFloatLE(104)!==refreshSeen)await rescan(state);
  return menu.commands[0];
 };
 runtime.observe=state=>runtime.active?.service?.observe?.(state)??false;
 runtime.beforeReturn=async()=>{await runtime.active?.service?.suspend?.();};
 runtime.close=async()=>{await runtime.active?.service?.close();await retainedFtp?.service?.close();};
 await rescan(menuState);await audio(null);return runtime;
}
module.exports={create,dispatchServiceRequest};
