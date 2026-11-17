const artifact = require('./sdk-sha256.v1.2.1.json');
const {executeLua, DEFAULT_PORT} = require('./repl-client.cjs');

function makeSource() {
  const entry = artifact.function;
  const bytes = [...Buffer.from(entry.bytes, 'hex')].join(',');
  const vectors = artifact.vectors.map(({inputHex, expected}) => {
    const input = Buffer.from(inputHex, 'hex');
    const values = [...input].join(',');
    return `{${input.length},{${values}},${JSON.stringify(expected)}}`;
  }).join(',');
  return `local ffi=require('ffi')
local info=LS and LS.nx_info
local function fail(reason) return 'GC_SHA256_V1\\tfail\\t'..reason end
if not (LS and LS.state=='serving' and info and info.profile==${JSON.stringify(artifact.gameProfile)}) then return fail('profile') end
if not (info.sdk_base and info.sdk_base%4096==0) then return fail('sdk-base') end
if not (LS.fs_bridge and LS.fs_bridge.stage=='accept') then return fail('bridge-busy') end
local code=ffi.cast('const uint8_t*',ffi.cast('uintptr_t',info.sdk_base+${entry.offset}))
local expectedBytes={${bytes}}
for j=1,#expectedBytes do if tonumber(code[j-1])~=expectedBytes[j] then return fail('function-bytes') end end
local gc=require('gc.ffi_call')
local ready,why=gc.preflight(ffi,info)
if not ready then return fail('native-preflight:'..tostring(why)) end
local vectors={${vectors}}
local hashes={}
for index,vector in ipairs(vectors) do
  local n,values,want=vector[1],vector[2],vector[3]
  local input=ffi.new('uint8_t[?]',math.max(1,n))
  for j=1,n do input[j-1]=values[j] end
  local output=ffi.new('uint8_t[48]')
  for j=0,47 do output[j]=165 end
  local digest=ffi.cast('uint8_t*',output)+8
  local result,err=gc.gp_invoke(ffi,love.graphics.present,info,info.sdk_base+${entry.offset},{digest,32,input,n})
  if not result then return fail('native-call:'..tostring(err)) end
  for j=0,7 do if tonumber(output[j])~=165 or tonumber(output[40+j])~=165 then return fail('output-guard:'..index) end end
  for j=1,n do if tonumber(input[j-1])~=values[j] then return fail('input-changed:'..index) end end
  local parts={}
  for j=8,39 do parts[#parts+1]=string.format('%02x',tonumber(output[j])) end
  local got=table.concat(parts)
  if got~=want then return fail('hash-mismatch:'..index..':'..got) end
  hashes[#hashes+1]=got
end
if LS.fs_bridge.stage~='accept' then return fail('bridge-changed') end
return table.concat({'GC_SHA256_V1','ok',string.format('0x%x',info.sdk_base),hashes[1],hashes[2],LS.fs_bridge.stage},'\\t')`;
}

function parseReply(reply) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:)/m.test(reply)) throw new Error(reply.trim());
  const line = reply.trimEnd().split('\n').find(item => item.startsWith('-> GC_SHA256_V1\t'));
  if (!line) throw new Error('Gravity Circuit SHA-256 qualification reply was not recognized');
  const fields = line.slice(3).split('\t');
  if (fields[1] !== 'ok') throw new Error(`Gravity Circuit SHA-256 qualification failed: ${fields.slice(2).join(' ')}`);
  if (fields.length !== 6 || !/^0x[0-9a-f]+$/.test(fields[2]) ||
      !/^[0-9a-f]{64}$/.test(fields[3]) || !/^[0-9a-f]{64}$/.test(fields[4]) ||
      fields[5] !== 'accept') {
    throw new Error('Gravity Circuit SHA-256 qualification reply is incomplete');
  }
  if (fields[3] !== artifact.vectors[0].expected || fields[4] !== artifact.vectors[1].expected) {
    throw new Error('Gravity Circuit SHA-256 qualification returned the wrong digest');
  }
  return {
    gameProfile: artifact.gameProfile,
    sdkBase: fields[2],
    functionOffset: artifact.function.offset,
    vectorHashes: [fields[3], fields[4]],
    fsBridgeStage: fields[5],
  };
}

async function qualifyHash({host, port = DEFAULT_PORT, timeoutMs = 20000}) {
  return parseReply(await executeLua({host, port, source: makeSource(), timeoutMs}));
}

async function main() {
  const host = process.argv[2];
  if (!host) {
    process.stderr.write('usage: node qualify-hash.cjs <switch-ipv4> [port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await qualifyHash({host, port: process.argv[3] ? Number(process.argv[3]) : DEFAULT_PORT});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {artifact, makeSource, parseReply, qualifyHash};
