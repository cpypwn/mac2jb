-- Phase A: create ONE raw kernel thread that longjmps straight into
-- svcExitThread, then start + join + close. Ported from the HW-proven Civ7
-- probe, borrowing scheduling params from the CURRENT thread (0xFFFF8000).
-- .text-free; step-gated for nora_debug.py crash localization.
--
--   nora_debug.py <host> phaseA_create_seedsow.lua --max 9
--
-- Offsets (Seedsow sdk, from the dumped NSO):
local LONGJMP     = 0x5511B4
local SVC_EXIT    = 0x168B4C
local SVC_CREATE  = 0x168B2C
local SVC_START   = 0x168B44
local SVC_WAITSYN = 0x168BF4
local SVC_CLOSE   = 0x168BE4
local GET_PRIO    = 0x168B5C
local GET_MASK    = 0x168B7C
local CUR_THREAD  = 0xFFFF8000
local STACK_BYTES = 0x14000
local WAIT_NS     = 0x77359400   -- 2s

local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")
local function hx(v) return string.format("0x%x", v) end
local function rd32(x)
  local a = x - x % 8
  local w = N.peek(a)
  if x % 8 == 0 then return w % 0x100000000 end
  return math.floor(w / 0x100000000)
end
local function sdk(o) return N.sdk_base + o end
local S = {}
local function step(n, name, fn)
  if n > STOP then return end
  local r = fn()
  print(string.format("STEP %d OK %s %s", n, name, r or ""))
end
local function pagealign(raw) return raw + 0xFFF - (raw + 0xFFF) % 0x1000 end

step(1, "env", function()
  assert(N.sdk_base and N.sdk_base ~= 0, "no sdk_base")
  return "sdk=" .. hx(N.sdk_base)
end)

step(2, "alloc", function()
  S.ctrl   = pagealign(N.alloc(0x2000))
  S.frameA = pagealign(N.alloc(0x2000))
  S.stackA = pagealign(N.alloc(STACK_BYTES + 0x1000))
  assert(S.ctrl ~= 0 and S.frameA ~= 0 and S.stackA ~= 0, "alloc failed")
  S.stackTop = S.stackA + STACK_BYTES
  return "ctrl=" .. hx(S.ctrl) .. " frame=" .. hx(S.frameA) .. " stackTop=" .. hx(S.stackTop)
end)

step(3, "borrow-prio", function()
  local r = N.call_deep(sdk(GET_PRIO), S.ctrl + 0x20, CUR_THREAD, 0, 0, 0)
  assert(r == 0, "GetThreadPriority failed: " .. hx(r))
  S.prio = rd32(S.ctrl + 0x20)
  -- Some nora requests run on a pool thread whose priority reads 0; fall back
  -- to the Civ7-proven FALLBACK_PRIORITY so create still gets a valid 1..63.
  local borrowed = S.prio
  if not (S.prio > 0 and S.prio < 64) then S.prio = 44 end
  return "prio=" .. S.prio .. " (borrowed=" .. borrowed .. ")"
end)

step(4, "borrow-mask", function()
  local r = N.call_deep(sdk(GET_MASK), S.ctrl + 0x18, S.ctrl + 0x38, CUR_THREAD, 0, 0)
  assert(r == 0, "GetThreadCoreMask failed: " .. hx(r))
  S.mask = N.peek(S.ctrl + 0x38)
  S.cores = {}
  for b = 0, 7 do if math.floor(S.mask / 2^b) % 2 == 1 then S.cores[#S.cores+1] = b end end
  -- HW evidence (Civ7): cores 6,7 pass create validation; append as fallbacks.
  for _, c in ipairs({6, 7}) do
    local seen = false
    for _, x in ipairs(S.cores) do if x == c then seen = true end end
    if not seen then S.cores[#S.cores+1] = c end
  end
  return "mask=" .. hx(S.mask) .. " candidates=" .. table.concat(S.cores, ",")
end)

step(5, "build-frame", function()
  -- jmp_buf for longjmp: +0x58 = target PC, +0x68 = stack pointer.
  -- Phase A: jump straight to svcExitThread so the thread exits immediately.
  N.poke(S.frameA + 0x58, sdk(SVC_EXIT))
  N.poke(S.frameA + 0x68, S.stackTop)
  N.poke(S.ctrl, 0)
  return "pc=" .. hx(sdk(SVC_EXIT)) .. " sp=" .. hx(S.stackTop)
end)

step(6, "create", function()
  -- svcCreateThread(out=ctrl, entry=longjmp, arg=frame, stackTop, prio, core)
  -- 6 args: test whether call_deep forwards x5 (core). A dropped x5 -> 0xe001.
  S.createResults = {}
  S.core = nil
  for _, core in ipairs(S.cores) do
    N.poke(S.ctrl, 0)
    local r = N.call_deep(sdk(SVC_CREATE), S.ctrl, sdk(LONGJMP), S.frameA, S.stackTop, S.prio, core)
    S.createResults[#S.createResults+1] = core .. ":" .. hx(r)
    if r == 0 then S.core = core; S.handle = rd32(S.ctrl); break end
  end
  assert(S.core ~= nil, "no core accepted svcCreateThread; results=" ..
    table.concat(S.createResults, " "))
  assert(S.handle and S.handle > 0 and S.handle < 0xffff8000, "bad handle: " .. hx(S.handle or 0))
  return "core=" .. S.core .. " handle=" .. hx(S.handle) .. " tried=" .. table.concat(S.createResults, " ")
end)

step(7, "start", function()
  local r = N.call_deep(sdk(SVC_START), S.handle, 0, 0, 0, 0)
  assert(r == 0, "svcStartThread failed: " .. hx(r))
  return "started"
end)

step(8, "join", function()
  N.poke(S.ctrl + 0x08, 0)
  N.poke(S.ctrl + 0x10, S.handle)
  -- svcWaitSynchronization(out_index @ x0, handles @ x1, count=1, timeout_ns)
  local r = N.call_deep(sdk(SVC_WAITSYN), S.ctrl + 0x08, S.ctrl + 0x10, 1, WAIT_NS, 0)
  S.waitIndex = rd32(S.ctrl + 0x08)
  assert(r == 0, "svcWaitSynchronization failed: " .. hx(r))
  return "wait=0 index=" .. S.waitIndex
end)

step(9, "close", function()
  local r = N.call_deep(sdk(SVC_CLOSE), S.handle, 0, 0, 0, 0)
  assert(r == 0, "svcCloseHandle failed: " .. hx(r))
  -- (probe leaks its page-aligned buffers on purpose; re-arm reclaims them)
  return "PHASE-A PASS: raw kernel thread created/started/joined/closed"
end)

print("phaseA bound=" .. STOP .. " reached end")
