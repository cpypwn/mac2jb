-- Phase D validation: prove the ported multi-call worker frame chains on HW.
-- Runs a 2-call STATIC chain on one raw-svc thread: get_tls ; get_tls.
-- Both result slots must equal the thread's TLS base -> chaining works.
--   nora_debug.py <host> phaseD_validate_seedsow.lua --max 6
local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")
local LONGJMP,SVC_CREATE,SVC_START,SVC_WAIT,SVC_CLOSE,GET_PRIO = 0x5511B4,0x168B2C,0x168B44,0x168BF4,0x168BE4,0x168B5C
local GET_TLS,CUR_THREAD,STACK_BYTES,WAIT_NS = 0x14BA80,0xFFFF8000,0x14000,0x77359400
local function hx(v) return string.format("0x%x", v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdkn(o) return N.sdk_base + o end

-- ---- ported frames.cjs build() with current-build offsets ----
local function build_worker(base, calls)
  local STEP,RESULT,PAGE = 0x140,0x800,0x1000
  local LOADTABLE,CALL4,SAVERES64,EXIT,MEMMOVE,LOADSELF = 0x4E094,0x359b88,0x19bcc0,0x168B4C,0x522830,112
  local function sdk(o) return N.sdk_base+o end
  local function align(v) return math.ceil(v/PAGE)*PAGE end
  local expanded,patches = {},{}
  for _,call in ipairs(calls) do
    local loads = {}
    for i=1,4 do local a=call.args[i]
      if type(a)=="table" and a.dyn then loads[#loads+1]={argument=i-1,loadidx=#expanded}
        expanded[#expanded+1]={fn=MEMMOVE,args={0,a.dyn,8,0}} end end
    local target=#expanded
    for _,l in ipairs(loads) do l.target=target; patches[#patches+1]=l end
    local s={} for i=1,4 do local a=call.args[i]; s[i]=(type(a)=="table") and 0 or a end
    expanded[#expanded+1]={fn=call.fn,args=s}
  end
  local count=#expanded
  local tables=align(RESULT+count*8)
  local stack=align(tables+count*0x100)+0x10000
  local size=align(stack+count*STEP+0x4000)
  for _,p in ipairs(patches) do
    local slot
    if p.argument==0 then slot=(p.target==0) and 0x30 or (stack+(p.target-1)*STEP+0xe8)
    else slot=stack+p.target*STEP+({[1]=0x10,[2]=0x20,[3]=0x28})[p.argument] end
    expanded[p.loadidx+1].args[1]=base+slot
  end
  local function put(o,v) N.poke(base+o,v) end
  -- targeted zeroing (jmp_buf, results, tables, stack frames)
  for o=0,0x200,8 do put(o,0) end
  for o=RESULT,RESULT+count*8,8 do put(o,0) end
  for o=tables,tables+count*0x100,8 do put(o,0) end
  for o=stack,stack+count*STEP+0x200,8 do put(o,0) end
  put(0x10,base+tables); put(0x30,expanded[1].args[1]); put(0x58,sdk(LOADTABLE)); put(0x68,base+stack)
  for idx=0,count-1 do
    local call=expanded[idx+1]
    local tb,sp=tables+idx*0x100,stack+idx*STEP
    put(tb,base+tb+0x10); put(tb+0x10+LOADSELF,sdk(call.fn)); put(RESULT+idx*8,0)
    put(sp+8,sdk(CALL4)); put(sp+0x10,call.args[2]); put(sp+0x20,call.args[3]); put(sp+0x28,call.args[4])
    put(sp+0xd8,sdk(SAVERES64)); put(sp+0x118,base+RESULT+idx*8)
    if idx+1<count then put(sp+0x108,base+tables+(idx+1)*0x100); put(sp+0xe8,expanded[idx+2].args[1]); put(sp+0x128,sdk(LOADTABLE))
    else put(sp+0x128,sdk(EXIT)) end
  end
  local resOff={} for i=0,count-1 do resOff[i+1]=RESULT+i*8 end
  return {resOff=resOff,stack=stack,tables=tables,size=size,count=count}
end
-- ----

local S={}
local function step(n,name,fn) if n>STOP then return end print(string.format("STEP %d OK %s %s",n,name,fn() or "")) end

step(1,"env",function() assert(N.sdk_base~=0) return "sdk="..hx(N.sdk_base) end)
step(2,"alloc",function()
  S.ctrl=(N.alloc(0x2000)); S.ctrl=S.ctrl+0xFFF-(S.ctrl+0xFFF)%0x1000
  local f=N.alloc(0x40000); S.frame=f+0xFFF-(f+0xFFF)%0x1000
  local s=N.alloc(STACK_BYTES+0x1000); S.stack=s+0xFFF-(s+0xFFF)%0x1000
  return "frame="..hx(S.frame) end)
step(3,"borrow-prio",function()
  N.poke(S.ctrl,0); local r=N.call_deep(sdkn(GET_PRIO),S.ctrl+0x20,CUR_THREAD,0,0,0)
  local p=(r==0) and rd32(S.ctrl+0x20) or 0; if not(p>0 and p<64) then p=44 end; S.prio=p; return "prio="..p end)
step(4,"build-2call",function()
  -- call0: get_tls -> res1 (base+0x800). call1: memmove(base+0x900, base+0x800, 8)
  S.lay = build_worker(S.frame, {
    {fn=GET_TLS, args={0,0,0,0}},
    {fn=0x522830, args={S.frame+0x900, S.frame+0x800, 8, 0}},  -- memmove(dst,src,8)
  })
  return "count="..S.lay.count end)
step(5,"create-start-join",function()
  N.poke(S.frame+0x30,0)  -- first call x0 (get_tls ignores)
  N.poke(S.ctrl,0)
  local cr=N.call_deep(sdkn(SVC_CREATE),S.ctrl,sdkn(LONGJMP),S.frame,S.stack+STACK_BYTES,S.prio,0)
  assert(cr==0,"create failed "..hx(cr)); S.th=rd32(S.ctrl)
  assert(N.call_deep(sdkn(SVC_START),S.th,0,0,0,0)==0,"start failed")
  N.poke(S.ctrl+0x08,0); N.poke(S.ctrl+0x10,S.th)
  local jr=N.call_deep(sdkn(SVC_WAIT),S.ctrl+0x08,S.ctrl+0x10,1,WAIT_NS,0)
  N.call_deep(sdkn(SVC_CLOSE),S.th,0,0,0,0)
  if jr~=0 then return "JOIN "..hx(jr).." (hang)" end
  return "joined idx="..rd32(S.ctrl+0x08) end)
step(6,"verify",function()
  local r={} for i=1,S.lay.count do r[i]=hx(N.peek(S.frame+S.lay.resOff[i])) end
  local diag = N.peek(S.frame+0x900)
  return "results: "..table.concat(r," ").." | memmove-dst[0x900]="..hx(diag) end)
step(7,"dump-call1-slots",function()
  local T=S.lay.tables; local ST=S.lay.stack
  -- call0 continuation slots (SP_0=stack): next-table@+0x108, next-x0@+0xe8, cont@+0x128
  -- call1 table region (tables+0x100): self-ptr@+0, target@+0x80
  return "c0.nexttable[+0x108]="..hx(N.peek(S.frame+ST+0x108))..
         " c0.nextx0[+0xe8]="..hx(N.peek(S.frame+ST+0xe8))..
         " c0.cont[+0x128]="..hx(N.peek(S.frame+ST+0x128))..
         " | c1.tbl[+0x"..string.format("%x",T+0x100).."]="..hx(N.peek(S.frame+T+0x100))..
         " c1.tgt[+0x"..string.format("%x",T+0x180).."]="..hx(N.peek(S.frame+T+0x180))..
         " | loadTable="..hx(sdkn(0x4E094)).." get_tls="..hx(sdkn(0x14BA80)) end)
print("phaseD bound="..STOP.." reached end")
