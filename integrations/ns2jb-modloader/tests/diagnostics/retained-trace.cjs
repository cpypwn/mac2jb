'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'trace-retain-')),session='switch2-test',run=path.join(tmp,session);fs.mkdirSync(path.join(run,'switch2/ro'),{recursive:true});fs.writeFileSync(path.join(run,'switch2/ro',session+'-layout.json'),JSON.stringify({count:16,table:0x300000}));
const objects=new Map(),handles=new Map();let next=10,clones=0,closed=0,traceFailure=false,reportFailure=false;
const base=0x4000000000n,table=Buffer.alloc(80);for(const [i,o]of [[0,0x1036f0],[1,0x104e10],[4,0x104ef0],[5,0x1050a0],[6,0x1053d0],[7,0x105410]])table.writeBigUInt64LE(base+BigInt(o),i*8);
const sdTable=Buffer.alloc(80);sdTable.writeBigUInt64LE(base+0x4b8c0n);sdTable.writeBigUInt64LE(base+0x103390n,8);
const sd={address:0x500000,refs:1,offset:0x28,table:sdTable,vptr:0x700000};objects.set(sd.address,sd);
function handle(o){const h=next++;handles.set(h,o);return h;}
function file(kind){const o={address:0x500000+next*256,refs:1,offset:0x20,table,vptr:0x700000+next*256,kind};objects.set(o.address,o);return handle(o);}
const s={async ipc(){return{result:0,handles:[handle(sd)]};},async close(h){const o=handles.get(h);assert(o);o.refs--;handles.delete(h);}};
const domain={oneHandle:r=>r.handles[0],wire:{control:id=>id},async send(s,label,h,id){const o=handles.get(h);assert(o);if(id===2){clones++;o.refs++;return{result:0,handles:[handle(o)]};}const data=Buffer.alloc(4);data.writeUInt32LE(h);return{result:0,data};}};
const a={s,domain,root:1,filesystem:{async pathMethod(s,h,id,name){assert(id===8);if(traceFailure&&name.endsWith('.trace'))throw Error('Console response timed out; restart the application');if(reportFailure&&name.endsWith('.log'))return{result:0x202};return{result:0,handles:[file(name.endsWith('.trace')?'trace':'log')]};},async fileSize(s,h){return handles.get(h).kind==='trace'?40960n:123n;}},async close(){closed++;for(const h of [...handles.keys()])await s.close(h);}};
const mount=require.resolve('../../lib/game-files/mount-api.cjs');require(mount);require.cache[mount].exports={attachGame:async()=>a};
const m={async read(at,n){if(at>=0x300000&&at<0x300000+16*0x30){const id=(at-0x300000)/0x30+1,o=handles.get(id),b=Buffer.alloc(0x30);assert(o);b.writeBigUInt64LE(BigInt(o.address),32);return b;}for(const o of objects.values()){if(at===o.address){assert(n<=o.offset+4,'SDK probe exceeded the owned adapter');const b=Buffer.alloc(n);b.writeBigUInt64LE(BigInt(o.vptr));b.writeUInt32LE(o.refs,o.offset);return b;}if(at===o.vptr)return o.table;}throw Error('Unexpected memory read');},async u32(at){for(const o of objects.values())if(at===o.address+o.offset)return o.refs;throw Error('Unexpected ref read');}};
(async()=>{try{
 const {openSource}=require('../../lib/native/source.cjs'),log={sdPath:'/ns2jb-modloader/logs/20261105T000000Z-switch2-test.log',tracePath:'/ns2jb-modloader/logs/20261105T000000Z-switch2-test.trace',size:123};
 const bridge={session,base,m,c:{pending:false}};
 const source=await openSource(run,bridge,log);assert(source.logFile&&source.traceFile&&source.filesystem);assert.equal(source.traceFile.baseline,1);assert.equal(clones,3);assert.equal(handles.size,3);await source.close();assert.equal(closed,1);assert.equal(handles.size,0);
 // An uncertain request must not be followed by cleanup or another IPC call.
 next=1;traceFailure=true;sd.refs=1;bridge.c.pending=false;await assert.rejects(openSource(run,bridge,log),/timed out/);assert(bridge.c.pending);assert.equal(closed,1);assert(handles.size>0);
 console.log('App-side trace qualification, exclusive ownership, handle cleanup and no post-timeout RPC: passed');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
