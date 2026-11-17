const worker = require('./sdk-worker-layout.v1.2.1.json');
const events = require('./sdk-event-code.v1.2.1.json');
const rawSvc = require('./sdk-raw-svc.v1.2.1.json');
const crc = require('./sdk-crc32.v1.2.1.json');
const {build, SENTINEL} = require('./worker-frame.cjs');
const {executeLua, DEFAULT_PORT} = require('./repl-client.cjs');

const BASE = 0x100000000;
const SDK = 0x200000000;
const GATE = 0x18000;
const STACK = 0x20000;
const STACK_BYTES = 0x10000;
const ARENA_BYTES = STACK + STACK_BYTES + 0x1000;
const FRAME_LIMIT = 0x18000;

function plan() {
  const calls = [
    {function: SDK + events.functions.wait.offset, args: [BASE + GATE, 0, 0, 0]},
    {function: SDK + rawSvc.functions.getCurrentProcessorNumber.offset, args: [0, 0, 0, 0]},
  ];
  const prepared = build(BASE, SDK, calls, worker.functions, {
    sdkBytes: worker.sdkCode.size,
    memcpyOffset: 0,
    exitOffset: rawSvc.functions.exitThread.offset,
  });
  if (prepared.frame.length > FRAME_LIMIT || prepared.proof.nativeCalls !== 2 ||
      prepared.proof.resultOffsets[0] !== 0x800 || prepared.proof.resultOffsets[1] !== 0x808)
    throw Error('Gravity Circuit disposable worker layout changed');
  const words = [];
  for (let offset = 0; offset < prepared.frame.length; offset += 8) {
    const value = prepared.frame.readBigUInt64LE(offset);
    if (!value) continue;
    if (value === SENTINEL) words.push([offset, 3, 0]);
    else if (value >= BigInt(BASE) && value < BigInt(BASE + ARENA_BYTES))
      words.push([offset, 1, Number(value - BigInt(BASE))]);
    else if (value >= BigInt(SDK) && value < BigInt(SDK + worker.sdkCode.size))
      words.push([offset, 2, Number(value - BigInt(SDK))]);
    else throw Error(`Unrelocatable disposable worker word at 0x${offset.toString(16)}`);
  }
  return {words, proof: prepared.proof};
}

