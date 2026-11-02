const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const preparation=require('./prepare.cjs'),service=require('./service.cjs');
const catalog=require('../../vendor/MintBrew/homebrew-launcher/app-catalog.cjs');
const {create}=require('../../vendor/MintBrew/homebrew-launcher/app-runtime.cjs');
const repository=path.resolve(__dirname,'../..');

test('Staged File Exchange is identical to the IZ2S module and loads in MintBrew',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mintbrew-exchange-stage-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'apps'));
 preparation.prepareMintBrew(repository,root);
 const app=await catalog.readApp(path.join(root,'apps/iz-exchange'));
 assert.equal(app.manifest.hostRuntime,'module:iz-exchange/runtime');
 assert.equal(app.files.compute.bytes.readUInt32LE(),0x07230203);
 const file=path.join(root,'apps/iz-exchange/assets/data.bin');
 await fs.writeFile(file,Buffer.from('changed'));
 assert.throws(()=>preparation.verifyMintBrew(repository,root),/Changed File Exchange runtime app file/);
});

test('File Exchange service uses the MintBrew mapping and fits its storage',async()=>{
 const rpc={a:{session:'offline'}},app={id:'iz-exchange',manifest:{hostRuntime:'module:iz-exchange/runtime'}};
 const menu={controls:{mapped:0x100000,bytes:8*1024*1024}},calls=[];
 const result=await service.create({rpc,menu,directory:'/tmp/offline',root:repository,app,
  createRuntime:async options=>{calls.push(options);return {close:async()=>{}};}});
 assert.equal(typeof result.close,'function');
 assert.deepEqual(calls,[{rpc,mapped:menu.controls.mapped,directory:'/tmp/offline',app}]);
 await assert.rejects(service.create({rpc,menu:{controls:{mapped:0,bytes:4096}},directory:'/tmp/offline',root:repository,app,createRuntime:async()=>{}}),/mailbox exceeds/);
 await assert.rejects(service.create({rpc,menu,directory:'/tmp/offline',root:repository,
  app:{id:'other',manifest:app.manifest},createRuntime:async()=>{}}),/Unsupported File Exchange runtime/);
});

test('IZ2S File Exchange host service publishes, navigates and closes on MintBrew mapping',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mintbrew-exchange-service-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const layout=require('../../vendor/IZ2S-Platform/modules/iz-exchange/server/layout.cjs');
 const runtime=require('../../vendor/IZ2S-Platform/modules/iz-exchange/server/runtime.cjs');
 const mapped=0x100000,request=Buffer.alloc(16),writes=[],events=[];
 const rpc={a:{session:'offline'},read:async(p,n)=>{
  assert.equal(p,mapped+layout.OFFSET);assert.equal(n,16);return Buffer.from(request);
 },write:async(p,b)=>{writes.push({p,bytes:Buffer.from(b)});}};
 const native={storage:{list:async location=>location==='/'?
  [{name:'save',type:'dir',size:0}]:[{name:'sample.sav',type:'file',size:128}]}};
 const server={state:{running:false,port:2121,address:'192.0.2.2',clients:0},
  async start(port){assert.equal(port,2121);this.state.running=true;events.push('start');},
  async stop(){this.state.running=false;events.push('stop');},async pump(){events.push('pump');}};
 const instance=await runtime.create({rpc,mapped,directory,native,createServer:()=>server});
 assert.deepEqual(events.slice(0,1),['start']);
 assert.equal(writes[0].p,mapped+layout.OFFSET+64);
 assert.equal(writes[0].bytes.readUInt32LE(),layout.MAGIC);
 request.writeUInt32LE(1);request.writeUInt32LE(2,4);request.writeUInt32LE(0,8);
 assert.equal(await instance.pending(),true);
 await instance.afterBatch();
 const state=JSON.parse(await fs.readFile(path.join(directory,'file-exchange.json')));
 assert.equal(state.cwd,'/save');assert.equal(state.entries,1);
 await instance.close();
 assert.equal(events.includes('stop'),true);
 assert.equal(JSON.parse(await fs.readFile(path.join(directory,'file-exchange.json'))).active,false);
});

test('MintBrew launches File Exchange and returns to menu in the same session',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mintbrew-exchange-lifecycle-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'apps');await fs.mkdir(root);
 await fs.cp(path.join(repository,'vendor/IZ2S-Platform/modules/iz-exchange/switch'),path.join(root,'iz-exchange'),{recursive:true});
 await fs.cp(path.join(repository,'vendor/MintBrew/apps/hello-world'),path.join(root,'hello-world'),{recursive:true});
 const memory=Buffer.alloc(8*1024*1024),events=[];
 const rpc={a:{session:'offline'},read:async(p,n)=>Buffer.from(memory.subarray(p,p+n)),
  write:async(p,b)=>{b.copy(memory,p);}};
 const menu={catalog:{root},controls:{mapped:0,bytes:memory.length},commands:[['menu']]};
 const runtime=await create({rpc,menu,directory,root:repository,
  prepareApp:async(_rpc,_menu,app)=>({ready:true,scratchRestored:true,commands:[[app.id]]}),
  createIzExchange:async()=>({pending:async()=>true,afterBatch:async()=>events.push('batch'),close:async()=>events.push('close')})});
 const index=runtime.report.catalog.apps.findIndex(app=>app.id==='iz-exchange');
 assert.ok(index>=0);
 memory.writeUInt32LE(index+1,1012);
 assert.deepEqual(await runtime.afterBatch(),['iz-exchange']);
 assert.equal(await runtime.active.service.pending(),true);
 await runtime.afterBatch();
 assert.deepEqual(events,['batch']);
 assert.deepEqual(await runtime.afterBatch({returnRequested:true}),['menu']);
 assert.deepEqual(events,['batch','close']);
 assert.equal(runtime.active,null);
 const hello=runtime.report.catalog.apps.findIndex(app=>app.id==='hello-world');
 memory.writeUInt32LE(hello+1,1012);
 assert.deepEqual(await runtime.afterBatch(),['hello-world']);
 await runtime.close();
 assert.deepEqual(events,['batch','close']);
});
