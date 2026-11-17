'use strict';

const {createHash} = require('node:crypto');
const net = require('node:net');
const {packet} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {FUNCTIONS} = require('./worker-frame.cjs');
const {RESULT_OFFSET, TABLE_OFFSET, STACK_OFFSET, CALL_STRIDE} =
  require('./worker-chain.cjs');
const {PACKET_OFFSET, PACKET_BYTES} = require('./fs-counter-overlap.cjs');
const {FRAME_SPACING} = require('./fs-counter-overlap.cjs');
const {ROLES, OWNER_BYTES, FRAME_BYTES, FRAME_BASE_OFFSET,
  SCRATCH_BYTES} =
  require('./fs-gap-port-layout.cjs');
const {WORKER_KIND: PROTECTED_LAYOUT_KIND,
  ROLES: PROTECTED_ROLES} = require('./fs-protected-event-layout.cjs');
const {CALLS, EVENT_OFFSET, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {makePreamble} = require('./qualify-owned.cjs');

const MARKER = 'BAL_GAP_EVENT_WORKER_V1';
const PHASE = 'fs-gap-event-worker';
const SOURCE_LIMIT = 32768;
const MAX_TICKS = 19200000n * 2n;
const COUNTER_PACKET = packet(1009);

function check(value, reason) {
  if (!value) throw Error(`Balatro gap event worker: ${reason}`);
}

function exactStaged({nonce, arenaBase, sdkBase, waveId, staged}) {
  check(/^[0-9a-f]{16}$/.test(nonce || '') &&
    /^[0-9a-f]{16}$/.test(waveId || '') && waveId !== nonce &&
    /^0x[0-9a-f]+$/.test(arenaBase || '') &&
    /^0x[0-9a-f]+$/.test(sdkBase || ''),
  'fresh owner and pinned image are required');
  const arena = Number(BigInt(arenaBase));
  const sdk = Number(BigInt(sdkBase));
  check(Number.isSafeInteger(arena) && arena >= 0x1000 &&
    arena % 0x1000 === 0 && arena + OWNER_BYTES < 2 ** 39 &&
    Number.isSafeInteger(sdk) && sdk >= 0x1000 &&
    sdk % 0x1000 === 0 && sdk + profile.sdkCode.size < 2 ** 39,
  'arena or SDK is outside the pinned user range');
  const layout = staged?.layout;
  const frames = staged?.frames;
  const mode = staged?.mode;
  const protectedMode = mode === 'protected-event-control' ||
    mode === 'protected-storage-event-control';
  const roles = protectedMode ? PROTECTED_ROLES : ROLES;
  check(staged?.workerKind === 'balatro-gap-event-frames' &&
    staged.arenaNonce === nonce && staged.waveId === waveId &&
    staged.arenaBase === arena && staged.sdkBase === sdk &&
    layout?.workerKind === (protectedMode ? PROTECTED_LAYOUT_KIND :
      'balatro-gap-13-layout-only') &&
    layout.owner?.arenaBase === arena && layout.owner.sdkBase === sdk &&
    layout.owner.arenaNonce === nonce &&
    layout.owner.arenaBytes === OWNER_BYTES &&
    layout.owner.sdkCodeSha256 === profile.sdkCode.sha256 &&
    layout.frameLayoutNonoverlapVerified === true &&
    layout.nativeFrameHandlesVerified === false &&
    layout.positiveAttemptAllowed === false &&
    layout.scratch?.address === arena + 0x10000 &&
    layout.scratch.bytes === SCRATCH_BYTES &&
    layout.scratch.end === arena + 0x90000 &&
    layout.frameBase === arena + FRAME_BASE_OFFSET &&
    layout.frameSpacing === FRAME_SPACING &&
    layout.frameBytes === FRAME_BYTES &&
    Array.isArray(layout.frames) && layout.frames.length === roles.length &&
    Array.isArray(frames) &&
    (mode === 'event-smoke' && frames.length === 1 &&
      frames[0].role === 'trigger' ||
      protectedMode && frames.length === PROTECTED_ROLES.length &&
        Array.isArray(layout.protectedRoles) &&
        layout.protectedRoles.every((role, index) =>
          role === PROTECTED_ROLES[index]) ||
      ['gap-candidate', 'gap-counter-control'].includes(mode) &&
        frames.length === ROLES.length),
  'event layout or role count changed');
  const protectedPlan = staged.protectedPlan;
  if (protectedMode) check(protectedPlan?.workerKind ===
    (mode === 'protected-event-control' ?
      'protected-canary-window' : 'protected-storage-window') &&
    protectedPlan.arenaNonce === nonce &&
    protectedPlan.waveId === waveId &&
    protectedPlan.arenaBase === arena &&
    protectedPlan.sdkBase === sdk &&
    protectedPlan.fsSideMarkerReadbackVerified === false &&
    protectedPlan.markerHitVerified === false &&
    protectedPlan.fsStageVerified === false &&
    Array.isArray(protectedPlan.frames) &&
    protectedPlan.frames.length === PROTECTED_ROLES.length,
  'protected negative request plan changed');
  const sendArgs = STACK_OFFSET + 0x30 + 2 * CALL_STRIDE;
  const handles = new Set();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const roleIndex = roles.indexOf(frame?.role);
    const layoutFrame = layout.frames[roleIndex];
    const protectedFrame = protectedMode ? protectedPlan.frames[i] : null;
    const hash = createHash('sha256').update(frame?.bytes || Buffer.alloc(0))
      .digest('hex');
    check(roleIndex >= 0 && layoutFrame &&
      layoutFrame.role === frame.role &&
      layoutFrame.index === roleIndex &&
      layoutFrame.address === arena + FRAME_BASE_OFFSET +
        roleIndex * FRAME_SPACING &&
      layoutFrame.end === layoutFrame.address + FRAME_BYTES &&
      layoutFrame.packetAddress === layoutFrame.address + PACKET_OFFSET &&
      frame.address === layoutFrame.address &&
      frame.index === layoutFrame.index &&
      frame.packetAddress === layoutFrame.packetAddress &&
      frame.gateAddress === arena + EVENT_OFFSET &&
      Number.isInteger(frame.handle) && frame.handle > 0 &&
      frame.handle < 0xffff8000 &&
      Buffer.isBuffer(frame.bytes) && frame.bytes.length === FRAME_BYTES &&
      frame.bytes.readBigUInt64LE(0x30) === BigInt(frame.gateAddress) &&
      frame.bytes.readBigUInt64LE(sendArgs + 0xf0) === BigInt(frame.handle) &&
      frame.sha256 === hash && frame.resultOffsets === RESULT_OFFSETS &&
      (mode === 'event-smoke' || frame.role === roles[i]) &&
      (!protectedMode || protectedFrame?.role === frame.role &&
        protectedFrame.handle === frame.handle &&
        frame.requestSha256 === protectedFrame.requestSha256 &&
        frame.bytes.subarray(PACKET_OFFSET, PACKET_OFFSET + PACKET_BYTES)
          .equals(protectedFrame.bytes.subarray(PACKET_OFFSET,
            PACKET_OFFSET + PACKET_BYTES))) &&
      (mode !== 'gap-counter-control' ||
        frame.bytes.subarray(PACKET_OFFSET,
          PACKET_OFFSET + 256).equals(COUNTER_PACKET)),
    `${frame?.role || i} event frame ownership changed`);
    check(!handles.has(frame.handle),
      `${frame.role} reuses a concurrent service handle`);
    handles.add(frame.handle);
  }
  return {nonce, arenaBase, sdkBase, waveId,
    staged, frames, mode, arena, sdk};
}

