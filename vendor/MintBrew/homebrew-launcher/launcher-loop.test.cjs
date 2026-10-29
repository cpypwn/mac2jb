const test=require('node:test');
const assert=require('node:assert/strict');
const {serviceStartError}=require('./launcher-loop.cjs');

test('idle MintBrew menu has no failed service to read',()=>{
 assert.equal(serviceStartError(undefined,null),null);
 assert.equal(serviceStartError(undefined,{service:undefined}),null);
});

test('only the active service receives its start failure',()=>{
 const service={},error=Error('stream start failed');
 const failure={service,error};
 assert.equal(serviceStartError(failure,{service}),error);
 assert.equal(serviceStartError(failure,{service:{}}),null);
 assert.equal(serviceStartError(failure,null),null);
});
