'use strict';
const fs=require('node:fs'),path=require('node:path');
const {isUncertain}=require('./game-files/uncertain.cjs');
const {Bridge}=require('./native/bridge.cjs');
const {openSource,unpin}=require('./native/source.cjs');
const {attachGame,createGameFiles}=require('./game-files/mount-api.cjs');
const {openSelected}=require('./content.cjs'),{check,sha,writeJson}=require('./common.cjs');
const {layout,buildContext}=require('./context.cjs'),{buildAll,validateCapture}=require('./native.cjs');
function sampleRanges(size){
 if(!size)return[];if(size<=768)return[{offset:0,length:size}];
 return[0,Math.floor((size-256)/2),size-256].map(offset=>({offset,length:256}));
}
function sampleResources(resources){
 if(resources.length<=3)return resources;
 return[...new Set([resources[0],resources[Math.floor(resources.length/2)],resources.at(-1),resources.find(r=>r.added),resources.find(r=>!r.added)].filter(Boolean))];
}
async function verifyResources(run,plan,payloadFile,controller,source){
 const a=await attachGame(run),files=createGameFiles(a),deferred=new Set((plan.deferredGames||[]).map(game=>game.titleId)),report={romfs:[],exefs:[],deferredGames:[...deferred]},payload=fs.readFileSync(payloadFile),{verifySamples}=require('./native/verify.cjs');let mount;
 try{
  for(const v of plan.views){
   if(deferred.has(v.titleId))continue;
   mount=await openSelected(a,files,{...v.selection,resolvedSource:v.source});check(mount.source.contentId===v.source.contentId&&mount.source.version===v.source.version&&mount.size===v.virtualSize,'Mounted virtual RomFS identity/size differs');
   const header=Buffer.from(v.headerHex,'hex'),replacement=v.segments.find(s=>s.offset===0&&s.length>=80&&!s.sourcePath&&!s.original);
   if(replacement)payload.copy(header,0,replacement.sourceOffset,replacement.sourceOffset+80);
   const dataOffset=header.readBigUInt64LE(72),samples=[{offset:0,length:80,expected:header}];
   for(const r of sampleResources(v.resources)){
    const record=Buffer.alloc(16);record.writeBigUInt64LE(BigInt(r.overlayOffset)-dataOffset);record.writeBigUInt64LE(BigInt(r.modifiedSize),8);samples.push({offset:r.recordOffset+8,length:16,expected:record});
    let sampledBytes=0;
    for(const sample of sampleRanges(r.modifiedSize)){
     samples.push({offset:r.overlayOffset+sample.offset,length:sample.length,sourcePath:r.sourcePath,sourceOffset:r.sourceOffset+sample.offset});sampledBytes+=sample.length;
    }
    report.romfs.push({titleId:v.titleId,path:r.path,verified:true,sampledBytes});
   }
   await verifySamples(a,controller,mount,samples,source.filesystem.object);
   await files.close(mount);mount=null;
  }
  for(const group of plan.namespaces){
   if(deferred.has(group.titleId))continue;
   mount=await openSelected(a,files,{...group.selection,resolvedSource:group.source},'exefs');check(mount.source.contentId===group.source.contentId&&mount.source.version===group.source.version,'CodeFS selection changed');
   const wanted=plan.exefs.filter(e=>e.titleId===group.titleId),listed=await files.list(mount,'/',()=>false);
   check(listed.length===wanted.length&&listed.every(e=>e.type==='file'&&wanted.some(x=>x.name===e.name&&x.replacement.size===e.size)),'Native CodeFS directory differs');
   const samples=[];
   for(const e of wanted){
    if(!e.modified){report.exefs.push({titleId:e.titleId,name:e.name,verified:true,inheritedOriginal:true,sampledBytes:0});continue;}
    const r=e.replacement;let sampledBytes=0,before=samples.length;
    if(r.segments){
     const ranges=r.segments.filter(s=>s.inline),selected=ranges.length<=4?ranges:[ranges[0],ranges[Math.floor(ranges.length/3)],ranges[Math.floor(2*ranges.length/3)],ranges.at(-1)];
     for(const segment of selected){const n=Math.min(256,segment.length);samples.push({name:'/'+e.name,fileSize:r.size,offset:segment.offset,length:n,expected:payload.subarray(segment.sourceOffset,segment.sourceOffset+n)});sampledBytes+=n;}
    }else for(const sample of sampleRanges(r.size)){
     samples.push({name:'/'+e.name,fileSize:r.size,offset:sample.offset,length:sample.length,sourcePath:r.sourcePath,sourceOffset:r.sourceOffset+sample.offset});sampledBytes+=sample.length;
    }
    if(samples.length===before)samples.push({name:'/'+e.name,fileSize:r.size,offset:0,length:0,expected:Buffer.alloc(0)});
    report.exefs.push({titleId:e.titleId,name:e.name,verified:true,sampledBytes});
   }
   await verifySamples(a,controller,mount,samples,source.filesystem.object);
   await files.close(mount);mount=null;
  }
  return report;
 }catch(error){if(isUncertain(error))controller.c.pending=true;throw error;}
 finally{if(!controller.c.pending){if(mount)await files.close(mount);await a.close();}}
}
async function install(run,plan,directory,captureFile,bootstrap,onStage=()=>{}){
 check(plan.session===path.basename(run)&&plan.schema===5,'Wrong overlay session');const data=fs.readFileSync(captureFile);validateCapture(data);
 const journal=path.join(directory,'resident-install.json');check(!fs.existsSync(journal),'A resident installation already exists for this session');
 const r={session:plan.session,titleIds:plan.titleIds,started:new Date().toISOString(),verified:false,active:false,hooks:[],hookMayBeAttached:false,resourcesRetained:false,installedNcasChanged:false,requiresPcAfterHandoff:false};
 const save=()=>writeJson(journal,r);const stage=name=>{r.stage=name;save();onStage(name);};save();let b,source,allocation;const l=layout(plan);
 try{
  stage('opening resident controller');
  if(bootstrap){bootstrap.transfer();b=bootstrap.bridge;r.preparationRuntimeReused=true;r.runtime=b.runtime;}else{b=new Bridge();await b.open(run,{captureFile});}r.base=String(b.base);save();
  b.progress=(label,status)=>{r.nativeOperation={label,status,at:new Date().toISOString()};save();};
  stage('opening and qualifying retained SD report files');
  source=await openSource(run,b,plan.diagnostics);
  if(plan.lazy){source.registry=(await b.m.u64(Number(b.base+0x11e12d0n)))+16n;check(source.registry>=0x100000000n&&source.registry<0x8000000000n,'FS program registry is unavailable');}
  stage('allocating resident context');
  if(plan.lazy&&l.bytes>0x100000){
   const output=await b.call(0x694c0,[8],'allocate-context-output');check(output>=0x100000000n&&output<0x8000000000n,'Native allocation output failed');
   try{const result=await b.call(0x215620,[b.base+0x11ee960n,output,l.bytes],'allocate-mod-manifest');check(result===0n,'Cannot reserve mod manifest memory: '+result);allocation=await b.m.u64(Number(output));r.contextAllocationKind='SDK memory block';}
   finally{if(!b.c.pending)await b.call(0x69580,[output,8],'free-context-output');}
  }else allocation=await b.call(0x694c0,[l.bytes],'allocate-layeredfs-context',{clearAllocation:true});
  check(allocation>=0x100000000n&&allocation<0x8000000000n,'Native context allocation failed');
  const mapping=await b.c.info(b.h,allocation,b.pid);check(!mapping.result&&mapping.memory.permissions===3&&mapping.memory.attributes===0&&allocation+BigInt(l.bytes)<=BigInt(mapping.memory.address)+BigInt(mapping.memory.size),'Native context is not backed by sufficient RW memory');
  if(r.contextAllocationKind&&b.runtime?.published){
   const offsets=require('./native/artifacts.cjs').runtime(0n,0n).offsets;
   await b.callRuntime(offsets.lfs_zero,[allocation,l.bytes],'clear-mod-manifest');r.contextPreimageZeroed=true;
  }
  r.context=String(allocation);r.contextBytes=l.bytes;r.filesystem=source.filesystem;if(source.logFile)r.logFile=source.logFile;if(source.traceFile)r.traceFile=source.traceFile;r.diagnosticPath=plan.diagnostics?.sdPath;save();
  let native=await buildAll(b.base,allocation,plan,{capture:captureFile,directory:path.join(directory,'build')});
  const payload=fs.readFileSync(path.join(directory,'prepared',plan.payload.filename));const context=buildContext(plan,source,b.base,allocation,native,0,payload);
  stage('transferring resident manifest');
  for(let off=0;off<context.length;off+=0x10000){const part=context.subarray(off,off+0x10000),at=Number(allocation)+off;await b.writeData(at,r.contextAllocationKind&&!r.contextPreimageZeroed?await b.m.read(at,part.length):Buffer.alloc(part.length),part);}
  stage('mapping resident executable');
  const retainRuntime=record=>{r.runtime=record;return save();};
  const runtime=b.runtime?await b.replaceRuntime(native.runtimeCode,retainRuntime):await b.mapRuntime(native.runtimeCode,retainRuntime,allocation+152n);
  native=await buildAll(b.base,allocation,plan,{capture:captureFile,directory:path.join(directory,'build'),runtimeAddress:runtime.address});r.native={runtimeBytes:native.runtimeBytes,gatewayBytes:native.codeBytes,sha256:native.sha256,runtimeSha256:native.runtimeSha256};
  if(source.traceFile){
   stage('qualifying diagnostic physical clock');
   check(await b.callRuntime(native.offsets.lfs_trace_clock_probe,[allocation+BigInt(l.traceOffset)+49136n],'qualify-diagnostic-clock')===0n,'Diagnostic clock probe failed');
   const clock=await b.m.read(Number(allocation)+l.traceOffset+49136,16);r.diagnosticClock={tick:String(clock.readBigUInt64LE()),frequency:String(clock.readBigUInt64LE(8)),counter:'CNTPCT_EL0'};
   check(BigInt(r.diagnosticClock.frequency)>0n,'Diagnostic clock frequency is unavailable');save();
  }
  stage('retaining resident SD file references');
  check(await b.m.u32(source.filesystem.object+source.filesystem.refOffset)===source.filesystem.baseline,'SD reference baseline changed');
  check(await b.callRuntime(native.offsets.lfs_initialize,[],'retain-resident-SD')===0n,'SD retention failed');
  check(await b.m.u32(source.filesystem.object+source.filesystem.refOffset)===source.filesystem.baseline+1,'SD reference did not retain once');source.filesystem.pinned=true;if(source.logFile)source.logFile.pinned=true;if(source.traceFile)source.traceFile.pinned=true;
  if(source.logFile)check(await b.m.u32(source.logFile.object+source.logFile.refOffset)===source.logFile.baseline+1,'Report reference did not retain once');
  if(source.traceFile)check(await b.m.u32(source.traceFile.object+source.traceFile.refOffset)===source.traceFile.baseline+1,'Trace reference did not retain once');
  await source.close();source.closed=true;r.clientSessionClosed=true;save();
  stage('attaching resident hooks');
  const installerCave=b.cave;
  await b.stage(Buffer.alloc(0));await b.controlCave();
  r.codeMayBeStaged=true;save();
  const gateway=Buffer.alloc(1024);native.code.copy(gateway);
  for(let i=0;i<gateway.length;i+=16)if(gateway.subarray(i,i+16).some(Boolean))await b.patch(installerCave+BigInt(i),Buffer.alloc(16),gateway.subarray(i,i+16));
  r.codeStaged=true;save();
  for(const hook of native.hooks){r.hooks.push({...hook,attached:false});r.hookMayBeAttached=true;save();await b.patch(BigInt(hook.target),Buffer.from(hook.originalHex,'hex'),Buffer.from(hook.replacementHex,'hex'));r.hooks.at(-1).attached=true;save();}
  r.hookAttached=true;
  if(l.exefs)r.exefsContext=String(allocation+BigInt(l.romfs));
  stage('activating resident runtime');
  check(await b.callRuntime(native.offsets.lfs_activate,[],'activate-resident-mods')===0n,'Cannot activate native mods');r.active=true;r.resourcesRetained=true;save();
  stage('verifying resident runtime');
  const controller=b;
  r.verification=plan.lazy?{mode:'native-on-mount',romfs:[],exefs:[],gamesNeedNotBePresent:true}:await verifyResources(run,plan,path.join(directory,'prepared',plan.payload.filename),controller,source);
  // Read diagnostics through the separate process-memory helper. The retained
  // IStorage endpoint observes its own in-flight Read in the active counter.
  const counters=await b.read(allocation,104);r.counters=Object.fromEntries([['calls',16],['matched',24],['sourceReads',80],['errors',88],['active',96]].map(([k,off])=>[k,String(counters.readBigUInt64LE(off))]));check(r.counters.errors==='0'&&r.counters.active==='0','Resident RomFS reader is failed or busy');
  if(l.exefs){const bytes=await b.read(allocation+BigInt(l.romfs),112);r.exefsCounters={calls:String(bytes.readBigUInt64LE(80)),matched:String(bytes.readBigUInt64LE(88)),errors:String(bytes.readBigUInt64LE(96)),active:String(bytes.readBigUInt64LE(104))};check(r.exefsCounters.errors==='0'&&r.exefsCounters.active==='0'&&(!r.verification.exefs.length||BigInt(r.exefsCounters.matched)>0n),'Resident ExeFS verification failed');}
  if(source.logFile){
   if(!plan.lazy)
   check(await controller.callRuntime(native.offsets.lfs_game_observations,[],'start-game-observations')===0n,'Cannot begin game observations');
   const errors=plan.lazy?await b.m.u32(Number(allocation)+l.lazyOffset+132):await b.m.u64(Number(allocation)+256);r.diagnosticWriteErrors=String(errors);if(errors)console.warn('WARNING: The SD runtime report could not be updated; mods remain active.');
  }
  r.verified=true;r.residentUntilReboot=true;r.readyForGameHandoff=false;r.finished=new Date().toISOString();save();
  // The resident owns its source references, contexts and shared RX page.
  // Closing a controller must not clear the installed code or restore X-only.
  stage('closing resident controller');
  await b.releaseControl();await b.stage(Buffer.alloc(0));b.readable=false;await b.c.close();r.controllerHandlesClosed=true;save();return r;
 }catch(error){
  r.error=error.stack;
  if(b?.c&&isUncertain(error))b.c.pending=true;
  if(b?.c&&!b.c.pending&&!b.previous){await b.c.close();}
  else if(b?.c&&!b.c.pending&&!r.runtime&&!r.codeMayBeStaged&&!r.hookMayBeAttached&&!source?.closed){
   if(source){if(source.traceFile)await unpin(b,source.traceFile,true);if(source.logFile)await unpin(b,source.logFile,true);await unpin(b,source.filesystem,true);await source.close();}
   if(allocation){if(r.contextAllocationKind==='SDK memory block')await b.call(0x215800,[b.base+0x11ee960n,allocation,l.bytes],'free-unused-mod-manifest');else await b.call(0x69580,[allocation,l.bytes],'free-unused-layeredfs-context');}await b.close();
  }else if(b){r.resourcesRetained=true;r.requiresInspectionOrReboot=true;}
  save();throw error;
 }
}
module.exports={install,verifyResources,sampleRanges,sampleResources};
