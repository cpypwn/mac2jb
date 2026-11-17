const crypto = require('node:crypto');
const net = require('node:net');
const {packet: cmifPacket, response: cmifResponse} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {qualifyNativeCrc, SDK_CRC32} = require('./qualify-native-crc.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const {FUNCTIONS, RESULT_SENTINEL} = require('./worker-frame.cjs');
const {RESULT_OFFSET, TABLE_OFFSET, STACK_OFFSET, CALL_STRIDE, buildChainLayout} =
  require('./worker-chain.cjs');
const {makeIdleSource, parseIdleReply, makeReleaseSource, parseReleaseReply} =
  require('./native-counter-overlap.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_FS_COUNTER_OVERLAP_V1';
const WORKERS = 3;
const ARENA_BYTES = 0x200000;
const FRAME_SPACING = 0x4000;
const PACKET_OFFSET = 0x2000;
const PACKET_BYTES = 0x1000;
const SERVICE_HANDLE_OFFSET = STACK_OFFSET + 0x30 + CALL_STRIDE - 0x10;
const TICK_HZ = 19200000n;
const MAX_TICKS = TICK_HZ * 2n;
const MIN_CLIENT_OVERLAP_TICKS = TICK_HZ / 1000n;
const REFERENCE_BASE = 0x100000000;
const REFERENCE_SDK = 0x200000000;
const SOURCE_LIMIT = 32768;
const INIT = cmifPacket(1, Buffer.alloc(8), {pid: true});
const COUNTERS = cmifPacket(1009);

function requestPrefix(packet) {
  const last = packet.findLastIndex(byte => byte !== 0);
  if (last < 0 || packet.subarray(last + 1).some(byte => byte !== 0) ||
      last >= 64) throw Error('Balatro FS request prefix changed');
  return packet.subarray(0, last + 1).toString('hex');
}

function buildFrame({base, sdk, handle = 0}) {
  if (!Number.isInteger(handle) || handle < 0 || handle >= 0xffff8000) {
    throw new RangeError('Balatro FS worker handle is out of range');
  }
  const {frame: chain} = buildChainLayout({base, sdk,
    calls: ['systemTick', 'systemTick', 'systemTick']});
  if (chain.length !== PACKET_OFFSET) throw Error('Balatro worker stack layout changed');
  const frame = Buffer.alloc(PACKET_OFFSET + PACKET_BYTES);
  chain.copy(frame);
  frame.writeBigUInt64LE(BigInt(sdk + profile.symbols.svcSend.offset), TABLE_OFFSET + 8);
  const first = STACK_OFFSET + 0x30;
  frame.writeBigUInt64LE(BigInt(base + PACKET_OFFSET), first + 0x78);
  frame.writeBigUInt64LE(BigInt(PACKET_BYTES), first + 0x80);
  frame.writeBigUInt64LE(BigInt(handle), SERVICE_HANDLE_OFFSET);
  COUNTERS.copy(frame, PACKET_OFFSET);
  return frame;
}

function frameWords() {
  const frame = buildFrame({base: REFERENCE_BASE, sdk: REFERENCE_SDK});
  const words = [];
  for (let offset = 0; offset < PACKET_OFFSET; offset += 8) {
    const value = frame.readBigUInt64LE(offset);
    if (value === 0n) continue;
    if (value === RESULT_SENTINEL) words.push([offset, 3, 0]);
    else if (value === BigInt(PACKET_BYTES)) words.push([offset, 4, PACKET_BYTES]);
    else if (value >= BigInt(REFERENCE_BASE) &&
             value < BigInt(REFERENCE_BASE + frame.length)) {
      words.push([offset, 1, Number(value - BigInt(REFERENCE_BASE))]);
    } else if (value >= BigInt(REFERENCE_SDK) &&
               value < BigInt(REFERENCE_SDK + profile.sdkCode.size)) {
      words.push([offset, 2, Number(value - BigInt(REFERENCE_SDK))]);
    } else throw Error(`unrelocatable Balatro FS worker word at 0x${offset.toString(16)}`);
  }
  return words;
}

function tick(value) {
  if (!/^[0-9a-f]{16}$/.test(value || '')) throw Error('Balatro FS tick is not exact');
  return BigInt(`0x${value}`);
}

function assessRows(rows) {
  if (!Array.isArray(rows) || rows.length !== WORKERS) {
    throw Error('Balatro FS overlap needs three independent workers');
  }
  const ids = new Set();
  const intervals = rows.map(row => {
    if (!/^[0-9a-f]{16}$/.test(row?.threadId || '') ||
        row.threadId === '0000000000000000' || ids.has(row.threadId) ||
        row.nativeResult !== 0) throw Error('Balatro FS worker identity or result is invalid');
    ids.add(row.threadId);
    const start = tick(row.enteredTick);
    const end = tick(row.completedTick);
    if (start === 0n || end <= start || end - start > MAX_TICKS) {
      throw Error('Balatro FS request lifetime exceeds the bounded envelope');
    }
    return {start, end};
  });
  const latestEntry = intervals.reduce((a, row) => row.start > a ? row.start : a, 0n);
  const earliestExit = intervals.reduce((a, row) => row.end < a ? row.end : a,
    intervals[0].end);
  const overlapTicks = latestEntry < earliestExit ? earliestExit - latestEntry : 0n;
  return {nativeCounterHz: Number(TICK_HZ),
    clientIpcWindowOverlapMeasured: overlapTicks >= MIN_CLIENT_OVERLAP_TICKS,
    clientOverlapThresholdTicks: String(MIN_CLIENT_OVERLAP_TICKS),
    commonOverlapTicks: String(overlapTicks),
    markerAttempted: false, markerHitVerified: false, fsStageVerified: false};
}

function makeSource({nonce, arenaBase, sdkBase, mainBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      ![arenaBase, sdkBase, mainBase].every(value => /^0x[0-9a-f]+$/.test(value || ''))) {
    throw new TypeError('Balatro FS overlap needs a fresh owner and exact image addresses');
  }
  const arena = Number(BigInt(arenaBase));
  const sdk = Number(BigInt(sdkBase));
  if (![arena, sdk].every(value => Number.isSafeInteger(value) && value >= 4096 &&
      value % 4096 === 0 && value < 2 ** 39) ||
      arena + ARENA_BYTES >= 2 ** 39 || sdk + profile.sdkCode.size >= 2 ** 39) {
    throw new RangeError('Balatro FS overlap addresses are outside the pinned user range');
  }
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw Error('Balatro pinned preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="fs-counter-overlap"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const words = frameWords().map(row => `{${row.join(',')}}`).join(',');
  const symbols = profile.symbols;
  const source = `${preamble}
if string.format('0x%x',base)~='${sdkBase}' or
   string.format('0x%x',info.main_base or 0)~='${mainBase}' then
  return fail('image-base-changed')
end
local held=b.fs_bridge
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${arena} or held.bytes~=${ARENA_BYTES} or not held.buf or
   b.fs_worker_hold or b.fs_transport then return fail('fresh-arena-or-idle-state') end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.before~=held.base-raw-64 or
   held.after~=held.base-raw+held.bytes or
   held.base+held.bytes+64>raw+ffi.sizeof(held.buf) then return fail('arena-bounds') end
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
local current=love.ffi.declare('uint64_t',{},base+${symbols['nn::os::GetCurrentThread'].offset})
local thread=tonumber(current())
if not thread or thread<4096 or thread%8~=0 or
   thread+${profile.threadManager.nodeHandleOffset + 4}>=2^39 then return fail('current-thread') end
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
local getService=love.ffi.declare('uint32_t',{'uint32_t *','const char *','uint64_t'},
  base+${symbols['nn::sm::GetServiceHandle'].offset})
local send=love.ffi.declare('uint32_t',{'void *','uint64_t','uint32_t','uint32_t'},
  base+${symbols.svcSend.offset})
local create=love.ffi.declare('uint32_t',{'uint32_t *','uint64_t','uint64_t',
  'uint64_t','int32_t','int32_t'},base+${symbols.svcCreateThread.offset})
local start=love.ffi.declare('uint32_t',{'uint32_t'},base+${symbols.svcStartThread.offset})
local getId=love.ffi.declare('uint32_t',{'uint64_t *','uint32_t'},
  base+${symbols.svcGetThreadId.offset})
local wait=love.ffi.declare('uint32_t',{'uint32_t *','uint32_t *','int32_t','int64_t'},
  base+${symbols.svcWaitSynchronization.offset})
local close=love.ffi.declare('uint32_t',{'uint32_t'},base+${symbols.svcCloseHandle.offset})
local initPrefix='${requestPrefix(INIT)}'
local counterPrefix='${requestPrefix(COUNTERS)}'
local function putPrefix(address,hex)
  local ptr=ffi.cast('uint8_t*',address)
  for i=0,#hex/2-1 do ptr[i]=tonumber(hex:sub(i*2+1,i*2+2),16) end
end
local function validReply(ptr,minimum)
  local w=ffi.cast('const uint32_t*',ptr)
  local header=tonumber(w[1])
  return tonumber(w[0])==0 and header%1024>=minimum and
    header<0x80000000 and tonumber(w[4])==0x4f434653 and
    tonumber(w[6])==0
end
local words={${words}}
local hold={arena=held,entries={},services={}}
b.fs_worker_hold=hold
local function join(entry)
  if not entry.started or entry.joined then return true end
  local index=ffi.new('uint32_t[1]')
  local handles=ffi.new('uint32_t[1]',entry.handle)
  for i=1,200 do
    local rc=tonumber(wait(index,handles,1,0))
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
local ok,errorText=pcall(function()
  local name=ffi.new('char[8]','fsp-srv')
  for j=0,${WORKERS - 1} do
    local frameBase=held.base+j*${FRAME_SPACING}
    local packet=frameBase+${PACKET_OFFSET}
    if frameBase%4096~=0 or packet%4096~=0 then error('unaligned-fs-packet') end
    ffi.fill(ffi.cast('uint8_t*',frameBase),${PACKET_OFFSET + PACKET_BYTES},0)
    for _,word in ipairs(words) do
      local offset,tag,value=word[1],word[2],word[3]
      local p=ffi.cast('uint64_t*',frameBase+offset)
      if tag==1 then p[0]=ffi.cast('uint64_t',frameBase+value)
      elseif tag==2 then p[0]=ffi.cast('uint64_t',base+value)
      elseif tag==3 then p[0]=ffi.cast('uint64_t',0xfedcba9876543210ULL)
      else p[0]=ffi.cast('uint64_t',value) end
    end
    local out=ffi.new('uint32_t[1]')
    local rc=tonumber(getService(out,name,7))
    if rc~=0 then error('service-open:'..tostring(rc)) end
    local service=tonumber(out[0])
    if not service or service==0 or service>=0xffff8000 then
      error('service-handle')
    end
    hold.services[#hold.services+1]={handle=service,worker=j+1}
    putPrefix(packet,initPrefix)
    rc=tonumber(send(ffi.cast('void*',packet),${PACKET_BYTES},service,0))
    if rc~=0 or not validReply(packet,4) then error('service-init:'..tostring(rc)) end
    putPrefix(packet,counterPrefix)
    ffi.cast('uint64_t*',frameBase+${SERVICE_HANDLE_OFFSET})[0]=service
  end
  for j=0,${WORKERS - 1} do
    local frameBase=held.base+j*${FRAME_SPACING}
    local out=ffi.new('uint32_t[1]')
    local rc=tonumber(create(out,base+${FUNCTIONS.longjmp.offset},frameBase,
      frameBase+${PACKET_OFFSET},tonumber(priority[0]),0))
    if rc~=0 then error('thread-create:'..tostring(rc)) end
    local entry={handle=tonumber(out[0]),started=false,joined=false}
    hold.entries[#hold.entries+1]=entry
    if not entry.handle or entry.handle==0 or entry.handle>=0xffff8000 then
      error('thread-handle')
    end
    local id=ffi.new('uint64_t[1]')
    rc=tonumber(getId(id,entry.handle))
    if rc~=0 then error('thread-id:'..tostring(rc)) end
    local parts=ffi.cast('const uint32_t*',id)
    entry.id=string.format('%08x%08x',tonumber(parts[1]),tonumber(parts[0]))
    if entry.id=='0000000000000000' then error('thread-id-zero') end
    rc=tonumber(start(entry.handle))
    if rc~=0 then error('thread-start:'..tostring(rc)) end
    entry.started=true
  end
  for _,entry in ipairs(hold.entries) do
    if not join(entry) then error('worker-timeout') end
  end
end)
local rows={}
if ok then
  for j,entry in ipairs(hold.entries) do
    local frameBase=held.base+(j-1)*${FRAME_SPACING}
    local first=tickHex(frameBase+${RESULT_OFFSET})
    local last=tickHex(frameBase+${RESULT_OFFSET + 16})
    local result=tonumber(ffi.cast('const uint64_t*',frameBase+${RESULT_OFFSET + 8})[0])
    local packet=frameBase+${PACKET_OFFSET}
    if first=='fedcba9876543210' or last=='fedcba9876543210' or
       first=='0000000000000000' or last=='0000000000000000' or
       result~=0 or not validReply(packet,36) then
      ok=false;errorText='counter-reply:'..j;break
    end
    rows[#rows+1]=entry.id..','..first..','..last..','..tostring(result)
  end
end
local retained=false
for _,entry in ipairs(hold.entries) do
  if entry.handle and entry.handle~=0 then
    if entry.started and not entry.joined then
      local joined,done=pcall(join,entry)
      if not joined or not done then
        ok=false;errorText=tostring(errorText or 'worker-timeout')
      end
    end
    if not entry.started or entry.joined then
      local closed,rc=pcall(close,entry.handle)
      if closed and tonumber(rc)==0 then entry.handle=0
      else ok=false;errorText=tostring(errorText or 'thread-close') end
    end
  end
  if entry.handle and entry.handle~=0 then retained=true end
end
for _,service in ipairs(hold.services) do
  local worker=hold.entries[service.worker]
  if not worker or not worker.started or worker.joined then
    local closed,rc=pcall(close,service.handle)
    if closed and tonumber(rc)==0 then service.handle=0
    else ok=false;errorText=tostring(errorText or 'service-close') end
  end
  if service.handle and service.handle~=0 then retained=true end
end
if not retained then b.fs_worker_hold=nil end
if not guard() then held.stage='quarantined';return fail('arena-guard-after-worker') end
if b.fs_bridge~=held or held.stage~='ready' then return fail('arena-changed') end
if not ok then return fail(tostring(errorText)..(retained and ':retained' or ':released')) end
if retained or #rows~=${WORKERS} then return fail('worker-cleanup') end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',held.base),
  string.format('0x%x',base),'thread-and-service-handles-released',
  rows[1],rows[2],rows[3],'arena-retained'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro FS overlap source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce, arenaBase, sdkBase}) {
  if (typeof reply !== 'string') throw new TypeError('Balatro FS reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line =>
    line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('missing or duplicated Balatro FS overlap reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== 'fs-counter-overlap' ||
      fields[3] !== nonce) throw Error('Balatro FS overlap reply has a stale owner');
  if (fields[2] === 'fail' && fields.length === 5) {
    throw Error(`Balatro FS overlap failed: ${fields[4]}`);
  }
  if (fields.length !== 11 || fields[2] !== 'ok' || fields[4] !== arenaBase ||
      fields[5] !== sdkBase || fields[6] !== 'thread-and-service-handles-released' ||
      fields[10] !== 'arena-retained') {
    throw Error('Balatro FS overlap reply is incomplete or cleanup is unverified');
  }
  const rows = fields.slice(7, 10).map(value => {
    const parts = value.split(',');
    if (parts.length !== 4 || parts[3] !== '0') {
      throw Error('Balatro FS request result is incomplete');
    }
    return {threadId: parts[0], enteredTick: parts[1],
      completedTick: parts[2], nativeResult: Number(parts[3])};
  });
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    nonce, arenaBase, sdkBase, rows, ...assessRows(rows),
    workerHandles: 'released', serviceHandles: 'released', arena: 'retained',
    explicitFsWriteRequests: 0, rpcLoggingMayWriteSave: true,
    counterStateClearedByCommand1009: true,
    status: 'FS counter IPC client-window timing only; no FS canary marker or 2/4 verified'};
}

async function runDiagnostic({host, macIp, nonce = crypto.randomBytes(8).toString('hex'),
  execute = executeLua, identifyImage = identify, reserve = checkArena,
  preflight = runPreflight, verifyCrc = qualifyNativeCrc, onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce) ||
      [execute, identifyImage, reserve, preflight, verifyCrc, onPhase]
        .some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro FS overlap needs IPv4 addresses and a fresh owner');
  }
  let arenaState = 'not-reserved';
  const step = async (name, operation) => {
    onPhase(name, {nonce, arenaState});
    try {
      return await operation();
    } catch (error) {
      throw new Error(`${name}: ${error.message}`, {cause: error});
    }
  };
  const before = await step('identify-image-before-reserve',
    () => identifyImage(host, execute));
  if (before.state !== 'serving' || before.metadataVersion !== profile.runtimeVersion ||
      before.codeHeadProfile !== '1.0.1f' ||
      !/^0x[0-9a-f]+$/.test(before.mainBase || '') ||
      !/^0x[0-9a-f]+$/.test(before.sdkBase || '')) {
    throw Error('Balatro is not the pinned 1.0.1f image');
  }
  parseIdleReply(await step('check-no-held-native-state', () => execute({host, port: 9026,
    source: makeIdleSource({nonce, mainBase: before.mainBase,
      sdkBase: before.sdkBase}), timeoutMs: 10000})), nonce);
  arenaState = 'reserve-request-in-flight';
  const arena = await step('reserve-fresh-owned-arena',
    () => reserve({host, phase: 'reserve', nonce, execute}));
  arenaState = 'retained';
  if (arena.nonce !== nonce || arena.phase !== 'reserve' ||
      arena.bytes !== ARENA_BYTES) throw Error('Balatro fresh arena did not verify');
  const context = {nonce, arenaBase: arena.base,
    sdkBase: before.sdkBase, mainBase: before.mainBase};
  let safeToRelease = true;
  let released = false;
  let releaseAttempted = false;
  const releaseArena = async name => {
    releaseAttempted = true;
    arenaState = 'release-request-in-flight';
    const release = await step(name, async () => {
      const reply = await execute({host, port: 9026,
        source: makeReleaseSource(context), timeoutMs: 10000});
      return parseReleaseReply(reply, context);
    });
    released = true;
    arenaState = 'detached';
    return release;
  };
  try {
    const ready = await step('verify-fresh-arena-and-clock',
      () => preflight({host, nonce, execute}));
    if (ready.nonce !== nonce || ready.arenaBase !== arena.base ||
        ready.arenaBytes !== ARENA_BYTES || ready.sdkHz !== Number(TICK_HZ)) {
      throw Error('Balatro fresh arena or native clock changed');
    }
    safeToRelease = false;
    const crc = await step('verify-pinned-sdk-crc',
      () => verifyCrc({host, macIp, nonce, execute, port: 39381}));
    if (crc.nonce !== nonce || crc.port !== 39381 ||
        crc.sdkBase !== before.sdkBase ||
        crc.sdkCrc32 !== `0x${SDK_CRC32.toString(16)}`) {
      throw Error('Balatro complete SDK CRC or base changed');
    }
    safeToRelease = true;
    const afterCrc = await step('verify-arena-after-sdk-crc',
      () => preflight({host, nonce, execute}));
    if (afterCrc.nonce !== nonce || afterCrc.arenaBase !== arena.base ||
        afterCrc.sdkHz !== Number(TICK_HZ)) throw Error('Balatro arena changed after CRC');
    safeToRelease = false;
    const result = parseReply(await step('run-fs-counter-client-overlap',
      () => execute({host, port: 9026,
        source: makeSource(context), timeoutMs: 15000})), context);
    safeToRelease = true;
    const after = await step('identify-image-after-workers',
      () => identifyImage(host, execute));
    if (after.state !== before.state || after.metadataVersion !== before.metadataVersion ||
        after.mainBase !== before.mainBase || after.sdkBase !== before.sdkBase ||
        after.sampleFingerprintSha256 !== before.sampleFingerprintSha256) {
      throw Error('Balatro image changed during FS overlap diagnostic');
    }
    const release = await releaseArena('detach-owned-arena');
    return {...result, arena: release.arena};
  } catch (error) {
    if (safeToRelease && !released && !releaseAttempted) {
      try {
        await releaseArena('detach-owned-arena-after-failure');
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'Balatro diagnostic failed and owned arena cleanup was not verified');
      }
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node fs-counter-overlap.cjs <switch-ipv4> <mac-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runDiagnostic({host: argv[0],
      macIp: argv[1], onPhase: (name, state) => process.stderr.write(
        `phase: ${name} owner=${state.nonce} arena=${state.arenaState}\n`)}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry or canary marker attempt was made. Restart Balatro if an arena or worker was retained.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {MARKER, WORKERS, FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES,
  SERVICE_HANDLE_OFFSET,
  buildFrame, frameWords, assessRows, makeSource, parseReply, runDiagnostic};
