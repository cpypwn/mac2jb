-- Phase C.2: initialize the fsp-srv session via SetCurrentProcess (cmd 1 with
-- a HIPC send-pid descriptor) on the raw-svc thread. If svc result 0 and SFCO
-- result 0, we have a WORKING, initialized fs IPC channel on a real thread --
-- the gateway to every fs command (and the fs-bug stage-2).
--
-- Packet layout mirrors the engine's shared/ipc.cjs packet(cmd=1,{pid:true}):
--   w0=4 ; w1=ceil((32+8)/4)=10 | 0x80000000 ; w2=1(send_pid) ;
--   pid placeholder(8) ; align->0x20 ; SFCI@0x20 ; cmd(1)@0x28 ; input u64(0)@0x30
--
--   nora_debug.py <host> phaseC_setcurproc_seedsow.lua --max 9
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")

local LONGJMP,LOADTABLE,CALL4,SAVERES64,SVC_EXIT = 0x5511B4,0x4E094,0x359b88,0x19bcc0,0x168B4C
local SVC_CREATE,SVC_START,SVC_WAIT,SVC_CLOSE,GET_PRIO = 0x168B2C,0x168B44,0x168BF4,0x168BE4,0x168B5C
local GET_SERVICE,SEND_SYNC_USER = 0x14CC90,0x168C54
local CUR_THREAD,STACK_BYTES = 0xFFFF8000,0x14000
local RESULT,TABLES,FRAME_STACK,FRAME_BYTES = 0x800,0x1000,0x12000,0x17000
local WAIT_NS,IPC_SIZE,SFCO = 0x77359400,0x1000,0x4f434653

local function hx(v) return string.format("0x%x", v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(o) return N.sdk_base + o end
local function pagealign(r) return r + 0xFFF - (r + 0xFFF) % 0x1000 end
local S = {}
local function step(n, name, fn) if n > STOP then return end local r = fn() print(string.format("STEP %d OK %s %s", n, name, r or "")) end

step(1,"env",function() assert(N.sdk_base~=0) return "sdk="..hx(N.sdk_base) end)
step(2,"alloc",function()
  S.ctrl=pagealign(N.alloc(0x2000)); S.frameB=pagealign(N.alloc(FRAME_BYTES+0x1000))
  S.stackB=pagealign(N.alloc(STACK_BYTES+0x1000)); S.np=N.alloc(0x200)
  S.buf=pagealign(N.alloc(0x3000))+0x1000; S.stackTop=S.stackB+STACK_BYTES
  assert(S.ctrl~=0 and S.frameB~=0 and S.buf~=0,"alloc failed"); return "buf="..hx(S.buf) end)
step(3,"get-fsp-handle",function()
  local b=S.np-S.np%16; N.write_bytes(b,"fsp-srv\0"); N.poke(b+0x40,0)
  local res=N.call_deep(sdk(GET_SERVICE),b+0x40,b,7,0,0); S.handle=rd32(b+0x40)
  assert(res==0 and S.handle~=0,"GetServiceHandle failed"); return "handle="..hx(S.handle) end)
step(4,"stage-SetCurrentProcess",function()
  for o=0,IPC_SIZE-8,8 do N.poke(S.buf+o,0) end
  -- w0=4, w1=0x8000000A, w2=1(send_pid), pid(8), pad->0x20, SFCI, token, cmd=1, input u64(0)
  local req = "\4\0\0\0" .. "\10\0\0\128" .. "\1\0\0\0" .. string.rep("\0",8)
           .. string.rep("\0",12) .. "SFCI" .. "\0\0\0\0" .. "\1\0\0\0" .. "\0\0\0\0"
           .. string.rep("\0",8)
  N.write_bytes(S.buf, req)
  return "w1="..hx(rd32(S.buf+4)).." SFCI@0x20="..hx(rd32(S.buf+0x20)).." cmd@0x28="..hx(rd32(S.buf+0x28)) end)
step(5,"borrow-prio",function()
  N.poke(S.ctrl,0); local r=N.call_deep(sdk(GET_PRIO),S.ctrl+0x20,CUR_THREAD,0,0,0)
  local p=(r==0) and rd32(S.ctrl+0x20) or 0; if not(p>0 and p<64) then p=44 end; S.prio=p; return "prio="..p end)
step(6,"build-frame",function()
  local f=S.frameB; for off=0,0xB0,8 do N.poke(f+off,0) end
  N.poke(f+0x10,f+TABLES); N.poke(f+0x30,S.buf); N.poke(f+0x58,sdk(LOADTABLE)); N.poke(f+0x68,f+FRAME_STACK)
  N.poke(f+TABLES,f+TABLES+0x10); N.poke(f+TABLES+0x80,sdk(SEND_SYNC_USER)); N.poke(f+RESULT,0x1234)
  local sp=f+FRAME_STACK
  N.poke(sp+0x08,sdk(CALL4)); N.poke(sp+0x10,IPC_SIZE); N.poke(sp+0x20,S.handle); N.poke(sp+0x28,0)
  N.poke(sp+0xd8,sdk(SAVERES64)); N.poke(sp+0x118,f+RESULT); N.poke(sp+0x128,sdk(SVC_EXIT))
  return "target=send_sync_user handle="..hx(S.handle) end)
step(7,"create",function()
  N.poke(S.ctrl,0); local cr=N.call_deep(sdk(SVC_CREATE),S.ctrl,sdk(LONGJMP),S.frameB,S.stackTop,S.prio,0)
  assert(cr==0,"create failed: "..hx(cr)); S.th=rd32(S.ctrl); assert(S.th>0 and S.th<0xffff8000,"bad handle")
  return "thread="..hx(S.th) end)
step(8,"BLOCKING-SEND",function()
  local r=N.call_deep(sdk(SVC_START),S.th,0,0,0,0); assert(r==0,"start failed")
  N.poke(S.ctrl+0x08,0); N.poke(S.ctrl+0x10,S.th)
  local jr=N.call_deep(sdk(SVC_WAIT),S.ctrl+0x08,S.ctrl+0x10,1,WAIT_NS,0)
  S.svc=N.peek(S.frameB+RESULT)
  if jr~=0 then return "JOIN "..hx(jr).." (timeout=hang)" end
  return "joined; svcSendSyncRequest="..hx(S.svc) end)
step(9,"verify",function()
  N.call_deep(sdk(SVC_CLOSE),S.th,0,0,0,0)
  local pos=nil; for off=0,0x40,4 do if rd32(S.buf+off)==SFCO then pos=S.buf+off; break end end
  if not pos then local d={}; for o=0,0x30,4 do d[#d+1]=hx(rd32(S.buf+o)) end
    return "svc="..hx(S.svc).." no SFCO; reply="..table.concat(d," ") end
  local cmif=rd32(pos+8)
  return "svc="..hx(S.svc).." SFCO@+"..hx(pos-S.buf).." cmif_result="..hx(cmif)..
    ((S.svc==0 and cmif==0) and "  *** fsp-srv SESSION INITIALIZED on a real thread ***" or "") end)
print("phaseC2 bound="..STOP.." reached end")
