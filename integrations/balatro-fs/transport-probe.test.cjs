const assert = require('node:assert/strict');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {PORT, HELLO_BYTES, SOURCE, makeStageSource, parseStageReply,
  makeCloseSource, parseCloseReply, parseHello, runTransportProbe} = require('./transport-probe.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const nonce = 'd3b7e24c1a09f563';
const arenaBase = '0x4a144f8000';
const macIp = '10.0.0.205';

function hello() {
  const data = Buffer.alloc(HELLO_BYTES);
  const words = [0x31545344n, 1n, 2n, BigInt(arenaBase) + 0x10000n,
    0x80000n, 0x100000000n, 0x200000000n, 0n,
    0x200000000n + BigInt(profile.symbols.memmove.offset),
    0n, 0n, 0n, 0n, 0n, 0n, BigInt(profile.sdkCode.offlineCrc32)];
  words.forEach((value, index) => data.writeBigUInt64LE(value, index * 8));
  return data;
}

test('the stage is pinned to Balatro 1.0.1f and bounded by the REPL', () => {
  const source = makeStageSource({nonce, hostIp: macIp});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local phase="transport-probe"/);
  assert.match(source, /Balatro arena/);
  assert.match(source, /memmoveOffset=5851952/);
  assert.doesNotMatch(SOURCE, /CreateFile|WriteFile|CommitSaveData|call_native/);
  assert.throws(() => makeStageSource({nonce, hostIp: 'not-an-ip'}));
  assert.throws(() => makeStageSource({nonce: 'invalid', hostIp: macIp}));
});

test('the reply and 128-byte greeting reject mismatched profiles', () => {
  assert.deepEqual(parseStageReply(`-> BAL_TRANSPORT_V1\tlistening\t${PORT}\n`),
    {status: 'listening', port: PORT});
  const greeting = hello();
  assert.equal(parseHello(greeting, {arenaBase}).scratchBytes, 0x80000);
  for (const bad of [
    greeting.subarray(0, 127),
    Buffer.from(greeting),
    Buffer.from(greeting),
    Buffer.from(greeting),
  ].map((data, index) => {
    if (index === 1) data.writeBigUInt64LE(0n, 0);
    if (index === 2) data.writeBigUInt64LE(0n, 24);
    if (index === 3) data.writeBigUInt64LE(0n, 120);
    return data;
  })) assert.throws(() => parseHello(bad, {arenaBase}));
  assert.throws(() => parseStageReply('-> BAL_TRANSPORT_V1\tlistening\t9027\n'));
  assert.throws(() => parseStageReply(`-> BAL_TRANSPORT_V1\ttransport-probe\tfail\t${nonce}\tidentity\n`),
    /identity/);
  assert.match(makeCloseSource({nonce, hostIp: macIp}), /BL.fs_transport=nil/);
  assert.throws(() => makeCloseSource({nonce: 'wrong', hostIp: macIp}));
  assert.doesNotThrow(() => parseCloseReply(`-> BAL_TRANSPORT_V1\tclosed\t${PORT}\n`));
  assert.throws(() => parseCloseReply('-> BAL_TRANSPORT_V1\tcleanup-refused\n'));
});

test('the runner stages once and validates a matching handshake', async () => {
  let sent = 0;
  const execute = async ({host, port, source}) => {
    sent++;
    assert.equal(host, '10.0.0.189');
    assert.equal(port, 9026);
    assert.match(source, /BAL_TRANSPORT_V1/);
    return source.includes('BL.fs_transport=nil') ?
      `-> BAL_TRANSPORT_V1\tclosed\t${PORT}\n` :
      `-> BAL_TRANSPORT_V1\tlistening\t${PORT}\n`;
  };
  const result = await runTransportProbe({host: '10.0.0.189', macIp, nonce, execute,
    preflight: async () => ({nonce, arenaBase, arenaBytes: 0x200000}),
    receive: async ({host, port}) => {
      assert.equal(host, '10.0.0.189');
      assert.equal(port, PORT);
      return hello();
    }});
  assert.equal(result.sdkCrc32, Number(profile.sdkCode.offlineCrc32));
  assert.equal(sent, 2);
  await assert.rejects(runTransportProbe({host: '10.0.0.189', macIp, nonce, execute,
    preflight: async () => ({nonce: 'wrong', arenaBase, arenaBytes: 0x200000})}),
  /preflight does not match/);
  assert.equal(sent, 2);
});

test('the runner closes the listener after a rejected greeting', async () => {
  let closed = false;
  await assert.rejects(runTransportProbe({host: '10.0.0.189', macIp, nonce,
    execute: async ({source}) => {
      if (source.includes('BL.fs_transport=nil')) {
        closed = true;
        return `-> BAL_TRANSPORT_V1\tclosed\t${PORT}\n`;
      }
    return `-> BAL_TRANSPORT_V1\tlistening\t${PORT}\n`;
    },
    preflight: async () => ({nonce, arenaBase, arenaBytes: 0x200000}),
    receive: async () => Buffer.alloc(128)}), /does not match/);
  assert.equal(closed, true);
});

test('the Lua bridge sends one greeting and remains reusable', t => {
  const check = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (check.error) return t.skip('LuaJIT is unavailable');
  const script = `
local ffi=require('ffi')
local bridge=assert(loadstring(${JSON.stringify(SOURCE)},'transport-probe'))()
local data=ffi.new('uint8_t[?]',0x200000+0x2000)
local raw=tonumber(ffi.cast('uintptr_t',data))
local base=raw+0x1000-raw%0x1000
local before,after=base-raw-64,base-raw+0x200000
for i=0,63 do data[before+i]=165;data[after+i]=165 end
local accepted=0
local replies={}
local io={}
function io.accept() accepted=accepted+1;return 17,'10.0.0.205:12345' end
function io.send(_,part) replies[#replies+1]=part;return #part end
function io.close() end
local b={state='serving',rpc={step=function() return 'idle' end},
  info={main_base=0x100000000,sdk_base=0x200000000},
  fs_bridge={owner='${nonce}',stage='ready',bytes=0x200000,base=base,
    buf=data,before=before,after=after},
  net={listener=function() return 21 end,transport=function() return io end},
  log={log=function(msg) error(msg) end}}
assert(bridge.install(b,{hostIp='10.0.0.205',nonce='${nonce}',
  port=${PORT},sdkCrc32=${Number(profile.sdkCode.offlineCrc32)},
  memmoveOffset=${profile.symbols.memmove.offset}})=='BAL_TRANSPORT_V1\\tlistening\\t${PORT}')
b.rpc:step();b.rpc:step()
assert(accepted==1 and b.fs_transport.stage=='accept' and #replies==1 and #replies[1]==128)
local words=ffi.cast('const uint64_t*',replies[1])
assert(tonumber(words[3])==base+0x10000 and tonumber(words[4])==0x80000)
assert(bridge.install(b,{hostIp='10.0.0.205',nonce='${nonce}',
  port=${PORT},sdkCrc32=${Number(profile.sdkCode.offlineCrc32)},
  memmoveOffset=${profile.symbols.memmove.offset}})=='BAL_TRANSPORT_V1\\treused\\t${PORT}')
b.fs_transport:close()
assert(b.fs_transport.stage=='closed')`;
  const result = spawnSync('luajit', ['-e', script], {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
