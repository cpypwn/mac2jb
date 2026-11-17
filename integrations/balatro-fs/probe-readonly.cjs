const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');
const helpers = require('./owned-helpers.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');

const MARKER = 'BAL_FS_READONLY_V1';
const SDK_BASE = Number(BigInt(live.identity.sdkBase));
const SDK_DATA_DELTA = Number(BigInt(live.mappings.sdkData.base)) - SDK_BASE;
const MOUNT_ROM_OFFSET = Number(BigInt(live.mountTable.rom.node)) -
  Number(BigInt(live.mappings.mountNodes.base));
const MOUNT_SAVE_OFFSET = Number(BigInt(live.mountTable.save.node)) -
  Number(BigInt(live.mappings.mountNodes.base));
const REQUEST_LIMIT = 32768;
const CONSOLE_BANNER = ['+-----------------+', ' lovera1n by cpypwn', '+-----------------+'];

function luaBytes(hex) {
  return `"${[...Buffer.from(hex, 'hex')].map(byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
}

function validateProfile() {
  assert.equal(profile.runtimeVersion, '1.0.1f-FULL');
  assert.equal(live.identity.runtimeVersion, profile.runtimeVersion);
  assert.equal(abi.gameProfile, profile.gameProfile);
  assert.equal(abi.runtimeVersion, profile.runtimeVersion);
  assert.equal(abi.sdkCodeSha256, profile.sdkCode.sha256);
  assert.equal(helpers.sdkCodeSha256, profile.sdkCode.sha256);
  for (const name of ['entryType', 'freeSpace']) {
    const entry = abi.functions[name];
    assert.ok(entry && Number.isSafeInteger(entry.offset) && entry.offset > 0);
    assert.ok(/^[0-9a-f]+$/.test(entry.head) && entry.head.length % 2 === 0);
    assert.ok(entry.offset + entry.head.length / 2 <= profile.sdkCode.size);
    const body = Buffer.from(entry.body, 'hex');
    assert.equal(body.length, entry.size);
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), entry.sha256);
    assert.equal(entry.body.slice(0, entry.head.length), entry.head);
  }
}

function makeSource({nonce}) {
  validateProfile();
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('nonce must be 16 lowercase hex digits');
  }
  const checks = [
    ...Object.entries(profile.symbols).map(([name, entry]) =>
      `{${entry.offset},${luaBytes(entry.bytes)},${JSON.stringify(name)}}`),
    ...Object.entries(abi.functions).map(([name, entry]) =>
      `{${entry.offset},${luaBytes(entry.body || entry.head)},${JSON.stringify(name)}}`),
    {offset: helpers.functions.queryMemory.offset, bytes: helpers.functions.queryMemory.bytes,
      name: 'svcQueryMemory'},
  ].map(entry => typeof entry === 'string' ? entry :
    `{${entry.offset},${luaBytes(entry.bytes)},${JSON.stringify(entry.name)}}`);
  const source = `local b=BL
local info=b and b.info
local nonce=${JSON.stringify(nonce)}
local function fail(reason) return table.concat({'${MARKER}','fail',nonce,reason},'\\t') end
if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return fail('identity') end
if type(info.sdk_base)~='number' or info.sdk_base<4096 or
   info.sdk_base%4096~=0 or info.sdk_base+${profile.sdkCode.size}>=2^39 then
  return fail('sdk-base-range') end
if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return fail('native-bridge') end
local ffi=require('ffi')
local base=info.sdk_base
if ffi.string(ffi.cast('const char*',base+${helpers.functions.queryMemory.offset}),${helpers.functions.queryMemory.size})~=${luaBytes(helpers.functions.queryMemory.bytes)} then return fail('query-code') end
local query=love.ffi.declare('uint32_t',{'void *','void *','uint64_t'},base+${helpers.functions.queryMemory.offset})
local function mapping(addr)
  local buf=ffi.new('uint8_t[80]')
  for i=0,7 do buf[i]=165;buf[72+i]=165 end
  local out=ffi.cast('uint8_t*',buf)+8
  local page=ffi.new('uint32_t[1]')
  local called,rc=pcall(query,out,page,addr)
  if not called or tonumber(rc)~=0 then return nil,'query-rc' end
  for i=0,7 do if tonumber(buf[i])~=165 or tonumber(buf[72+i])~=165 then return nil,'query-guard' end end
  local u64=ffi.cast('const uint64_t*',out)
  local u32=ffi.cast('const uint32_t*',out)
  return {base=tonumber(u64[0]),size=tonumber(u64[1]),type=tonumber(u32[4]),perm=tonumber(u32[6])}
end
local codeMap,why=mapping(base)
if not codeMap then return fail(why) end
if codeMap.base~=base or codeMap.size~=${Number(BigInt(live.mappings.sdkCode.size))} or codeMap.type~=3 or codeMap.perm~=5 then return fail('code-map') end
local dataMap,why=mapping(base+${Number(BigInt(live.mountTable.sdkOffset))})
if not dataMap then return fail(why) end
if dataMap.base~=base+${SDK_DATA_DELTA} or dataMap.size~=${Number(BigInt(live.mappings.sdkData.size))} or dataMap.type~=4 or dataMap.perm~=3 then return fail('data-map') end
local checks={${checks.join(',')}}
for _,item in ipairs(checks) do
  if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return fail('code:'..item[3]) end
end
local head=base+${Number(BigInt(live.mountTable.sdkOffset))}
local first=tonumber(ffi.cast('const uint64_t*',head+8)[0])
local last=tonumber(ffi.cast('const uint64_t*',head)[0])
local romMap,romWhy=mapping(first)
local saveMap,saveWhy=mapping(last)
if not romMap or not saveMap then return fail(romWhy or saveWhy or 'mount-map') end
if romMap.base~=saveMap.base or romMap.size~=${Number(BigInt(live.mappings.mountNodes.size))} or
   romMap.type~=5 or romMap.perm~=3 or
   first~=romMap.base+${MOUNT_ROM_OFFSET} or last~=romMap.base+${MOUNT_SAVE_OFFSET} then
  return fail('mount-head') end
local proxy=base+${Number(BigInt(live.fsProxy.objectSdkOffset))}
local proxyWords=ffi.cast('const uint64_t*',proxy)
local proxyId=tonumber(ffi.cast('const uint32_t*',proxy+24)[0])
if tonumber(proxyWords[0])~=base+${Number(BigInt(live.fsProxy.vtableSdkOffset))} or
   tonumber(proxyWords[2])~=base+${Number(BigInt(live.fsProxy.managerSdkOffset))} or
   not proxyId or proxyId<1 or proxyId>65535 then return fail('proxy-id') end
local freeCall=love.ffi.declare('uint32_t',{'void *','const char *'},base+${abi.functions.freeSpace.offset})
local freeOut=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)
local mount=ffi.new('char[?]',7,'save:/')
local called,freeRc=pcall(freeCall,ffi.cast('void*',freeOut+1),mount)
if not called then return fail('free-call:'..tostring(freeRc)) end
if tonumber(freeRc)~=0 then return fail('free-rc:'..tostring(freeRc)) end
if tonumber(freeOut[0])~=0x5a17eacc or tonumber(freeOut[2])~=0x5a17eacc then return fail('free-guard') end
local free=tonumber(freeOut[1])
if not free or free<1048576 or free>16777216 then return fail('free-range') end
local entryCall=love.ffi.declare('uint32_t',{'void *','const char *'},base+${abi.functions.entryType.offset})
local entryOut=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc)
local path=ffi.new('char[?]',#('save:/bal-fs-'..nonce..'.bin')+1,'save:/bal-fs-'..nonce..'.bin')
local entered,entryRc=pcall(entryCall,ffi.cast('void*',entryOut+1),path)
if not entered then return fail('entry-call:'..tostring(entryRc)) end
if tonumber(entryOut[0])~=0x5a17eacc or tonumber(entryOut[2])~=0x5a17eacc then return fail('entry-guard') end
if tonumber(entryRc)==0 then return fail('path-exists') end
local showcase=package.loaded['bl.lovera1n_showcase']
if type(showcase)=='table' and type(showcase.fs_log)=='function' then
  local log=require('bl.log')
  for _,line in ipairs({${CONSOLE_BANNER.map(JSON.stringify).join(',')}}) do log.log(line) end
  pcall(showcase.fs_log,'target image: Balatro 1.0.1f')
  pcall(showcase.fs_log,'native profile loaded')
  pcall(showcase.fs_log,'1/4 Checking the console')
end
return table.concat({'${MARKER}','ok',nonce,tostring(free),string.format('%08x',tonumber(entryRc))},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > REQUEST_LIMIT) {
    throw new RangeError('read-only source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid nonce');
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro read-only reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[2] !== nonce) {
    throw new Error('Balatro read-only reply does not match this nonce');
  }
  if (fields[1] === 'fail' && fields.length === 4) {
    throw new Error(`Balatro read-only probe failed: ${fields[3]}`);
  }
  if (fields[1] !== 'ok' || fields.length !== 5 ||
      !/^\d+$/.test(fields[3]) || !/^[0-9a-f]{8}$/.test(fields[4])) {
    throw new Error('Balatro read-only reply is incomplete');
  }
  const freeBytes = Number(fields[3]);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 1048576 || freeBytes > 16777216 ||
      fields[4] === '00000000') {
    throw new Error('Balatro read-only reply has invalid values');
  }
  return {gameProfile: profile.gameProfile, nonce, freeBytes,
    absentPathResult: `0x${fields[4]}`, status: 'read-only; no save transaction tested'};
}

module.exports = {makeSource, parseReply};

if (require.main === module) {
  const nonce = process.argv[2] || crypto.randomBytes(8).toString('hex');
  process.stdout.write(`${makeSource({nonce})}\n`);
}
