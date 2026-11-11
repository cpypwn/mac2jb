-- Concurrency test: create N raw-svc threads that each sleep 1s, start them all,
-- then join all. If they run concurrently the whole thing takes ~1s; if the
-- scheduler serializes them it takes ~N s. The PC times the /eval.
-- Each thread also records its TLS (proof it ran) via get_tls.
local N = assert(_G.n2h, "n2h not initialized")
local LONGJMP,CREATE,START,WAIT,CLOSE,GETPRIO = 0x5511B4,0x168B2C,0x168B44,0x168BF4,0x168BE4,0x168B5C
local GETTLS,SLEEP_THREAD,EXITT = 0x14BA80,0x168B54,0x168B4C
local LOADTABLE,CALL4,SAVERES64 = 0x4E094,0x359b88,0x19bcc0
local CUR_THREAD = 0xFFFF8000
local SLEEP_NS = 1000000000  -- 1s
local NTHREADS = 4
local function hx(v) return string.format("0x%x",v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(o) return N.sdk_base+o end
local function pa(a) return a+0xFFF-(a+0xFFF)%0x1000 end

-- minimal 2-call worker frame: get_tls (res0=TLS) -> svc_sleep_thread(ns) -> exit
local function build(base, sleepns)
  local STEP,RESULT=0x140,0x800
  local calls={{fn=GETTLS,a={0,0,0,0}},{fn=SLEEP_THREAD,a={sleepns,0,0,0}}}
  local count=#calls
  local tables=0x1000; local stack=0x12000
  local function put(o,v) N.poke(base+o,v) end
  for o=0,0x200,8 do put(o,0) end
  for o=RESULT,RESULT+count*8,8 do put(o,0) end
  for o=tables,tables+count*0x100,8 do put(o,0) end
  for o=stack,stack+count*STEP+0x200,8 do put(o,0) end
  put(0x10,base+tables); put(0x30,0); put(0x58,sdk(LOADTABLE)); put(0x68,base+stack)
  for idx=0,count-1 do local c=calls[idx+1]; local tb,sp=tables+idx*0x100,stack+idx*STEP
    put(tb,base+tb+0x10); put(tb+0x10+112,sdk(c.fn)); put(RESULT+idx*8,0)
    put(sp+8,sdk(CALL4)); put(sp+0x10,c.a[2]); put(sp+0x20,c.a[3]); put(sp+0x28,c.a[4])
    put(sp+0xd8,sdk(SAVERES64)); put(sp+0x118,base+RESULT+idx*8)
    if idx+1<count then put(sp+0x108,base+tables+(idx+1)*0x100); put(sp+0xe8,calls[idx+2].a[1]); put(sp+0x128,sdk(LOADTABLE))
    else put(sp+0x128,sdk(EXITT)) end
  end
  return RESULT
end

local ctrl=pa(N.alloc(0x2000))
-- borrow priority
N.poke(ctrl,0)
local pr=N.call_deep(sdk(GETPRIO),ctrl+0x20,CUR_THREAD,0,0,0)
local prio=(pr==0) and rd32(ctrl+0x20) or 44; if not(prio>0 and prio<64) then prio=44 end

local frames,stacks,handles={},{},{}
for i=1,NTHREADS do
  frames[i]=pa(N.alloc(0x20000)); stacks[i]=pa(N.alloc(0x15000))
  build(frames[i], SLEEP_NS)
end
-- create + start ALL threads (no join between)
for i=1,NTHREADS do
  local c=ctrl+0x100*i  -- separate out-handle slot per thread
  N.poke(c,0)
  local cr=N.call_deep(sdk(CREATE),c,sdk(LONGJMP),frames[i],stacks[i]+0x14000,prio,0)
  assert(cr==0,"create "..i.." failed "..hx(cr))
  handles[i]=rd32(c)
  assert(N.call_deep(sdk(START),handles[i],0,0,0,0)==0,"start "..i.." failed")
end
print("started "..NTHREADS.." threads (each sleeps 1s)")
-- join all
for i=1,NTHREADS do
  N.poke(ctrl+0x08,0); N.poke(ctrl+0x10,handles[i])
  local jr=N.call_deep(sdk(WAIT),ctrl+0x08,ctrl+0x10,1,0x4000000000,0)  -- generous timeout
  print(string.format("thread %d joined jr=%s TLS=%s", i, hx(jr), hx(N.peek(frames[i]+0x800))))
  N.call_deep(sdk(CLOSE),handles[i],0,0,0,0)
end
print("CONC-TEST DONE")
