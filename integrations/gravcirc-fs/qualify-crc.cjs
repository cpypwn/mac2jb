const artifact = require('./sdk-crc32.v1.2.1.json');
const {executeLua, DEFAULT_PORT} = require('./repl-client.cjs');

function makeSource() {
  const {gameProfile, sdkCode, function: entry, vector, sdkCheck} = artifact;
  const bytes = [...Buffer.from(entry.bytes, 'hex')].join(',');
  const vectorBytes = [...Buffer.from(vector.ascii, 'ascii')].join(',');
  return `local ffi=require('ffi')
local info=LS and LS.nx_info
local function fail(reason) return 'GC_CRC_V1\\tfail\\t'..reason end
if not (LS and LS.state=='serving' and info and info.profile==${JSON.stringify(gameProfile)}) then return fail('profile') end
if not (info.sdk_base and info.sdk_base%4096==0) then return fail('sdk-base') end
if LS.fs_bridge and LS.fs_bridge.stage~='accept' then return fail('bridge-busy:'..tostring(LS.fs_bridge.stage)) end
local p=ffi.cast('const uint8_t*',ffi.cast('uintptr_t',info.sdk_base+${entry.offset}))
local bytes={${bytes}}
for j=0,#bytes-1 do if tonumber(p[j])~=bytes[j+1] then return fail('function-bytes') end end
local gc=require('gc.ffi_call')
local ready,why=gc.preflight(ffi,info)
if not ready then return fail('native-preflight:'..tostring(why)) end
local test=ffi.new('uint8_t[${vectorBytes.split(',').length}]',{${vectorBytes}})
local vector,err=gc.gp_invoke(ffi,love.graphics.present,info,info.sdk_base+${entry.offset},{${vector.seed},test,${vectorBytes.split(',').length}})
if not vector then return fail('vector-call:'..tostring(err)) end
if tonumber(vector.raw)~=${vector.expected} then return fail('vector-result:'..tostring(vector.raw)) end
local sdk,err=gc.gp_invoke(ffi,love.graphics.present,info,info.sdk_base+${entry.offset},{${sdkCheck.seed},info.sdk_base,${sdkCode.size}})
if not sdk then return fail('sdk-call:'..tostring(err)) end
if tonumber(sdk.raw)~=${sdkCheck.expected} then return fail('sdk-result:'..tostring(sdk.raw)) end
return table.concat({'GC_CRC_V1','ok',string.format('0x%x',info.sdk_base),string.format('%08x',tonumber(vector.raw)),string.format('%08x',tonumber(sdk.raw)),tostring(LS.fs_bridge and LS.fs_bridge.stage or 'absent')},'\\t')`;
}

function parseReply(reply) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:)/m.test(reply)) throw new Error(reply.trim());
  const line = reply.trimEnd().split('\n').find(item => item.startsWith('-> GC_CRC_V1\t'));
  if (!line) throw new Error('Gravity Circuit CRC qualification reply was not recognized');
  const fields = line.slice(3).split('\t');
  if (fields[1] !== 'ok') throw new Error(`Gravity Circuit CRC qualification failed: ${fields.slice(2).join(' ')}`);
  if (fields.length !== 6 || !/^0x[0-9a-f]+$/.test(fields[2]) ||
      !/^[0-9a-f]{8}$/.test(fields[3]) || !/^[0-9a-f]{8}$/.test(fields[4])) {
    throw new Error('Gravity Circuit CRC qualification reply is incomplete');
  }
  if (Number.parseInt(fields[3], 16) !== artifact.vector.expected ||
      Number.parseInt(fields[4], 16) !== artifact.sdkCheck.expected) {
    throw new Error('Gravity Circuit CRC qualification returned the wrong checksum');
  }
  return {
    gameProfile: artifact.gameProfile,
    sdkBase: fields[2],
    functionOffset: artifact.function.offset,
    vectorCrc32: fields[3],
    sdkCrc32: fields[4],
    fsBridgeStage: fields[5],
  };
}

async function qualifyCrc({host, port = DEFAULT_PORT, timeoutMs = 20000}) {
  return parseReply(await executeLua({host, port, source: makeSource(), timeoutMs}));
}

async function main() {
  const host = process.argv[2];
  if (!host) {
    process.stderr.write('usage: node qualify-crc.cjs <switch-ipv4> [port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await qualifyCrc({host, port: process.argv[3] ? Number(process.argv[3]) : DEFAULT_PORT});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {artifact, makeSource, parseReply, qualifyCrc};
