const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');
const helpers = require('./owned-helpers.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');

const MARKER = 'BAL_DOMAIN_READONLY_V1';
const LIMIT = 32768;
const SDK_DATA_DELTA = Number(BigInt(live.mappings.sdkData.base) - BigInt(live.identity.sdkBase));
const SDK_DATA_SIZE = Number(BigInt(live.mappings.sdkData.size));
const SDK_CRC32 = Number.parseInt(profile.sdkCode.offlineCrc32, 16);

function luaBytes(hex) {
  return `"${[...Buffer.from(hex, 'hex')].map(byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;
}

function validateProfile() {
  assert.equal(profile.runtimeVersion, '1.0.1f-FULL');
  assert.equal(live.identity.runtimeVersion, profile.runtimeVersion);
  assert.equal(helpers.sdkCodeSha256, profile.sdkCode.sha256);
  assert.equal(abi.sdkCodeSha256, profile.sdkCode.sha256);
  assert.equal(live.mountTable.sdkOffset, `0x${profile.mounts.tableOffset.toString(16)}`);
  assert.equal(live.fsProxy.managerSdkOffset, '0xd52940');
  assert.equal(live.fsProxy.vtableSdkOffset, '0xce84d0');
  assert.equal(Object.keys(profile.symbols).length, 41);
  assert.equal(SDK_CRC32, 0xac8a9d29);
  assert.ok(profile.symbols.nnutilZlib_crc32);
  assert.ok(abi.functions.entryType);
}

function makeSource({nonce}) {
  validateProfile();
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('nonce must be 16 lowercase hex digits');
  const checks = Object.entries(profile.symbols).map(([name, entry]) =>
    `{${entry.offset},${luaBytes(entry.bytes)},${JSON.stringify(name)}}`);
  const source = `local b=BL
local info=b and b.info
local nonce=${JSON.stringify(nonce)}
local function fail(reason) return table.concat({'${MARKER}','fail',nonce,reason},'\\t') end
if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return fail('identity') end
if type(info.sdk_base)~='number' or info.sdk_base<4096 or info.sdk_base%4096~=0 or
   info.sdk_base+${profile.sdkCode.size}>=2^39 then return fail('sdk-base-range') end
if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return fail('native-bridge') end
local ffi=require('ffi')
local base=info.sdk_base
if ffi.string(ffi.cast('const char*',base+${helpers.functions.queryMemory.offset}),${helpers.functions.queryMemory.size})~=${luaBytes(helpers.functions.queryMemory.bytes)} then return fail('query-code') end
local query=love.ffi.declare('uint32_t',{'void *','void *','uint64_t'},base+${helpers.functions.queryMemory.offset})
local function mapping(addr)
  if type(addr)~='number' or addr<4096 or addr>=2^39 then return nil,'address-range' end
  local buf=ffi.new('uint8_t[80]')
  for i=0,7 do buf[i]=165;buf[72+i]=165 end
  local out=ffi.cast('uint8_t*',buf)+8
  local page=ffi.new('uint32_t[1]')
  local called,rc=pcall(query,out,page,addr)
  if not called or tonumber(rc)~=0 then return nil,'query-rc' end
  for i=0,7 do if tonumber(buf[i])~=165 or tonumber(buf[72+i])~=165 then return nil,'query-guard' end end
  local u64=ffi.cast('const uint64_t*',out)
  local u32=ffi.cast('const uint32_t*',out)
  local m={base=tonumber(u64[0]),size=tonumber(u64[1]),type=tonumber(u32[4]),perm=tonumber(u32[6])}
  if not m.base or not m.size or m.base>addr or m.size<1 or
     m.base+m.size>2^39 or addr>=m.base+m.size then return nil,'mapping-range' end
  return m
end
local function readable(addr,len)
  local m,why=mapping(addr)
  if not m then return nil,why end
  if (m.perm~=1 and m.perm~=3 and m.perm~=5) or addr+len>m.base+m.size then return nil,'unreadable' end
  return m
end
local codeMap,why=readable(base,${profile.sdkCode.size})
if not codeMap then return fail(why) end
if codeMap.base~=base or codeMap.size~=${Number(BigInt(live.mappings.sdkCode.size))} or
   codeMap.type~=3 or codeMap.perm~=5 then return fail('code-map') end
local dataMap,why=readable(base+${SDK_DATA_DELTA},${SDK_DATA_SIZE})
if not dataMap then return fail(why) end
if dataMap.base~=base+${SDK_DATA_DELTA} or dataMap.size~=${SDK_DATA_SIZE} or
   dataMap.type~=4 or dataMap.perm~=3 then return fail('data-map') end
local checks={${checks.join(',')}}
for _,item in ipairs(checks) do
  if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return fail('code:'..item[3]) end
end
local crc=love.ffi.declare('uint32_t',{'uint32_t','const void *','uint64_t'},base+${profile.symbols.nnutilZlib_crc32.offset})
local vector=ffi.new('char[10]','123456789')
local called,vectorCrc=pcall(crc,0,vector,9)
if not called or tonumber(vectorCrc)~=0xcbf43926 then return fail('crc-vector') end
local sdkCalled,sdkCrc=pcall(crc,0,ffi.cast('const void*',base),${profile.sdkCode.size})
if not sdkCalled or tonumber(sdkCrc)~=${SDK_CRC32} then return fail('sdk-crc') end
local head=base+${profile.mounts.tableOffset}
local node=tonumber(ffi.cast('const uint64_t*',head+8)[0])
local seen={}
local count=0
local saveNode,accessor,implementation
while node~=head do
  if count>=8 or seen[node] then return fail('mount-cycle') end
  seen[node]=true
  count=count+1
  local addr=node-8
  local map,reason=readable(addr,48)
  if not map or map.type~=5 or map.perm~=3 then return fail(reason or 'mount-map') end
  local name=ffi.string(ffi.cast('const char*',addr+24),16):match('^[^%z]*')
  if name=='save' then
    if saveNode then return fail('duplicate-save') end
    saveNode=node
    accessor=addr
    implementation=tonumber(ffi.cast('const uint64_t*',addr+40)[0])
  end
  node=tonumber(ffi.cast('const uint64_t*',addr+16)[0])
end
if not saveNode or count<2 then return fail('save-mount-missing') end
local implMap,reason=readable(implementation,24)
if not implMap or implMap.type~=5 or implMap.perm~=3 then return fail(reason or 'implementation-map') end
local implWords=ffi.cast('const uint64_t*',implementation)
if tonumber(implWords[0])~=base+${Number(BigInt(live.mountTable.save.vtableSdkOffset))} then return fail('implementation-type') end
local service=tonumber(implWords[2])
local serviceMap,reason=readable(service,32)
if not serviceMap or serviceMap.perm~=3 then return fail(reason or 'service-map') end
local serviceWords=ffi.cast('const uint64_t*',service)
local serviceVtable=tonumber(serviceWords[0])
local manager=tonumber(serviceWords[2])
local objectId=tonumber(ffi.cast('const uint32_t*',service+24)[0])
local vtableMap,reason=readable(serviceVtable,8)
if not vtableMap or vtableMap.base~=dataMap.base or vtableMap.type~=4 then return fail(reason or 'service-vtable-map') end
local serviceVtableOffset=serviceVtable-base
if serviceVtableOffset<${SDK_DATA_DELTA} or serviceVtableOffset>=${SDK_DATA_DELTA + SDK_DATA_SIZE} then return fail('service-vtable-offset') end
local managerMap,reason=readable(manager,0x80)
if not managerMap or managerMap.perm~=3 then return fail(reason or 'manager-map') end
local proxy=base+${Number(BigInt(live.fsProxy.objectSdkOffset))}
local proxyWords=ffi.cast('const uint64_t*',proxy)
local rootId=tonumber(ffi.cast('const uint32_t*',proxy+24)[0])
if tonumber(proxyWords[0])~=base+${Number(BigInt(live.fsProxy.vtableSdkOffset))} or
   tonumber(proxyWords[2])~=manager or manager~=base+${Number(BigInt(live.fsProxy.managerSdkOffset))} or
   not rootId or rootId<1 or rootId>65535 or
   not objectId or objectId<1 or objectId>65535 or objectId==rootId then return fail('manager-or-object') end
local managerBytes=ffi.cast('const uint8_t*',manager)
local stateSize=tonumber(ffi.cast('const uint32_t*',managerBytes+8)[0])
local stateValue=tonumber(ffi.cast('const uint32_t*',managerBytes+92)[0])
if stateSize~=2048 or stateValue~=3 then return fail('manager-state') end
local entry=love.ffi.declare('uint32_t',{'void *','const char *'},base+${abi.functions.entryType.offset})
local path=ffi.new('char[?]',#('save:/bal-domain-'..nonce..'.bin')+1,'save:/bal-domain-'..nonce..'.bin')
local out=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc)
local entered,entryRc=pcall(entry,ffi.cast('void*',out+1),path)
if not entered or tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return fail('entry-call-or-guard') end
if tonumber(entryRc)~=0x202 then return fail('absent-path-result') end
local slot=tonumber(ffi.cast('const uint64_t*',managerBytes+16)[0])
local slotMap,reason=readable(slot,256)
if not slotMap or slotMap.perm~=3 or slot~=manager+128 then return fail(reason or 'session-slot-map') end
local capacity=tonumber(ffi.cast('const uint32_t*',managerBytes+88)[0])
if capacity~=16 then return fail('session-pool-capacity') end
local idleHead=tonumber(ffi.cast('const uint64_t*',managerBytes+64)[0])
local spareHead=tonumber(ffi.cast('const uint64_t*',managerBytes+72)[0])
local seenNodes={}
local seenHandles={}
local function list(head,needHandle)
  local count=0
  while head~=0 do
    if not head or head<slot or head>=slot+256 or (head-slot)%16~=0 or
       seenNodes[head] or count>=16 then return nil end
    seenNodes[head]=true
    count=count+1
    local node=ffi.cast('const uint8_t*',head)
    local handle=tonumber(ffi.cast('const uint32_t*',node)[0])
    if needHandle then
      if not handle or handle<1 or handle>=0xffff8000 or seenHandles[handle] then return nil end
      seenHandles[handle]=true
    end
    head=tonumber(ffi.cast('const uint64_t*',node+8)[0])
  end
  return count
end
local idleCount=list(idleHead,true)
local spareCount=list(spareHead,false)
if not idleCount or not spareCount or idleCount<1 or idleCount>stateValue or
   idleCount+spareCount~=16 then return fail('session-pool-lists') end
local selectedNode=idleHead
local borrowed=tonumber(ffi.cast('const uint32_t*',selectedNode)[0])
if not borrowed or borrowed<1 or borrowed>=0xffff8000 then return fail('borrowed-handle') end
local function dec(n) return string.format('%.0f',n) end
return table.concat({'${MARKER}','ok',nonce,dec(base),dec(saveNode),dec(accessor),
  dec(implementation),dec(service),dec(serviceVtable),dec(serviceVtableOffset),
  dec(manager),tostring(objectId),tostring(rootId),tostring(stateSize),
  tostring(stateValue),dec(slot),tostring(borrowed),dec(selectedNode),tostring(idleCount),string.format('%08x',tonumber(entryRc)),
  string.format('%08x',tonumber(sdkCrc))},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > LIMIT) throw new RangeError('read-only domain source exceeds REPL limit');
  return source;
}

