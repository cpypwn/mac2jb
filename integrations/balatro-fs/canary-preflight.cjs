const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_CANARY_PREFLIGHT_V1';
const PORT = 9026;
const ARENA_BYTES = 0x200000;
const INTERVAL_MS = 250;
const SOURCE_LIMIT = 32768;
const TOLERANCE = 0.2;
const EXPECTED_HZ = 19200000;

function makeSource({nonce, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('nonce must be 16 lowercase hex digits');
  if (!/^0x[0-9a-f]+$/.test(arenaBase || '')) throw new TypeError('arena base must be hexadecimal');
  const address = Number(BigInt(arenaBase));
  if (!Number.isSafeInteger(address) || address < 4096 || address % 4096 !== 0 ||
      address + ARENA_BYTES >= 2 ** 39) throw new RangeError('arena base is out of range');
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw new Error('Balatro pinned preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="canary-preflight"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const tick = profile.symbols['nn::os::GetSystemTick'];
  const frequency = profile.symbols['nn::os::GetSystemTickFrequency'];
  if (!tick || !frequency || profile.runtimeVersion !== '1.0.1f-FULL') {
    throw new Error('Balatro timing profile is incomplete');
  }
  const source = `${preamble}
local held=b.fs_bridge
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${address} or held.bytes~=${ARENA_BYTES} or not held.buf then
  return fail('retained-arena')
end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.base<raw+64 or held.base+held.bytes+64>raw+ffi.sizeof(held.buf) then
  return fail('arena-bounds')
end
local function guard()
  if held.before~=held.base-raw-64 or held.after~=held.base-raw+held.bytes then return false end
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
if not (love.timer and type(love.timer.getTime)=='function' and
        type(love.timer.sleep)=='function') then return fail('timer-unavailable') end
local getTick=love.ffi.declare('uint64_t',{},base+${tick.offset})
local getFrequency=love.ffi.declare('uint64_t',{},base+${frequency.offset})
local hz=tonumber(getFrequency())
if hz~=${EXPECTED_HZ} then return fail('sdk-frequency') end
local wallStart=love.timer.getTime()
local tickStart=getTick()
love.timer.sleep(${INTERVAL_MS / 1000})
local tickEnd=getTick()
local wallEnd=love.timer.getTime()
local ticks=tonumber(tickEnd-tickStart)
local micros=math.floor((wallEnd-wallStart)*1000000+0.5)
if not ticks or not micros or ticks<=0 or micros<${INTERVAL_MS * 500} or
   micros>${INTERVAL_MS * 4000} or not guard() or
   b.fs_bridge~=held or held.stage~='ready' then return fail('timing-or-arena-changed') end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',held.base),
                     tostring(held.bytes),tostring(hz),tostring(ticks),
                     tostring(micros),'ready'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro canary preflight source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || !/^0x[0-9a-f]+$/.test(arenaBase || '')) {
    throw new TypeError('invalid Balatro canary preflight context');
  }
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('missing or duplicated Balatro canary preflight reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== 'canary-preflight' || fields[3] !== nonce) {
    throw Error('Balatro canary preflight reply does not match this request');
  }
  if (fields[2] === 'fail' && fields.length === 5) {
    throw Error(`Balatro canary preflight failed: ${fields[4]}`);
  }
  if (fields.length !== 10 || fields[2] !== 'ok' || fields[4] !== arenaBase ||
      fields[5] !== String(ARENA_BYTES) || !fields.slice(6, 9).every(value => /^\d+$/.test(value)) ||
      fields[9] !== 'ready') throw Error('Balatro canary preflight reply is incomplete');
  const sdkHz = Number(fields[6]);
  const elapsedTicks = Number(fields[7]);
  const wallMicros = Number(fields[8]);
  const measuredHz = elapsedTicks * 1e6 / wallMicros;
  if (sdkHz !== EXPECTED_HZ || !Number.isSafeInteger(elapsedTicks) ||
      !Number.isSafeInteger(wallMicros) || wallMicros < INTERVAL_MS * 500 ||
      wallMicros > INTERVAL_MS * 4000) {
    throw Error('Balatro SDK tick measurement did not verify');
  }
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    nonce, arenaBase, arenaBytes: ARENA_BYTES, sdkHz, measuredHz,
    elapsedTicks, wallMicros, status: 'arena and timing preflight only; FS canary and marker unverified'};
}

async function runPreflight({host, nonce, execute = executeLua, inspect = checkArena}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (typeof execute !== 'function' || typeof inspect !== 'function') {
    throw new TypeError('invalid Balatro preflight dependency');
  }
  const arena = await inspect({host, phase: 'inspect', nonce, execute});
  if (arena.bytes !== ARENA_BYTES) throw Error('Balatro retained arena has an unexpected size');
  const context = {nonce, arenaBase: arena.base};
  const source = makeSource(context);
  const reply = await execute({host, port: PORT, source, timeoutMs: 15000});
  return parseReply(reply, context);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node canary-preflight.cjs <switch-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runPreflight({host: argv[0], nonce: argv[1]});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {ARENA_BYTES, EXPECTED_HZ, INTERVAL_MS, makeSource, parseReply, runPreflight};
