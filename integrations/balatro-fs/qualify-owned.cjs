const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');
const helpers = require('./owned-helpers.v1.0.1f.json');

const MARKER = 'BAL_OWNED_V1';
const PHASES = new Set(['allocation', 'service']);
const SDK_BASE = Number(BigInt(live.identity.sdkBase));
const SDK_DATA_DELTA = Number(BigInt(live.mappings.sdkData.base)) - SDK_BASE;
const ALLOCATOR_MANAGER_DELTA = Number(BigInt(live.mappings.allocatorManager.base)) - SDK_BASE;
const MOUNT_ROM_OFFSET = Number(BigInt(live.mountTable.rom.node)) -
  Number(BigInt(live.mappings.mountNodes.base));
const MOUNT_SAVE_OFFSET = Number(BigInt(live.mountTable.save.node)) -
  Number(BigInt(live.mappings.mountNodes.base));
const REQUEST_LIMIT = 32768;

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseSymbols(dynsym, dynstr) {
  if (!Buffer.isBuffer(dynsym) || !Buffer.isBuffer(dynstr) || dynsym.length % 24 !== 0) {
    throw new TypeError('captured SDK symbol tables must be complete buffers');
  }
  const symbols = new Map();
  for (let offset = 0; offset < dynsym.length; offset += 24) {
    const nameOffset = dynsym.readUInt32LE(offset);
    if (nameOffset >= dynstr.length) continue;
    const end = dynstr.indexOf(0, nameOffset);
    if (end < 0) continue;
    const name = dynstr.toString('ascii', nameOffset, end);
    if (!name) continue;
    const value = Number(dynsym.readBigUInt64LE(offset + 8));
    const size = Number(dynsym.readBigUInt64LE(offset + 16));
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(size)) continue;
    if (symbols.has(name)) throw new Error(`duplicate captured SDK symbol: ${name}`);
    symbols.set(name, {offset: value, size});
  }
  return symbols;
}

function validateArtifact() {
  assert.equal(helpers.gameProfile, profile.gameProfile);
  assert.equal(helpers.runtimeVersion, profile.runtimeVersion);
  assert.equal(helpers.sdkCodeSha256, profile.sdkCode.sha256);
  assert.equal(helpers.capturedSdkBase, live.identity.sdkBase);
  assert.equal(live.identity.runtimeVersion, profile.runtimeVersion);
  assert.equal(live.identity.pinnedCodeHeadsMatched, Object.keys(profile.symbols).length);
  const dataStart = Number(BigInt(live.mappings.sdkData.base)) - SDK_BASE;
  const dataEnd = dataStart + Number(BigInt(live.mappings.sdkData.size));
  assert.ok(Number.isSafeInteger(helpers.allocatorManagerGlobalSdkOffset) &&
    helpers.allocatorManagerGlobalSdkOffset >= dataStart &&
    helpers.allocatorManagerGlobalSdkOffset + 8 <= dataEnd);
  for (const [name, entry] of Object.entries(helpers.functions)) {
    const bytes = Buffer.from(entry.bytes, 'hex');
    assert.equal(bytes.length, entry.size, `${name} body size`);
    assert.equal(hash(bytes), entry.sha256, `${name} body hash`);
    assert.ok(Number.isSafeInteger(entry.offset) && entry.offset >= 0);
  }
}

function verifyCapturedSdk({code, dynsym, dynstr}) {
  validateArtifact();
  if (!Buffer.isBuffer(code) || code.length !== profile.sdkCode.size ||
      hash(code) !== profile.sdkCode.sha256) {
    throw new Error('captured Balatro SDK image does not match the pinned 1.0.1f image');
  }
  const symbols = parseSymbols(dynsym, dynstr);
  for (const [name, entry] of Object.entries(helpers.functions)) {
    if (entry.offset + entry.size > code.length ||
        code.subarray(entry.offset, entry.offset + entry.size).toString('hex') !== entry.bytes) {
      throw new Error(`captured Balatro SDK ${name} bytes differ`);
    }
    if (entry.symbol) {
      const symbol = symbols.get(entry.symbol);
      if (!symbol || symbol.offset !== entry.offset || symbol.size !== entry.size) {
        throw new Error(`captured Balatro SDK ${name} symbol differs`);
      }
    }
  }
  for (const [name, entry] of Object.entries(profile.symbols)) {
    if (code.subarray(entry.offset, entry.offset + entry.bytes.length / 2).toString('hex') !== entry.bytes) {
      throw new Error(`captured Balatro SDK ${name} code head differs`);
    }
  }
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: hash(code), verifiedCodeHeads: Object.keys(profile.symbols).length,
    verifiedHelpers: Object.keys(helpers.functions)};
}