function parseReply(reply, {nonce}) {
  validateProfile();
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid nonce');
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('missing or duplicated Balatro domain reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[2] !== nonce) throw Error('Balatro domain reply nonce mismatch');
  if (fields[1] === 'fail' && fields.length === 4) throw Error(`Balatro domain probe failed: ${fields[3]}`);
  if (fields[1] !== 'ok' || fields.length !== 21 ||
      fields.slice(3, 19).some(value => !/^\d+$/.test(value)) ||
      fields[19] !== '00000202' || fields[20] !== SDK_CRC32.toString(16)) {
    throw Error('Balatro domain reply is incomplete or unverified');
  }
  const numbers = fields.slice(3, 19).map(Number);
  if (numbers.some(value => !Number.isSafeInteger(value)) ||
      numbers.slice(0, 6).some(value => value < 4096 || value >= 2 ** 39) ||
      numbers[0] % 4096 !== 0 || numbers[1] !== numbers[2] + 8 ||
      numbers[6] !== numbers[5] - numbers[0] ||
      numbers[6] < SDK_DATA_DELTA || numbers[6] >= SDK_DATA_DELTA + SDK_DATA_SIZE ||
      numbers[7] !== numbers[0] + Number(BigInt(live.fsProxy.managerSdkOffset)) ||
      numbers[8] < 1 || numbers[8] > 65535 || numbers[9] < 1 || numbers[9] > 65535 ||
      numbers[8] === numbers[9] || numbers[10] !== 2048 || numbers[11] !== 3 ||
      numbers[12] !== numbers[7] + 0x80 ||
      numbers[13] < 1 || numbers[13] >= 0xffff8000 ||
      numbers[14] < numbers[12] || numbers[14] >= numbers[12] + 256 ||
      (numbers[14] - numbers[12]) % 16 !== 0 ||
      numbers[15] < 1 || numbers[15] > numbers[11]) {
    throw Error('Balatro domain reply has invalid fields');
  }
  const hex = value => `0x${value.toString(16)}`;
  return {
    gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion, nonce,
    sdkCodeSha256: profile.sdkCode.sha256, sdkCrc32: `0x${fields[20]}`,
    sdkBase: hex(numbers[0]),
    mount: {name: 'save', node: hex(numbers[1]), accessor: hex(numbers[2]),
      implementation: hex(numbers[3]), service: hex(numbers[4]),
      serviceVtable: hex(numbers[5]), serviceVtableOffset: hex(numbers[6]),
      manager: hex(numbers[7]), objectId: numbers[8], guardsVerified: true},
    proxy: {object: hex(numbers[0] + Number(BigInt(live.fsProxy.objectSdkOffset))),
      manager: hex(numbers[7]), objectId: numbers[9]},
    sessionManager: {stateSize: numbers[10], stateValue: numbers[11],
      slot: hex(numbers[12]), borrowedHandle: numbers[13],
      selectedNode: hex(numbers[14]), idleCount: numbers[15],
      livenessVerified: false},
    absentPathResult: `0x${fields[19]}`,
    status: 'read-only; mounted domain not cloned',
  };
}

module.exports = {MARKER, makeSource, parseReply};

if (require.main === module) {
  const nonce = process.argv[2] || crypto.randomBytes(8).toString('hex');
  process.stdout.write(`${makeSource({nonce})}\n`);
}
