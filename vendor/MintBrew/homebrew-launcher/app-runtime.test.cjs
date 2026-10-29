const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {create}=require('./app-runtime.cjs');
test('Rescan, load, return, cache, removal and version reload use package data',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hb-runtime-test-')),root=path.join(directory,'apps');await fs.mkdir(root);
 await fs.cp(path.resolve(__dirname,'../apps/hello-world'),path.join(root,'hello-world'),{recursive:true});
 const capacity=8*1024*1024,memory=Buffer.alloc(capacity+4096),mapped=0x100000;memory.writeUInt32LE(1,112);memory.writeUInt32LE(1,1020);
 memory.writeUInt32LE(7,976);memory.writeUInt32LE(8,980);
 let captureAudioSourceAtRestore=false,audioSourceAtRestore;
 const rpc={a:{session:'test-session'},async read(p,n){assert.ok(p>=mapped&&p+n<=mapped+memory.length);return Buffer.from(memory.subarray(p-mapped,p-mapped+n));},async write(p,b){assert.ok(p>=mapped&&p+b.length<=mapped+memory.length);b.copy(memory,p-mapped);if(captureAudioSourceAtRestore&&p===mapped)audioSourceAtRestore=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json'))).package.id;}};
 const prepared=[],menu={catalog:{root},controls:{mapped,bytes:capacity},commands:[['11','12','13']]};
 const runtime=await create({rpc,menu,directory,prepareApp:async(r,m,app)=>{prepared.push({id:app.id,bytes:app.files.compute.bytes.length});return {ready:true,scratchRestored:true,commands:[['21','22','23']],...(app.files.memory?{privateStorage:{mapped:mapped+capacity,bytes:4096}}:{})};}});
 assert.equal(memory.readUInt32LE(112),1);assert.equal(runtime.report.catalog.apps[0].name,'Hello World');
 let menuAudio=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 assert.equal(menuAudio.package.id,'mintbrew-menu');
 assert.ok((await fs.readFile(menuAudio.package.effects[8])).some(byte=>byte!==0));
 memory.writeUInt32LE(1,1012);assert.deepEqual(await runtime.afterBatch(),['21','22','23']);assert.equal(runtime.active.app.id,'hello-world');assert.equal(prepared.length,1);assert.equal(memory.readFloatLE(960),1);
 let audio=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));assert.equal(audio.package.id,'hello-world');
 memory.writeUInt32LE(13,976);memory.writeUInt32LE(8,980);memory.writeUInt32LE(1,1016);captureAudioSourceAtRestore=true;
 assert.deepEqual(await runtime.afterBatch(),menu.commands[0]);captureAudioSourceAtRestore=false;
 assert.equal(runtime.active,null);assert.equal(memory.readFloatLE(964),0);
 assert.equal(audioSourceAtRestore,'hello-world','menu state restores before changing sound source');
 assert.equal(memory.readUInt32LE(976),0,'old menu sound sequence is cleared');
 assert.equal(memory.readUInt32LE(980),0,'old menu sound kind is cleared');
 menuAudio=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 assert.equal(menuAudio.package.id,'mintbrew-menu');
 memory.writeUInt32LE(1,1012);await runtime.afterBatch();assert.equal(prepared.length,1);memory.writeUInt32LE(1,1016);await runtime.afterBatch();
 const manifest=path.join(root,'hello-world/app.json'),m=JSON.parse(await fs.readFile(manifest));m.version='1.0.1';m.name='Changed App';m.transition='none';await fs.writeFile(manifest,JSON.stringify(m));
 m.memory={bytes:4096,initial:'assets/private.bin',encoding:'deflate'};await fs.writeFile(path.join(root,'hello-world/assets/private.bin'),require('node:zlib').deflateSync(Buffer.alloc(4096,7)));await fs.writeFile(manifest,JSON.stringify(m));
 memory.writeFloatLE(memory.readFloatLE(104)+1,104);await runtime.afterBatch();assert.equal(runtime.report.catalog.apps[0].name,'Changed App');
 memory.writeUInt32LE(1,1012);await runtime.afterBatch();assert.equal(prepared.length,2);assert.equal(memory.readFloatLE(960),0);memory.writeUInt32LE(1,1016);await runtime.afterBatch();assert.equal(memory.readFloatLE(960),1);assert.equal(memory.readFloatLE(964),0);
 assert.ok(memory.subarray(capacity).every(v=>v===7));memory.fill(9,capacity);memory.writeUInt32LE(1,1012);await runtime.afterBatch();assert.ok(memory.subarray(capacity).every(v=>v===7));assert.equal(prepared.length,2);memory.writeUInt32LE(1,1016);await runtime.afterBatch();
 await fs.rename(path.join(root,'hello-world'),path.join(root,'.removed'));memory.writeFloatLE(memory.readFloatLE(104)+1,104);await runtime.afterBatch();assert.equal(memory.readUInt32LE(112),0);assert.equal(memory.readFloatLE(96),0);
 await fs.writeFile(path.join(root,'.DS_Store'),'finder metadata');
 await fs.rename(path.join(root,'.removed'),path.join(root,'hello-world'));memory.writeFloatLE(memory.readFloatLE(104)+1,104);await runtime.afterBatch();
 assert.deepEqual(runtime.report.catalog.apps.map(app=>app.id),['hello-world']);assert.deepEqual(runtime.report.catalog.rejected,[]);
 memory.writeUInt32LE(1,1012);await runtime.afterBatch();assert.equal(runtime.active.app.id,'hello-world');
 memory.writeUInt32LE(1,1016);await runtime.afterBatch();
 await fs.rename(path.join(root,'hello-world'),path.join(root,'.removed'));memory.writeFloatLE(memory.readFloatLE(104)+1,104);await runtime.afterBatch();
 assert.deepEqual(runtime.report.catalog.apps,[]);
 memory.writeUInt32LE(1,1012);await runtime.afterBatch();assert.equal(runtime.active,null);
 assert.equal(runtime.report.transitions.filter(e=>e.event==='launch').length,5);
});
test('Changed/broken packages return to a usable menu instead of dispatching',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hb-runtime-fail-')),root=path.join(directory,'apps');await fs.mkdir(root);await fs.cp(path.resolve(__dirname,'../apps/hello-world'),path.join(root,'hello-world'),{recursive:true});
 const memory=Buffer.alloc(8*1024*1024),rpc={a:{session:'test'},read:async(p,n)=>Buffer.from(memory.subarray(p,p+n)),write:async(p,b)=>{b.copy(memory,p);}};
 const menu={catalog:{root},controls:{mapped:0,bytes:memory.length},commands:[['1']]};let dispatched=false;
 const runtime=await create({rpc,menu,directory,prepareApp:async()=>{dispatched=true;throw Error('Must not run');}});
 await fs.writeFile(path.join(root,'hello-world/app.comp.spv'),Buffer.alloc(20));memory.writeUInt32LE(1,1012);assert.deepEqual(await runtime.afterBatch(),['1']);assert.equal(dispatched,false);assert.equal(memory.readUInt32LE(112),0);assert.equal(memory.readUInt32LE(92),1);assert.equal(runtime.active,null);
});
test('Host hold request returns through the normal menu transition',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hb-runtime-hold-')),root=path.join(directory,'apps');await fs.mkdir(root);
 await fs.cp(path.resolve(__dirname,'../apps/hello-world'),path.join(root,'hello-world'),{recursive:true});
 const memory=Buffer.alloc(8*1024*1024),rpc={a:{session:'test'},read:async(p,n)=>Buffer.from(memory.subarray(p,p+n)),write:async(p,b)=>{b.copy(memory,p);}};
 const menu={catalog:{root},controls:{mapped:0,bytes:memory.length},commands:[['menu']]};
 const runtime=await create({rpc,menu,directory,prepareApp:async()=>({ready:true,scratchRestored:true,commands:[['app']]})});
 memory.writeUInt32LE(1,1012);assert.deepEqual(await runtime.afterBatch(),['app']);
 assert.equal(memory.readUInt32LE(1016),0);
 assert.deepEqual(await runtime.afterBatch({returnRequested:true}),['menu']);
 assert.equal(runtime.active,null);
 assert.equal(runtime.report.transitions.at(-1).event,'return');
 assert.equal(memory.readUInt32LE(1016),0);
 memory.writeUInt32LE(1,1012);assert.deepEqual(await runtime.afterBatch(),['app']);
 assert.deepEqual(await runtime.afterBatch({returnRequested:true,failure:Error('stream service failed')}),['menu']);
 assert.equal(runtime.active,null);
 assert.equal(memory.readUInt32LE(92),1);
 assert.equal(runtime.report.transitions.at(-1).error,'stream service failed');
});
test('MintFTP keeps title FTP alive for the OunceCake game list and stops it before game selection',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hb-runtime-mintftp-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'apps');await fs.mkdir(root);
 await fs.cp(path.resolve(__dirname,'../../../integrations/mintbrew-file-explorer/app'),path.join(root,'mintftp'),{recursive:true});
 await fs.cp(path.resolve(__dirname,'../apps/ouncecake'),path.join(root,'ouncecake'),{recursive:true});
 await fs.writeFile(path.join(directory,'mintbrew-host.json'),JSON.stringify({runDirectory:'/test/run',sourceSession:'held-test'}));
 const mapped=0x100000,capacity=8*1024*1024,memory=Buffer.alloc(capacity+16*1024*1024);
 const rpc={a:{session:'test-session'},read:async(p,n)=>Buffer.from(memory.subarray(p-mapped,p-mapped+n)),
  write:async(p,b)=>{b.copy(memory,p-mapped);}};
 const events=[],menu={catalog:{root},controls:{mapped,bytes:capacity},commands:[['menu']]};
 const mintftp={start:async()=>{},handoff(){events.push('handoff');return this;},
  stopForGame:async()=>events.push('stop title ftp'),close:async()=>events.push('close title ftp')};
 const ouncecake={start:async()=>{},select:async index=>events.push('select game '+index),
  back:async()=>{},close:async()=>events.push('close game ftp')};
 const runtime=await create({rpc,menu,directory,root:path.resolve(__dirname,'../../..'),
  prepareApp:async(r,m,app)=>({ready:true,scratchRestored:true,commands:[['app']],
   ...(app.files.memory?{privateStorage:{mapped:mapped+capacity,bytes:app.files.memory.allocationBytes}}:{})}),
  createMintFtp:()=>mintftp,createOunceCake:()=>ouncecake});
 const catalog=runtime.report.catalog.apps;
 memory.writeUInt32LE(catalog.findIndex(app=>app.id==='mintftp')+1,1012);
 await runtime.afterBatch();assert.equal(runtime.active.app.id,'mintftp');
 memory.writeUInt32LE(0x4d465447,784);memory.writeUInt32LE(1,1016);
 await runtime.afterBatch();assert.equal(runtime.active.app.id,'ouncecake');
 assert.deepEqual(events,['handoff']);
 let source=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 assert.equal(source.package.id,'ouncecake');assert.equal(source.ftpOwner.id,'mintftp');
 memory.writeUInt32LE(1,1012);await runtime.afterBatch();
 assert.deepEqual(events,['handoff','stop title ftp','select game 0']);
 memory.writeUInt32LE(1,1016);await runtime.afterBatch();
 assert.deepEqual(events,['handoff','stop title ftp','select game 0','close game ftp','close title ftp']);
 source=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 assert.equal(source.ftpOwner,undefined);assert.equal(runtime.active,null);
});
test('MintNES publishes its APU snapshot and event mailboxes to the audio bridge',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hb-runtime-mintnes-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'apps');await fs.mkdir(root);
 await fs.cp(path.resolve(__dirname,'../apps/mintnes'),path.join(root,'mintnes'),{recursive:true});
 const layout=require('../apps/mintnes/layout.cjs');
 const mapped=0x100000,capacity=8*1024*1024,privateMapped=mapped+capacity;
 const memory=Buffer.alloc(capacity+layout.bytes);
 const rpc={a:{session:'test-session'},read:async(p,n)=>Buffer.from(memory.subarray(p-mapped,p-mapped+n)),
  write:async(p,b)=>{b.copy(memory,p-mapped);}};
 const menu={catalog:{root},controls:{mapped,bytes:capacity},commands:[['menu']]};
 const runtime=await create({rpc,menu,directory,
  prepareApp:async()=>({ready:true,scratchRestored:true,commands:[['app']],
   privateStorage:{mapped:privateMapped,bytes:layout.bytes}}),
  createMintNes:async()=>({start:async()=>{},pending:async()=>false,close:async()=>{}})});
 memory.writeUInt32LE(1,1012);await runtime.afterBatch();
 const source=JSON.parse(await fs.readFile(path.join(directory,'game-audio-source.json')));
 assert.equal(source.package.id,'mintnes');
 assert.equal(source.apuMapped,privateMapped+layout.apuBase*4);
 assert.equal(source.apuBytes,(layout.apuFrame-layout.apuBase+1)*4);
 assert.equal(source.apuEventsMapped,privateMapped+layout.apuEventBase*4);
 assert.equal(source.apuEventsBytes,layout.apuEventCount*3*4);
});
