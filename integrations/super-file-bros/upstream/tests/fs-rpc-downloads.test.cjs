const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const {execFileSync} = require('node:child_process');
function fixture() {
  const data = new Map([['/sd/photos/a.jpg', Buffer.from('photo bytes')], ['/sd/photos/日本語.txt', Buffer.from('hello ✓')]]);
  const dirs = new Map([['/sd/photos', [{name:'a.jpg',type:'file',size:11}, {name:'日本語.txt',type:'file',size:9}, {name:'empty',type:'dir'}]], ['/sd/photos/empty', []]]);
  const calls = []; let file;
  const backend = {request: async (method, value = {}) => {
    calls.push({method, ...value});
    if (method === 'status') return {status:'ready',mode:'storage',lease:'test'};
    if (method === 'stat') return {type: dirs.has(value.path) ? 'dir' : 'file', size:data.get(value.path)?.length || 0};
    if (method === 'retain') return {token:'hold',stat: await backend.request('stat',value)};
    if (method === 'download-open') {file = data.get(value.path); return {size:file.length};}
    if (method === 'download-read') return {data:file.subarray(value.offset,value.offset+value.length).toString('base64')};
    if (method === 'download-list') return {entries:dirs.get(value.path).slice()};
    if (['release','download-close','download-touch'].includes(method)) return {ok:true};
    throw Error(method);
  }};
  return {backend,calls};
}
async function appFor(t, backend) {
  const app = await require('../tools/fs-rpc-browser/server.cjs').create({backend});
  t.after(async () => {app.server.closeAllConnections(); await app.close();});
  const origin = new URL(app.url).origin;
  return {app, origin, post: async (route, data) => fetch(origin+route,{method:'POST',headers:{origin,'x-fs-key':app.token},body:JSON.stringify(data)})};
}
test('direct file download requires an authenticated ticket, sends exact bytes and releases its lease', async t => {
  const {backend,calls} = fixture(), {app,origin,post} = await appFor(t,backend);
  assert.equal((await fetch(origin+'/api/download',{method:'POST',body:'{}'})).status,403);
  const ticket = await (await post('/api/download',{path:'/sd/photos/a.jpg'})).json();
  const response = await fetch(origin+ticket.url);
  assert.equal(response.headers.get('content-disposition').startsWith('attachment;'),true);
  assert.equal(await response.text(),'photo bytes');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(c=>c.method==='release').length,1);
  assert.equal((await fetch(origin+ticket.url)).status,410);
  const records = await (await fetch(origin+'/api/downloads',{headers:{'x-fs-key':app.token}})).json();
  assert.equal(records[0].status,'done'); assert.equal(records[0].bytes,11);
});
test('folder ZIP64 download preserves Unicode, empty folders and CRCs with bounded streaming reads', async t => {
  const {backend,calls}=fixture(), {origin,post}=await appFor(t,backend);
  const ticket = await (await post('/api/download',{path:'/sd/photos'})).json();
  const bytes = Buffer.from(await (await fetch(origin+ticket.url)).arrayBuffer());
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'fs-zip-test-')); t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const archive = path.join(temp,'photos.zip'); await fs.writeFile(archive,bytes);
  const result = JSON.parse(execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),['-c',"import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))",archive],{encoding:'utf8'}));
  assert.deepEqual(result,{'photos/':'','photos/a.jpg':'photo bytes','photos/日本語.txt':'hello ✓','photos/empty/':''});
  assert.ok(calls.filter(c=>c.method==='download-read').every(c=>c.length<=32768));
});
test('cancelled queued tickets cannot start and traversal entries fail rather than producing a successful archive', async t => {
  const {backend}=fixture(), base=backend.request;
  backend.request=async (method,value)=>method==='download-list' ? {entries:[{name:'../escape',type:'file'}]} : base(method,value);
  const {origin,post}=await appFor(t,backend);
  const first = await (await post('/api/download',{path:'/sd/photos/a.jpg'})).json();
  await post('/api/download/cancel',{id:first.id});
  assert.equal((await fetch(origin+first.url)).status,410);
  const second = await (await post('/api/download',{path:'/sd/photos'})).json();
  await assert.rejects(async()=>{const response=await fetch(origin+second.url); await response.arrayBuffer();});
});
test('broker retains storage during transfers, enforces path scope and closes retained handles on release', async () => {
  const {createBroker}=require('../tools/dolphin-fs-rpc/service.cjs'); let closed=0;
  const broker=createBroker({persist:async()=>{},library:{findSession:async()=>({identity:'one',host:'127.0.0.1'}),
    exportStorage:async(session,options)=>{options.storageReady({stat:async()=>({type:'file',size:3}),openRead:async()=>({size:3}),close:async()=>closed++});
      await options.ready({}); await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));}}});
  await broker.handle({method:'start-storage'}); await new Promise(resolve=>setImmediate(resolve));
  const state=await broker.handle({method:'status'});
  const retained=await broker.handle({method:'retain',path:'/sd/one',lease:state.lease});
  await assert.rejects(broker.handle({method:'stop'}),/download is in progress/);
  await assert.rejects(broker.handle({method:'download-open',token:retained.token,path:'/sd/two'}),/outside/);
  await broker.handle({method:'download-open',token:retained.token,path:'/sd/one'});
  await broker.handle({method:'release',token:retained.token}); assert.equal(closed,1);
  await broker.close();
});
test('starting tickets are single use and cancellation releases a lease acquired after cancellation', async t => {
  const {backend,calls}=fixture(), base=backend.request; let retained, resume;
  const began=new Promise(resolve=>retained=resolve), gate=new Promise(resolve=>resume=resolve);
  backend.request=async(method,value)=>{if(method==='retain'){retained();await gate;}return base(method,value);};
  const {origin,post}=await appFor(t,backend);
  const ticket=await (await post('/api/download',{path:'/sd/photos/a.jpg'})).json();
  const first=fetch(origin+ticket.url).then(r=>r.arrayBuffer()).catch(()=>null);
  await began;
  assert.equal((await fetch(origin+ticket.url)).status,410);
  await post('/api/download/cancel',{id:ticket.id}); resume(); await first;
  for(let i=0;i<20&&!calls.some(c=>c.method==='release');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls.filter(c=>c.method==='release').length,1);
});