function makeSource() {
  const {words} = plan();
  const signatures = [worker.functions.longjmp, worker.functions.loadTable,
    worker.functions.call4, worker.functions.saveResult64, worker.functions.current,
    events.functions.initialize, events.functions.wait, events.functions.signal,
    events.functions.finalize, ...Object.values(rawSvc.functions)];
  const checks = signatures.map(entry => `{${entry.offset},'${entry.bytes}'}`).join(',');
  const encoded = words.map(word => `{${word.join(',')}}`).join(',');
  return `local ffi=require('ffi')
local gc=require('gc.ffi_call')
local info=LS and LS.nx_info
local function fail(why,retained) return 'GC_WORKER_V1\\tfail\\t'..tostring(why)..'\\t'..tostring(retained and 'retained' or 'released') end
if not (LS and LS.state=='serving' and info and info.profile=='gravity-circuit-v1.2.1' and info.sdk_base and info.sdk_base%4096==0) then return fail('profile',false) end
if not (LS.fs_bridge and LS.fs_bridge.stage=='accept') then return fail('bridge-not-ready',false) end
if LS.gc_worker_hold then return fail('previous-worker-retained',true) end
local sdk=info.sdk_base
local function bytes_ok(offset,hex)
  local p=ffi.cast('const uint8_t*',ffi.cast('uintptr_t',sdk+offset))
  for i=0,#hex/2-1 do if tonumber(p[i])~=tonumber(hex:sub(i*2+1,i*2+2),16) then return false end end
  return true
end
for _,check in ipairs({${checks}}) do if not bytes_ok(check[1],check[2]) then return fail('signature:'..check[1],false) end end
local ready,why=gc.preflight(ffi,info)
if not ready then return fail('native-preflight:'..tostring(why),false) end
local function call(offset,args)
  local result,err=gc.gp_invoke(ffi,love.graphics.present,info,sdk+offset,args)
  if not result then error('native-call:'..offset..':'..tostring(err)) end
  return tonumber(ffi.cast('uint32_t',result.raw))
end
local crcResult=call(${crc.function.offset},{0,sdk,${worker.sdkCode.size}})
if crcResult~=${crc.sdkCheck.expected} then return fail('sdk-crc',false) end
local arena=ffi.new('uint8_t[?]',${ARENA_BYTES + 0x1000})
local address=tonumber(ffi.cast('uintptr_t',arena))
local base=address+(4096-address%4096)%4096
if base<0x1000 or base+${ARENA_BYTES}>=2^39 then return fail('arena-address',false) end
local hold={arena=arena,base=base,started=false,joined=false,handle=0,event=false}
local function at(offset) return ffi.cast('uintptr_t',base+offset) end
local function read32(offset) return tonumber(ffi.cast('uint32_t*',at(offset))[0]) end
local function write64(offset,value) ffi.cast('uint64_t*',at(offset))[0]=ffi.cast('uint64_t',value) end
local function result(offset) return ffi.cast('uint64_t*',at(offset))[0] end
ffi.fill(ffi.cast('uint8_t*',at(0)),${ARENA_BYTES},0)
for _,word in ipairs({${encoded}}) do
  local offset,tag,value=word[1],word[2],word[3]
  if tag==1 then write64(offset,base+value)
  elseif tag==2 then write64(offset,sdk+value)
  else local p=ffi.cast('uint32_t*',at(offset));p[0]=0x76543210;p[1]=0xfedcba98 end
end
LS.gc_worker_hold=hold
local function signal() call(${events.functions.signal.offset},{base+${GATE}}) end
local function wait_done()
  local out=ffi.new('uint32_t[1]')
  local handles=ffi.new('uint32_t[1]',hold.handle)
  for i=1,100 do
    local status=call(${rawSvc.functions.waitSynchronization.offset},{out,handles,1,0})
    if status==0 then if tonumber(out[0])~=0 then error('wrong-wait-index') end;hold.joined=true;return end
    if status~=${rawSvc.waitTimeoutResult} then error('wait-result:'..status) end
    love.timer.sleep(0.01)
  end
  error('worker-join-timeout')
end
local ok,err=pcall(function()
  call(${events.functions.initialize.offset},{base+${GATE},0,0})
  hold.event=true
  local event=ffi.cast('uint8_t*',at(${GATE}))
  if tonumber(event[0])~=0 or tonumber(event[1])~=1 or read32(${GATE + 4})~=0 then error('event-state') end
  local current=gc.gp_invoke(ffi,love.graphics.present,info,sdk+${worker.functions.current.offset},{})
  if not current then error('current-thread-call') end
  local thread=tonumber(ffi.cast('uintptr_t',current.raw))
  if not (thread and thread>0x1000 and thread<2^39 and thread%8==0) then error('current-thread-pointer') end
  local gameHandle=tonumber(ffi.cast('uint32_t*',ffi.cast('uintptr_t',thread+${rawSvc.managerList.nodeHandleOffset}))[0])
  if gameHandle==0 or gameHandle>=0xffff8000 then error('game-thread-handle') end
  local priority=ffi.new('uint32_t[1]')
  local core=ffi.new('uint32_t[1]')
  local mask=ffi.new('uint64_t[1]')
  if call(${rawSvc.functions.getThreadPriority.offset},{priority,gameHandle})~=0 then error('priority-query') end
  if call(${rawSvc.functions.getThreadCoreMask.offset},{core,mask,gameHandle})~=0 then error('core-mask-query') end
  local prio=tonumber(priority[0])
  if prio<1 or prio>63 then error('priority-range') end
  local bits=tonumber(ffi.cast('uint32_t',mask[0]))
  local chosen=nil
  for i=0,15 do if math.floor(bits/2^i)%2==1 then chosen=i;break end end
  if chosen==nil then error('core-mask-empty') end
  hold.priority=prio;hold.core=chosen
  local out=ffi.new('uint32_t[1]')
  local status=call(${rawSvc.functions.createThread.offset},{out,sdk+${worker.functions.longjmp.offset},base,base+${STACK + STACK_BYTES},prio,chosen})
  if status~=0 then error('create-result:'..status) end
  hold.handle=tonumber(out[0])
  if hold.handle==0 or hold.handle>=0xffff8000 then error('created-handle') end
  local started=call(${rawSvc.functions.startThread.offset},{hold.handle})
  if started~=0 then error('start-result:'..started) end
  hold.started=true
  if read32(0x800)~=0x76543210 or read32(0x804)~=0xfedcba98 then error('gate-passed-before-signal') end
  local workerCore=ffi.new('uint32_t[1]')
  local workerMask=ffi.new('uint64_t[1]')
  if call(${rawSvc.functions.getThreadCoreMask.offset},{workerCore,workerMask,hold.handle})~=0 then error('worker-mask-query') end
  local before=tonumber(ffi.cast('uint32_t',workerMask[0]))
  local selected=2^chosen
  if math.floor(before/selected)%2~=1 then error('borrowed-core-missing') end
  if call(${rawSvc.functions.setThreadCoreMask.offset},{hold.handle,0xffffffff,selected})~=0 then error('worker-mask-set') end
  workerMask[0]=0
  if call(${rawSvc.functions.getThreadCoreMask.offset},{workerCore,workerMask,hold.handle})~=0 then error('worker-mask-readback') end
  local after=tonumber(ffi.cast('uint32_t',workerMask[0]))
  if after~=selected then error('worker-mask-differs:'..after) end
  hold.affinityBefore=before;hold.affinityAfter=after
  signal()
  wait_done()
  if read32(0x800)==0x76543210 and read32(0x804)==0xfedcba98 then error('gate-result-unchanged') end
  local observed=read32(0x808)
  if observed>15 then error('worker-core-range:'..observed) end
  hold.workerCore=observed
end)
if not ok and hold.started and not hold.joined then
  pcall(signal)
  pcall(wait_done)
end
if hold.handle~=0 and (hold.joined or not hold.started) then
  local closed,code=pcall(call,${rawSvc.functions.closeHandle.offset},{hold.handle})
  if closed and code==0 then hold.handle=0
  elseif ok then ok=false;err='close-handle:'..tostring(code) end
end
if hold.event and (hold.joined or not hold.started) then
  local finalized=pcall(call,${events.functions.finalize.offset},{base+${GATE}})
  if finalized then hold.event=false
  elseif ok then ok=false;err='finalize-event' end
end
local retained=hold.started and not hold.joined or hold.handle~=0 or hold.event
if not retained then LS.gc_worker_hold=nil end
if not ok then return fail(err,retained) end
if retained then return fail('incomplete-cleanup',true) end
if LS.fs_bridge.stage~='accept' then return fail('bridge-changed',false) end
return table.concat({'GC_WORKER_V1','ok',string.format('0x%x',sdk),tostring(hold.priority),tostring(hold.core),tostring(hold.workerCore),tostring(hold.affinityBefore),tostring(hold.affinityAfter),'released'},'\\t')`;
}

