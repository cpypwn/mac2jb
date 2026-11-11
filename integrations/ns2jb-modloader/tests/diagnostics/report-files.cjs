'use strict';
const assert=require('node:assert/strict');
const io=new Map(),handles=new Map(),memory=new Map();let next=10,closed=0;
const base='/ns2jb-modloader/logs/',names=['20261101T000000Z-switch2-old1','20261102T000000Z-switch2-old2','20261103T000000Z-switch2-old3','20261104T000000Z-switch2-old4'];
for(const name of names)for(const ext of ['.log','.trace'])io.set(base+name+ext,Buffer.alloc(12));
const directories=new Set(['/ns2jb-modloader','/ns2jb-modloader/logs']);
const s={base:0x100000,async write(at,b){memory.set(at,Buffer.from(b));},async close(h){assert(handles.has(h));handles.delete(h);},async ipc(label,h,id,input=Buffer.alloc(0),opts={}){
 if(id===18)return{result:0,handles:[1]};const name=handles.get(h);assert(name);
 if(id===3){io.set(name,Buffer.alloc(Number(input.readBigUInt64LE())));return{result:0};}
 if(id===1){const at=Number(input.readBigUInt64LE(8)),n=Number(input.readBigUInt64LE(16)),bytes=memory.get(opts.send[0].address);assert(bytes.length>=n&&at+n<=io.get(name).length);bytes.copy(io.get(name),at,0,n);return{result:0};}
 if(id===2)return{result:0};throw Error('Unexpected file operation '+id);
}};
const a={s,root:1,domain:{oneHandle:r=>r.handles[0],async send(s,label,h,request){
 const id=request.readUInt32LE(24),raw=memory.get(s.base+0x2000),name=raw.toString('utf8',0,raw.indexOf(0));
 if(id===7){const type=directories.has(name)?0:io.has(name)?1:null;if(type===null)return{result:0x202,canonicalResult:0x202};const data=Buffer.alloc(4);data.writeUInt32LE(type);return{result:0,canonicalResult:0,data};}
 if(id===1){assert(io.has(name));io.delete(name);return{result:0};}
 if(id===0){assert(!io.has(name));io.set(name,Buffer.alloc(Number(request.readBigUInt64LE(40))));return{result:0};}
 if(id===8){assert(io.has(name));const h=next++;handles.set(h,name);return{result:0,handles:[h]};}
 throw Error('Unexpected path command '+id);
}},filesystem:{},async close(){closed++;}};
const mount=require.resolve('../../lib/game-files/mount-api.cjs');require(mount);require.cache[mount].exports={attachGame:async()=>a,createGameFiles:()=>({list:async()=>[...io.keys()].map(n=>({name:n.slice(base.length),type:'file'}))})};
(async()=>{
 const d=require('../../lib/diagnostics.cjs'),collection={games:[],patches:[]},plan={lazy:true,lazyGames:[],lazyPatches:[]};const report=d.report({session:'switch2-test',sdPath:base+'20261105T000000Z-switch2-test.log',collection,plan,trace:true});
 await d.writeReport('unused',report);assert.equal(closed,1);assert.equal(handles.size,0);assert(io.get(report.sdPath).equals(report.buffer));assert.equal(io.get(report.tracePath).length,40960);assert(io.get(report.tracePath).every(b=>b===0));
 assert.equal([...io.keys()].filter(n=>n.endsWith('.log')).length,3);assert.equal([...io.keys()].filter(n=>n.endsWith('.trace')).length,3);assert(!io.has(base+names[0]+'.log')&&!io.has(base+names[0]+'.trace'));assert(!io.has(base+names[1]+'.log')&&!io.has(base+names[1]+'.trace'));
 const normal=d.report({session:'switch2-normal',sdPath:base+'20261106T000000Z-switch2-normal.log',collection,plan});
 assert(!normal.tracePath);assert(!normal.buffer.includes(Buffer.from('Trace snapshots')));assert(!normal.buffer.includes(Buffer.from('File identity:')));
 await d.writeReport('unused',normal);assert.equal(closed,2);assert.equal(handles.size,0);assert(io.get(normal.sdPath).equals(normal.buffer));assert(!io.has(normal.sdPath.replace(/\.log$/,'.trace')));
 assert.equal([...io.keys()].filter(n=>n.endsWith('.log')).length,3);assert.equal([...io.keys()].filter(n=>n.endsWith('.trace')).length,2);
 console.log('Default text-only logs, opt-in trace creation, three-session rotation and handle cleanup: passed');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
