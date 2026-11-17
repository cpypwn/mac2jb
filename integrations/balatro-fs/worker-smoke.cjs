const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const {FRAME_BYTES, FUNCTIONS, RESULT_OFFSET, RESULT_SENTINEL,
  buildFrameLayout} = require('./worker-frame.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_WORKER_SMOKE_V1';
const REFERENCE_BASE = 0x100000000;
const REFERENCE_SDK = 0x200000000;
const SOURCE_LIMIT = 32768;
const EXPECTED_RESULT = 19200000;
const ARENA_BYTES = 0x200000;

function frameWords() {
  const {frame} = buildFrameLayout({base: REFERENCE_BASE, sdk: REFERENCE_SDK});
  const words = [];
  for (let offset = 0; offset < frame.length; offset += 8) {
    const value = frame.readBigUInt64LE(offset);
    if (value === 0n) continue;
    if (value === RESULT_SENTINEL) words.push([offset, 3, 0]);
    else if (value >= BigInt(REFERENCE_BASE) &&
             value < BigInt(REFERENCE_BASE + FRAME_BYTES)) {
      words.push([offset, 1, Number(value - BigInt(REFERENCE_BASE))]);
    } else if (value >= BigInt(REFERENCE_SDK) &&
               value < BigInt(REFERENCE_SDK + profile.sdkCode.size)) {
      words.push([offset, 2, Number(value - BigInt(REFERENCE_SDK))]);
    } else throw Error(`unrelocatable Balatro worker frame at 0x${offset.toString(16)}`);
  }
  return words;
}

function makeSource({nonce, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || !/^0x[0-9a-f]+$/.test(arenaBase || '')) {
    throw new TypeError('invalid retained Balatro arena context');
  }
  const address = Number(BigInt(arenaBase));
  if (!Number.isSafeInteger(address) || address < 4096 || address % 4096 ||
      address + ARENA_BYTES >= 2 ** 39) throw new RangeError('invalid Balatro arena address');
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw Error('Balatro preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="worker-smoke"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const checks = [
    ...Object.values(FUNCTIONS),
    ...['svcCreateThread', 'svcStartThread', 'svcWaitSynchronization',
      'svcCloseHandle', 'svcGetThreadPriority', 'svcGetThreadCoreMask',
      'nn::os::GetCurrentThread'].map(name => profile.symbols[name]),
  ].map(entry => `{${entry.offset},'${entry.bytes}'}`).join(',');
  const words = frameWords().map(word => `{${word.join(',')}}`).join(',');
  const sym = profile.symbols;
  const source = `${preamble}
local held=b.fs_bridge
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${address} or held.bytes~=${ARENA_BYTES} or not held.buf then
  return fail('retained-arena')
end
if b.fs_worker_hold then return fail('previous-worker-retained') end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.base<raw+64 or held.base+held.bytes+64>raw+ffi.sizeof(held.buf) or
   held.before~=held.base-raw-64 or held.after~=held.base-raw+held.bytes then
  return fail('arena-bounds')
end
local function guard()
  for i=0,63 do
    if tonumber(held.buf[held.before+i])~=165 or
       tonumber(held.buf[held.after+i])~=165 then return false end
  end
  return true
end
if not guard() then return fail('arena-guard') end
local first,why=mapping(held.base)
if not first then return fail(why) end
local last,lastWhy=mapping(held.base+held.bytes-1)
if not last then return fail(lastWhy) end
if first.base~=last.base or first.size~=last.size or first.type~=5 or first.perm~=3 or
   first.base>held.base or held.base+held.bytes>first.base+first.size then
  return fail('arena-map')
end
local function bytesOk(offset,hex)
  local p=ffi.cast('const uint8_t*',base+offset)
  for i=0,#hex/2-1 do
    if tonumber(p[i])~=tonumber(hex:sub(i*2+1,i*2+2),16) then return false end
  end
  return true
end
for _,check in ipairs({${checks}}) do
  if not bytesOk(check[1],check[2]) then return fail('sdk-signature:'..check[1]) end
end
local current=love.ffi.declare('uint64_t',{},base+${sym['nn::os::GetCurrentThread'].offset})
local thread=tonumber(current())
if not thread or thread<4096 or thread+${profile.threadManager.nodeHandleOffset + 4}>=2^39 or
   thread%8~=0 then return fail('current-thread') end
local currentMap,threadWhy=mapping(thread)
if not currentMap or currentMap.type~=4 or currentMap.perm~=3 or
   thread+${profile.threadManager.nodeHandleOffset + 4}>currentMap.base+currentMap.size then
  return fail(threadWhy or 'thread-map')
end
local threadHandle=tonumber(ffi.cast('const uint32_t*',thread+${profile.threadManager.nodeHandleOffset})[0])
if not threadHandle or threadHandle==0 or threadHandle>=0xffff8000 then
  return fail('thread-handle')
end
local getPriority=love.ffi.declare('uint32_t',{'uint32_t *','uint32_t'},base+${sym.svcGetThreadPriority.offset})
local getMask=love.ffi.declare('uint32_t',{'uint32_t *','uint64_t *','uint32_t'},base+${sym.svcGetThreadCoreMask.offset})
local priority=ffi.new('uint32_t[1]')
local core=ffi.new('uint32_t[1]')
local mask=ffi.new('uint64_t[1]')
if tonumber(getPriority(priority,threadHandle))~=0 or
   tonumber(getMask(core,mask,threadHandle))~=0 then return fail('borrowed-thread-query') end
local prio=tonumber(priority[0])
local coreMask=tonumber(mask[0])
if prio~=${profile.liveReadOnlyEvidence.borrowedThread.priority} or
   coreMask~=${profile.liveReadOnlyEvidence.borrowedThread.coreMask} then
  return fail('borrowed-thread-profile')
end
local frame=ffi.cast('uint8_t*',held.base)
ffi.fill(frame,${FRAME_BYTES},0)
local words={${words}}
for _,word in ipairs(words) do
  local offset,tag,value=word[1],word[2],word[3]
  if tag==3 then
    local p=ffi.cast('uint32_t*',held.base+offset)
    p[0]=0x76543210;p[1]=0xfedcba98
  else
    ffi.cast('uint64_t*',held.base+offset)[0]=ffi.cast('uint64_t',
      tag==1 and held.base+value or base+value)
  end
end
local create=love.ffi.declare('uint32_t',{'uint32_t *','uint64_t','uint64_t',
  'uint64_t','int32_t','int32_t'},base+${sym.svcCreateThread.offset})
local start=love.ffi.declare('uint32_t',{'uint32_t'},base+${sym.svcStartThread.offset})
local wait=love.ffi.declare('uint32_t',{'uint32_t *','uint32_t *','int32_t','int64_t'},
  base+${sym.svcWaitSynchronization.offset})
local close=love.ffi.declare('uint32_t',{'uint32_t'},base+${sym.svcCloseHandle.offset})
local out=ffi.new('uint32_t[1]')
local hold={arena=held,handle=0,started=false,joined=false}
b.fs_worker_hold=hold
local ok,errorText=pcall(function()
  local rc=tonumber(create(out,base+${FUNCTIONS.longjmp.offset},held.base,
    held.base+${FRAME_BYTES},prio,0))
  if rc~=0 then error('create-result:'..tostring(rc)) end
  hold.handle=tonumber(out[0])
  if not hold.handle or hold.handle==0 or hold.handle>=0xffff8000 then
    error('created-handle')
  end
  rc=tonumber(start(hold.handle))
  if rc~=0 then error('start-result:'..tostring(rc)) end
  hold.started=true
  local index=ffi.new('uint32_t[1]')
  local handles=ffi.new('uint32_t[1]',hold.handle)
  local finished=false
  for i=1,200 do
    rc=tonumber(wait(index,handles,1,0))
    if rc==0 then
      if tonumber(index[0])~=0 then error('wait-index') end
      hold.joined=true;finished=true;break
    end
    if rc~=59905 then error('wait-result:'..tostring(rc)) end
    love.timer.sleep(0.01)
  end
  if not finished then error('worker-timeout') end
  local p=ffi.cast('const uint32_t*',held.base+${RESULT_OFFSET})
  if tonumber(p[0])~=${EXPECTED_RESULT} or tonumber(p[1])~=0 then
    error('worker-result:'..tostring(p[0])..':'..tostring(p[1]))
  end
  if tonumber(ffi.cast('const uint64_t*',held.base+0x500)[0])~=0 or
     tonumber(ffi.cast('const uint64_t*',held.base+0x508)[0])~=0 then
    error('scratch-result')
  end
end)
if hold.handle~=0 and (hold.joined or not hold.started) then
  local closed,closeResult=pcall(close,hold.handle)
  if closed and tonumber(closeResult)==0 then hold.handle=0
  elseif ok then ok=false;errorText='close-handle:'..tostring(closeResult) end
end
local retained=hold.started and not hold.joined or hold.handle~=0
if not retained then b.fs_worker_hold=nil end
if not guard() then return fail('arena-guard-after-worker') end
if not ok then return fail(tostring(errorText)..(retained and ':retained' or ':released')) end
if retained or b.fs_bridge~=held or held.stage~='ready' then return fail('worker-state') end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',held.base),
  tostring(prio),tostring(coreMask),tostring(${EXPECTED_RESULT}),'released'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro read-only worker source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce, arenaBase}) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('missing or duplicated Balatro worker reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== 'worker-smoke' || fields[3] !== nonce) {
    throw Error('Balatro worker reply does not match this request');
  }
  if (fields[2] === 'fail' && fields.length === 5) throw Error(`Balatro worker failed: ${fields[4]}`);
  if (fields.length !== 9 || fields[2] !== 'ok' || fields[4] !== arenaBase ||
      fields[5] !== String(profile.liveReadOnlyEvidence.borrowedThread.priority) ||
      fields[6] !== String(profile.liveReadOnlyEvidence.borrowedThread.coreMask) ||
      fields[7] !== String(EXPECTED_RESULT) || fields[8] !== 'released') {
    throw Error('Balatro read-only worker reply is incomplete');
  }
  return {gameProfile: profile.gameProfile, nonce, arenaBase,
    tickFrequency: EXPECTED_RESULT, cleanup: 'released',
    status: 'read-only native worker verified; no FS canary or marker tested'};
}

async function runWorkerSmoke({host, nonce, execute = executeLua, preflight = runPreflight}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('nonce must be 16 lowercase hex digits');
  const ready = await preflight({host, nonce, execute});
  if (ready.nonce !== nonce || ready.arenaBytes !== ARENA_BYTES) {
    throw Error('Balatro arena preflight did not match the worker request');
  }
  const context = {nonce, arenaBase: ready.arenaBase};
  return parseReply(await execute({host, port: 9026, source: makeSource(context),
    timeoutMs: 15000}), context);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node worker-smoke.cjs <switch-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runWorkerSmoke({host: argv[0], nonce: argv[1]}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {MARKER, EXPECTED_RESULT, frameWords, makeSource, parseReply, runWorkerSmoke};