function parseReply(reply) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:)/m.test(reply)) throw Error(reply.trim());
  const line = reply.trimEnd().split('\n').find(value => value.startsWith('-> GC_WORKER_V1\t'));
  if (!line) throw Error('Gravity Circuit worker qualification reply was not recognized');
  const fields = line.slice(3).split('\t');
  if (fields[1] !== 'ok')
    throw Error(`Gravity Circuit worker qualification failed: ${fields.slice(2).join(' ')}`);
  if (fields.length !== 9 || !/^0x[0-9a-f]+$/.test(fields[2]) ||
      ![3, 4, 5, 6, 7].every(index => /^\d+$/.test(fields[index])) || fields[8] !== 'released')
    throw Error('Gravity Circuit worker qualification reply is incomplete');
  return {sdkBase: fields[2], priority: Number(fields[3]), borrowedCore: Number(fields[4]),
    workerCore: Number(fields[5]), affinityBefore: Number(fields[6]),
    affinityAfter: Number(fields[7]), cleanup: fields[8]};
}

async function qualifyWorker({host, port = DEFAULT_PORT, timeoutMs = 30000}) {
  return parseReply(await executeLua({host, port, source: makeSource(), timeoutMs}));
}

async function main() {
  const host = process.argv[2];
  if (!host) {
    process.stderr.write('usage: node qualify-worker.cjs <switch-ipv4> [port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await qualifyWorker({host,
      port: process.argv[3] ? Number(process.argv[3]) : DEFAULT_PORT}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {plan, makeSource, parseReply, qualifyWorker};
