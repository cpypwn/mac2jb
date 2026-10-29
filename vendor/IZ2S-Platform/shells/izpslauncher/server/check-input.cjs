// Exercise navigation against the actual console compute shader before live input.
const fs=require('node:fs/promises'),path=require('node:path');
const {journal}=require('../../../core/services/journal.cjs');
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
   {"name":"D-pad right","buttons":16384,"selection":0,"want":1},
   {"name":"D-pad wraps right","buttons":16384,"selection":2,"want":0},
   {"name":"D-pad wraps left","buttons":4096,"selection":0,"want":2},
   {"name":"Held button is not repeated","buttons":16384,"previous":16384,"selection":1,"want":1},
   {"name":"Stick right","stick":32767,"selection":0,"want":1},
   {"name":"Stick left","stick":-32767,"selection":1,"want":0},
   {"name":"Stick repeat cooldown","stick":32767,"cooldown":0.2,"selection":1,"want":1},
   {"name":"Vertical D-pad leaves horizontal selection unchanged","buttons":32768,"selection":1,"want":1},
   {"name":"Vertical stick leaves horizontal selection unchanged","stickY":32767,"selection":1,"want":1},
   {"name":"A opens empty tile","buttons":1,"selection":2,"want":2,"wantModal":1},
   {"name":"B closes empty tile","buttons":2,"modal":1,"selection":2,"want":2},
   {"name":"Modal holds selection","buttons":16384,"modal":1,"selection":1,"want":1,"wantModal":1},
   {"name":"Disconnected input ignored","connected":false,"buttons":16384,"selection":1,"want":1},
   {"name":"Touch selects third tile","touch":[640,400],"selection":0,"want":2},
   {"name":"Ending touch ignored","touch":[640,400],"ending":true,"selection":0,"want":0},
   {"name":"Removed refresh area ignores touch","touch":[1107,119],"selection":1,"want":1},
   {"name":"Holding removed refresh area stays idle","touch":[1107,119],"selection":1,"want":1,"steps":80},
   {"name":"Direct touch from third to first tile","touch":[192,400],"selection":2,"want":0},
   {"name":"First horizontal gap does not select","touch":[304,400],"selection":0,"want":0},
   {"name":"Second horizontal gap does not select","touch":[528,400],"selection":2,"want":2},
   {"name":"Space above tiles does not select","touch":[192,216],"selection":2,"want":2},
   {"name":"Caption below tile does not select","touch":[192,578],"selection":2,"want":2},
   {"name":"Rounded corner does not select","touch":[107,251],"selection":2,"want":2},
   {"name":"Touch selects second tile","touch":[416,400],"selection":0,"want":1},
   {"name":"Tile top edge selects inside","touch":[192,251],"selection":2,"want":0},
   {"name":"Single-title D-pad stays on title","count":1,"buttons":16384,"selection":0,"want":0},
   {"name":"Two-title wrap uses actual count","count":2,"buttons":16384,"selection":1,"want":0},
   {"name":"Empty library ignores D-pad","count":0,"buttons":16384,"selection":2,"want":0},
   {"name":"Empty library ignores A","count":0,"buttons":1,"selection":0,"want":0},
   {"name":"Empty library ignores tile taps","count":0,"touch":[640,400],"selection":0,"want":0},
   {"name":"Empty library ignores removed refresh area","count":0,"touch":[1107,119],"selection":0,"want":0},
   {"name":"Left selects previous tile without changing catalog","installed":3,"count":3,"buttons":4096,"selection":2,"want":1,"wantCount":3},
   {"name":"Installed app request waits for fade","installed":2,"count":2,"buttons":1,"selection":1,"want":1,"steps":20,"wantLaunch":2},
   {"name":"More than one page wraps left correctly","installed":7,"count":7,"buttons":4096,"selection":0,"want":6},
   {"name":"Right reaches the next page","installed":7,"count":7,"buttons":16384,"selection":4,"want":5},
   {"name":"Touch on second page selects global app index","installed":7,"count":7,"touch":[192,400],"selection":6,"want":5},
   {"name":"Absent tile on partial page ignores touch","installed":6,"count":6,"touch":[416,400],"selection":5,"want":5},
   {"name":"Last partial page wraps right","installed":6,"count":6,"buttons":16384,"selection":5,"want":0},
   {"name":"Touch on real app starts fade once","installed":3,"count":3,"touch":[416,400],"selection":0,"want":1,"steps":1,"wantLaunch":0},
   {"name":"Touch selects fourth portrait tile","installed":5,"count":5,"touch":[864,400],"selection":0,"want":3},
   {"name":"Touch selects fifth portrait tile","installed":5,"count":5,"touch":[1088,400],"selection":0,"want":4},
   {"name":"Third portrait gap ignores touch","installed":5,"count":5,"touch":[752,400],"selection":1,"want":1},
   {"name":"Fourth portrait gap ignores touch","installed":5,"count":5,"touch":[976,400],"selection":1,"want":1}
  ];
  for(const test of cases){
   const input=Buffer.alloc(1024);input.writeUInt32LE(test.buttons||0,8);input.writeUInt32LE(test.connected===false?0:1,32);input.writeInt32LE(test.stick||0,16);input.writeInt32LE(test.stickY||0,20);
   input.writeFloatLE(test.cooldown||0,76);input.writeUInt32LE(test.selection,80);input.writeUInt32LE(test.previous||0,84);input.writeUInt32LE(test.modal||0,92);
   input.writeFloatLE(test.busy||0,96);input.writeFloatLE(test.requests||0,104);input.writeUInt32LE(test.heldTouch?1:0,124);
   input.writeUInt32LE(test.count===undefined?3:test.count,112);
   input.writeUInt32LE(test.reserved||0,120);
   input.writeUInt32LE(test.installed||0,1020);
   if(test.touch){input.writeUInt32LE(1,136);input.writeUInt32LE(test.ending?2:0,152);input.writeUInt32LE(test.touch[0],160);input.writeUInt32LE(test.touch[1],164);}
   await rpc.write(prep.controls.mapped,input);
   for(let step=0;step<(test.steps||1);step++){await ok('vkQueueSubmit',queue,1,p+0x400,0);await ok('vkQueueWaitIdle',queue);}
   const result=await rpc.read(prep.controls.mapped+64,64),selection=result.readUInt32LE(16),modal=result.readUInt32LE(28),frames=result.readUInt32LE(24);
   const refresh={remaining:result.readFloatLE(32),angle:result.readFloatLE(36),requests:result.readFloatLE(40),completions:result.readFloatLE(44)};
   const library={count:result.readUInt32LE(48),preview:result.readUInt32LE(52),reserved:result.readUInt32LE(56)};
   const launch=test.wantLaunch===undefined?null:(await rpc.read(prep.controls.mapped+1012,4)).readUInt32LE();
   const passed=(test.wantLaunch===undefined||launch===test.wantLaunch)&&selection===test.want&&result.readFloatLE(4)===selection&&modal===(test.wantModal||0)&&frames===(test.steps||1)&&result.readFloatLE()>0&&
    (refresh.remaining>0)===!!test.wantBusy&&refresh.requests===(test.wantRequests||0)&&refresh.completions===(test.wantCompletions||0)&&
    (test.wantBusy?refresh.angle>0:refresh.angle===0)&&library.reserved===(test.wantReserved||0)&&
    library.count===(test.wantCount===undefined?(test.count===undefined?3:test.count):test.wantCount)&&library.preview===(test.wantPreview||0);
   report.cases.push({name:test.name,selection,modal,frames,refresh,library,passed});await save();check(passed,'GPU launcher check failed: '+test.name);
  }
  report.passed=true;console.log('GPU checks passed: '+report.cases.length+' launcher cases.');
 }finally{
  const initial=Buffer.alloc(1024);initial.writeUInt32LE(prep.titleCount||0,112);initial.writeUInt32LE(prep.titleCount||0,1020);initial.writeFloatLE(1,960);await rpc.write(prep.controls.mapped,initial);await put(0,saved);report.scratchRestored=(await rpc.read(p,saved.length)).equals(saved);report.completed=new Date().toISOString();await save();
 }
}
if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});

module.exports = {main};
