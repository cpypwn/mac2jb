-- Phase B: run worker_probe's PROVEN emitter command-loop on a RAW-SVC thread
-- (Phase A) instead of the HW-crashing thread_impl_create. The thread enters
-- via longjmp (sdk+0x5511b4) landing on the worker pivot, exactly mirroring
-- worker_probe's pivot-descriptor (x29=chain+0x50, x30=main(G.pivot)).
--
-- Coarse STOP checkpoints for nora_debug.py:
--   1 = setup + emitter chain built (no thread yet)
--   2 = raw svcCreateThread succeeded (thread exists, gated, not started)
--   3 = started + initial-gate verified (thread is spinning in its wait loop)
--   4 = ran one job (svc_sleep) and re-armed  -> WORKER EXECUTES JOBS
--   5 = exit job + join + close               -> PHASE B PASS
--
--   nora_debug.py <host> phaseB_worker_seedsow.lua --max 5
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h is not initialized")

local L = {
  stride = 0x4000, tt = 0x000, tt_alloc = 0x200, handle = 0x1B8,
  priority = 0x44, stack_size_field = 0x50, stack_ptr = 0x58,
  stack = 0x200, stack_size = 0x800, pd = 0xBB0, pd_x29 = 0xBE0, pd_x30 = 0xBE8,
  chain = 0xBF0, desc = 0x1000, desc_size = 0xC00, out = 0x1C00, wait_index = 0x1C08,
  marker = 0x1C10, cmd = 0x1C80, ack = 0x1CA0, status = 0x1CC0, job = 0x1D00,
  loop_scratch = 0x1D60, job_signal = 0x1D80, jmpbuf = 0x1E00, ctrl = 0x1F00, slack = 0x10,
}
local G = { thread_pivot = 0x111DCC, pivot = 0x14A94C, call2 = 0x0B7A88 }
local ARMED, GO = 1, 2
local SEQ = 0x4E4F5241
local SLEEP_NS = 1000000
local POLL_LIMIT = 200
local JOIN_NS = 250000000
local CUR_THREAD = 0xFFFF8000
-- raw-svc offsets (Seedsow sdk)
local SVC_CREATE, SVC_START, SVC_WAIT, SVC_CLOSE = 0x168b2c, 0x168b44, 0x168bf4, 0x168be4
local GET_PRIO, LONGJMP = 0x168b5c, 0x5511b4

