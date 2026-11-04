'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {generate,checksum}=require('./generate.cjs');
const original=fs.readFileSync(path.resolve(__dirname,'../../assets/hosts/kurumuz/bootstrap.bas'));
test('variant preserves every original byte and its START ABI',()=>{
  const result=generate({address:'192.168.50.1'});
  assert.deepEqual(result.output.subarray(0,original.length),original);
  assert.equal((result.output.toString().match(/COMMON DEF START\(PORT,A,B,C,D\)/g)||[]).length,1);
  assert.equal(result.receipt.saveName,'NS2DK');assert.equal(result.receipt.hardwareValidated,false);
  assert.match(result.receipt.outputSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(checksum(original),{lines:228,characters:8029,checksum:590182,command:checksum(original).command});
  assert.deepEqual(result.receipt.sourceCheck,checksum(result.output));
  assert.ok(result.extension.includes("DKCHECK(P#,A#,B#,C#,D#)"));
});
test('rejects changed source, unsupported profiles and malformed preset input',()=>{
  assert.throws(()=>generate({source:Buffer.concat([original,Buffer.from('\n')])}),/SHA256 mismatch/);
  for(const profileId of ['izmysh','cellenseres','../kurumuz','']) assert.throws(()=>generate({profileId}),/Only/);
  for(const address of ['256.1.2.3','192.168.1','1.2.3.4:39380','01.2.3.4','-1.2.3.4','1.2.3.4\nEND','1.2.3.4\n',null,1])
    assert.throws(()=>generate({address}),/IPv4/);
});
test('no-preset variant omits DKCONNECT and extension has only namespaced definitions',()=>{
  const {extension}=generate();assert.ok(!extension.includes('COMMON DEF DKCONNECT')); 
  assert.ok(!/\b(?:REMOVE|COPY|RAW#|BOOT\(|KEY\(|PHASE\s*=|FD\s*=)/.test(extension.replace(/PRINT .*$/gm,'')));
  const definitions=[...extension.matchAll(/^COMMON DEF (\w+)/gm)].map(m=>m[1]);
  assert.deepEqual(definitions,['DKINFO','DKHELP','DKSTATUS','DKCHECK','DKSTART']);
  assert.equal(new Set(definitions).size,definitions.length);
  assert.ok(extension.split('\n').every(line=>line.length<=96));
  assert.ok([...Buffer.from(extension)].every(byte=>byte===10 || byte>=32&&byte<=126));
  assert.ok(extension.indexOf('IF !DKCHECK')<extension.indexOf('RETURN START'));
  assert.ok(extension.indexOf('IF PHASE!=0')<extension.indexOf('RETURN START'));
});
test('scratch test contains helpers unchanged and only a harmless START stub',()=>{
  const result=generate({address:'192.168.50.1'}),text=result.scratch.toString();
  assert.ok(text.endsWith(result.extension));assert.ok(text.includes('CALLS=CALLS+1:RETURN 1'));
  assert.ok(!text.includes('COMMON DEF BOOT'));assert.ok(!text.includes('NSR='));
  assert.ok(text.includes('PHASE=6:V=DKSTART'));assert.ok(text.includes('CALLS!=0 OR PHASE!=0'));
  assert.ok(text.includes('DK TEST ERRORS'));assert.ok(text.split('\n').every(line=>line.length<=96));
});