function luaBytes(hex) {
  return `"${[...Buffer.from(hex, 'hex')].map(byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
}

function makePreamble({phase, nonce, skipMountCheck = true}) {
  validateArtifact();
  if (!PHASES.has(phase) && phase !== 'allocator-map') {
    throw new TypeError('phase must be allocation, service, or allocator-map');
  }
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('nonce must be 16 lowercase hex digits');
  const checks = [
    ...Object.entries(profile.symbols).map(([name, entry]) =>
      `{${entry.offset},${luaBytes(entry.bytes)},${JSON.stringify(name)}}`),
    ...Object.entries(helpers.functions).map(([name, entry]) =>
      `{${entry.offset},${luaBytes(entry.bytes)},${JSON.stringify(name)}}`),
  ];
  const before = `local b=BL
local info=b and b.info
local phase=${JSON.stringify(phase)}
local nonce=${JSON.stringify(nonce)}
local function fail(reason) return table.concat({'${MARKER}',phase,'fail',nonce,reason},'\\t') end
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
  local infoBuf=ffi.new('uint8_t[80]')
  for i=0,7 do infoBuf[i]=165; infoBuf[72+i]=165 end
  local out=ffi.cast('uint8_t*',infoBuf)+8
  local page=ffi.new('uint32_t[1]')
  local rc=query(out,page,addr)
  if tonumber(rc)~=0 then return nil,'query-rc' end
  for i=0,7 do if tonumber(infoBuf[i])~=165 or tonumber(infoBuf[72+i])~=165 then return nil,'query-guard' end end
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
end`;
  const mountCheck = skipMountCheck ? '' : `
local head=base+${Number(BigInt(live.mountTable.sdkOffset))}
local first=tonumber(ffi.cast('const uint64_t*',head+8)[0])
local last=tonumber(ffi.cast('const uint64_t*',head)[0])
local romMap,romWhy=mapping(first)
local saveMap,saveWhy=mapping(last)
if not romMap or not saveMap then return fail(romWhy or saveWhy or 'mount-map') end
if romMap.base~=saveMap.base or romMap.size~=${Number(BigInt(live.mappings.mountNodes.size))} or
   romMap.type~=5 or romMap.perm~=3 or
   first~=romMap.base+${MOUNT_ROM_OFFSET} or last~=romMap.base+${MOUNT_SAVE_OFFSET} then
  return fail('mount-head') end`;
  const proxyCheck = `
local proxy=base+${Number(BigInt(live.fsProxy.objectSdkOffset))}
local proxyWords=ffi.cast('const uint64_t*',proxy)
local proxyId=tonumber(ffi.cast('const uint32_t*',proxy+24)[0])
if tonumber(proxyWords[0])~=base+${Number(BigInt(live.fsProxy.vtableSdkOffset))} or
   tonumber(proxyWords[2])~=base+${Number(BigInt(live.fsProxy.managerSdkOffset))} or
   not proxyId or proxyId<1 or proxyId>65535 then return fail('proxy-id') end`;
  return before + mountCheck + proxyCheck;
}

function makeSource({phase, nonce, skipMountCheck = true}) {
  if (!PHASES.has(phase)) throw new TypeError('phase must be allocation or service');
  const before = makePreamble({phase, nonce, skipMountCheck});
  const allocation = `
local allocate=love.ffi.declare('uint32_t',{'uint64_t *','uint64_t'},base+${helpers.functions.allocate.offset})
local release=love.ffi.declare('void',{'uint64_t','uint64_t'},base+${helpers.functions.free.offset})
local manager=tonumber(ffi.cast('const uint64_t*',base+${helpers.allocatorManagerGlobalSdkOffset})[0])
if not manager or manager<4096 or manager>=9007199254740992 then return fail('allocator-manager') end
local managerMap,managerWhy=mapping(manager)
if not managerMap then return fail(managerWhy) end
if managerMap.base~=base+${ALLOCATOR_MANAGER_DELTA} or managerMap.size~=${Number(BigInt(live.mappings.allocatorManager.size))} or managerMap.type~=4 or managerMap.perm~=3 or manager<managerMap.base or manager+0x3f8>managerMap.base+managerMap.size then return fail('allocator-map') end
local lower=tonumber(ffi.cast('const uint64_t*',manager+0x3e8)[0])
local extent=tonumber(ffi.cast('const uint64_t*',manager+0x3f0)[0])
if not lower or not extent or lower<4096 or extent<4096 or lower+extent>=9007199254740992 then return fail('allocator-bounds') end
local out=ffi.new('uint64_t[3]')
out[0]=0x5a17eacc; out[1]=0; out[2]=0x5a17eacc
local called,returnOrError=pcall(allocate,ffi.cast('uint64_t*',out)+1,4096)
if not called then return fail('allocate-call:'..tostring(returnOrError)) end
local return32=tonumber(returnOrError)
if not return32 then return fail('allocate-return32') end
if return32~=0 then return fail('allocate-return32:'..string.format('0x%x',return32)) end
local addr=tonumber(out[1])
local safe=type(addr)=='number' and addr>=lower and addr+4096<=lower+extent
if not safe then return fail('allocate-address') end
local released,releaseError=pcall(release,addr,4096)
if not released then return fail('free-call:'..tostring(releaseError)) end
if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return fail('allocate-guard') end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',addr),'free-returned'},'\\t')`;
  const service = `
local getService=love.ffi.declare('uint32_t',{'uint32_t *','const char *','uint64_t'},base+${helpers.functions.getService.offset})
local closeHandle=love.ffi.declare('uint32_t',{'uint32_t'},base+${helpers.functions.closeHandle.offset})
local out=ffi.new('uint32_t[3]')
out[0]=0x5a17eacc; out[1]=0; out[2]=0x5a17eacc
local name=ffi.new('char[8]','fsp-srv')
local called,rc=pcall(getService,ffi.cast('uint32_t*',out)+1,name,7)
if not called then return fail('service-call:'..tostring(rc)) end
if tonumber(rc)~=0 then return fail('service-rc:'..tostring(rc)) end
local handle=tonumber(out[1])
if handle==0 then return fail('service-handle') end
local closed,closeRc=pcall(closeHandle,handle)
if not closed then return fail('close-call:'..tostring(closeRc)) end
if tonumber(closeRc)~=0 then return fail('service-close-rc:'..tostring(closeRc)) end
if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return fail('service-guard') end
local showcase=package.loaded['bl.lovera1n_showcase']
if type(showcase)=='table' and type(showcase.fs_log)=='function' then
  pcall(showcase.fs_log,'fsp-srv handle verified and closed')
end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('%08x',handle),'closed'},'\\t')`;
  const source = before + (phase === 'allocation' ? allocation : service);
  if (Buffer.byteLength(source, 'utf8') > REQUEST_LIMIT) throw new RangeError('qualification source exceeds REPL limit');
  return source;
}