local R, S = {}, {}
local function hex(v) if type(v)=="number" then return string.format("0x%x", v) end return tostring(v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(name) if type(name)=="number" then return N.sdk_base+name end return N.sdk_base+N.offsets_sdk[name] end
local function main(va) return N.main_base + va end

local function build()
  assert(N.gadgets.g_load_x0 and N.gadgets.g_load_x19 and N.gadgets.g_store_x0_x19, "missing core gadgets")
  assert(N.offsets_sdk.wait_for_address_eq1_inf and N.offsets_sdk.svc_signal_to_address and
    N.offsets_sdk.svc_wait_sync and N.offsets_sdk.svc_close_handle and N.offsets_sdk.svc_sleep_thread,
    "missing core SDK offsets")
  R.raw = N.alloc(L.stride + 0xFFF)
  assert(R.raw and R.raw ~= 0, "worker allocation failed")
  R.block = R.raw + 0xFFF; R.block = R.block - R.block % 0x1000
  R.tt = R.block + L.tt
  local function owned(a) return type(a)=="number" and a>=R.block and a+12<=R.block+L.stride end
  local function poke(a,v) assert(owned(a),"poke outside owned block "..hex(a)) N.poke(a,v) end
  local function w(off) return R.block+off end
  S.w, S.poke = w, poke

  -- ThreadType-ish scratch (unused by the raw-svc path except as scratch) + stack
  for off=0,L.tt_alloc-8,8 do poke(R.tt+off,0) end
  poke(R.tt+L.stack_size_field, L.stack_size)
  poke(R.tt+L.stack_ptr, w(L.stack))

  -- control fields
  poke(w(L.out),0); poke(w(L.wait_index),0); poke(w(L.marker),0)
  poke(w(L.cmd),ARMED); poke(w(L.ack),ARMED); poke(w(L.status),0)
  poke(w(L.job)+0x38,0); poke(w(L.job)+0x40,0); poke(w(L.job)+0x48,0); poke(w(L.job)+0x50,0)
  poke(w(L.loop_scratch),0)
  poke(w(L.job_signal)+0x38,0); poke(w(L.job_signal)+0x48,sdk("svc_signal_to_address")); poke(w(L.job_signal)+0x50,w(L.ack))

  for off=0,0x58,8 do poke(w(L.chain)+off,0) end
  poke(w(L.chain)+0x50,0)
  poke(w(L.chain)+0x58,main(N.gadgets.g_load_x19))

  local E = N.new_emitter(w(L.chain)+0x60, w(L.desc), w(L.desc)+L.desc_size, w(L.desc)-L.slack, w(L.loop_scratch))
  local function q(a,v) assert(owned(a),"emitter write outside block") E.words[#E.words+1]={a,v} end
  local function wait_eq1(a)
    E:g1(a); E:patch(sdk("wait_for_address_eq1_inf"))
    local b=E.cursor; for off=0,0x30,8 do q(b+off,0) end; E.cursor=b+0x40; E.pending=b+0x38
  end
  local function vcall2(desc)
    E:g1(desc); E:patch(main(G.call2))
    local b=E.cursor; q(b,0); q(b+8,desc); q(b+0x10,0); E.cursor=b+0x20; E.pending=b+0x18
  end
  local function loop()
    E:patch(main(N.gadgets.g_load_x0))
    local b=E.cursor; q(b,0); q(b+8,0); q(b+0x10,w(L.chain)+0x50); q(b+0x18,main(G.pivot))
    E.cursor=b+0x20; E.pending=nil
  end
  wait_eq1(w(L.cmd)); vcall2(w(L.job))
  E:g1(w(L.marker)); E:g2(0,0); E:peek(w(L.job)+0x40,w(L.status))
  E:g0(1); E:g1(w(L.cmd)); E:g2(0,0)
  E:g0(0); E:g1(w(L.ack)); E:g2(0,0)
  vcall2(w(L.job_signal)); loop()
  assert(E.cursor<=E.chain_end,"worker chain overlaps descriptors")
  E:flush()
end

local function borrow_prio()
  local ctrl = S.w(L.ctrl)
  N.poke(ctrl,0)
  local r = N.call_deep(sdk(GET_PRIO), ctrl+0x20, CUR_THREAD, 0,0,0)
  local p = (r==0) and rd32(ctrl+0x20) or 0
  if not (p>0 and p<64) then p=44 end
  S.prio = p; return p
end

local function create()
  -- jmp_buf: longjmp restores x19..x28(+0..0x48), x29(+0x50), x30(+0x58), sp(+0x68), d8-d15(+0x70..)
  local jb = S.w(L.jmpbuf)
  for off=0,0xB0,8 do S.poke(jb+off,0) end
  S.poke(jb+0x50, S.w(L.chain)+0x50)     -- x29 = chain cursor (pivot reads this)
  S.poke(jb+0x58, main(G.pivot))          -- x30 = worker pivot (branched to)
  S.poke(jb+0x68, S.w(L.stack)+L.stack_size) -- sp
  local ctrl = S.w(L.ctrl); N.poke(ctrl,0)
  local cr = N.call_deep(sdk(SVC_CREATE), ctrl, sdk(LONGJMP), jb, S.w(L.stack)+L.stack_size, S.prio, 0)
  assert(cr==0, "svcCreateThread failed: "..hex(cr))
  R.handle = rd32(ctrl)
  assert(R.handle>0 and R.handle<0xffff8000, "bad handle: "..hex(R.handle))
  return R.handle
end

local function start_and_gate()
  local r = N.call_deep(sdk(SVC_START), R.handle,0,0,0,0)
  assert(r==0,"svcStartThread failed: "..hex(r))
  N.call_deep(sdk("svc_sleep_thread"), SLEEP_NS,0,0,0,0)
  R.g_cmd, R.g_ack, R.g_status = N.peek(S.w(L.cmd)), N.peek(S.w(L.ack)), N.peek(S.w(L.status))
  assert(R.g_cmd==ARMED and R.g_ack==ARMED and R.g_status==0,
    "worker not gated: cmd="..hex(R.g_cmd).." ack="..hex(R.g_ack).." status="..hex(R.g_status))
  return "cmd="..hex(R.g_cmd).." ack="..hex(R.g_ack)
end

local function run_job()
  local w=S.w
  N.poke(w(L.job)+0x38,0); N.poke(w(L.job)+0x40,SEQ)
  N.poke(w(L.job)+0x48,sdk("svc_sleep_thread")); N.poke(w(L.job)+0x50,SLEEP_NS)
  N.poke(w(L.ack),ARMED); N.poke(w(L.cmd),GO)
  local sr = N.call_deep(sdk("svc_signal_to_address"), w(L.cmd),0,0,0,0)
  assert(sr==0,"job signal failed: "..hex(sr))
  local ack
  for _=1,POLL_LIMIT do
    ack = N.peek(w(L.ack))
    if ack==0 then break end
    N.call_deep(sdk("svc_sleep_thread"), SLEEP_NS,0,0,0,0)
  end
  R.ack, R.status, R.cmd = ack, N.peek(w(L.status)), N.peek(w(L.cmd))
  assert(ack==0,"job ack timeout (worker did not run)")
  assert(R.status==SEQ,"job status mismatch: "..hex(R.status))
  assert(R.cmd==ARMED,"worker did not re-arm: "..hex(R.cmd))
  return "status="..hex(R.status).." (worker executed a job)"
end

local function exit_join_close()
  local w=S.w
  N.poke(w(L.job)+0x38,0); N.poke(w(L.job)+0x40,0)
  N.poke(w(L.job)+0x48,sdk("svc_exit_thread")); N.poke(w(L.job)+0x50,0)
  N.poke(w(L.cmd),GO)
  N.call_deep(sdk("svc_signal_to_address"), w(L.cmd),0,0,0,0)
  N.poke(w(L.out), R.handle)          -- handles[0] = worker handle
  N.poke(w(L.wait_index),0)
  local jr = N.call_deep(sdk(SVC_WAIT), w(L.wait_index), w(L.out), 1, JOIN_NS, 0)
  assert(jr==0,"join failed: "..hex(jr))
  local cr = N.call_deep(sdk(SVC_CLOSE), R.handle,0,0,0,0)
  assert(cr==0,"close failed: "..hex(cr))
  return "PHASE-B PASS: raw-svc worker ran a job and joined"
end

local ck = {}
local function at(n, name, fn) if STOP>=n then ck[#ck+1]=string.format("STEP %d OK %s %s", n, name, fn() or "") end end

at(1, "build-chain", function() build(); return "block="..hex(R.block) end)
at(2, "create",      function() borrow_prio(); return "prio="..S.prio.." "..("handle="..hex(create())) end)
at(3, "start-gate",  start_and_gate)
at(4, "run-job",     run_job)
at(5, "exit-join",   exit_join_close)
for _,line in ipairs(ck) do print(line) end
print("phaseB bound="..STOP.." reached end")
