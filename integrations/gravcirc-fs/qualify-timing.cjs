const crypto = require('node:crypto');
const timing = require('./sdk-timing.v1.2.1.json');
const profile = require('./profile.v1.2.1.json');
const {executeLua, DEFAULT_PORT} = require('./repl-client.cjs');

const DEFAULT_INTERVAL_NS = 1000000000;
const MAX_INTERVAL_NS = 1000000000;
const TOLERANCE_PPM = 100000;

function makeSource(intervalNs = DEFAULT_INTERVAL_NS, nonce = '0000000000000000') {
  if (!Number.isSafeInteger(intervalNs) || intervalNs < 100000000 || intervalNs > MAX_INTERVAL_NS) {
    throw new RangeError('timing interval must be between 100 ms and 1 s');
  }
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw new TypeError('timing nonce must be 16 lowercase hex digits');
  const functionRows = ['tick', 'frequency', 'sleep'].map(name => {
    const entry = timing.functions[name];
    return `{${entry.offset},{${[...Buffer.from(entry.bytes, 'hex')].join(',')}}}`;
  });
  const tick = timing.functions.tick.offset;
  const frequency = timing.functions.frequency.offset;
  const sleep = timing.functions.sleep.offset;
  return `local ffi=require('ffi')
local info=LS and LS.nx_info
local function fail(reason) return 'GC_TIMING_V2\\tfail\\t'..reason end
if not (LS and LS.state=='serving' and info and info.profile==${JSON.stringify(timing.gameProfile)}) then return fail('profile') end
if not (LS.fs_bridge and LS.fs_bridge.stage=='accept') then return fail('bridge-busy') end
if not (info.sdk_base and info.sdk_base%4096==0) then return fail('sdk-base') end
local checks={${functionRows.join(',')}}
for _,entry in ipairs(checks) do
  local p=ffi.cast('const uint8_t*',ffi.cast('uintptr_t',info.sdk_base+entry[1]))
  for j=1,#entry[2] do if tonumber(p[j-1])~=entry[2][j] then return fail('function-bytes') end end
end
local gc=require('gc.ffi_call')
local ready,why=gc.preflight(ffi,info)
if not ready then return fail('native-preflight:'..tostring(why)) end
local function call(offset,args)
  local result,err=gc.gp_invoke(ffi,love.graphics.present,info,info.sdk_base+offset,args or {})
  if not result then error('native timing call failed: '..tostring(err)) end
  return result.raw
end
local sdkHz=tonumber(call(${frequency}))
if sdkHz~=${timing.functions.frequency.returnedHz} then return fail('sdk-frequency:'..tostring(sdkHz)) end
local start=call(${tick})
call(${sleep},{${intervalNs}})
local finish=call(${tick})
local delta=tonumber(finish-start)
if not (delta and delta>0 and delta<${intervalNs}) then return fail('counter-delta:'..tostring(delta)) end
if LS.fs_bridge.stage~='accept' then return fail('bridge-changed') end
return table.concat({'GC_TIMING_V2','ok',tostring(sdkHz),tostring(delta),
  tostring(LS.fs_bridge.stage),string.format('%.0f',info.sdk_base),
  string.format('%.0f',LS.fs_bridge.scratch),
  tostring(LS.fs_bridge.profile.sdkCrc32),${JSON.stringify(nonce)}},'\\t')`;
}

function parseReply(reply, intervalNs = DEFAULT_INTERVAL_NS, expectedNonce = null) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:)/m.test(reply)) throw new Error(reply.trim());
  const line = reply.trimEnd().split('\n').find(item => item.startsWith('-> GC_TIMING_V2\t'));
  if (!line) throw new Error('Gravity Circuit timing reply was not recognized');
  const fields = line.slice(3).split('\t');
  if (fields[1] !== 'ok') throw new Error(`Gravity Circuit timing qualification failed: ${fields.slice(2).join(' ')}`);
  if (fields.length !== 9 || !fields.slice(2, 4).every(value => /^\d+$/.test(value)) ||
      !fields.slice(5, 8).every(value => /^\d+$/.test(value)) ||
      !/^[0-9a-f]{16}$/.test(fields[8])) {
    throw new Error('Gravity Circuit timing reply is incomplete');
  }
  const sdkFrequency = Number(fields[2]);
  const elapsedTicks = Number(fields[3]);
  const sdkBase = Number(fields[5]);
  const scratch = Number(fields[6]);
  const sdkCrc32 = Number(fields[7]);
  const nonce = fields[8];
  const measuredFrequency = elapsedTicks * 1000000000 / intervalNs;
  const nativeFrequency = timing.nativeCounterHz;
  if (fields[4] !== 'accept' || sdkFrequency !== timing.functions.frequency.returnedHz ||
      !Number.isSafeInteger(sdkBase) || sdkBase < 0x1000 || sdkBase % 4096 ||
      !Number.isSafeInteger(scratch) || scratch < 0x1000 || scratch % 4096 ||
      sdkCrc32 !== profile.sdkCrc32 ||
      expectedNonce !== null && nonce !== expectedNonce ||
      !Number.isSafeInteger(nativeFrequency) || nativeFrequency <= 0 ||
      Math.abs(measuredFrequency - nativeFrequency) > nativeFrequency * TOLERANCE_PPM / 1000000) {
    throw new Error('Gravity Circuit counter frequency differs from the measured native frequency');
  }
  return {
    gameProfile: timing.gameProfile,
    sdkFrequency,
    nativeFrequency,
    intervalNs,
    elapsedTicks,
    measuredFrequency,
    tolerancePpm: TOLERANCE_PPM,
    fsBridgeStage: fields[4],
    sdkBase,
    scratch,
    sdkCrc32,
    nonce,
  };
}

async function qualifyTiming({host, port = DEFAULT_PORT, intervalNs = DEFAULT_INTERVAL_NS,
  timeoutMs = 15000}) {
  const nonce = crypto.randomBytes(8).toString('hex');
  return parseReply(await executeLua({host, port, source: makeSource(intervalNs, nonce), timeoutMs}),
    intervalNs, nonce);
}

async function main() {
  const host = process.argv[2];
  if (!host) {
    process.stderr.write('usage: node qualify-timing.cjs <switch-ipv4> [port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await qualifyTiming({host, port: process.argv[3] ? Number(process.argv[3]) : DEFAULT_PORT});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {DEFAULT_INTERVAL_NS, TOLERANCE_PPM, makeSource, parseReply, qualifyTiming};
