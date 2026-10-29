const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {scan,readApp,summary,raster,SLOT_BYTES,MAX_APPS}=require('./app-catalog.cjs');
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'hb-catalog-test-'));await fs.cp(path.resolve(__dirname,'../apps/hello-world'),path.join(root,'hello-world'),{recursive:true});return root;}
async function edit(root,fn){const file=path.join(root,'hello-world/app.json'),m=JSON.parse(await fs.readFile(file));fn(m);await fs.writeFile(file,JSON.stringify(m));}
test('Discovers complete packages and real shader stages',async()=>{const c=await scan(await fixture());assert.equal(c.apps.length,1);assert.equal(c.apps[0].id,'hello-world');assert.equal(c.rejected.length,0);});
test('Bundled apps keep the requested order while other apps follow them',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mintbrew-order-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const ordered=['stremio-experimental','izdoom','froggy-road','ouncecake','cpu-gpu-probe','hello-world'];
 for(const id of [...ordered,'custom-app']){
  const folder=path.join(root,id);
  await fs.cp(path.resolve(__dirname,'../apps/hello-world'),folder,{recursive:true});
  const manifest=path.join(folder,'app.json'),app=JSON.parse(await fs.readFile(manifest));
  app.id=id;await fs.writeFile(manifest,JSON.stringify(app));
 }
 const catalog=await scan(root);
 assert.deepEqual(catalog.rejected,[]);
 assert.deepEqual(catalog.apps.map(app=>app.id),[...ordered,'custom-app']);
});
test('Adding/removing folders changes the catalog without a launcher edit',async()=>{const root=await fixture(),first=await scan(root);await fs.rename(path.join(root,'hello-world'),path.join(root,'.removed'));assert.equal((await scan(root)).apps.length,0);await fs.rename(path.join(root,'.removed'),path.join(root,'renamed'));assert.equal((await scan(root)).apps[0].fingerprint,first.apps[0].fingerprint);});
test('Manifest edits invalidate the package fingerprint',async()=>{const root=await fixture(),first=await scan(root);await edit(root,m=>m.name='Ocean Tool');assert.notEqual((await scan(root)).apps[0].fingerprint,first.apps[0].fingerprint);});
test('App descriptions shown by MintBrew omit final periods',async()=>{
 const root=await fixture();await edit(root,m=>m.description='Play version 1.2.3...   ');
 const app=await readApp(path.join(root,'hello-world'),{validate:false});
 assert.equal(app.description,'Play version 1.2.3');
 assert.equal(app.manifest.description,'Play version 1.2.3...   ');
 assert.equal(summary({root,apps:[app],rejected:[]}).apps[0].description,'Play version 1.2.3');
});
test('Rejects unsupported ABI without hiding other apps',async()=>{const root=await fixture();await fs.cp(path.join(root,'hello-world'),path.join(root,'bad'),{recursive:true});const file=path.join(root,'bad/app.json'),m=JSON.parse(await fs.readFile(file));m.abi=999;await fs.writeFile(file,JSON.stringify(m));const c=await scan(root);assert.equal(c.apps.length,1);assert.match(c.rejected[0].error,/ABI/);});
test('Rejects traversal and escaping symlinks',async()=>{const root=await fixture();await edit(root,m=>m.icon='../outside.png');assert.equal((await scan(root)).apps.length,0);await edit(root,m=>m.icon='assets/escape');await fs.symlink('/etc/hosts',path.join(root,'hello-world/assets/escape'));assert.match((await scan(root)).rejected[0].error,/escapes/);});
test('Rejects shader stage swaps and corrupt instructions',async()=>{const root=await fixture();await edit(root,m=>m.shaders.compute=m.shaders.fragment);assert.match((await scan(root)).rejected[0].error,/compute/);await edit(root,m=>m.shaders.compute='app.comp.spv');await fs.writeFile(path.join(root,'hello-world/app.comp.spv'),Buffer.alloc(20));assert.match((await scan(root)).rejected[0].error,/SPIR-V/);});
test('Rejects duplicate ids and malformed state sizes',async()=>{const root=await fixture();await fs.cp(path.join(root,'hello-world'),path.join(root,'copy'),{recursive:true});const c=await scan(root);assert.equal(c.apps.length,1);assert.match(c.rejected[0].error,/Duplicate/);await fs.writeFile(path.join(root,'hello-world/assets/state.bin'),Buffer.alloc(16));await assert.rejects(readApp(path.join(root,'hello-world')),/1024/);});
test('Rasterizes full descriptions and icons inside fixed GPU slots',async()=>{
 const root=await fixture();await edit(root,m=>m.description='W'.repeat(160));
 const c=await scan(root),bytes=await raster(c,root,'proof');
 assert.equal(bytes.length,MAX_APPS*SLOT_BYTES);
 assert.ok(bytes.readUInt32LE(126976)>0);
 assert.ok(bytes.readUInt32LE(126984)>1080);
 assert.ok(bytes.readUInt32LE(126984)<=2044);
 assert.ok(bytes.subarray(24576,90112).some((v,i)=>i%2048>1500&&v!==0));
 assert.ok(bytes.subarray(90112,126976).some(v=>v!==0));
});
test('Rejects malformed icons before catalog rendering',async()=>{const root=await fixture();await fs.writeFile(path.join(root,'hello-world/assets/icon.png'),Buffer.from('not an image'));const c=await scan(root);assert.equal(c.apps.length,0);assert.match(c.rejected[0].error,/PNG/);});
test('Catalog rendering uses captured icons even after a folder is removed',async()=>{const root=await fixture(),c=await scan(root);await fs.rename(path.join(root,'hello-world'),path.join(root,'.removed'));assert.equal((await raster(c,root,'snapshot')).length,MAX_APPS*SLOT_BYTES);});
test('Validates bounded compressed private GPU memory images',async()=>{
 const root=await fixture(),{deflateSync}=require('node:zlib');await fs.writeFile(path.join(root,'hello-world/assets/memory.bin'),deflateSync(Buffer.alloc(4096,7)));
 await edit(root,m=>m.memory={bytes:4096,initial:'assets/memory.bin',encoding:'deflate'});let c=await scan(root);assert.equal(c.apps[0].files.memory.bytes.length,4096);assert.equal(c.apps[0].files.memory.bytes[0],7);
 await edit(root,m=>m.memory.bytes=2048);assert.match((await scan(root)).rejected[0].error,/memory size/);
 await edit(root,m=>m.memory.bytes=4096);await fs.writeFile(path.join(root,'hello-world/assets/memory.bin'),deflateSync(Buffer.alloc(8192)));assert.equal((await scan(root)).apps.length,0);
 await edit(root,m=>m.memory={bytes:4096,initial:'../../outside',encoding:'deflate'});assert.match((await scan(root)).rejected[0].error,/inside/);
});
test('Accepts only a bounded CPU counter bridge in private GPU memory',async t=>{
 const root=await fixture(),folder=path.join(root,'hello-world');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(folder,'assets/memory.bin'),Buffer.alloc(16));
 await edit(root,m=>{m.memory={bytes:4096,initial:'assets/memory.bin'};m.cpuBridge={kind:'counter-v1',offset:0};});
 assert.deepEqual((await readApp(folder,{validate:false})).manifest.cpuBridge,{kind:'counter-v1',offset:0});
 await edit(root,m=>m.cpuBridge.offset=4080);
 await readApp(folder,{validate:false});
 for(const offset of [-8,1,4090,4096,1.5,null,'0']){
  await edit(root,m=>m.cpuBridge.offset=offset);
  await assert.rejects(readApp(folder,{validate:false}),/CPU counter bridge mailbox/);
 }
 await edit(root,m=>m.cpuBridge={kind:'counter-v2',offset:0});
 await assert.rejects(readApp(folder,{validate:false}),/CPU counter bridge mailbox/);
 await edit(root,m=>m.cpuBridge={kind:'counter-v1',offset:0,script:'run.cjs'});
 await assert.rejects(readApp(folder,{validate:false}),/CPU counter bridge mailbox/);
 await edit(root,m=>{delete m.memory;m.cpuBridge={kind:'counter-v1',offset:0};});
 await assert.rejects(readApp(folder,{validate:false}),/CPU counter bridge mailbox/);
});
