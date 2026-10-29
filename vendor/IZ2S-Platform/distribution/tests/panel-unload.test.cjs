const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
test('unload API requires authentication and origin, and forwards only the selected IDs',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'iz2s-unload-api-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const calls=[],manager={async unloadPackages(ids){calls.push(ids);}};
 const window=await require('../../panel/http.cjs').createWindowServer({root,manager,port:0,token:'unload-test-key'});t.after(()=>window.close());
 const origin=new URL(window.url).origin;
 const request=(headers)=>fetch(origin+'/api/unload',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({ids:['demo']})});
 assert.equal((await request({origin})).status,403);assert.equal((await request({'x-iz-key':'unload-test-key'})).status,403);assert.equal(calls.length,0);
 assert.equal((await request({origin,'x-iz-key':'unload-test-key'})).status,200);assert.deepEqual(calls,[['demo']]);
 manager.preview=true;assert.notEqual((await request({origin,'x-iz-key':'unload-test-key'})).status,200);assert.equal(calls.length,1);
});
