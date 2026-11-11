-- Phase B (CORRECT port): run ONE native call on a raw-svc thread using the
-- Civ7 probe's HW-proven worker frame (loadTable -> call4 -> target ->
-- saveResult64 -> svcExitThread), all SDK-relative gadgets. The RE showed
-- "Seedsow"/"Ounce" IS Civ7 and nora shares Civ7's sdk (longjmp/svc offsets
-- identical), so these sdk gadgets are valid here -- unlike worker_probe's
-- stale MAIN-module pivot/call2.
--
-- The thread longjmps into sdk+loadTable, which drives a frame that calls
-- memmove(dst=ctrl+0x20, src=ctrl+0x28, 8); saveResult64 stores the return;
-- svcExitThread. We verify dst==src-value and result==dst.
--
--   nora_debug.py <host> phaseB_civ7frame_seedsow.lua --max 7
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")

-- sdk gadget offsets (Civ7 probe; nora shares this sdk)
local LONGJMP   = 0x5511B4
local LOADTABLE = 0x4E094
local CALL4     = 0x359b88
local SAVERES64 = 0x19bcc0
local MEMMOVE   = 0x522830
local SVC_EXIT  = 0x168B4C
local SVC_CREATE, SVC_START, SVC_WAIT, SVC_CLOSE = 0x168B2C, 0x168B44, 0x168BF4, 0x168BE4
local GET_PRIO  = 0x168B5C
local CUR_THREAD = 0xFFFF8000

local STACK_BYTES = 0x14000
local RESULT, TABLES, FRAME_STACK, FRAME_BYTES = 0x800, 0x1000, 0x12000, 0x17000
local WAIT_NS = 0x77359400
-- sentinels kept < 2^53 so Lua doubles represent them exactly (poke/peek precise)
local EXPECTED = 0xc0ffee123456
local SENTINEL = 0xfedcba98

local function hx(v) return string.format("0x%x", v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(o) return N.sdk_base + o end
local function pagealign(r) return r + 0xFFF - (r + 0xFFF) % 0x1000 end
local S = {}
local function step(n, name, fn) if n > STOP then return end local r = fn() print(string.format("STEP %d OK %s %s", n, name, r or "")) end

step(1, "env", function() assert(N.sdk_base~=0,"no sdk") return "sdk="..hx(N.sdk_base) end)

step(2, "alloc", function()
  S.ctrl   = pagealign(N.alloc(0x2000))
  S.frameB = pagealign(N.alloc(FRAME_BYTES + 0x1000))
  S.stackB = pagealign(N.alloc(STACK_BYTES + 0x1000))
  assert(S.ctrl~=0 and S.frameB~=0 and S.stackB~=0, "alloc failed")
  S.stackTop = S.stackB + STACK_BYTES
  return "ctrl="..hx(S.ctrl).." frame="..hx(S.frameB)
end)

step(3, "borrow-prio", function()
  N.poke(S.ctrl, 0)
  local r = N.call_deep(sdk(GET_PRIO), S.ctrl+0x20, CUR_THREAD, 0,0,0)
  local p = (r==0) and rd32(S.ctrl+0x20) or 0
  if not (p>0 and p<64) then p=44 end
  S.prio = p; return "prio="..p
end)

step(4, "build-frame", function()
  local f, c = S.frameB, S.ctrl
  -- Zero the longjmp jmp_buf slots (x19..x28 @ +0x00..0x48, x29 @ +0x50, FP
  -- d8-d15 @ +0x70..) so longjmp doesn't load garbage into callee-saved regs
  -- that loadTable/call4 then deref. (Phase A zeroed its jmp_buf; this didn't.)
  for off = 0, 0xB0, 8 do N.poke(f + off, 0) end
  N.poke(f + 0x10, f + TABLES)
  N.poke(f + 0x30, c + 0x20)
  N.poke(f + 0x58, sdk(LOADTABLE))      -- longjmp PC -> loadTable
  N.poke(f + 0x68, f + FRAME_STACK)     -- longjmp sp
  N.poke(f + TABLES, f + TABLES + 0x10)
  N.poke(f + TABLES + 0x80, sdk(MEMMOVE))
  N.poke(f + RESULT, SENTINEL)
  local sp = f + FRAME_STACK
  N.poke(sp + 0x08, sdk(CALL4))
  N.poke(sp + 0x10, c + 0x28)
  N.poke(sp + 0x20, 8)
  N.poke(sp + 0x28, 0)
  N.poke(sp + 0xd8, sdk(SAVERES64))
  N.poke(sp + 0x118, f + RESULT)
  N.poke(sp + 0x128, sdk(SVC_EXIT))
  N.poke(c + 0x20, 0)                    -- memmove dst (observable)
  N.poke(c + 0x28, EXPECTED)             -- memmove src
  return "loadTable="..hx(sdk(LOADTABLE))
end)

step(5, "create", function()
  N.poke(S.ctrl, 0)
  local cr = N.call_deep(sdk(SVC_CREATE), S.ctrl, sdk(LONGJMP), S.frameB, S.stackTop, S.prio, 0)
  assert(cr==0, "svcCreateThread failed: "..hx(cr))
  S.handle = rd32(S.ctrl)
  assert(S.handle>0 and S.handle<0xffff8000, "bad handle: "..hx(S.handle))
  return "handle="..hx(S.handle)
end)

step(6, "start-join", function()
  local r = N.call_deep(sdk(SVC_START), S.handle, 0,0,0,0)
  assert(r==0, "svcStartThread failed: "..hx(r))
  N.poke(S.ctrl+0x08, 0); N.poke(S.ctrl+0x10, S.handle)
  local jr = N.call_deep(sdk(SVC_WAIT), S.ctrl+0x08, S.ctrl+0x10, 1, WAIT_NS, 0)
  assert(jr==0, "join failed: "..hx(jr))
  return "joined idx="..rd32(S.ctrl+0x08)
end)

step(7, "verify", function()
  local dst = N.peek(S.ctrl + 0x20)
  local res = N.peek(S.frameB + RESULT)
  N.call_deep(sdk(SVC_CLOSE), S.handle, 0,0,0,0)
  assert(dst == EXPECTED, "memmove did not run: dst="..hx(dst).." want "..hx(EXPECTED))
  assert(res == S.ctrl + 0x20, "saveResult wrong: "..hx(res).." want "..hx(S.ctrl+0x20))
  return "PHASE-B PASS: worker ran memmove (dst="..hx(dst)..", result="..hx(res)..")"
end)

print("phaseB-civ7 bound="..STOP.." reached end")
