const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {BYTES, makeArenaBody, makeSource, parseReply} = require('./ffi-arena.cjs');

const nonce = '0123456789abcdef';

function lua(source) {
  const result = spawnSync('luajit', ['-e', source], {encoding: 'utf8'});
  if (result.error?.code === 'ENOENT') return null;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function harness(after) {
  return lua(`
local real=require('ffi')
local mapped={}
local nextAddr=0x4964000000
local ffi={new=real.new,sizeof=real.sizeof}
function ffi.cast(kind,obj)
  if kind~='uintptr_t' then return real.cast(kind,obj) end
  local actual=tonumber(real.cast('uintptr_t',obj))
  if not mapped[actual] then mapped[actual]=nextAddr;nextAddr=nextAddr+0x400000 end
  return real.cast('uintptr_t',mapped[actual])
end
local b={net={initialized=true,pool=real.new('uint8_t[?]',0x104000),
  iobuf=real.new('uint8_t[4096]'),pollfd=real.new('uint8_t[64]'),
  addrbuf=real.new('uint8_t[64]'),addrlen=real.new('uint32_t[1]')}}
local arena={ctrl={buf=real.new('uint8_t[?]',0x200)},
             stack=real.new('uint8_t[?]',0x20100),
             ctx=real.new('uint8_t[?]',0x820)}
package.preload['bl.ffi_call']=function() return {prime=function() return arena end} end
local phase='reserve'
local nonce='${nonce}'
local function fail(reason)
  return table.concat({'BAL_FFI_ARENA_V1',phase,'fail',nonce,reason},'\\t')
end
local function mapping(addr) return {base=0,size=2^39,type=5,perm=3} end
local function run()
${makeArenaBody()}
end
${after}
`);
}

test('pinned 1.0.1f source is bounded, compiles and rejects an absent runtime', () => {
  for (const phase of ['reserve', 'inspect']) {
    const source = makeSource({phase, nonce});
    assert.ok(Buffer.byteLength(source, 'utf8') <= 32768);
    assert.match(source, /info\.version=='1\.0\.1f-FULL'/);
    assert.match(source, /ffi\.new,'uint8_t\[\?\]',size\+extra/);
    assert.match(source, /b\.fs_bridge=held/);
    assert.match(source, /held\.base%0x1000~=0/);
    assert.match(source, /first\.type~=5 or first\.perm~=3/);
    assert.match(source, /'pool',net\.pool/);
    assert.match(source, /'control',nativeArena\.ctrl\.buf/);
    assert.doesNotMatch(source, /pcall\(allocate|createFile|writeFile|commit\(/);
    const run = spawnSync('luajit', ['-e', `local f=assert(loadstring(io.read('*a')));io.write(f())`],
      {input: source, encoding: 'utf8'});
    if (run.error?.code === 'ENOENT') continue;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `BAL_FFI_ARENA_V1\t${phase}\tfail\t${nonce}\tidentity`);
  }
  assert.throws(() => makeSource({phase: 'write', nonce}), /phase must be/);
  assert.throws(() => makeSource({phase: 'reserve', nonce: 'bad'}), /nonce must be/);
});

test('2 MiB buffer is retained, page aligned and reusable by inspect without another allocation', () => {
  const output = harness(`
local first=run()
local retained=b.fs_bridge.buf
phase='inspect'
local second=run()
assert(b.fs_bridge.buf==retained and b.fs_bridge.stage=='ready')
io.write(first..'\\n'..second)`);
  if (output === null) return;
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 2);
  const reserved = parseReply(`-> ${lines[0]}\n`, {phase: 'reserve', nonce});
  const inspected = parseReply(`-> ${lines[1]}\n`, {phase: 'inspect', nonce});
  assert.equal(reserved.bytes, BYTES);
  assert.equal(inspected.base, reserved.base);
});

test('modified guard quarantines the retained arena', () => {
  const output = harness(`
local first=run()
assert(first:find('\\tok\\t'))
b.fs_bridge.buf[b.fs_bridge.before]=0
phase='inspect'
local second=run()
io.write(second..'\\n'..b.fs_bridge.stage)`);
  if (output === null) return;
  assert.equal(output,
    `BAL_FFI_ARENA_V1\tinspect\tfail\t${nonce}\tguard\nquarantined`);
});

test('overlap with socket memory is refused and quarantines the arena', () => {
  const output = harness(`
local first=run()
assert(first:find('\\tok\\t'))
b.net.pool=b.fs_bridge.buf
phase='inspect'
local second=run()
io.write(second..'\\n'..b.fs_bridge.stage)`);
  if (output === null) return;
  assert.equal(output,
    `BAL_FFI_ARENA_V1\tinspect\tfail\t${nonce}\toverlap:socket-pool\nquarantined`);
});

test('parser rejects stale nonce, invalid address, incomplete or duplicate replies', () => {
  const valid = `-> BAL_FFI_ARENA_V1\treserve\tok\t${nonce}\t0x4964000000\t2097152\tretained\n`;
  assert.equal(parseReply(valid, {phase: 'reserve', nonce}).bytes, BYTES);
  assert.throws(() => parseReply(valid.replace(nonce, 'ffffffffffffffff'),
    {phase: 'reserve', nonce}), /phase and nonce/);
  assert.throws(() => parseReply(valid.replace('0x4964000000', '0x4964000001'),
    {phase: 'reserve', nonce}), /invalid address/);
  assert.throws(() => parseReply(valid.replace('retained', 'unknown'),
    {phase: 'reserve', nonce}), /incomplete/);
  assert.throws(() => parseReply(valid + valid, {phase: 'reserve', nonce}), /duplicated/);
  assert.throws(() => parseReply(`-> BAL_FFI_ARENA_V1\treserve\tfail\t${nonce}\theap-map\n`,
    {phase: 'reserve', nonce}), /failed: heap-map/);
});
