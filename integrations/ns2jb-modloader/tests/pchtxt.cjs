'use strict';
const assert=require('node:assert/strict');
const {compilePchtxt,decodeText}=require('../lib/pchtxt.cjs'),{parseIps}=require('../lib/exefs.cjs');
const build='0123456789abcdef'.padEnd(64,'0'),prefix='@nsobid-'+build+'\n';
function compile(text){return compilePchtxt(prefix+text,'fixture.pchtxt');}
function rows(text){return parseIps(compile(text).buffer);}
const sample='@flag offset_shift 0x100\n@enabled\n00000008 AABB\n@disabled\n00000009 FF\n@enabled\n0000000A 1020 / original\n@stop\n00000000 11\n';
const converted=compile(sample);assert.equal(converted.buildId,build);assert.equal(converted.records,2);assert.equal(converted.patchedBytes,4);
assert.equal(converted.buffer.toString('hex'),'4950533332000001080002aabb0000010a0002102045454f46');
assert.deepEqual(rows('@enabled\n8 01 23 ab CD\n'),[{offset:8,data:Buffer.from('0123abcd','hex')}]);
assert.deepEqual(rows('@flag offset_shift -0x10\n@enabled\n20 80\n@flag offset_shift +32\n20 81'),[{offset:16,data:Buffer.from([128])},{offset:64,data:Buffer.from([129])}]);
assert.equal(compilePchtxt('@NSOBID-ABCD\r@ENABLED\r00000100 FE').buildId,'abcd'.padEnd(64,'0'));
assert.equal(rows('@disabled\nDisabled explanatory notes\n@enabled\n100 FE # comment')[0].data[0],254);
assert.deepEqual(rows('@enabled\n100 "A/#é\\n\\x42\\101\\0" // comment')[0].data,Buffer.from('A/#é\nBA\0\0'));
assert.deepEqual(rows("@enabled\n100 'it\\\'s'" )[0].data,Buffer.from("it's\0"));
assert.equal(compile('@flag print_values\n@little-endian\n@big_endian\n@enabled\n100 12345678').buffer.toString('hex'),compile('@enabled\n100 12345678').buffer.toString('hex'));
const input=prefix+sample;
for(const bytes of [Buffer.from(input),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(input)]),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(input,'utf16le')]),Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from(input,'utf16le').swap16()])])assert.deepEqual(compilePchtxt(bytes).buffer,converted.buffer);
assert.throws(()=>decodeText(Buffer.from([0xff]),'bad.pchtxt'),/bad.pchtxt: invalid utf-8/);
for(const text of ['@nsobid-xyz\n','@enabled\n100 01','@nsobid-abc\n','@nsobid-12\n@nsobid-34\n'])assert.throws(()=>compilePchtxt(text,'wrong.pchtxt'),/wrong.pchtxt:\d+:/);
for(const text of ['@enabled\n100 ABC','@enabled\n100 GG','@enabled\n-1 80','@enabled\n100000000 80','@flag offset_shift -257\n@enabled\n100 80','@enabled\nffffffff 1122','@flag offset_shift garbage','@flag unknown','@unknown','@enabled\n100 "unclosed','@enabled\n100 "bad\\q"','@enabled\n100 "bad\\x"','@enabled\n100 "bad\\777"','@enabled\n100 "ok" trailing'])assert.throws(()=>compile(text),/fixture.pchtxt:\d+:/,text);
assert.throws(()=>compile('@enabled\n45454f46 80'),/EEOF marker/);
const large=Buffer.alloc(140000,0xab),split=compile('@enabled\n100 '+large.toString('hex')),splitRows=parseIps(split.buffer);
assert.equal(splitRows.length,3);assert.deepEqual(Buffer.concat(splitRows.map(row=>row.data)),large);assert.deepEqual(splitRows.map(row=>row.offset),[256,256+65535,256+131070]);
// No inherited 4096-character input-line limit; a split must cross EEOF
// without emitting an ambiguous terminator as a record address.
const near=compile('@enabled\n45444f47 '+Buffer.alloc(70000,1).toString('hex'));
assert.equal(parseIps(near.buffer).reduce((n,row)=>n+row.data.length,0),70000);
assert.equal(compile('@disabled\n100 FF').records,0);
console.log('IPSwitch: canonical IPS32 bytes, internal Build ID, encodings, block selection, offset shifts, strings, comments, large records and actionable malformed-input errors: passed');