function exactOptions(options) {
  const {mainBase, hostIp, port, stageReceipt} = options || {};
  check(/^0x[0-9a-f]+$/.test(mainBase || '') &&
    net.isIP(hostIp) === 4 && Number.isInteger(port) &&
    port >= 1024 && port <= 65535 && port !== 39380,
  'fresh owner, pinned image, and exact transport are required');
  const exact = exactStaged(options);
  const {nonce, waveId, frames} = exact;
  check(
    stageReceipt?.arenaNonce === nonce &&
    stageReceipt.waveId === waveId &&
    stageReceipt.exactReadbackVerified === true &&
    stageReceipt.workerStarted === false &&
    stageReceipt.saveWrites === 0 &&
    Array.isArray(stageReceipt.frameSha256) &&
    stageReceipt.frameSha256.length === frames.length,
  'freshly staged event frames changed');
  check(frames.every((frame, index) =>
    stageReceipt.frameSha256[index] === frame.sha256),
  'event frame native readback receipt changed');
  return {...exact, mainBase, hostIp, port};
}

async function stageGapEventFrames(native, staged) {
  exactStaged({nonce: staged?.arenaNonce,
    arenaBase: `0x${staged?.arenaBase?.toString(16)}`,
    sdkBase: `0x${staged?.sdkBase?.toString(16)}`,
    waveId: staged?.waveId, staged});
  check(native && typeof native.write === 'function' &&
    typeof native.read === 'function' &&
    native.addresses?.scratch === staged.arenaBase + 0x10000 &&
    native.addresses?.sdk === staged.sdkBase,
  'owned native transport differs from the 13-role layout');
  for (const frame of staged.frames) {
    await native.write(frame.address, frame.bytes);
    const observed = await native.read(frame.address, frame.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(frame.bytes),
      `${frame.role} immediate native readback changed`);
  }
  for (const frame of staged.frames) {
    const observed = await native.read(frame.address, frame.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(frame.bytes),
      `${frame.role} final native readback changed`);
  }
  return {arenaNonce: staged.arenaNonce, waveId: staged.waveId,
    frameSha256: staged.frames.map(frame => frame.sha256),
    exactReadbackVerified: true, workerStarted: false, saveWrites: 0};
}

