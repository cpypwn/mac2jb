-- Phase C.3: clean fsp-srv round-trip via TLS-slot REUSE across two single-call
-- threads (reuses the proven Phase-B frame; no multi-call chain).
--   T1: frame target = get_message_buffer_on_tls -> reports its TLS base, exits.
--   Main: stage the CMIF request directly into that TLS address.
--   T2: frame target = svcSendSyncRequest (TLS variant, svc 0x21, x0=handle).
--       If T2 reuses T1's freed TLS slot, the request is already there.
--
--   nora_debug.py <host> phaseC_tls_reuse_seedsow.lua --max 9
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")

local LONGJMP,LOADTABLE,CALL4,SAVERES64,SVC_EXIT = 0x5511B4,0x4E094,0x359b88,0x19bcc0,0x168B4C
local SVC_CREATE,SVC_START,SVC_WAIT,SVC_CLOSE,GET_PRIO = 0x168B2C,0x168B44,0x168BF4,0x168BE4,0x168B5C
local GET_SERVICE,GET_TLS,SEND_SYNC = 0x14CC90,0x14BA80,0x168C4C
local CUR_THREAD,STACK_BYTES = 0xFFFF8000,0x14000
local RESULT,TABLES,FRAME_STACK,FRAME_BYTES = 0x800,0x1000,0x12000,0x17000
local WAIT_NS,SFCO = 0x77359400,0x4f434653

local function hx(v) return string.format("0x%x", v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(o) return N.sdk_base + o end
local function pagealign(r) return r + 0xFFF - (r + 0xFFF) % 0x1000 end
local S = {}
local function step(n, name, fn) if n > STOP then return end local r = fn() print(string.format("STEP %d OK %s %s", n, name, r or "")) end

-- Build+run a single-call worker: target(x0=a0,x1=a1,x2=a2,x3=a3), store x0 to frame+RESULT.
-- Returns (svc/returnValue stored, thread joined?). frame/stack buffers passed in.
local function runcall(frame, stack, ctrl, prio, target, a0, a1, a2, a3)
  for off=0,0xB0,8 do N.poke(frame+off,0) end
  N.poke(frame+0x10, frame+TABLES)
  N.poke(frame+0x30, a0)                     -- x0
  N.poke(frame+0x58, sdk(LOADTABLE))
  N.poke(frame+0x68, frame+FRAME_STACK)
  N.poke(frame+TABLES, frame+TABLES+0x10)
  N.poke(frame+TABLES+0x80, sdk(target))
  N.poke(frame+RESULT, 0)
  local sp = frame+FRAME_STACK
  N.poke(sp+0x08, sdk(CALL4))
  N.poke(sp+0x10, a1)                        -- x1
  N.poke(sp+0x20, a2)                        -- x2
  N.poke(sp+0x28, a3)                        -- x3
  N.poke(sp+0xd8, sdk(SAVERES64))
  N.poke(sp+0x118, frame+RESULT)
  N.poke(sp+0x128, sdk(SVC_EXIT))
  N.poke(ctrl, 0)
  local cr = N.call_deep(sdk(SVC_CREATE), ctrl, sdk(LONGJMP), frame, stack+STACK_BYTES, prio, 0)
  assert(cr==0, "create failed "..hx(cr))
  local th = rd32(ctrl)
  assert(N.call_deep(sdk(SVC_START), th, 0,0,0,0)==0, "start failed")
  N.poke(ctrl+0x08, 0); N.poke(ctrl+0x10, th)
  local jr = N.call_deep(sdk(SVC_WAIT), ctrl+0x08, ctrl+0x10, 1, WAIT_NS, 0)
  local res = N.peek(frame+RESULT)
  N.call_deep(sdk(SVC_CLOSE), th, 0,0,0,0)
  return res, jr, th
end

step(1,"env",function() assert(N.sdk_base~=0) return "sdk="..hx(N.sdk_base) end)
step(2,"alloc",function()
  S.ctrl=pagealign(N.alloc(0x2000))
  S.f1=pagealign(N.alloc(FRAME_BYTES+0x1000)); S.s1=pagealign(N.alloc(STACK_BYTES+0x1000))
  S.f2=pagealign(N.alloc(FRAME_BYTES+0x1000)); S.s2=pagealign(N.alloc(STACK_BYTES+0x1000))
  S.np=N.alloc(0x200)
  return "ok" end)
step(3,"get-fsp-handle",function()
  local b=S.np-S.np%16; N.write_bytes(b,"fsp-srv\0"); N.poke(b+0x40,0)
  local res=N.call_deep(sdk(GET_SERVICE),b+0x40,b,7,0,0); S.handle=rd32(b+0x40)
  assert(res==0 and S.handle~=0,"GetServiceHandle failed"); return "handle="..hx(S.handle) end)
step(4,"borrow-prio",function()
  N.poke(S.ctrl,0); local r=N.call_deep(sdk(GET_PRIO),S.ctrl+0x20,CUR_THREAD,0,0,0)
  local p=(r==0) and rd32(S.ctrl+0x20) or 0; if not(p>0 and p<64) then p=44 end; S.prio=p; return "prio="..p end)
step(5,"T1-get-tls",function()
  local tls,jr = runcall(S.f1, S.s1, S.ctrl, S.prio, GET_TLS, 0,0,0,0)
  assert(jr==0, "T1 join failed "..hx(jr)); S.tls = tls
  assert(S.tls~=0, "TLS came back 0"); return "T1 TLS="..hx(S.tls) end)
step(6,"stage-request-in-TLS",function()
  -- zero the IPC region then write GetGlobalAccessLogMode (cmd 1006) request
  for o=0,0xF8,8 do N.poke(S.tls+o,0) end
  local req = "\4\0\0\0" .. "\8\0\0\0" .. string.rep("\0",8) ..
              "SFCI" .. "\0\0\0\0" .. "\238\3\0\0" .. "\0\0\0\0"
  N.write_bytes(S.tls, req)
  return "staged at TLS; SFCI@0x10="..hx(rd32(S.tls+0x10)) end)
step(7,"T2-send-BLOCKING",function()
  -- svcSendSyncRequest (svc 0x21): x0 = session handle; message in T2's TLS
  local res,jr,th = runcall(S.f2, S.s2, S.ctrl, S.prio, SEND_SYNC, S.handle,0,0,0)
  S.svc = res; S.t2join = jr
  if jr~=0 then return "T2 JOIN "..hx(jr).." (hang)" end
  return "T2 joined; svcSendSyncRequest="..hx(res) end)
step(8,"check-tls-reused",function()
  -- did T2 get T1's slot? the reply (if any) would be in S.tls
  local w0 = rd32(S.tls); return "TLS buf+0 now="..hx(w0).." (reply type=0 if answered)" end)
step(9,"verify-reply",function()
  local pos=nil; for off=0,0x40,4 do if rd32(S.tls+off)==SFCO then pos=S.tls+off; break end end
  if not pos then local d={}; for o=0,0x30,4 do d[#d+1]=hx(rd32(S.tls+o)) end
    return "svc="..hx(S.svc).." no SFCO in TLS; reply="..table.concat(d," ") end
  local cmif=rd32(pos+8); local mode=rd32(pos+16)
  return "svc="..hx(S.svc).." SFCO@+"..hx(pos-S.tls).." cmif="..hx(cmif).." mode="..hx(mode)..
    ((S.svc==0 and cmif==0) and "  *** CLEAN fsp-srv ROUND-TRIP ON A REAL THREAD ***" or "") end)
print("phaseC3 bound="..STOP.." reached end")
