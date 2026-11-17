const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {qualifyNativeCrc, SDK_CRC32} = require('./qualify-native-crc.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const {FUNCTIONS, RESULT_SENTINEL} = require('./worker-frame.cjs');
const {RESULT_OFFSET, TABLE_OFFSET, STACK_OFFSET, buildChainLayout} = require('./worker-chain.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_NATIVE_OVERLAP_V1';
const ARENA_BYTES = 0x200000;
const FRAME_SPACING = 0x4000;
const WORKERS = 3;
const SLEEP_NS = 100000000;
const TICK_HZ = 19200000;
const REFERENCE_BASE = 0x100000000;
const REFERENCE_SDK = 0x200000000;
const SOURCE_LIMIT = 32768;

function makeIdleSource({nonce, mainBase, sdkBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      !/^0x[0-9a-f]+$/.test(mainBase || '') ||
      !/^0x[0-9a-f]+$/.test(sdkBase || '')) {
    throw new TypeError('Balatro idle gate needs exact image addresses and owner');
  }
  return `local b=BL
if not b or b.state~='serving' or not b.info or
   b.info.version~='${profile.runtimeVersion}' or
   string.format('0x%x',b.info.main_base or 0)~='${mainBase}' or
   string.format('0x%x',b.info.sdk_base or 0)~='${sdkBase}' then
  return '${MARKER}\\tidle\\tfail\\t${nonce}\\timage-changed'
end
if b.fs_bridge or b.fs_worker_hold or b.fs_transport then
  return '${MARKER}\\tidle\\tfail\\t${nonce}\\tactive-state'
end
return '${MARKER}\\tidle\\tok\\t${nonce}\\tno-held-state'`;
}

function parseIdleReply(reply, nonce) {
  if (typeof reply !== 'string') throw new TypeError('Balatro idle reply must be text');
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\tidle\t`));
  if (lines.length !== 1) throw Error('Balatro idle-state reply is missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields.length !== 5 || fields[0] !== MARKER || fields[1] !== 'idle' ||
      fields[3] !== nonce) throw Error('Balatro idle-state owner changed');
  if (fields[2] !== 'ok' || fields[4] !== 'no-held-state') {
    throw Error(`Balatro has active state or a changed image: ${fields[4]}`);
  }
  return {nonce, idle: true};
}

function buildSleepFrame({base, sdk}) {
  const sleep = profile.symbols['nn::os::SleepThread'];
  if (!sleep || !Number.isSafeInteger(sleep.offset) || sleep.offset % 4) {
    throw Error('Balatro SleepThread is absent from the pinned SDK profile');
  }
  const {frame} = buildChainLayout({base, sdk,
    calls: ['systemTick', 'systemTick', 'systemTick']});
  frame.writeBigUInt64LE(BigInt(sdk + sleep.offset), TABLE_OFFSET + 8);
  frame.writeBigUInt64LE(BigInt(SLEEP_NS), STACK_OFFSET + 0x30 + 0x78);
  return frame;
}

function frameWords() {
  const frame = buildSleepFrame({base: REFERENCE_BASE, sdk: REFERENCE_SDK});
  const words = [];
  for (let offset = 0; offset < frame.length; offset += 8) {
    const value = frame.readBigUInt64LE(offset);
    if (value === 0n) continue;
    if (value === RESULT_SENTINEL) words.push([offset, 3, 0]);
    else if (value === BigInt(SLEEP_NS)) words.push([offset, 4, SLEEP_NS]);
    else if (value >= BigInt(REFERENCE_BASE) &&
             value < BigInt(REFERENCE_BASE + frame.length)) {
      words.push([offset, 1, Number(value - BigInt(REFERENCE_BASE))]);
    } else if (value >= BigInt(REFERENCE_SDK) &&
               value < BigInt(REFERENCE_SDK + profile.sdkCode.size)) {
      words.push([offset, 2, Number(value - BigInt(REFERENCE_SDK))]);
    } else throw Error(`unrelocatable Balatro overlap frame word at 0x${offset.toString(16)}`);
  }
  return {words, frameBytes: frame.length};
}

function parseTickHex(value) {
  if (!/^[0-9a-f]{16}$/.test(value || '')) throw Error('Balatro native tick is not exact');
  return BigInt(`0x${value}`);
}

function assessRows(rows) {
  if (!Array.isArray(rows) || rows.length !== WORKERS) {
    throw Error('Balatro native overlap needs three independent worker rows');
  }
  const ids = new Set();
  const intervals = rows.map(row => {
    if (!/^[0-9a-f]{16}$/.test(row?.threadId || '') ||
        row.threadId === '0000000000000000' || ids.has(row.threadId)) {
      throw Error('Balatro native worker ID is missing or reused');
    }
    ids.add(row.threadId);
    const entered = parseTickHex(row.enteredTick);
    const completed = parseTickHex(row.completedTick);
    const minimum = BigInt(TICK_HZ / 20);
    const maximum = BigInt(TICK_HZ);
    if (entered === 0n || completed <= entered ||
        completed - entered < minimum || completed - entered > maximum) {
      throw Error('Balatro native worker lifetime is outside the bounded sleep envelope');
    }
    return {entered, completed};
  });
  const latestEntry = intervals.reduce((current, row) => row.entered > current ? row.entered : current, 0n);
  const earliestExit = intervals.reduce((current, row) => row.completed < current ? row.completed : current,
    intervals[0].completed);
  return {nativeCounterHz: TICK_HZ,
    nativeWorkerOverlapMeasured: latestEntry < earliestExit,
    commonOverlapTicks: latestEntry < earliestExit ? (earliestExit - latestEntry).toString() : '0',
    markerHitVerified: false, fsStageVerified: false};
}

function makeSource({nonce, arenaBase, sdkBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      !/^0x[0-9a-f]+$/.test(arenaBase || '') ||
      !/^0x[0-9a-f]+$/.test(sdkBase || '')) {
    throw new TypeError('Balatro overlap needs a nonce and exact arena/SDK addresses');
  }
  const arena = Number(BigInt(arenaBase));
  const sdk = Number(BigInt(sdkBase));
  if (![arena, sdk].every(address => Number.isSafeInteger(address) &&
      address >= 4096 && address % 4096 === 0 && address < 2 ** 39) ||
      arena + ARENA_BYTES >= 2 ** 39 || sdk + profile.sdkCode.size >= 2 ** 39) {
    throw new RangeError('Balatro overlap addresses are outside the pinned user range');
  }
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw Error('Balatro pinned preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="native-counter-overlap"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const {words, frameBytes} = frameWords();
  const wordRows = words.map(row => `{${row.join(',')}}`).join(',');
  const symbols = profile.symbols;
  const source = `${preamble}
if string.format('0x%x',base)~='${sdkBase}' then return fail('sdk-base-changed') end
local held=b.fs_bridge
if not held or held.owner~=nonce or held.stage~='ready' or
   held.base~=${arena} or held.bytes~=${ARENA_BYTES} or not held.buf then
  return fail('fresh-arena-missing')
end
if b.fs_worker_hold or b.fs_transport then return fail('previous-worker-or-transport') end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.base<raw+64 or held.base+held.bytes+64>raw+ffi.sizeof(held.buf) or
   held.before~=held.base-raw-64 or held.after~=held.base-raw+held.bytes then
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
local words={${wordRows}}
for j=0,${WORKERS - 1} do
  local frameBase=held.base+j*${FRAME_SPACING}
  ffi.fill(ffi.cast('uint8_t*',frameBase),${frameBytes},0)
  for _,word in ipairs(words) do
    local offset,tag,value=word[1],word[2],word[3]
    local p=ffi.cast('uint64_t*',frameBase+offset)
    if tag==1 then p[0]=ffi.cast('uint64_t',frameBase+value)
    elseif tag==2 then p[0]=ffi.cast('uint64_t',base+value)
    elseif tag==3 then p[0]=ffi.cast('uint64_t',0xfedcba9876543210ULL)
    else p[0]=ffi.cast('uint64_t',value) end
  end
end
local create=love.ffi.declare('uint32_t',{'uint32_t *','uint64_t','uint64_t',
  'uint64_t','int32_t','int32_t'},base+${symbols.svcCreateThread.offset})
local start=love.ffi.declare('uint32_t',{'uint32_t'},base+${symbols.svcStartThread.offset})
local getId=love.ffi.declare('uint32_t',{'uint64_t *','uint32_t'},
  base+${symbols.svcGetThreadId.offset})
local wait=love.ffi.declare('uint32_t',{'uint32_t *','uint32_t *','int32_t','int64_t'},
  base+${symbols.svcWaitSynchronization.offset})
local close=love.ffi.declare('uint32_t',{'uint32_t'},base+${symbols.svcCloseHandle.offset})
local hold={arena=held,entries={}}
b.fs_worker_hold=hold
local function join(entry)
  if not entry.started or entry.joined then return true end
  local index=ffi.new('uint32_t[1]')
  local handles=ffi.new('uint32_t[1]',entry.handle)
  for i=1,200 do
    local rc=tonumber(wait(index,handles,1,0))
    if rc==0 then
      if tonumber(index[0])~=0 then error('wait-index') end
      entry.joined=true
      return true
    end
    if rc~=59905 then error('wait-result:'..tostring(rc)) end
    love.timer.sleep(0.01)
  end
  return false
end
local function tickHex(addr)
  local p=ffi.cast('const uint32_t*',addr)
  return string.format('%08x%08x',tonumber(p[1]),tonumber(p[0]))
end
local ok,errorText=pcall(function()
  for j=0,${WORKERS - 1} do
    local frameBase=held.base+j*${FRAME_SPACING}
    local out=ffi.new('uint32_t[1]')
    local rc=tonumber(create(out,base+${FUNCTIONS.longjmp.offset},frameBase,
      frameBase+${frameBytes},tonumber(priority[0]),0))
    if rc~=0 then error('create-result:'..tostring(rc)) end
    local entry={handle=tonumber(out[0]),started=false,joined=false}
    hold.entries[#hold.entries+1]=entry
    if not entry.handle or entry.handle==0 or entry.handle>=0xffff8000 then
      error('created-handle')
    end
    local id=ffi.new('uint64_t[1]')
    rc=tonumber(getId(id,entry.handle))
    if rc~=0 then error('thread-id-result:'..tostring(rc)) end
    local parts=ffi.cast('const uint32_t*',id)
    entry.id=string.format('%08x%08x',tonumber(parts[1]),tonumber(parts[0]))
    if entry.id=='0000000000000000' then error('thread-id-zero') end
    rc=tonumber(start(entry.handle))
    if rc~=0 then error('start-result:'..tostring(rc)) end
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
    if first=='fedcba9876543210' or last=='fedcba9876543210' or
       first=='0000000000000000' or last=='0000000000000000' then
      ok=false;errorText='tick-result:'..j;break
    end
    rows[#rows+1]=entry.id..','..first..','..last
  end
end
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
      else ok=false;errorText=tostring(errorText or 'close-handle') end
    end
  end
end
local retained=false
for _,entry in ipairs(hold.entries) do
  if entry.handle and entry.handle~=0 then retained=true end
end
if not retained then b.fs_worker_hold=nil end
if not guard() then held.stage='quarantined';return fail('arena-guard-after-worker') end
if b.fs_bridge~=held or held.stage~='ready' then return fail('arena-changed') end
if not ok then return fail(tostring(errorText)..(retained and ':retained' or ':released')) end
if retained or #rows~=${WORKERS} then return fail('worker-cleanup') end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',held.base),
  string.format('0x%x',base),'handles-released',rows[1],rows[2],rows[3],
  'arena-retained'},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro overlap source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce, arenaBase, sdkBase}) {
  if (typeof reply !== 'string') throw new TypeError('Balatro overlap reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('missing or duplicated Balatro overlap reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== 'native-counter-overlap' ||
      fields[3] !== nonce) throw Error('Balatro overlap reply has a stale owner');
  if (fields[2] === 'fail' && fields.length === 5) {
    throw Error(`Balatro native overlap failed: ${fields[4]}`);
  }
  if (fields.length !== 11 || fields[2] !== 'ok' || fields[4] !== arenaBase ||
      fields[5] !== sdkBase || fields[6] !== 'handles-released' ||
      fields[10] !== 'arena-retained') {
    throw Error('Balatro overlap reply is incomplete or cleanup is unverified');
  }
  const rows = fields.slice(7, 10).map(value => {
    const parts = value.split(',');
    if (parts.length !== 3) throw Error('Balatro overlap row is incomplete');
    return {threadId: parts[0], enteredTick: parts[1], completedTick: parts[2]};
  });
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    nonce, arenaBase, sdkBase, rows, ...assessRows(rows),
    workerHandles: 'released', arena: 'retained', explicitFsWriteRequests: 0,
    rpcLoggingMayWriteSave: true,
    status: 'native timing worker diagnostic only; FS request overlap, pin placement, and marker unverified'};
}

function makeReleaseSource({nonce, arenaBase, sdkBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      !/^0x[0-9a-f]+$/.test(arenaBase || '') ||
      !/^0x[0-9a-f]+$/.test(sdkBase || '')) {
    throw new TypeError('Balatro arena cleanup needs the verified owner and addresses');
  }
  return `local b=BL
local held=b and b.fs_bridge
if not b or b.state~='serving' or not b.info or
   b.info.version~='${profile.runtimeVersion}' or
   string.format('0x%x',b.info.sdk_base or 0)~='${sdkBase}' or
   not held or held.owner~='${nonce}' or held.stage~='ready' or
   string.format('0x%x',held.base or 0)~='${arenaBase}' or
   held.bytes~=${ARENA_BYTES} or not held.buf or
   b.fs_worker_hold or b.fs_transport then
  return '${MARKER}\\tcleanup-refused'
end
local ffi=require('ffi')
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.before~=held.base-raw-64 or
   held.after~=held.base-raw+held.bytes or
   held.base+held.bytes+64>raw+ffi.sizeof(held.buf) then
  return '${MARKER}\\tcleanup-refused'
end
for i=0,63 do
  if tonumber(held.buf[held.before+i])~=165 or
     tonumber(held.buf[held.after+i])~=165 then
    return '${MARKER}\\tcleanup-refused'
  end
end
b.fs_bridge=nil
held=nil
pcall(collectgarbage,'collect')
return '${MARKER}\\tARENA_DETACHED\\t${nonce}\\t${arenaBase}'`;
}

function parseReleaseReply(reply, {nonce, arenaBase}) {
  if (typeof reply !== 'string' ||
      reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`))
        .length !== 1 ||
      !reply.trimEnd().split('\n').includes(
        `-> ${MARKER}\tARENA_DETACHED\t${nonce}\t${arenaBase}`)) {
    throw Error('Balatro fresh arena cleanup was not verified');
  }
  return {arena: 'detached', owner: nonce};
}

async function runDiagnostic({host, macIp, nonce = crypto.randomBytes(8).toString('hex'),
  execute = executeLua, identifyImage = identify, reserve = checkArena,
  preflight = runPreflight, verifyCrc = qualifyNativeCrc}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce) ||
      [execute, identifyImage, reserve, preflight, verifyCrc].some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro overlap needs IPv4 addresses and a fresh owner nonce');
  }
  const before = await identifyImage(host, execute);
  if (before.state !== 'serving' || before.metadataVersion !== profile.runtimeVersion ||
      before.codeHeadProfile !== '1.0.1f' ||
      !/^0x[0-9a-f]+$/.test(before.mainBase || '') ||
      !/^0x[0-9a-f]+$/.test(before.sdkBase || '')) {
    throw Error('Balatro is not the pinned 1.0.1f image');
  }
  parseIdleReply(await execute({host, port: 9026,
    source: makeIdleSource({nonce, mainBase: before.mainBase, sdkBase: before.sdkBase}),
    timeoutMs: 10000}), nonce);
  const arena = await reserve({host, phase: 'reserve', nonce, execute});
  if (arena.nonce !== nonce || arena.phase !== 'reserve' || arena.bytes !== ARENA_BYTES) {
    throw Error('Balatro fresh arena reservation did not verify');
  }
  const ready = await preflight({host, nonce, execute});
  if (ready.nonce !== nonce || ready.arenaBase !== arena.base ||
      ready.arenaBytes !== ARENA_BYTES || ready.sdkHz !== TICK_HZ) {
    throw Error('Balatro fresh arena or native clock changed');
  }
  const crc = await verifyCrc({host, macIp, nonce, execute, port: 39381});
  if (crc.nonce !== nonce || crc.port !== 39381 ||
      crc.sdkBase !== before.sdkBase ||
      crc.sdkCrc32 !== `0x${SDK_CRC32.toString(16)}`) {
    throw Error('Balatro complete SDK CRC or base changed');
  }
  const afterCrc = await preflight({host, nonce, execute});
  if (afterCrc.nonce !== nonce || afterCrc.arenaBase !== arena.base ||
      afterCrc.sdkHz !== TICK_HZ) throw Error('Balatro arena changed after SDK CRC');
  const context = {nonce, arenaBase: arena.base, sdkBase: before.sdkBase};
  const result = parseReply(await execute({host, port: 9026,
    source: makeSource(context), timeoutMs: 15000}), context);
  const after = await identifyImage(host, execute);
  if (after.state !== before.state || after.metadataVersion !== before.metadataVersion ||
      after.mainBase !== before.mainBase || after.sdkBase !== before.sdkBase ||
      after.sampleFingerprintSha256 !== before.sampleFingerprintSha256) {
    throw Error('Balatro image changed during native overlap diagnostic');
  }
  const released = parseReleaseReply(await execute({host, port: 9026,
    source: makeReleaseSource(context), timeoutMs: 10000}), context);
  return {...result, arena: released.arena};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node native-counter-overlap.cjs <switch-ipv4> <mac-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runDiagnostic({host: argv[0], macIp: argv[1]}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry or FS marker attempt was made. Restart Balatro if an arena or worker was retained.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {MARKER, ARENA_BYTES, FRAME_SPACING, WORKERS, SLEEP_NS, TICK_HZ,
  makeIdleSource, parseIdleReply, buildSleepFrame, frameWords, assessRows, makeSource, parseReply,
  makeReleaseSource, parseReleaseReply, runDiagnostic};