function parseReply(reply, {phase, nonce}) {
  if (!PHASES.has(phase) || !/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid qualification context');
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw new Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro qualification reply');
  const fields = lines[0].slice(3).split('\t');
  if ((fields.length !== 5 && fields.length !== 6) ||
      fields[0] !== MARKER || fields[1] !== phase || fields[3] !== nonce) {
    throw new Error('Balatro qualification reply does not match this phase and nonce');
  }
  if (fields[2] === 'fail' && fields.length === 5) {
    throw new Error(`Balatro ${phase} qualification failed: ${fields[4]}`);
  }
  if (fields[2] !== 'ok' || fields.length !== 6) {
    throw new Error('Balatro qualification reply has invalid status or field count');
  }
  if (phase === 'allocation' && (!/^0x[0-9a-f]+$/.test(fields[4]) || fields[5] !== 'free-returned')) {
    throw new Error('Balatro allocation qualification reply is incomplete');
  }
  if (phase === 'service' && (!/^[0-9a-f]{8}$/.test(fields[4]) || fields[5] !== 'closed')) {
    throw new Error('Balatro service qualification reply is incomplete');
  }
  return {gameProfile: profile.gameProfile, phase, nonce,
    observed: fields[4], cleanup: fields[5], status: 'native call returned; no save transaction tested'};
}

module.exports = {helpers, verifyCapturedSdk, makePreamble, makeSource, parseReply};
