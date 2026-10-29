const test=require('node:test'),assert=require('node:assert/strict');
const {journal}=require('./journal.cjs');
test('persist a pending native call before dispatch and preserve disconnect evidence',async()=>{
 const record={},saved=[];
 const call=journal(record,async()=>saved.push(JSON.parse(JSON.stringify(record))));
 await assert.rejects(call('acquire',[1n],async()=>{
  assert.equal(saved.at(-1).operations[0].status,'pending');
  throw Error('Console disconnected');
 }),/Console disconnected/);
 assert.equal(saved.at(-1).operations[0].status,'failed');
 assert.equal(saved.at(-1).operations[0].error,'Console disconnected');
 assert.equal(saved[0].operations[0].status,'pending');
});
test('do not issue a native call when its pending record cannot be saved',async()=>{
 let called=false;
 const call=journal({},async()=>{throw Error('Disk full');});
 await assert.rejects(call('create',[],async()=>{called=true;}),/Disk full/);
 assert.equal(called,false);
});
