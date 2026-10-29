const fs=require('node:fs/promises'),path=require('node:path');
const {journal}=require('./journal.cjs');
const check=(v,m)=>{if(!v)throw Error(m);};
const struct=(n,type,words={},pointers={})=>{const b=Buffer.alloc(n);b.writeUInt32LE(type);for(const[k,v]of Object.entries(words))b.writeUInt32LE(v,+k);for(const[k,v]of Object.entries(pointers))b.writeBigUInt64LE(BigInt(v),+k);return b;};
async function main(directory,attempt=''){
 check(!attempt||/^[a-z0-9-]+$/.test(attempt),'Invalid attempt label');const stem='launcher'+(attempt?'-'+attempt:'');
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs')),prep=JSON.parse(await fs.readFile(path.join(directory,stem+'.json')));
 check(prep.session===rpc.a.session&&prep.ready&&prep.scratchRestored,'Launcher preparation incomplete');
 const file=path.join(directory,stem+'-check.json'),report={session:rpc.a.session,cases:[],started:new Date().toISOString()};await fs.writeFile(file,'{}',{flag:'wx'});
 const save=()=>fs.writeFile(file,JSON.stringify(report,null,2)),tracked=journal(report,save);
 for(const address of Object.values(prep.functions))await rpc.request({command:'verify-function',address,hex:(await rpc.read(address,32)).toString('hex')});
 const call=(name,...args)=>tracked(name,args,()=>rpc.callAddress(prep.functions[name],args).then(r=>r.result));
 const ok=async(name,...args)=>check((await call(name,...args))===0n,name+' failed');
 const p=rpc.a.scratch+0x10000,saved=await rpc.read(p,0x2000),put=(o,b)=>rpc.write(p+o,b),ptr=async o=>(await rpc.read(p+o,8)).readBigUInt64LE();
 const device=BigInt(prep.resources.device),queue=BigInt(prep.resources.queue);
 try{
  await put(0x100,struct(32,40,{28:1},{16:prep.resources.pool}));await ok('vkAllocateCommandBuffers',device,p+0x100,p);const command=await ptr(0);
  await put(0x100,struct(32,42));await ok('vkBeginCommandBuffer',command,p+0x100);
  async function barrier(ss,sa,ds,da){await put(0x100,struct(48,1000314000,{}, {16:ss,24:sa,32:ds,40:da}));await put(0x200,struct(64,1000314003,{20:1},{24:p+0x100}));await call('vkCmdPipelineBarrier2',command,p+0x200);}
  await barrier(0x4888,0x6060,0x800,0x60);
  const descriptor=Buffer.alloc(8);descriptor.writeBigUInt64LE(BigInt(prep.controls.descriptor));await put(0x300,descriptor);await put(0x100,struct(64,1000545003,{16:32,36:1},{24:prep.layout,40:p+0x300}));
  await call('vkCmdBindDescriptorSets2',command,p+0x100);await call('vkCmdBindPipeline',command,1,BigInt(prep.computePipeline));await call('vkCmdDispatch',command,1,1,1);await barrier(0x800,0x40,0x4000,0x2000);await ok('vkEndCommandBuffer',command);
  const cmd=Buffer.alloc(8);cmd.writeBigUInt64LE(command);await put(0x300,cmd);await put(0x400,struct(72,4,{40:1},{48:p+0x300}));
  const cases=[
   {name:'D-pad down',buttons:1<<15,selection:0,want:1,wantTicks:1},
   {name:'D-pad wraps down',buttons:1<<15,selection:2,want:0},
   {name:'D-pad wraps up',buttons:1<<13,selection:0,want:2},
   {name:'Held button is not repeated',buttons:1<<15,previous:1<<15,selection:1,want:1,wantTicks:0},
   {name:'Stick down',stick:-32767,selection:0,want:1,wantTicks:1},
   {name:'Held stick ticks only on a new app',stick:-32767,selection:0,count:5,steps:20,want:1,wantTicks:1},
   {name:'Stick repeat cooldown',stick:-32767,cooldown:.2,selection:1,want:1,wantTicks:0},
   {name:'Right stick moves pointer',rightStick:[32767,0],selection:0,want:1,wantPointerX:978,wantPointerY:540,wantCursor:1},
   {name:'Right stick up moves pointer up',rightStick:[0,32767],selection:0,want:1,wantPointerX:960,wantPointerY:522,wantCursor:1},
   {name:'A opens empty slot',buttons:1,selection:2,want:2,wantModal:1},
   {name:'B closes empty slot',buttons:2,modal:1,selection:2,want:2},
   {name:'Modal holds selection',buttons:1<<15,modal:1,selection:1,want:1,wantModal:1},
   {name:'Disconnected input ignored',connected:false,buttons:1<<15,selection:1,want:1},
   {name:'Touch selects last row',touch:[600,484],selection:0,want:2},
   {name:'Ending touch ignored',touch:[600,484],ending:true,selection:0,want:0},
   {name:'Refresh stays still while idle',selection:0,want:0,steps:5},
   {name:'Refresh tap starts spinning',touch:[1107,119],selection:1,want:1,wantBusy:true,wantRequests:1},
   {name:'Held refresh tap waits for host acknowledgement',touch:[1107,119],selection:1,want:1,steps:80,wantRequests:1,wantBusy:true},
   {name:'Tap while refreshing ignored',touch:[1107,119],selection:1,want:1,busy:.6,requests:1,wantBusy:true,wantRequests:1},
   {name:'Refresh does not trigger through modal',touch:[1107,119],selection:0,want:0,modal:1,wantModal:1},
   {name:'Touch ending on refresh ignored',touch:[1107,119],ending:true,selection:0,want:0},
   {name:'Sliding held touch over refresh ignored',touch:[1107,119],heldTouch:true,selection:0,want:0},
   {name:'New tap after release refreshes again',touch:[1107,119],requests:1,selection:0,want:0,wantRequests:2,wantBusy:true},
   {name:'Direct touch from first to last row',touch:[600,484],selection:0,want:2},
   {name:'Direct touch from last to first row',touch:[600,283],selection:2,want:0},
   {name:'First gap does not select',touch:[600,333],selection:0,want:0},
   {name:'Second gap does not select',touch:[600,433],selection:2,want:2},
   {name:'Space above first row does not select',touch:[600,230],selection:2,want:2},
   {name:'Rounded corner does not select',touch:[202,243],selection:2,want:2},
   {name:'Single-title D-pad stays on title',count:1,buttons:1<<15,selection:0,want:0,wantTicks:0},
   {name:'Single-title held stick stays silent',count:1,stick:-32767,selection:0,steps:20,want:0,wantTicks:0},
   {name:'Two-title wrap uses actual count',count:2,buttons:1<<15,selection:1,want:0},
   {name:'Empty library ignores D-pad',count:0,buttons:1<<15,selection:2,want:0},
   {name:'Empty library ignores A',count:0,buttons:1,selection:0,want:0},
   {name:'Empty library ignores row taps',count:0,touch:[600,484],selection:0,want:0},
   {name:'Empty library still refreshes',count:0,touch:[1107,119],selection:0,want:0,wantBusy:true,wantRequests:1},
   {name:'Right leaves an empty library empty',count:0,buttons:1<<14,selection:0,want:0,wantCount:0},
   {name:'Left does not change the catalog',installed:3,count:3,buttons:1<<12,selection:2,want:2,wantCount:3},
   {name:'Disconnected horizontal input ignored',connected:false,count:0,buttons:1<<14,selection:0,want:0,wantCount:0},
   {name:'Installed app request waits for fade',installed:2,count:2,buttons:1,selection:1,want:1,steps:20,wantLaunch:2},
   {name:'More than one page wraps correctly',installed:5,count:5,buttons:1<<13,selection:0,want:4},
   {name:'Touch on scrolled list selects global app index',installed:5,count:5,touch:[600,383],selection:4,want:2},
   {name:'Left leaves an empty library empty',installed:0,count:0,buttons:1<<12,selection:0,want:0,wantCount:0},
   {name:'Completed host refresh leaves idle arrow still',selection:0,want:0,steps:3},
   {name:'Touch sets dark mode',touch:[667,678],selection:1,want:1,wantDark:1,wantDarkLevel:.1},
   {name:'Dark level eases over several frames',touch:[667,678],selection:1,want:1,steps:8,wantDark:1,wantDarkLevel:.7},
   {name:'Touch restores light mode',touch:[613,678],selection:1,want:1,wantDark:0},
   {name:'Slider touch leaves the selection alone',touch:[667,678],selection:0,want:0,wantDark:1},
   {name:'ZR clicks dark side of slider',buttons:512,pointer:[1010,1017],pointerInit:true,pointerActive:true,selection:1,want:1,wantDark:1},
   {name:'ZR clicks light side of slider',buttons:512,pointer:[910,1017],pointerInit:true,pointerActive:true,selection:1,want:1,wantDark:0},
   {name:'Slider click is ignored behind the modal',buttons:512,pointer:[1010,1017],pointerInit:true,pointerActive:true,modal:1,selection:1,want:1,wantModal:1,wantDark:0},
   {name:'A toggles dark on the switch',buttons:1,pointer:[1010,1017],pointerInit:true,pointerActive:true,selection:1,want:1,steps:20,wantDark:1,wantDarkLevel:.1,wantLaunch:0},
   {name:'A toggles light on the switch',buttons:1,pointer:[910,1017],pointerInit:true,pointerActive:true,selection:1,want:1,steps:20,wantDark:0,wantLaunch:0},
   {name:'A over blank space launches nothing',buttons:1,installed:3,pointer:[700,300],pointerInit:true,pointerActive:true,selection:1,want:1,steps:20,wantLaunch:0},
   {name:'A over a row still launches that row',buttons:1,installed:3,pointer:[960,424],pointerInit:true,pointerActive:true,selection:2,want:0,steps:20,wantLaunch:1},
  ];
  for(const test of cases){
   const input=Buffer.alloc(1024);input.writeUInt32LE(test.buttons||0,8);input.writeUInt32LE(test.connected===false?0:1,32);input.writeInt32LE(test.stick||0,20);
   input.writeInt32LE(test.rightStick?.[0]||0,24);input.writeInt32LE(test.rightStick?.[1]||0,28);
   input.writeFloatLE(test.cooldown||0,76);input.writeUInt32LE(test.selection,80);input.writeUInt32LE(test.previous||0,84);input.writeUInt32LE(test.modal||0,92);
   input.writeFloatLE(test.busy||0,96);input.writeFloatLE(test.requests||0,104);input.writeUInt32LE(test.heldTouch?1:0,124);
   input.writeUInt32LE(test.count===undefined?3:test.count,112);
   input.writeUInt32LE(test.reserved||0,120);
   input.writeUInt32LE(test.installed||0,1020);
   if(test.touch){input.writeUInt32LE(1,136);input.writeUInt32LE(test.ending?2:0,152);input.writeUInt32LE(test.touch[0],160);input.writeUInt32LE(test.touch[1],164);}
   if(test.pointer){input.writeFloatLE(test.pointer[0],816);input.writeFloatLE(test.pointer[1],820);}
   if(test.pointerInit)input.writeUInt32LE(1,784);
   if(test.pointerActive)input.writeUInt32LE(1,788);
   await rpc.write(prep.controls.mapped,input);
   for(let step=0;step<(test.steps||1);step++){await ok('vkQueueSubmit',queue,1,p+0x400,0);await ok('vkQueueWaitIdle',queue);}
   const result=await rpc.read(prep.controls.mapped+64,64),selection=result.readUInt32LE(16),modal=result.readUInt32LE(28),frames=result.readUInt32LE(24);
   const refresh={remaining:result.readFloatLE(32),angle:result.readFloatLE(36),requests:result.readFloatLE(40),completions:result.readFloatLE(44)};
   const library={count:result.readUInt32LE(48),preview:result.readUInt32LE(52),reserved:result.readUInt32LE(56)};
   const pointer={x:(await rpc.read(prep.controls.mapped+816,8)).readFloatLE(0),y:(await rpc.read(prep.controls.mapped+820,4)).readFloatLE(0),cursor:(await rpc.read(prep.controls.mapped+1004,4)).readUInt32LE(0)};
   const tick=(await rpc.read(prep.controls.mapped+976,8)).readUInt32LE(0);
   const launch=test.wantLaunch===undefined?null:(await rpc.read(prep.controls.mapped+1012,4)).readUInt32LE();
   const dark=(await rpc.read(prep.controls.mapped+1008,4)).readUInt32LE(0),darkLevel=(await rpc.read(prep.controls.mapped+968,4)).readFloatLE(0);
   const passed=(test.wantLaunch===undefined||launch===test.wantLaunch)&&(test.wantTicks===undefined||tick===test.wantTicks)&&selection===test.want&&result.readFloatLE(4)===selection&&modal===(test.wantModal||0)&&frames===(test.steps||1)&&result.readFloatLE()>0&&
    (refresh.remaining>0)===!!test.wantBusy&&refresh.requests===(test.wantRequests||0)&&refresh.completions===(test.wantCompletions||0)&&
    (test.wantBusy?refresh.angle>0:refresh.angle===0)&&library.reserved===(test.wantReserved||0)&&
    library.count===(test.wantCount===undefined?(test.count===undefined?3:test.count):test.wantCount)&&library.preview===(test.wantPreview||0)&&
    dark===(test.wantDark||0)&&(test.wantDarkLevel===undefined||darkLevel>=test.wantDarkLevel)&&
    (test.wantPointerX===undefined||pointer.x===test.wantPointerX)&&(test.wantPointerY===undefined||pointer.y===test.wantPointerY)&&(test.wantCursor===undefined||pointer.cursor===test.wantCursor);
   report.cases.push({name:test.name,selection,tick,modal,frames,refresh,library,pointer,dark,darkLevel,passed});await save();check(passed,'GPU launcher check failed: '+test.name);
  }
  report.passed=true;console.log('GPU checks passed: '+report.cases.length+' launcher cases. Apps use independent compute pipelines.');
 }finally{
  const initial=Buffer.alloc(1024);initial.writeUInt32LE(prep.titleCount||0,112);initial.writeUInt32LE(prep.titleCount||0,1020);initial.writeFloatLE(1,960);await rpc.write(prep.controls.mapped,initial);await put(0,saved);report.scratchRestored=(await rpc.read(p,saved.length)).equals(saved);report.completed=new Date().toISOString();await save();
 }
}
if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});
