-- Master-sync test: N threads each wait_for_address_eq1_inf(master), then mark
-- (get_tls) and exit. They must BLOCK while master==0 and all RUN after Lua
-- sets master=1 + signals. Proves the synchronized-start the race wave needs.
local N = assert(_G.n2h, "n2h not initialized")
local LONGJMP,CREATE,START,WAIT,CLOSE,GETPRIO = 0x5511B4,0x168B2C,0x168B44,0x168BF4,0x168BE4,0x168B5C
local GETTLS,EXITT,WAIT_EQ1,SIGNAL = 0x14BA80,0x168B4C,0x132784,0x168D24
local LOADTABLE,CALL4,SAVERES64,CUR_THREAD = 0x4E094,0x359b88,0x19bcc0,0xFFFF8000
local NT=4
local function hx(v) return string.format("0x%x",v) end
local function rd32(x) local a=x-x%8 local w=N.peek(a) if x%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local function sdk(o) return N.sdk_base+o end
local function pa(a) return a+0xFFF-(a+0xFFF)%0x1000 end

-- frame: wait_eq1(master) -> get_tls -> exit
local function build(base, master)
  local STEP,RESULT=0x140,0x800
  local calls={{fn=WAIT_EQ1,a={master,0,0,0}},{fn=GETTLS,a={0,0,0,0}}}
  local count=#calls; local tables=0x1000; local stack=0x12000
  local function put(o,v) N.poke(base+o,v) end
  for o=0,0x200,8 do put(o,0) end
  for o=RESULT,RESULT+count*8,8 do put(o,0) end
  for o=tables,tables+count*0x100,8 do put(o,0) end
  for o=stack,stack+count*STEP+0x200,8 do put(o,0) end
  put(0x10,base+tables); put(0x30,calls[1].a[1]); put(0x58,sdk(LOADTABLE)); put(0x68,base+stack)
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
local master=pa(N.alloc(0x1000)); N.poke(master,0)  -- blocking state
N.poke(ctrl,0)
local pr=N.call_deep(sdk(GETPRIO),ctrl+0x20,CUR_THREAD,0,0,0)
local prio=(pr==0) and rd32(ctrl+0x20) or 44; if not(prio>0 and prio<64) then prio=44 end

local frames,handles={},{}
for i=1,NT do frames[i]=pa(N.alloc(0x20000)); build(frames[i], master) end
for i=1,NT do local c=ctrl+0x100*i; N.poke(c,0)
  local st=pa(N.alloc(0x15000))
  assert(N.call_deep(sdk(CREATE),c,sdk(LONGJMP),frames[i],st+0x14000,prio,0)==0,"create "..i)
  handles[i]=rd32(c); assert(N.call_deep(sdk(START),handles[i],0,0,0,0)==0,"start "..i) end

-- check blocked: short-wait thread 1 (100ms) -> expect timeout (0xea01) = still waiting
N.poke(ctrl+0x08,0); N.poke(ctrl+0x10,handles[1])
local jr0=N.call_deep(sdk(WAIT),ctrl+0x08,ctrl+0x10,1,100000000,0)
local blocked = (jr0~=0)  -- timeout means still blocked on master
local marks_before=0; for i=1,NT do if N.peek(frames[i]+0x800)~=0 then marks_before=marks_before+1 end end
print(string.format("before release: thread1 wait jr=%s (blocked=%s) markers=%d/%d", hx(jr0), tostring(blocked), marks_before, NT))

-- RELEASE: master=1 + signal
N.poke(master,1)
N.call_deep(sdk(SIGNAL),master,0,0,0,0)

-- join all
local joined=0; for i=1,NT do N.poke(ctrl+0x08,0); N.poke(ctrl+0x10,handles[i])
  local jr=N.call_deep(sdk(WAIT),ctrl+0x08,ctrl+0x10,1,0x400000000,0)
  if jr==0 then joined=joined+1 end; N.call_deep(sdk(CLOSE),handles[i],0,0,0,0) end
local marks_after=0; for i=1,NT do if N.peek(frames[i]+0x800)~=0 then marks_after=marks_after+1 end end
print(string.format("after release: joined=%d/%d markers=%d/%d", joined, NT, marks_after, NT))
print((blocked and marks_before==0 and joined==NT and marks_after==NT) and "*** MASTER-SYNC WORKS ***" or "*** needs adjustment ***")
