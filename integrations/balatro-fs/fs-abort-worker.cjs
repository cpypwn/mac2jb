const net = require('node:net');
const {createHash} = require('node:crypto');
const {makePreamble} = require('./qualify-owned.cjs');
const {FUNCTIONS, RESULT_SENTINEL} = require('./worker-frame.cjs');
const {RESULT_OFFSET} = require('./worker-chain.cjs');
const {ROLES} = require('./fs-abort-frames.cjs');
const {FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES,
  SERVICE_HANDLE_OFFSET} = require('./fs-counter-overlap.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_FS_ABORT_WORKER_V1';
const GUARD_MARKER = 'BAL_FS_ABORT_GUARD_V1';
const PHASE = 'fs-abort-worker';
const ARENA_BYTES = 0x200000;
const SOURCE_LIMIT = 32768;
const TICK_HZ = 19200000n;
const MAX_TICKS = TICK_HZ * 2n;
const PROTECTED_ROLES = Object.freeze(['canary', ...ROLES]);
const REQUEST_KINDS = Object.freeze({canary: 'cloned-save-entry-type',
  pin: 'owned-storage-open', receive: 'receive-buffer-request',
  trigger: 'cloned-save-entry-type'});

function workerRoles(staged) {
  if (staged?.workerKind === 'protected-canary-window' &&
      staged.frames?.length === PROTECTED_ROLES.length) return PROTECTED_ROLES;
  if ((staged?.workerKind === undefined ||
       staged.workerKind === 'abort-control') &&
      staged.frames?.length === ROLES.length) return ROLES;
  throw Error('Balatro worker kind and exact role count changed');
}

function address(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) {
    throw new TypeError(`Balatro ${name} must be an exact hex address`);
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 4096 || number % 4096 ||
      number >= 2 ** 39) {
    throw new RangeError(`Balatro ${name} is outside the pinned user range`);
  }
  return number;
}

function exactOptions(options) {
  const {nonce, arenaBase, sdkBase, mainBase, waveId,
    hostIp, port, staged, stageReceipt} = options || {};
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      !/^[0-9a-f]{16}$/.test(waveId || '') || waveId === nonce ||
      net.isIP(hostIp) !== 4 || !Number.isInteger(port) ||
      port < 1024 || port > 65535 || port === 39380) {
    throw new TypeError('Balatro abort worker needs a distinct wave and exact transport');
  }
  const arena = address(arenaBase, 'arena');
  const sdk = address(sdkBase, 'SDK');
  address(mainBase, 'main image');
  const roles = workerRoles(staged);
  if (arena + ARENA_BYTES >= 2 ** 39 ||
      sdk + profile.sdkCode.size >= 2 ** 39 ||
      staged?.arenaNonce !== nonce || staged?.waveId !== waveId ||
      staged?.arenaBase !== arena || staged?.sdkBase !== sdk ||
      stageReceipt?.arenaNonce !== nonce || stageReceipt?.waveId !== waveId ||
      stageReceipt?.exactReadbackVerified !== true ||
      stageReceipt?.workerStarted !== false || stageReceipt?.saveWrites !== 0 ||
      !Array.isArray(stageReceipt.frameSha256) ||
      stageReceipt.frameSha256.length !== roles.length ||
      (roles.length - 1) * FRAME_SPACING + PACKET_OFFSET + PACKET_BYTES >= 0x10000) {
    throw new Error('Balatro abort frames are not exact and freshly staged');
  }
  const handles = new Set();
  for (let i = 0; i < roles.length; i++) {
    const frame = staged.frames[i];
    const hash = createHash('sha256').update(frame?.bytes || Buffer.alloc(0)).digest('hex');
    if (frame?.role !== roles[i] ||
        frame.address !== arena + i * FRAME_SPACING ||
        !Buffer.isBuffer(frame.bytes) ||
        frame.bytes.length !== PACKET_OFFSET + PACKET_BYTES ||
        !Number.isInteger(frame.handle) || frame.handle <= 0 ||
        frame.handle >= 0xffff8000 || handles.has(frame.handle) ||
        frame.bytes.readBigUInt64LE(SERVICE_HANDLE_OFFSET) !== BigInt(frame.handle) ||
        frame.sha256 !== hash || stageReceipt.frameSha256[i] !== hash) {
      throw new Error(`Balatro ${roles[i]} frame no longer has exact ownership`);
    }
    handles.add(frame.handle);
  }
  return {nonce, arenaBase, sdkBase, mainBase, waveId,
    hostIp, port, staged, arena, sdk, roles};
}

