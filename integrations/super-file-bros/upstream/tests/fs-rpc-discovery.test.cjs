const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {discover}=require('../tools/fs-rpc-browser/discovery.cjs');
const {createBroker}=require('../tools/dolphin-fs-rpc/service.cjs');
test('a saved held session is validated before automatic reuse, and failed validation never becomes connected',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fs-discover-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const run=path.join(root,'held');await fs.mkdir(path.join(run,'switch2'),{recursive:true});
 await fs.writeFile(path.join(run,'connection.json'),JSON.stringify({addresses:{session:'live'}}));
 await fs.writeFile(path.join(run,'switch2/fs-execution-current.json'),JSON.stringify({session:'live',verified:true,restored:true,cleanup:{deferred:true},retainedEndpoint:{ready:true,session:'live'}}));
 const options={root,settings:{run,host:'10.42.0.20'},preflight:async()=>({ready:true}),findSession:async()=>{throw Error('Unavailable');}};
 assert.deepEqual(await discover(options),{run:await fs.realpath(run),host:'10.42.0.20',source:'saved'});
 await assert.rejects(discover({...options,preflight:async()=>({ready:false})}),/No active FS RPC/);
});
test('a portable folder beside RUN20 discovers its active session without manual fields',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'fs-nearby-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'fs-rpc-browser'),run20=path.join(parent,'iz2s-platform-run20');
 await fs.mkdir(path.join(run20,'data/state/attempts'),{recursive:true});
 const detected=await discover({root,settings:{},preflight:async()=>({ready:true}),findSession:async(candidate,preflight,options)=>{
  assert.equal(candidate,run20);assert.equal(options.standalone,false);return {run:'/held/live',host:'10.42.0.20'};
 }});
 assert.deepEqual(detected,{run:'/held/live',host:'10.42.0.20',source:'detected'});
});
test('health status responds immediately while a slow filesystem command holds the operation queue',async()=>{
 let entered,finish;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>finish=resolve);
 const broker=createBroker({persist:async()=>{},library:{findSession:async()=>({identity:'live'}),gamesFor:async()=>[],
  exportStorage:async(session,options)=>{options.storageReady({list:async()=>{entered();await gate;return [];}});await options.ready({});await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));}}});
 await broker.handle({method:'start-storage'});await new Promise(resolve=>setImmediate(resolve));
 const browse=broker.handle({method:'browse',path:'/'});await started;
 const status=await Promise.race([broker.handle({method:'status'}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Health was blocked')),100))]);
 assert.equal(status.status,'ready');finish();await browse;await broker.close();
});
test('nearby ns2jb2/ns2jb run folders are detected without a saved path; unavailable newer sessions are skipped',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'sfb-upstream-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'super-file-bros');
 async function writeRun(project,id,valid){
  const run=path.join(parent,project,'runs',id);await fs.mkdir(path.join(run,'switch2'),{recursive:true});
  await fs.writeFile(path.join(run,'connection.json'),JSON.stringify({addresses:{session:id}}));
  await fs.writeFile(path.join(run,'switch2/fs-execution-current.json'),JSON.stringify({session:id,verified:valid,restored:true,cleanup:{deferred:true},retainedEndpoint:{ready:true,session:id}}));
  return run;
 }
 const good=await writeRun('ns2jb2','switch2-good',true);await writeRun('ns2jb','switch2-closed',false);
 const selected=await discover({root,settings:{},preflight:async()=>({ready:true}),findSession:async()=>{throw Error('No integration');}});
 assert.deepEqual(selected,{run:await fs.realpath(good),host:'',source:'detected'});
 const saved=await discover({root,settings:{run:good,host:'192.168.1.20'},preflight:async()=>({ready:true})});
 assert.equal(saved.source,'saved');assert.equal(saved.host,'192.168.1.20');
});
