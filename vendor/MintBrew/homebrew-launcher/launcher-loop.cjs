const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const code=require('../smilebasic/engine/switch2/app/thread-code.json').functions;
const timing=require('../smilebasic/engine/switch2/app/timing-code.json').functions;
const holdReturn=require('./hold-return.cjs');
const frameClock=require('./frame-clock.cjs');
const check=(v,m)=>{if(!v)throw Error(m);};
const serviceStartError=(failure,active)=>failure?.service&&active?.service===failure.service?failure.error:null;
const struct=(n,type,words={},ptrs={})=>{const b=Buffer.alloc(n);b.writeUInt32LE(type);for(const[k,v]of Object.entries(words))b.writeUInt32LE(v,+k);for(const[k,v]of Object.entries(ptrs))b.writeBigUInt64LE(BigInt(v),+k);return b;};
async function main(directory,attempt='',instance=''){
 check(!instance||/^[a-z0-9-]+$/.test(instance),'Invalid loop instance');
 check(!attempt||/^[a-z0-9-]+$/.test(attempt),'Invalid attempt label');const stem='launcher'+(attempt?'-'+attempt:'');const loopStem=stem+(instance?'-'+instance:'');
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),sdk=rpc.a.sdk;
 const prepared=JSON.parse(await fs.readFile(path.join(directory,stem+'.json'))),module=JSON.parse(await fs.readFile(path.join(directory,'compatibility-module.json')));
 check(prepared.ready&&prepared.scratchRestored&&prepared.session===rpc.a.session,'Shader preparation incomplete');
 const qualified=JSON.parse(await fs.readFile(path.join(directory,stem+'-check.json')));check(qualified.session===rpc.a.session&&qualified.passed&&qualified.scratchRestored,'Launcher input checks incomplete');
 const file=path.join(directory,loopStem+'-loop.json');await fs.writeFile(file,'{}',{flag:'wx'});
 const report={session:rpc.a.session,started:new Date().toISOString(),batches:[],resourcesRetained:true};
 const save=()=>fs.writeFile(file,JSON.stringify(report,null,2));
 let stop=false;process.on('SIGINT',()=>stop=true);process.on('SIGTERM',()=>stop=true);
 const stopping=async()=>stop||await fs.access(path.join(directory,'launcher-loop.stop')).then(()=>true,()=>false);
 const sdkImage=require('../smilebasic/reference/sdk-checks.cjs');
 let runtime;
 let sdkRuntime;
 const config=await fs.readFile(path.join(directory,'stremio-config.json'),'utf8')
  .then(JSON.parse,error=>{if(error.code==='ENOENT')return {};throw error;});
 let serviceFatal;
 const onFatal=error=>{console.error('MintBrew: '+error.message);if(error.cleanupBlocked)serviceFatal=error;};
 runtime=await require('./app-runtime.cjs').create({rpc,menu:prepared,directory,config,
  onProgress:message=>console.log('MintBrew: '+message),
  onAccountProgress:watchProgress=>console.log('MAC2JB_STREMIO_ACCOUNT '+JSON.stringify(watchProgress)),onFatal});
 for(const c of [...Object.values(code),timing.tick]){
  const expected=Buffer.from(c.bytes,'hex').subarray(0,256);await rpc.request({command:'verify-function',address:sdk+c.offset,hex:expected.toString('hex')});
 }
 const lookup=sdk+0x45c288;await rpc.request({command:'verify-function',address:lookup,hex:sdkImage.bytes(0x45c288,16).toString('hex')});
 const freq=module.base+0x13d6f0;await rpc.request({command:'verify-function',address:freq,hex:'00ca9a52803ba072c0035fd6'});
 const frequency=Number((await rpc.callAddress(freq,[])).result);check(frequency===frameClock.FREQUENCY,'Unexpected timer frequency');report.counterFrequency=frequency;
 await rpc.request({command:'verify-function',address:sdk+0x586fb0,hex:require('../sdk/native/ipc-functions.json').copy.hex});
 const verified=new Set();for(const name of ['vkAcquireNextImage2KHR','vkQueueSubmit','vkQueuePresentKHR','vkQueueWaitIdle']){
  const symbol=module.symbols.find(s=>s.name===name&&s.section&&s.type===2),address=module.base+symbol.offset;check(address===prepared.functions[name],'Function address changed');
  await rpc.request({command:'verify-function',address,hex:(await rpc.read(address,32)).toString('hex')});verified.add(address);
 }
 const inputInspection=JSON.parse(await fs.readFile(path.join(directory,'input-inspection.json')));check(inputInspection.session===rpc.a.session,'Input inspection session differs');
 const input=inputInspection.imports['_ZN2nn3hid12GetNpadStateEPNS0_17NpadHandheldStateERKj'];
 const inputSlot=Number((await rpc.read(rpc.a.main+input.slot,8)).readBigUInt64LE());check(inputSlot===input.target,'Input function changed');
 await rpc.request({command:'verify-function',address:input.target,hex:input.bytes.slice(0,64)});verified.add(input.target);report.input={type:'handheld',id:32,target:input.target};
 const touch=inputInspection.imports['_ZN2nn3hid19GetTouchScreenStateILm16EEEvPNS0_16TouchScreenStateIXT_EEE'];
 check(Number((await rpc.read(rpc.a.main+touch.slot,8)).readBigUInt64LE())===touch.target,'Touch import changed');await rpc.request({command:'verify-function',address:touch.target,hex:touch.bytes.slice(0,64)});verified.add(touch.target);report.touch={target:touch.target,offset:128};
 const temp=rpc.a.scratch+0x10000,saved=await rpc.read(temp,8);let base;
 try{check((await rpc.call(5732112,[temp,4096,0x400000])).result===0n,'Allocation failed');base=Number((await rpc.read(temp,8)).readBigUInt64LE());}finally{await rpc.write(temp,saved);}
 check(base>0&&base%4096===0,'Bad allocation');report.base=base;await save();
 const control=base+0x1000;
 const r=prepared.resources,device=BigInt(r.device),queue=BigInt(r.queue),swapchain=BigInt(r.swapchain),acquired=BigInt(r.acquired),frameCount=60;
 const data=Buffer.alloc(0x9000),put=(o,b)=>b.copy(data,o),u64=(o,v)=>data.writeBigUInt64LE(BigInt(v),o);
 put(0x100,struct(56,1000060010,{48:1},{16:swapchain,24:0xffffffffffffffffn,32:acquired}));
 u64(0x200,acquired);data.writeUInt32LE(0x400,0x210);u64(0x220,swapchain);data.writeUInt32LE(32,0x230);
 const semObject=control+0x800;u64(0x850,control+0x880);r.semaphores.forEach((v,i)=>u64(0x880+i*8,v));
 put(0x600,struct(64,1000001001,{16:1,32:1},{24:semObject+0x28,40:control+0x220,48:control}));
 for(let phase=0;phase<prepared.commands.length;phase++){
  const o=0x1000+phase*0x100,obj=control+o;u64(o+0x50,obj+0x60);prepared.commands[phase].forEach((v,i)=>u64(o+0x60+i*8,v));
  put(o+0x80,struct(72,4,{16:1,40:1,56:1},{24:control+0x200,32:control+0x210,48:obj+0x28,64:semObject+0x28}));
 }
 await rpc.write(control,data);
 // check dynamic selection with the final swapchain index before launching.
 const last=r.images.length-1;await rpc.callAddress(lookup,[semObject,last]);check((await rpc.read(semObject+0x28,8)).readBigUInt64LE()===BigInt(r.semaphores[last]),'Semaphore selector differs');
 sdkRuntime=await require('../sdk/host/runtime.cjs').create({rpc,mapped:prepared.controls.mapped,directory});
 report.sdk={joyMouse:!!sdkRuntime.hardware.joyMouse,joyMouseError:sdkRuntime.hardware.joyMouseError};await save();
 try{
 await sdkRuntime.atBoundary();
 let frame,proof,checks,program,logicalCalls,bridgeMailbox;
 async function prepareFrame(){
 const calls=[];checks=[];const add=(fn,args,expectZero=false)=>{if(expectZero)checks.push(calls.length);calls.push({function:fn,args:[...args,...Array(4-args.length).fill(0)]});};
 const bridge=runtime.active?.app.manifest.cpuBridge,privateStorage=runtime.active?.gpu.privateStorage;
 bridgeMailbox=null;
 if(bridge){
  check(bridge.kind==='counter-v1'&&privateStorage&&Number.isSafeInteger(privateStorage.mapped)&&
    Number.isInteger(bridge.offset)&&bridge.offset>=0&&bridge.offset%8===0&&
    bridge.offset+12<=privateStorage.bytes,'Invalid private CPU-to-GPU mailbox');
  bridgeMailbox=privateStorage.mapped+bridge.offset;
 }
 add(sdk+timing.tick.offset,[]);
 for(let f=0;f<frameCount;f++){
  const obj=control+0x1000+(f%prepared.commands.length)*0x100;
  const clock=frameClock.append(calls,{sdk,base,mapped:prepared.controls.mapped,tickOffset:timing.tick.offset});
  if(bridgeMailbox!==null)add(sdk+frameClock.COPY_OFFSET,[bridgeMailbox,clock.result,8]);
  const frameInput=sdkRuntime.hardware.frameCalls(prepared.controls.mapped);
  if(!frameInput.some(call=>call.args[0]===prepared.controls.mapped))add(input.target,[prepared.controls.mapped,control+0x230]);
  for(const call of frameInput){verified.add(call.function);add(call.function,call.args);}
  add(touch.target,[prepared.controls.mapped+128]);
  add(prepared.functions.vkAcquireNextImage2KHR,[device.toString(),control+0x100,control],true);
  add(lookup,[obj,{u32:control}]);add(lookup,[semObject,{u32:control}]);
  add(prepared.functions.vkQueueSubmit,[queue.toString(),1,obj+0x80,0],true);
  add(prepared.functions.vkQueuePresentKHR,[queue.toString(),control+0x600],true);
  add(prepared.functions.vkQueueWaitIdle,[queue.toString()],true);
 }
 add(sdk+timing.tick.offset,[]);
 logicalCalls=calls;
 program=await require('../sdk/native/repeating.cjs').prepare(rpc,{base,code,calls,verified});frame=program.frame;proof=program.proof;
 report.proof=proof;report.frameSha256=crypto.createHash('sha256').update(frame).digest('hex');report.framesPerCycle=frameCount;report.continuous=true;await save();
 await fs.writeFile(path.join(directory,loopStem+'-loop-frame.bin'),frame);

 }
 await prepareFrame();
 const audioSource=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 check(audioSource.session===rpc.a.session&&audioSource.mapped===prepared.controls.mapped&&
  audioSource.package?.id==='mintbrew-menu','MintBrew menu sound source is unavailable');
 console.log('MintBrew game event source ready.');
 let thread=null,lastHeartbeat=0n,lastRefresh=0,lastConnected,serviceStartFailure;
 const hold=holdReturn.create();
 async function startWorker(){
  check(thread===null,'Worker already running');
  await rpc.call(0x586fb0,[program.live,program.snapshot,frame.length]);
  await frameClock.initialize(rpc,prepared.controls.mapped,frequency);
  if(bridgeMailbox!==null)await frameClock.initializeMailbox(rpc,bridgeMailbox,frequency);
  const pointer=Buffer.alloc(8);pointer.writeBigUInt64LE(BigInt(program.live));await rpc.write(program.selector,pointer);
  check((await rpc.callAddress(sdk+code.create.offset,[base,0,sdk+code.longjmp.offset,program.live])).result===0n,'pthread_create failed');
  thread=(await rpc.read(base,8)).readBigUInt64LE();report.thread=String(thread);report.threadRunning=true;lastHeartbeat=0n;await save();
 }
 async function stopWorker(){
  if(thread===null)return;await program.stop();const until=Date.now()+10000;let done=false;
  while(Date.now()<until){const result=(await rpc.callAddress(sdk+code.tryWait.offset,[thread])).result;check(result===0n||result===1n,'Bad thread state');if(result===1n){done=true;break;}await new Promise(r=>setTimeout(r,10));}
  check(done,'Continuous worker stop timed out; resources retained');check((await rpc.callAddress(sdk+code.join.offset,[thread,base+8])).result===0n,'Join failed');thread=null;report.threadRunning=false;
 }
 try{
  await startWorker();console.log('MintBrew continuous native frame loop running.');
  while(!await stopping()){
   if(serviceFatal)throw serviceFatal;
   await new Promise(r=>setTimeout(r,50));
   const state=await rpc.read(prepared.controls.mapped,1024),mailbox=await rpc.read(prepared.controls.mapped+0x7f0800,2052);
   const failedStart=serviceStartError(serviceStartFailure,runtime.active);
   if(serviceStartFailure&&!failedStart)serviceStartFailure=null;
   const observed=runtime.observe?.(state);
   check(!observed||typeof observed.then!=='function','App observation must not pause the frame worker');
   const heartbeat=(await rpc.read(program.addresses.at(-1),8)).readBigUInt64LE();
   if(heartbeat&&heartbeat!==lastHeartbeat){
    const raw=await rpc.read(program.results,logicalCalls.length*8),failures=checks.filter(i=>raw.readBigUInt64LE(i*8)!==0n).map(i=>({call:i,result:String(raw.readBigUInt64LE(i*8))}));
    check(!failures.length,'Continuous graphics call failed: '+JSON.stringify(failures));
    const interval=lastHeartbeat?Number(heartbeat-lastHeartbeat)/frequency:null;
    report.batches.push({status:'continuous',counter:String(heartbeat),interval,frames:frameCount,failures:[],at:new Date().toISOString()});if(report.batches.length>300)report.batches.shift();lastHeartbeat=heartbeat;await save();
    if(interval)console.log('MintBrew continuous: '+frameCount+' frames / '+interval.toFixed(3)+'s');
   }
   const refresh=state.readFloatLE(104),connected=!!(state.readUInt32LE(32)&1);
   let returnRequested=false;
   if(runtime.active&&runtime.active.app.id!=='stremio-experimental'&&state.readUInt32LE(1016)===0){
    const extension=await rpc.read(prepared.controls.mapped+0x7f0000,960);
    returnRequested=hold.update(holdReturn.buttons(state,extension),performance.now());
   }else hold.reset();
   if(!returnRequested&&!failedStart&&runtime.active?.service?.returnRequested)
    returnRequested=await runtime.active.service.returnRequested();
   const servicePending=!returnRequested&&!failedStart&&runtime.active?.service?.pending?
    await runtime.active.service.pending():false;
   const appRequest=runtime.active?state.readUInt32LE(1016)!==0||returnRequested||!!failedStart||
    servicePending||(runtime.active.service?.select&&state.readUInt32LE(1012)!==0):
    state.readUInt32LE(1012)!==0||refresh!==lastRefresh;
   const serviceRequest=mailbox.readUInt32LE()!==0&&mailbox.readUInt32LE()!==mailbox.readUInt32LE(2048);
   const connectionChanged=lastConnected!==undefined&&connected!==lastConnected;lastConnected=connected;
   if(!appRequest&&!serviceRequest&&!connectionChanged)continue;
   if(runtime.active&&(returnRequested||failedStart||state.readUInt32LE(1016)!==0))await runtime.beforeReturn?.();
   // only explicit app/service transitions or controller reconnects pause rendering.
   await stopWorker();await sdkRuntime.atBoundary(runtime.active?.app);
   const previousApp=runtime.active?.app,commands=await runtime.afterBatch({returnRequested:returnRequested||!!failedStart,failure:failedStart});
   if(runtime.active?.app!==previousApp){serviceStartFailure=null;hold.reset();await sdkRuntime.atBoundary(runtime.active?.app);}
   check(commands.length===r.images.length,'App swapchain command count differs');const handles=Buffer.alloc(commands.length*8);commands.forEach((v,i)=>handles.writeBigUInt64LE(BigInt(v),i*8));await rpc.write(control+0x1060,handles);
   lastRefresh=(await rpc.read(prepared.controls.mapped+104,4)).readFloatLE();await prepareFrame();await startWorker();
   if(runtime.active?.app!==previousApp&&runtime.active?.service){
    const service=runtime.active.service;
    void service.start().catch(error=>{
     onFatal(error);
     if(!error.cleanupBlocked&&runtime.active?.service===service)serviceStartFailure={service,error};
    });
   }
  }
 }finally{await stopWorker();}
 }finally{if(!report.threadRunning){try{await sdkRuntime?.close();}finally{await runtime.close();}}}
 report.completed=new Date().toISOString();await save();console.log('MintBrew stopped; resources retained.');
}
if(require.main===module)main(process.argv[2],process.argv[3],process.argv[4]).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={serviceStartError};
