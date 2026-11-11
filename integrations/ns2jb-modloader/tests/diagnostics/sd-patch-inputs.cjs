'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sd-patch-inputs-')),sdroot='/ns2jb-modloader',title='0400c3f00006e000';
const build='12'.padEnd(64,'0'),text=Buffer.from('@nsobid-'+build+'\n@flag offset_shift 0x100\n@enabled\n8 78\n');
let mode='text',reads=[],closed=[],released=0,attached=0,bridge;
function inventory(){
 const tree=new Map([[sdroot,{type:'directory',children:[]}]]);
 function add(name,type,size){const parent=path.posix.dirname(name);if(name!==sdroot&&!tree.has(parent))add(parent,'directory');tree.set(name,{type,children:[],...(size===undefined?{}:{size})});if(name!==sdroot)tree.get(parent).children.push(path.posix.basename(name));}
 add(sdroot+'/contents/'+title+'/exefs/arbitrary.pchtxt','file',text.length);
 add(sdroot+'/contents/exefs_patches/group/34.ips','file',9);
 if(mode==='paired'){
  tree.get(sdroot+'/contents/'+title+'/exefs').children=['12.pchtxt','12.ips'];
  tree.delete(sdroot+'/contents/'+title+'/exefs/arbitrary.pchtxt');
  tree.set(sdroot+'/contents/'+title+'/exefs/12.pchtxt',{type:'file',size:text.length});tree.set(sdroot+'/contents/'+title+'/exefs/12.ips',{type:'file',size:9});
 }
 bridge={c:{pending:false}};
 return {tree,bootstrap:{bridge,release:async()=>{released++;}}};
}
function mock(name,exports){const id=require.resolve(name);require(id);require.cache[id].exports=exports;}
mock('../../lib/native/inventory.cjs',{scanSd:async()=>inventory()});
mock('../../lib/game-files/mount-api.cjs',{attachGame:async()=>{
 attached++;return {root:1,domain:{oneHandle:()=>2},s:{ipc:async()=>({result:0}),close:async handle=>closed.push(handle)},
 filesystem:{openFile:async(s,handle,name)=>{assert(name.endsWith('.pchtxt'));return{result:0,handle:3};},fileSize:async()=>BigInt(text.length),readFile:async(s,handle,at,n)=>{reads.push({at,n});if(mode==='timeout')throw Error('Memory request timed out; it was not replayed');return text.subarray(at,at+n);}},close:async()=>closed.push('session')};
}});
const {collectSdMods}=require('../../lib/sd-mods.cjs'),lazy=require('../../lib/lazy-context.cjs');
(async()=>{try{
 let collection=await collectSdMods('unused',path.join(root,'first'),sdroot,{nativePreparation:true});
 assert.equal(reads.length,1);assert.deepEqual(reads[0],{at:0,n:text.length});assert.deepEqual(closed,[3,'session']);assert.equal(released,0);
 const patch=collection.games[0].patches[0];assert.equal(patch.inputFormat,'pchtxt');assert.equal(patch.size,16);assert.equal(patch.patchRecords,1);assert.equal(patch.sdPath,sdroot+'/contents/'+title+'/exefs/arbitrary.pchtxt');
 assert.equal(lazy.plan(collection,'switch2-test').lazyGames[0].files[0].kind,7);assert.equal(collection.patches.length,1);assert(collection.patches[0].path.startsWith('contents/exefs_patches/'));
 mode='paired';reads=[];closed=[];const previousAttached=attached;
 collection=await collectSdMods('unused',path.join(root,'paired'),sdroot,{nativePreparation:true});assert.equal(attached,previousAttached);assert.equal(reads.length,0);assert.equal(collection.games[0].patches.length,1);assert.equal(collection.games[0].patchReferences.length,1);
 mode='timeout';reads=[];closed=[];
 await assert.rejects(collectSdMods('unused',path.join(root,'timeout'),sdroot,{nativePreparation:true}),/timed out/);
 assert.equal(reads.length,1);assert.deepEqual(closed,[]);assert.equal(released,0);assert.equal(bridge.c.pending,true);
 console.log('SD patch inputs: metadata-only binary fast path; read and compile standalone text once; alias preserved; no SD writes; timed-out buffers and native bootstrap retained: passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