function requestId(waveId, role) {
  return createHash('sha256').update(`${waveId}:${role}`).digest('hex').slice(0, 16);
}

function makeAbortGuardSource(options) {
  const {nonce, sdkBase, mainBase, waveId, hostIp, port,
    staged, arena, roles} = exactOptions(options);
  const packets = staged.frames.map(frame =>
    frame.bytes.subarray(PACKET_OFFSET, PACKET_OFFSET + 256).toString('hex'));
  const handles = staged.frames.map(frame => frame.handle);
  const source = `local b=BL
local h=b and b.fs_bridge
local t=b and b.fs_transport
local tag='${GUARD_MARKER}'
local function fail(reason) return table.concat({tag,'fail','${nonce}','${waveId}',reason},'\\t') end
if not b or b.state~='serving' or not b.info or
   b.info.version~='${profile.runtimeVersion}' or
   string.format('0x%x',b.info.sdk_base or 0)~='${sdkBase}' or
   string.format('0x%x',b.info.main_base or 0)~='${mainBase}' or
   not h or h.owner~='${nonce}' or h.base~=${arena} or
   h.bytes~=${ARENA_BYTES} or h.stage~='ready' or not h.buf or
   b.fs_worker_hold or not t or t.owner~='${nonce}' or
   t.hostIp~='${hostIp}' or t.port~=${port} or
   t.arena~=h or t.stage~='read-request' or not t.client then
  return fail('owner-or-transport')
end
local ffi=require('ffi')
local raw=tonumber(ffi.cast('uintptr_t',h.buf))
if not raw or h.before~=h.base-raw-64 or
   h.after~=h.base-raw+h.bytes or
   h.base+h.bytes+64>raw+ffi.sizeof(h.buf) then return fail('arena-bounds') end
for i=0,63 do
  if tonumber(h.buf[h.before+i])~=165 or
     tonumber(h.buf[h.after+i])~=165 then return fail('arena-guard') end
end
local packets={${packets.map(value => `'${value}'`).join(',')}}
local handles={${handles.join(',')}}
for j=0,${roles.length - 1} do
  local frame=h.base+j*${FRAME_SPACING}
  if frame%4096~=0 or
     frame+${PACKET_OFFSET + PACKET_BYTES}>h.base+h.bytes then
    return fail('frame-bounds:'..j)
  end
  if tonumber(ffi.cast('const uint64_t*',frame+${SERVICE_HANDLE_OFFSET})[0])~=
     handles[j+1] then return fail('handle:'..j) end
  local words=ffi.cast('const uint32_t*',frame+${RESULT_OFFSET})
  for k=0,2 do
    if tonumber(words[k*2])~=0x76543210 or
       tonumber(words[k*2+1])~=0xfedcba98 then
      return fail('sentinel:'..j..':'..k)
    end
  end
  local ptr=ffi.cast('const uint8_t*',frame+${PACKET_OFFSET})
  local hex=packets[j+1]
  for i=0,255 do
    if tonumber(ptr[i])~=tonumber(hex:sub(i*2+1,i*2+2),16) then
      return fail('packet:'..j..':'..i)
    end
  end
end
return table.concat({tag,'ok','${nonce}','${waveId}','all-frames-verified'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro abort guard source exceeds the REPL limit');
  }
  return source;
}

function parseAbortGuardReply(reply, options) {
  const {nonce, waveId} = exactOptions(options);
  if (typeof reply !== 'string') throw new TypeError('Balatro abort guard reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const lines = reply.trimEnd().split('\n').filter(line =>
    line.startsWith(`-> ${GUARD_MARKER}\t`));
  if (lines.length !== 1) throw Error('Balatro abort guard reply missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields.length !== 5 || fields[0] !== GUARD_MARKER ||
      fields[2] !== nonce || fields[3] !== waveId) {
    throw Error('Balatro abort guard owner or wave changed');
  }
  if (fields[1] === 'fail') {
    throw Error(`Balatro abort guard failed before workers: ${fields[4]}`);
  }
  if (fields[1] !== 'ok' || fields[4] !== 'all-frames-verified') {
    throw Error('Balatro abort guard did not verify every staged frame');
  }
  return {owner: nonce, waveId, frameCount: workerRoles(options.staged).length,
    verified: true, workersStarted: false};
}

function makeAbortWorkerSource(options) {
  const {nonce, arenaBase, sdkBase, mainBase, waveId,
    hostIp, port, staged, arena, roles} = exactOptions(options);
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) {
    throw new Error('Balatro pinned preamble changed');
  }
  const preamble = inherited.replace('local phase="allocator-map"',
    `local phase="${PHASE}"`).replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const symbols = profile.symbols;
  const packets = staged.frames.map(frame =>
    frame.bytes.subarray(PACKET_OFFSET, PACKET_OFFSET + 256).toString('hex'));
  const handles = staged.frames.map(frame => frame.handle);
  const ids = roles.map(role => requestId(waveId, role));
  const source = `${preamble}
if string.format('0x%x',base)~='${sdkBase}' or
   string.format('0x%x',info.main_base or 0)~='${mainBase}' then
  return fail('image-base-changed')
end
local held=b.fs_bridge
local transport=b.fs_transport
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${arena} or held.bytes~=${ARENA_BYTES} or not held.buf or
   b.fs_worker_hold or not transport or transport.owner~=nonce or
   transport.hostIp~='${hostIp}' or transport.port~=${port} or
   transport.arena~=held or transport.info~=info or
   not transport.native or transport.stage~='read-request' or
   not transport.client then return fail('owner-or-transport-changed') end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.before~=held.base-raw-64 or
   held.after~=held.base-raw+held.bytes or
   held.base+held.bytes+64>raw+ffi.sizeof(held.buf) then
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
local last,lastWhy=mapping(held.base+held.bytes-1)
if not first or not last or first.base~=last.base or first.size~=last.size or
   first.type~=5 or first.perm~=3 or first.base>held.base or
   held.base+held.bytes>first.base+first.size then
  return fail(why or lastWhy or 'arena-map')
end
local packets={${packets.map(value => `'${value}'`).join(',')}}
local handles={${handles.join(',')}}
local function matchPacket(ptr,hex)
  for i=0,#hex/2-1 do
    if tonumber(ptr[i])~=tonumber(hex:sub(i*2+1,i*2+2),16) then
      return false
    end
  end
  return true
end
local function sentinel(address)
  local words=ffi.cast('const uint32_t*',address)
  return tonumber(words[0])==0x76543210 and tonumber(words[1])==0xfedcba98
end
for j=0,${roles.length - 1} do
  local frame=held.base+j*${FRAME_SPACING}
  if frame%4096~=0 or frame+${PACKET_OFFSET + PACKET_BYTES}>held.base+held.bytes then
    return fail('staged-frame-bounds:'..j)
  end
  if tonumber(ffi.cast('const uint64_t*',frame+${SERVICE_HANDLE_OFFSET})[0])~=handles[j+1] then
    return fail('staged-handle-changed:'..j)
  end
  if not sentinel(frame+${RESULT_OFFSET}) or
     not sentinel(frame+${RESULT_OFFSET + 8}) or
     not sentinel(frame+${RESULT_OFFSET + 16}) then
    return fail('staged-sentinel-changed:'..j)
  end
  if not matchPacket(ffi.cast('const uint8_t*',frame+${PACKET_OFFSET}),packets[j+1]) then
    return fail('staged-packet-changed:'..j)
  end
end
local current=love.ffi.declare('uint64_t',{},base+${symbols['nn::os::GetCurrentThread'].offset})
local thread=tonumber(current())
if not thread or thread<4096 or thread%8~=0 or
   thread+${profile.threadManager.nodeHandleOffset + 4}>=2^39 then
  return fail('current-thread')
end
local threadMap,threadWhy=mapping(thread)
if not threadMap or threadMap.type~=4 or threadMap.perm~=3 or
   thread+${profile.threadManager.nodeHandleOffset + 4}>threadMap.base+threadMap.size then
  return fail(threadWhy or 'thread-map')
end
local currentHandle=tonumber(ffi.cast('const uint32_t*',
  thread+${profile.threadManager.nodeHandleOffset})[0])
local getPriority=love.ffi.declare('uint32_t',{'uint32_t *','uint32_t'},
  base+${symbols.svcGetThreadPriority.offset})
local getMask=love.ffi.declare('uint32_t',{'uint32_t *','uint64_t *','uint32_t'},
  base+${symbols.svcGetThreadCoreMask.offset})
local priority=ffi.new('uint32_t[1]')
local core=ffi.new('uint32_t[1]')
local mask=ffi.new('uint64_t[1]')
if not currentHandle or currentHandle==0 or currentHandle>=0xffff8000 or
   tonumber(getPriority(priority,currentHandle))~=0 or
   tonumber(getMask(core,mask,currentHandle))~=0 or
   tonumber(priority[0])~=${profile.liveReadOnlyEvidence.borrowedThread.priority} or
   tonumber(mask[0])~=${profile.liveReadOnlyEvidence.borrowedThread.coreMask} then
  return fail('borrowed-thread-profile')
end
local create=love.ffi.declare('uint32_t',{'uint32_t *','uint64_t','uint64_t',
  'uint64_t','int32_t','int32_t'},base+${symbols.svcCreateThread.offset})
local start=love.ffi.declare('uint32_t',{'uint32_t'},base+${symbols.svcStartThread.offset})
local getId=love.ffi.declare('uint32_t',{'uint64_t *','uint32_t'},
  base+${symbols.svcGetThreadId.offset})
local wait=love.ffi.declare('uint32_t',{'uint32_t *','uint32_t *','int32_t','int64_t'},
  base+${symbols.svcWaitSynchronization.offset})
local close=love.ffi.declare('uint32_t',{'uint32_t'},base+${symbols.svcCloseHandle.offset})
local hold={owner=nonce,wave='${waveId}',phase='claim',entries={},arena=held}
b.fs_worker_hold=hold
local deadline=love.timer.getTime()+2
local function join(entry)
  if not entry.started or entry.joined then return true end
  local index=ffi.new('uint32_t[1]')
  local h=ffi.new('uint32_t[1]',entry.handle)
  for i=1,200 do
    if love.timer.getTime()>=deadline then return false end
    local rc=tonumber(wait(index,h,1,0))
    if rc==0 then
      if tonumber(index[0])~=0 then error('wait-index') end
      entry.joined=true;return true
    end
    if rc~=59905 then error('wait-result:'..tostring(rc)) end
    love.timer.sleep(0.01)
  end
  return false
end
local function tickHex(address)
  local ptr=ffi.cast('const uint32_t*',address)
  return string.format('%08x%08x',tonumber(ptr[1]),tonumber(ptr[0]))
end
local ok,why=pcall(function()
  for j=0,${roles.length - 1} do
    hold.phase='create:'..j
    local frame=held.base+j*${FRAME_SPACING}
    local out=ffi.new('uint32_t[1]')
    local rc=tonumber(create(out,base+${FUNCTIONS.longjmp.offset},frame,
      frame+${PACKET_OFFSET},tonumber(priority[0]),0))
    if rc~=0 then error('thread-create:'..tostring(rc)) end
    local entry={handle=tonumber(out[0]),started=false,joined=false}
    hold.entries[#hold.entries+1]=entry
    if not entry.handle or entry.handle==0 or entry.handle>=0xffff8000 then
      error('thread-handle')
    end
    local id=ffi.new('uint64_t[1]')
    hold.phase='identify:'..j
    rc=tonumber(getId(id,entry.handle))
    if rc~=0 then error('thread-id:'..tostring(rc)) end
    local parts=ffi.cast('const uint32_t*',id)
    entry.id=string.format('%08x%08x',tonumber(parts[1]),tonumber(parts[0]))
    if entry.id=='0000000000000000' then error('thread-id-zero') end
  end
  for j,entry in ipairs(hold.entries) do
    hold.phase='start:'..j
    local rc=tonumber(start(entry.handle))
    if rc~=0 then error('thread-start:'..tostring(rc)) end
    entry.started=true
  end
  for j,entry in ipairs(hold.entries) do
    hold.phase='join:'..j
    if not join(entry) then error('worker-timeout:'..j) end
  end
end)
local rows={}
if ok then
  hold.phase='verify-results'
  for j,entry in ipairs(hold.entries) do
    local frame=held.base+(j-1)*${FRAME_SPACING}
    local first=tickHex(frame+${RESULT_OFFSET})
    local last=tickHex(frame+${RESULT_OFFSET + 16})
    local result=tonumber(ffi.cast('const uint64_t*',frame+${RESULT_OFFSET + 8})[0])
    if first=='fedcba9876543210' or last=='fedcba9876543210' or
       first=='0000000000000000' or last=='0000000000000000' or
       result~=0 then
      ok=false;why='transport-result:'..j;break
    end
    rows[#rows+1]=entry.id..','..first..','..last..','..tostring(result)
  end
end
local retained=false
local failedPhase=hold.phase
for j,entry in ipairs(hold.entries) do
  if entry.handle and entry.handle~=0 then
    if entry.started and not entry.joined then
      hold.phase='cleanup-join:'..j
      local joined,done=pcall(join,entry)
      if not joined or not done then
        ok=false;why=tostring(why or 'worker-timeout')
      end
    end
    if not entry.started or entry.joined then
      hold.phase='cleanup-close:'..j
      local closed,rc=pcall(close,entry.handle)
      if closed and tonumber(rc)==0 then entry.handle=0
      else ok=false;why=tostring(why or 'thread-close') end
    end
  end
  if entry.handle and entry.handle~=0 then retained=true end
end
if not retained then b.fs_worker_hold=nil else held.stage='quarantined' end
if not guard() then held.stage='quarantined';return fail('arena-guard-after-worker') end
if b.fs_bridge~=held or b.fs_transport~=transport or
   (held.stage~='ready' and not retained) then
  held.stage='quarantined';return fail('owner-changed-after-worker')
end
if not ok then return fail(failedPhase..':'..tostring(why)..
  (retained and ':retained' or ':released')) end
if retained or #rows~=${roles.length} then return fail('worker-cleanup') end
return table.concat({'${MARKER}',phase,'ok',nonce,'${waveId}',
  string.format('0x%x',held.base),string.format('0x%x',base),
  'joined-closed',${roles.map((_, i) => `rows[${i + 1}]`).join(',')},'arena-retained'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro abort worker source exceeds the REPL limit');
  }
  return source;
}

function parseAbortWorkerReply(reply, options) {
  const {nonce, arenaBase, sdkBase, waveId, staged, roles} = exactOptions(options);
  if (typeof reply !== 'string') throw new TypeError('Balatro abort reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const lines = reply.trimEnd().split('\n').filter(line =>
    line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw new Error('Balatro abort reply missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== PHASE || fields[3] !== nonce) {
    throw new Error('Balatro abort reply has a stale owner');
  }
  if (fields[2] === 'fail' && fields.length === 5) {
    throw new Error(`Balatro abort worker failed: ${fields[4]}`);
  }
  if (fields.length !== 9 + roles.length || fields[2] !== 'ok' || fields[4] !== waveId ||
      fields[5] !== arenaBase || fields[6] !== sdkBase ||
      fields[7] !== 'joined-closed' || fields[8 + roles.length] !== 'arena-retained') {
    throw new Error('Balatro abort reply is incomplete or cleanup uncertain');
  }
  const ids = new Set();
  const rows = fields.slice(8, 8 + roles.length).map((value, index) => {
    const parts = value.split(',');
    if (parts.length !== 4 || !/^[0-9a-f]{16}$/.test(parts[0] || '') ||
        parts[0] === '0000000000000000' || ids.has(parts[0]) ||
        parts[3] !== '0') {
      throw new Error('Balatro abort worker identity or transport result changed');
    }
    ids.add(parts[0]);
    if (![parts[1], parts[2]].every(item => /^[0-9a-f]{16}$/.test(item || ''))) {
      throw new Error('Balatro abort worker counter is not exact');
    }
    const begin = BigInt(`0x${parts[1]}`);
    const end = BigInt(`0x${parts[2]}`);
    if (begin === 0n || end <= begin || end - begin > MAX_TICKS ||
        end > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Balatro abort worker exceeded bounded native time');
    }
    return {role: roles[index], requestKind: REQUEST_KINDS[roles[index]],
    handle: staged.frames[index].handle, threadId: parts[0],
    requestId: requestId(waveId, roles[index]),
    startTick: Number(begin), endTick: Number(end),
    rawStartTick: parts[1], rawEndTick: parts[2], transportResult: 0};
  });
  return {waveId, arenaNonce: nonce, sdkBase, rows,
    workerState: 'joined-closed', serviceHandles: 'closed',
    workerOwnedServiceHandles: 0, parentOwnedServiceHandles: 'preserved',
    clock: 'native-counter', nativeCounterFrequencyVerified: true,
    explicitSaveWrites: 0, arena: 'retained',
    fsSideMarkerReadbackVerified: false, fsStageVerified: false};
}

module.exports = {MARKER, GUARD_MARKER, PHASE, TICK_HZ, MAX_TICKS,
  makeAbortGuardSource, parseAbortGuardReply,
  makeAbortWorkerSource, parseAbortWorkerReply};
