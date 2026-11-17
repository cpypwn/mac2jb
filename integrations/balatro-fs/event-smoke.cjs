const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {SDK_CRC32, qualifyNativeCrc} = require('./qualify-native-crc.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_EVENT_SMOKE_V1';
const PORT = 9026;
const ARENA_BYTES = 0x200000;
const EVENT_OFFSET = 0x180000;
const SOURCE_LIMIT = 32768;

function makeSource({nonce, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || !/^0x[0-9a-f]+$/.test(arenaBase || '')) {
    throw new TypeError('invalid retained Balatro arena context');
  }
  const address = Number(BigInt(arenaBase));
  if (!Number.isSafeInteger(address) || address < 4096 || address % 4096 ||
      address + ARENA_BYTES >= 2 ** 39) throw new RangeError('invalid Balatro arena address');
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw Error('Balatro pinned preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="event-smoke"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const sym = profile.symbols;
  const names = ['nn::os::InitializeLightEvent', 'nn::os::FinalizeLightEvent',
    'nn::os::TryWaitLightEvent', 'nn::os::SignalLightEvent'];
  if (profile.runtimeVersion !== '1.0.1f-FULL' ||
      names.some(name => !sym[name] || !Number.isInteger(sym[name].offset))) {
    throw Error('Balatro event profile is incomplete');
  }
  const source = `${preamble}
local held=b.fs_bridge
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${address} or held.bytes~=${ARENA_BYTES} or not held.buf then
  return fail('retained-arena')
end
if b.fs_worker_hold then return fail('worker-retained') end
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
local event=held.base+${EVENT_OFFSET}
local eventMap,why=mapping(event)
if not eventMap or eventMap.type~=5 or eventMap.perm~=3 or
   eventMap.base>event-16 or event+24>eventMap.base+eventMap.size then
  return fail(why or 'event-map')
end
local p=ffi.cast('uint8_t*',event)
for i=-16,-1 do p[i]=165 end
for i=0,7 do p[i]=0 end
for i=8,23 do p[i]=165 end
local function eventGuard()
  for i=-16,-1 do if tonumber(p[i])~=165 then return false end end
  for i=8,23 do if tonumber(p[i])~=165 then return false end end
  return true
end
local initialize=love.ffi.declare('void',{'void *','uint32_t','uint32_t'},
  base+${sym['nn::os::InitializeLightEvent'].offset})
local finalize=love.ffi.declare('void',{'void *'},
  base+${sym['nn::os::FinalizeLightEvent'].offset})
local tryWait=love.ffi.declare('uint32_t',{'void *'},
  base+${sym['nn::os::TryWaitLightEvent'].offset})
local signal=love.ffi.declare('void',{'void *'},
  base+${sym['nn::os::SignalLightEvent'].offset})
local initialized=false
local initial,afterSignal
local ok,err=pcall(function()
  initialize(ffi.cast('void*',event),0,0)
  initialized=true
  if tonumber(p[0])~=0 or tonumber(p[1])~=1 or
     tonumber(ffi.cast('const uint32_t*',event+4)[0])~=0 then
    error('event-init-state')
  end
  initial=tonumber(tryWait(ffi.cast('void*',event)))
  if initial~=0 then error('event-initial-wait:'..tostring(initial)) end
  signal(ffi.cast('void*',event))
  afterSignal=tonumber(tryWait(ffi.cast('void*',event)))
  if afterSignal~=1 then error('event-signaled-wait:'..tostring(afterSignal)) end
end)
local finalized=false
if initialized then
  local cleanup,cleanupError=pcall(finalize,ffi.cast('void*',event))
  finalized=cleanup
  if not cleanup and ok then ok=false;err='event-finalize:'..tostring(cleanupError) end
end
if not eventGuard() or not guard() then return fail('event-or-arena-guard') end
if not ok then return fail(tostring(err)..(finalized and ':finalized' or ':retained')) end
if not finalized or held.stage~='ready' or b.fs_bridge~=held then
  return fail('event-state')
end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',event),
  tostring(initial),tostring(afterSignal),'finalized'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro event smoke exceeds REPL source limit');
  }
  return source;
}

function parseReply(reply, {nonce, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || !/^0x[0-9a-f]+$/.test(arenaBase || '')) {
    throw new TypeError('invalid Balatro event context');
  }
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('missing or duplicated Balatro event reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== 'event-smoke' || fields[3] !== nonce) {
    throw Error('Balatro event reply does not match this request');
  }
  if (fields[2] === 'fail' && fields.length === 5) {
    throw Error(`Balatro event smoke failed: ${fields[4]}`);
  }
  const expectedEvent = `0x${(BigInt(arenaBase) + BigInt(EVENT_OFFSET)).toString(16)}`;
  if (fields.length !== 8 || fields[2] !== 'ok' || fields[4] !== expectedEvent ||
      fields[5] !== '0' || fields[6] !== '1' || fields[7] !== 'finalized') {
    throw Error('Balatro event reply is incomplete');
  }
  return {gameProfile: profile.gameProfile, nonce, event: expectedEvent,
    unsignaledWait: false, signaledWait: true, cleanup: 'finalized',
    status: 'owned LightEvent lifecycle verified; FS canary and marker unverified'};
}

async function runEventSmoke({host, macIp, nonce, execute = executeLua,
  preflight = runPreflight, verifyCrc = qualifyNativeCrc}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (net.isIP(macIp) !== 4) throw new TypeError('Mac address must be IPv4');
  if (typeof execute !== 'function' || typeof preflight !== 'function' ||
      typeof verifyCrc !== 'function') {
    throw new TypeError('invalid Balatro event smoke dependency');
  }
  const ready = await preflight({host, nonce, execute});
  if (ready.nonce !== nonce || ready.arenaBytes !== ARENA_BYTES ||
      !/^0x[0-9a-f]+$/.test(ready.arenaBase || '')) {
    throw Error('Balatro retained arena preflight differs');
  }
  const crc = await verifyCrc({host, macIp, nonce, execute, port: 39381});
  if (crc.nonce !== nonce || crc.port !== 39381 ||
      crc.sdkCrc32 !== `0x${SDK_CRC32.toString(16)}` ||
      !/^0x[0-9a-f]+$/.test(crc.sdkBase || '')) {
    throw Error('Balatro live SDK CRC did not match the event request');
  }
  const afterCrc = await preflight({host, nonce, execute});
  if (afterCrc.nonce !== nonce || afterCrc.arenaBase !== ready.arenaBase ||
      afterCrc.arenaBytes !== ready.arenaBytes) {
    throw Error('Balatro retained arena changed after SDK CRC verification');
  }
  const context = {nonce, arenaBase: ready.arenaBase};
  const reply = await execute({host, port: PORT, source: makeSource(context), timeoutMs: 15000});
  return parseReply(reply, context);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node event-smoke.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runEventSmoke({host: argv[0],
      macIp: argv[1], nonce: argv[2]}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {MARKER, PORT, ARENA_BYTES, EVENT_OFFSET, makeSource,
  parseReply, runEventSmoke};
