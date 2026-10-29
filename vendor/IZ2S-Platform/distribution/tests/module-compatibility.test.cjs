const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../..'),compatibility=require('../../core/compatibility.cjs'),descriptors=require('../../core/descriptors.cjs');
const shell=require('../../shells/izpslauncher/shell.json');
const moduleDescriptor={platforms:['linux-x64'],switch:{abi:1},requires:{platformApi:1,consoleAbi:1,shell:'izlauncher'}};
const options={shell:'izpslauncher',shellDescriptor:shell,platform:'linux-x64'};
test('IZPSlauncher accepts the explicitly declared IZlauncher module format',()=>{assert.equal(compatibility.moduleCompatibility(moduleDescriptor,options).supported,true);assert.equal(compatibility.moduleCompatibility({...moduleDescriptor,requires:{...moduleDescriptor.requires,shell:['other','izlauncher']}},options).supported,true);});
test('module compatibility does not bypass host, ABI or unrelated shell checks',()=>{
 assert.equal(compatibility.moduleCompatibility(moduleDescriptor,{...options,platform:'win32-x64'}).supported,false);
 assert.equal(compatibility.moduleCompatibility({...moduleDescriptor,switch:{abi:2}},options).supported,false);
 assert.equal(compatibility.moduleCompatibility({...moduleDescriptor,requires:{...moduleDescriptor.requires,consoleAbi:2}},options).supported,false);
 assert.equal(compatibility.moduleCompatibility(moduleDescriptor,{...options,shell:'unrelated'}).supported,false);
 assert.equal(compatibility.moduleCompatibility(moduleDescriptor,{...options,shellDescriptor:{...shell,consoleAbi:2}}).supported,false);
});
test('shell module-format declarations are bounded IDs, not wildcards',()=>{for(const moduleShells of ['izlauncher',['*'],['../izlauncher'],['izlauncher','izlauncher'],Array(17).fill('izlauncher')])assert.throws(()=>descriptors.validate({...shell,moduleShells},'shell','izpslauncher'),/compatibility list/);});
test('startup selection uses the selected shell compatibility as well',async()=>{const preload=require('../../core/session/preload.cjs');assert.deepEqual(await preload.resolve(root,['iz-exchange'],{shell:'izpslauncher'}),['iz-exchange']);await assert.rejects(preload.resolve(root,['iz-exchange'],{shell:'unrelated'}),/incompatible/);});
test('IZPSlauncher child environment exposes the bundled console library and loads a browser-queued package',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'izps-library-regression-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const oldShell=process.env.IZ15_SHELL,oldModern=process.env.IZ2S_SHELL;
 process.env.IZ15_SHELL='izpslauncher';delete process.env.IZ2S_SHELL;
 t.after(()=>{if(oldShell===undefined)delete process.env.IZ15_SHELL;else process.env.IZ15_SHELL=oldShell;if(oldModern===undefined)delete process.env.IZ2S_SHELL;else process.env.IZ2S_SHELL=oldModern;});
 const memory=Buffer.alloc(8*1024*1024),rpc={a:{session:'local-catalog-regression'},read:async(at,size)=>Buffer.from(memory.subarray(at,at+size)),write:async(at,bytes)=>{assert.ok(at>=0&&at+bytes.length<=memory.length);bytes.copy(memory,at);}};
 const menu={controls:{mapped:0,bytes:memory.length},catalog:{root:path.join(directory,'loaded')},commands:[[1]]};
 const runtime={active:null,report:{catalog:{apps:[]},generation:0}};
 const stateRoot=path.join(directory,'queue'),repo=await require('../../core/packages/repository.cjs').create(root),inventory=await repo.list();
 const pkg=inventory.packages.find(p=>p.id==='iz-exchange');assert.ok(pkg?.supported,'The native IZPSlauncher process must not silently discard IZlauncher modules');
 const manager=await require('../../shells/izpslauncher/server/package-manager.cjs').create({root,rpc,menu,runtime,stateRoot,directory,prepareShell:async()=>({ready:true,scratchRestored:true,commands:[[1]]})});
 assert.ok(manager.report.available.some(p=>p.id===pkg.id));assert.ok(memory.readUInt32LE(832)>0,'The console picker must receive a nonempty library');
 if(process.env.IZ2S_LIBRARY_PROOF_DIR){const output=path.resolve(process.env.IZ2S_LIBRARY_PROOF_DIR);await fs.mkdir(output,{recursive:true});const state=Buffer.from(memory.subarray(0,1024));state.writeFloatLE(5,64);state.writeInt32LE(1,800);await fs.writeFile(path.join(output,'library.state.bin'),state);await fs.writeFile(path.join(output,'library.atlas.bin'),memory.subarray(1024));}
 await require('../../core/packages/jobs.cjs').create(stateRoot,pkg,'browser');assert.equal(await manager.pending(memory.subarray(0,1024)),true);
 await manager.perform(memory.subarray(0,1024));
 const catalogTools=require('../../core/services/app-catalog.cjs'),catalog=await catalogTools.scan(menu.catalog.root);assert.equal(catalog.rejected.length,0);assert.deepEqual(catalog.apps.map(a=>a.id),[pkg.id]);
 // Model the existing renderer boundary after the host has refreshed the catalog.
 runtime.report.catalog=catalogTools.summary(catalog);runtime.report.generation++;memory.writeUInt32LE(1,112);memory.writeUInt32LE(1,1020);
 await manager.atBoundary();assert.ok(manager.report.installed.some(app=>app.id===pkg.id));assert.equal((await require('../../core/packages/jobs.cjs').all(stateRoot))[0].status,'ready');assert.ok(memory.readUInt32LE(832)>0);assert.equal(memory.readUInt32LE(112),1);
 await manager.close();
});
