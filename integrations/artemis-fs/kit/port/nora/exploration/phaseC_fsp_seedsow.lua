-- Phase C: issue a BLOCKING fsp-srv IPC on the raw-svc thread. The same
-- svcSendSyncRequestWithUserBuffer hangs from the forged call_deep/main context
-- (fsp_roundtrip2.lua); here the Phase-B worker frame runs it on a REAL thread
-- that can block/resume. If it completes, blocking IPC is unblocked.
--
--   nora_debug.py <host> phaseC_fsp_seedsow.lua --max 9
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")

local LONGJMP   = 0x5511B4
local LOADTABLE = 0x4E094
local CALL4     = 0x359b88    -- current console build
local SAVERES64 = 0x19bcc0
local SVC_EXIT  = 0x168B4C
local SVC_CREATE, SVC_START, SVC_WAIT, SVC_CLOSE = 0x168B2C, 0x168B44, 0x168BF4, 0x168BE4
local GET_PRIO  = 0x168B5C
local GET_SERVICE   = 0x14CC90   -- nn::sm::GetServiceHandle
local SEND_SYNC_USER= 0x168C54   -- svcSendSyncRequestWithUserBuffer
local CUR_THREAD = 0xFFFF8000
local STACK_BYTES = 0x14000
local RESULT, TABLES, FRAME_STACK, FRAME_BYTES = 0x800, 0x1000, 0x12000, 0x17000
local WAIT_NS = 0x77359400
local IPC_SIZE = 0x1000
local SFCO = 0x4f434653