function makeGapEventWorkerSource(options) {
  const {nonce, arenaBase, sdkBase, mainBase, waveId,
    hostIp, port, frames, mode, arena, sdk} = exactOptions(options);
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  check(inherited.includes('local phase="allocator-map"') &&
    inherited.includes("'BAL_OWNED_V1'"),
  'pinned native preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    `local phase="${PHASE}"`).replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const symbols = profile.symbols;
  const functionAddresses = CALLS.map(name => sdk + symbols[name].offset);
  const packets = frames.map(frame =>
    frame.bytes.subarray(PACKET_OFFSET, PACKET_OFFSET + 256).toString('hex'));
  const handles = frames.map(frame => frame.handle);
  const addresses = frames.map(frame => frame.address);
  const delays = frames.map(frame => frame.delayNs);
  const event = arena + EVENT_OFFSET;
  const sendArgs = STACK_OFFSET + 0x30 + 2 * CALL_STRIDE;
  const source = `${preamble}
if string.format('0x%x',base)~='${sdkBase}' or
   string.format('0x%x',info.main_base or 0)~='${mainBase}' then
  return fail('image-base-changed')
end
local held=b.fs_bridge
local transport=b.fs_transport
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${arena} or held.bytes~=${OWNER_BYTES} or not held.buf or
   b.fs_worker_hold or not transport or transport.owner~=nonce or
   transport.hostIp~='${hostIp}' or transport.port~=${port} or
   transport.arena~=held or transport.info~=info or
   transport.stage~='read-request' or not transport.client then
  return fail('owner-or-transport-changed')
end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.before~=held.base-raw-64 or
   held.after~=held.base-raw+held.bytes or
   held.base+held.bytes+64>raw+ffi.sizeof(held.buf) then
  return fail('arena-bounds')
end
local function arenaGuard()
  for i=0,63 do
    if tonumber(held.buf[held.before+i])~=165 or
       tonumber(held.buf[held.after+i])~=165 then return false end
  end
  return true
end
if not arenaGuard() then return fail('arena-guard') end
local first,why=mapping(held.base)
local last,lastWhy=mapping(held.base+held.bytes-1)
if not first or not last or first.base~=last.base or first.size~=last.size or
   first.type~=5 or first.perm~=3 or first.base>held.base or
   held.base+held.bytes>first.base+first.size then
  return fail(why or lastWhy or 'arena-map')
end
local addresses={${addresses.join(',')}}
local handles={${handles.join(',')}}
local delays={${delays.join(',')}}
local packets={${packets.map(value => `'${value}'`).join(',')}}
local functions={${functionAddresses.join(',')}}
local function word(address)
  local p=ffi.cast('const uint32_t*',address)
  return tonumber(p[0])+tonumber(p[1])*4294967296
end
local function sentinel(address)
  local p=ffi.cast('const uint32_t*',address)
  return tonumber(p[0])==0x76543210 and tonumber(p[1])==0xfedcba98
end
for j=1,#addresses do
  local frame=addresses[j]
  if frame%4096~=0 or frame<held.base+0x100000 or
     frame+${FRAME_BYTES}>held.base+held.bytes or
     word(frame+0x30)~=${event} or
     word(frame+${STACK_OFFSET + 0x30 + 0x78})~=delays[j] or
     word(frame+${sendArgs + 0x78})~=frame+${PACKET_OFFSET} or
     word(frame+${sendArgs + 0x80})~=${PACKET_BYTES} or
     word(frame+${sendArgs + 0xf0})~=handles[j] then
    return fail('frame-arguments:'..j)
  end
  for k=0,${CALLS.length - 1} do
    if word(frame+${TABLE_OFFSET}+k*8)~=functions[k+1] or
       not sentinel(frame+${RESULT_OFFSET}+k*8) then
      return fail('frame-call:'..j..':'..k)
    end
  end
  local ptr=ffi.cast('const uint8_t*',frame+${PACKET_OFFSET})
  local hex=packets[j]
  for k=0,255 do
    if tonumber(ptr[k])~=tonumber(hex:sub(k*2+1,k*2+2),16) then
      return fail('frame-packet:'..j..':'..k)
    end
  end
end
local event=${event}
local eventMap,eventWhy=mapping(event)
if not eventMap or eventMap.type~=5 or eventMap.perm~=3 or
   eventMap.base>event-16 or event+24>eventMap.base+eventMap.size then
  return fail(eventWhy or 'event-map')
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
  base+${symbols['nn::os::InitializeLightEvent'].offset})
local signal=love.ffi.declare('void',{'void *'},
  base+${symbols['nn::os::SignalLightEvent'].offset})
local tryWait=love.ffi.declare('uint32_t',{'void *'},
  base+${symbols['nn::os::TryWaitLightEvent'].offset})
local finalize=love.ffi.declare('void',{'void *'},
  base+${symbols['nn::os::FinalizeLightEvent'].offset})
local eventPtr=ffi.cast('void*',event)
local current=love.ffi.declare('uint64_t',{},base+${symbols['nn::os::GetCurrentThread'].offset})
local thread=tonumber(current())
if not thread or thread<4096 or thread%8~=0 or
   thread+${profile.threadManager.nodeHandleOffset + 4}>=2^39 then
  return fail('borrowed-thread-pointer')
end
local threadMap,threadWhy=mapping(thread)
if not threadMap or threadMap.type~=4 or threadMap.perm~=3 or
   thread+${profile.threadManager.nodeHandleOffset + 4}>threadMap.base+threadMap.size then
  return fail(threadWhy or 'borrowed-thread-map')
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
local initialized,initWhy=pcall(initialize,eventPtr,0,0)
if not initialized then held.stage='quarantined';return fail('event-init-unknown:'..tostring(initWhy)) end
if tonumber(p[0])~=0 or tonumber(p[1])~=1 or
   tonumber(ffi.cast('const uint32_t*',event+4)[0])~=0 then
  local cleaned=pcall(finalize,eventPtr)
  if not cleaned then held.stage='quarantined' end
  return fail('event-init-state:'..(cleaned and 'finalized' or 'retained'))
end
local hold={owner=nonce,wave='${waveId}',mode='${mode}',entries={},event=event,
  arena=held,transport=transport,
  initialized=true,signalAttempted=false,signaled=false,finalized=false}
b.fs_worker_hold=hold
local deadline=love.timer.getTime()+4
local function join(entry)
  if not entry.started or entry.joined then return true end
  local index=ffi.new('uint32_t[1]')
  local h=ffi.new('uint32_t[1]',entry.handle)
  for i=1,400 do
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
local function releaseEvent()
  hold.signalAttempted=true
  local ok,reason=pcall(signal,eventPtr)
  if not ok then return false,tostring(reason) end
  local checked,value=pcall(tryWait,eventPtr)
  if not checked or tonumber(value)~=1 then
    return false,'event-not-signaled'
  end
  hold.signaled=true
  return true,nil
end
local function tickHex(address)
  local ptr=ffi.cast('const uint32_t*',address)
  return string.format('%08x%08x',tonumber(ptr[1]),tonumber(ptr[0]))
end
local ok,why=pcall(function()
  for j,frame in ipairs(addresses) do
    hold.phase='create:'..j
    local out=ffi.new('uint32_t[1]')
    local rc=tonumber(create(out,base+${FUNCTIONS.longjmp.offset},frame,
      frame+${PACKET_OFFSET},tonumber(priority[0]),0))
    if rc~=0 then error('thread-create:'..tostring(rc)) end
    local entry={handle=tonumber(out[0]),started=false,joined=false}
    hold.entries[#hold.entries+1]=entry
    if not entry.handle or entry.handle==0 or entry.handle>=0xffff8000 then
      error('thread-handle') end
    local id=ffi.new('uint64_t[1]')
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
  hold.phase='signal-master'
  local released,reason=releaseEvent()
  if not released then error('event-release:'..tostring(reason)) end
  for j,entry in ipairs(hold.entries) do
    hold.phase='join:'..j
    if not join(entry) then error('worker-timeout:'..j) end
  end
end)
local failedPhase=hold.phase
-- Manual reset makes a second signal safe. A partial start must be released
-- before any join or handle close, even after an earlier signal error.
if not hold.signaled and #hold.entries>0 then
  hold.phase='cleanup-signal'
  local released,reason=releaseEvent()
  if not released then ok=false;why=tostring(why or reason) end
end
local rows={}
if ok then
  hold.phase='verify-results'
  for j,entry in ipairs(hold.entries) do
    local frame=addresses[j]
    local first=tickHex(frame+${RESULT_OFFSETS.startTick})
    local last=tickHex(frame+${RESULT_OFFSETS.endTick})
    local result=word(frame+${RESULT_OFFSETS.transportResult})
    if first=='fedcba9876543210' or last=='fedcba9876543210' or
       first=='0000000000000000' or last=='0000000000000000' or
       result~=0 then ok=false;why='transport-result:'..j;break end
    rows[#rows+1]=entry.id..','..first..','..last..','..tostring(result)
  end
end
local retained=false
for j,entry in ipairs(hold.entries) do
  if entry.handle and entry.handle~=0 then
    if entry.started and not entry.joined then
      hold.phase='cleanup-join:'..j
      local joined,done=pcall(join,entry)
      if not joined or not done then ok=false;why=tostring(why or 'worker-timeout') end
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
if not retained then
  hold.phase='event-finalize'
  local finalized,reason=pcall(finalize,eventPtr)
  if finalized then hold.finalized=true
  else ok=false;why=tostring(why or reason) end
end
if retained or not hold.finalized or not eventGuard() or not arenaGuard() or
   b.fs_bridge~=held or b.fs_transport~=transport then
  held.stage='quarantined'
  return fail(failedPhase..':'..tostring(why or 'worker-or-event-retained')..':retained')
end
b.fs_worker_hold=nil
if not ok or #rows~=#addresses then
  return fail(failedPhase..':'..tostring(why or 'worker-results')..':released')
end
return table.concat({'${MARKER}',phase,'ok',nonce,'${waveId}',
  string.format('0x%x',held.base),string.format('0x%x',base),
  '${mode}','joined-closed',tostring(#addresses),table.concat(rows,';'),
  'event-finalized','arena-retained'},'\\t')`;
  check(Buffer.byteLength(source, 'utf8') <= SOURCE_LIMIT,
    'generated source exceeds REPL limit');
  return source;
}

function parseGapEventWorkerReply(reply, options) {
  const {nonce, arenaBase, sdkBase, waveId, frames, mode} = exactOptions(options);
  check(typeof reply === 'string', 'worker reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw Error(reply.trim());
  }
  const lines = reply.trimEnd().split('\n').filter(line =>
    line.startsWith(`-> ${MARKER}\t`));
  check(lines.length === 1, 'worker reply is missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  check(fields[0] === MARKER && fields[1] === PHASE &&
    fields[3] === nonce, 'worker reply owner changed');
  if (fields[2] === 'fail' && fields.length === 5) {
    throw Error(`Balatro gap event worker failed: ${fields[4]}`);
  }
  check(fields.length === 13 && fields[2] === 'ok' &&
    fields[4] === waveId && fields[5] === arenaBase &&
    fields[6] === sdkBase && fields[7] === mode &&
    fields[8] === 'joined-closed' &&
    Number(fields[9]) === frames.length &&
    fields[11] === 'event-finalized' &&
    fields[12] === 'arena-retained',
  'worker result, event finalization, or cleanup is incomplete');
  const values = fields[10].split(';');
  check(values.length === frames.length,
    'worker did not return one row per event-gated frame');
  const ids = new Set();
  const rows = values.map((value, index) => {
    const parts = value.split(',');
    check(parts.length === 4 &&
      /^[0-9a-f]{16}$/.test(parts[0] || '') &&
      parts[0] !== '0000000000000000' && !ids.has(parts[0]) &&
      /^[0-9a-f]{16}$/.test(parts[1] || '') &&
      /^[0-9a-f]{16}$/.test(parts[2] || '') &&
      parts[3] === '0',
    'worker identity, tick, or transport result changed');
    ids.add(parts[0]);
    const start = BigInt(`0x${parts[1]}`);
    const end = BigInt(`0x${parts[2]}`);
    check(start > 0n && end > start && end - start <= MAX_TICKS &&
      end <= BigInt(Number.MAX_SAFE_INTEGER),
    'worker exceeded native time envelope');
    return {role: frames[index].role, handle: frames[index].handle,
      threadId: parts[0], startTick: Number(start),
      endTick: Number(end), rawStartTick: parts[1],
      rawEndTick: parts[2], transportResult: 0};
  });
  return {waveId, arenaNonce: nonce, sdkBase, mode,
    rows, eventGate: 'initialized-signaled-finalized',
    workerState: 'joined-closed', threadHandles: 'closed',
    parentOwnedServiceHandles: 'preserved',
    nativeCounterFrequencyVerified: true,
    markerHitVerified: false, fsStageVerified: false};
}

module.exports = {MARKER, PHASE, SOURCE_LIMIT, MAX_TICKS,
  stageGapEventFrames, makeGapEventWorkerSource,
  parseGapEventWorkerReply};
