'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateFsMappings,profile}=require('../lib/native/fs-abi.cjs');

test('native FS capture requires executable pages for every hook target',()=>{
 const complete=[{offset:0,end:profile.captureSize,permissions:5}];
 assert.equal(validateFsMappings(complete).loggingExecutable,true);
 assert.throws(()=>validateFsMappings([{offset:0,end:profile.captureSize,permissions:1}]),
  error=>error.fsCompatibility?.stage==='native-code-mappings');
});