local function hx(v) return string.format("0x%x", v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(o) return N.sdk_base + o end
local function pagealign(r) return r + 0xFFF - (r + 0xFFF) % 0x1000 end
local S = {}
local function step(n, name, fn) if n > STOP then return end local r = fn() print(string.format("STEP %d OK %s %s", n, name, r or "")) end

step(1, "env", function() assert(N.sdk_base~=0) return "sdk="..hx(N.sdk_base) end)

step(2, "alloc", function()
  S.ctrl   = pagealign(N.alloc(0x2000))
  S.frameB = pagealign(N.alloc(FRAME_BYTES + 0x1000))
  S.stackB = pagealign(N.alloc(STACK_BYTES + 0x1000))
  S.np     = N.alloc(0x200)                      -- service-name scratch
  S.buf    = pagealign(N.alloc(0x3000)) + 0x1000 -- page-aligned IPC buffer
  assert(S.ctrl~=0 and S.frameB~=0 and S.stackB~=0 and S.buf~=0, "alloc failed")
  S.stackTop = S.stackB + STACK_BYTES
  return "buf="..hx(S.buf)
end)

step(3, "get-fsp-handle", function()
  local b = S.np - S.np % 16
  N.write_bytes(b, "fsp-srv\0")
  N.poke(b + 0x40, 0)
  local res = N.call_deep(sdk(GET_SERVICE), b + 0x40, b, 7, 0, 0)
  S.handle = rd32(b + 0x40)
  assert(res == 0 and S.handle ~= 0, "GetServiceHandle failed res="..hx(res).." h="..hx(S.handle))
  return "fsp-srv handle="..hx(S.handle)
end)

step(4, "stage-request", function()
  for o = 0, IPC_SIZE - 8, 8 do N.poke(S.buf + o, 0) end
  -- CMIF Request: hipc type=4, 8 data-words; SFCI + cmd 1006 GetGlobalAccessLogMode
  local req = "\4\0\0\0" .. "\8\0\0\0" .. string.rep("\0", 8) ..
              "SFCI" .. "\0\0\0\0" .. "\238\3\0\0" .. "\0\0\0\0"
  N.write_bytes(S.buf, req)
  return "cmd=1006 buf+4="..hx(rd32(S.buf+4))
end)

step(5, "borrow-prio", function()
  N.poke(S.ctrl, 0)
  local r = N.call_deep(sdk(GET_PRIO), S.ctrl+0x20, CUR_THREAD, 0,0,0)
  local p = (r==0) and rd32(S.ctrl+0x20) or 0
  if not (p>0 and p<64) then p=44 end
  S.prio = p; return "prio="..p
end)

step(6, "build-frame", function()
  local f = S.frameB
  for off = 0, 0xB0, 8 do N.poke(f + off, 0) end
  -- target(x0=[f+0x30], x1=[sp+0x10], x2=[sp+0x20], x3=[sp+0x28]); target=[f+TABLES+0x80]
  N.poke(f + 0x10, f + TABLES)
  N.poke(f + 0x30, S.buf)                 -- x0 = user buffer
  N.poke(f + 0x58, sdk(LOADTABLE))
  N.poke(f + 0x68, f + FRAME_STACK)
  N.poke(f + TABLES, f + TABLES + 0x10)
  N.poke(f + TABLES + 0x80, sdk(SEND_SYNC_USER))   -- target
  N.poke(f + RESULT, 0x1234)              -- result sentinel
  local sp = f + FRAME_STACK
  N.poke(sp + 0x08, sdk(CALL4))
  N.poke(sp + 0x10, IPC_SIZE)             -- x1 = size
  N.poke(sp + 0x20, S.handle)             -- x2 = session handle
  N.poke(sp + 0x28, 0)                    -- x3
  N.poke(sp + 0xd8, sdk(SAVERES64))
  N.poke(sp + 0x118, f + RESULT)
  N.poke(sp + 0x128, sdk(SVC_EXIT))
  return "target=svcSendSyncRequestWithUserBuffer"
end)

step(7, "create", function()
  N.poke(S.ctrl, 0)
  local cr = N.call_deep(sdk(SVC_CREATE), S.ctrl, sdk(LONGJMP), S.frameB, S.stackTop, S.prio, 0)
  assert(cr==0, "svcCreateThread failed: "..hx(cr))
  S.thandle = rd32(S.ctrl)
  assert(S.thandle>0 and S.thandle<0xffff8000, "bad handle")
  return "thread="..hx(S.thandle)
end)

step(8, "start-join-BLOCKING-SEND", function()
  local r = N.call_deep(sdk(SVC_START), S.thandle, 0,0,0,0)
  assert(r==0, "start failed: "..hx(r))
  N.poke(S.ctrl+0x08, 0); N.poke(S.ctrl+0x10, S.thandle)
  local jr = N.call_deep(sdk(SVC_WAIT), S.ctrl+0x08, S.ctrl+0x10, 1, WAIT_NS, 0)
  S.svcResult = N.peek(S.frameB + RESULT)
  if jr ~= 0 then return "JOIN r="..hx(jr).." (0xea01=timeout: send still HANGS on the thread)" end
  return "joined; svcSendSyncRequest result="..hx(S.svcResult)
end)

step(9, "verify-reply", function()
  N.call_deep(sdk(SVC_CLOSE), S.thandle, 0,0,0,0)
  local pos = nil
  for off = 0, 0x40, 4 do if rd32(S.buf + off) == SFCO then pos = S.buf + off; break end end
  if not pos then
    local dump = {}
    for off = 0, 0x20, 4 do dump[#dump+1] = hx(rd32(S.buf+off)) end
    return "no SFCO; svcResult="..hx(S.svcResult or 0).." reply="..table.concat(dump, " ")
  end
  local cmif, mode = rd32(pos + 8), rd32(pos + 16)
  local ok = (S.svcResult == 0 and cmif == 0)
  return "SFCO@+"..hx(pos-S.buf).." cmif="..hx(cmif).." accessLogMode="..hx(mode)..
    (ok and "  *** BLOCKING fsp-srv IPC ON A REAL THREAD WORKS ***" or "")
end)

print("phaseC bound="..STOP.." reached end")
