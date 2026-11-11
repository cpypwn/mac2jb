-- Setup bisector for nora_bridge: isolates WHERE bridge setup hangs (before
-- listen), since a prior run wedged nora's single worker in a native call that
-- never returned. Run via nora_debug.py (increasing STOP bound); each
-- bounded run executes steps 1..N then RETURNS (no accept) so it never wedges.
--   python3 nora_debug.py <CONSOLE_IP> bridge_setup_diag.lua --max 8
-- A hang (no response) at bound K => step K is the culprit; 1..K-1 are clean.
local N = assert(_G.n2h, "n2h not initialized")
local BOUND = __STOP_AT__
local O = N.offsets_sdk
local function sdk(o) return N.sdk_base+o end
local function hx(v) return string.format("0x%x",v) end
local function s32(v) v=v%0x100000000; if v>=0x80000000 then return v-0x100000000 end return v end
local SOCKET=sdk(O.socket_socket or 0x14d4c0); local BIND=sdk(O.socket_bind or 0x14d3b0)
local LISTEN=sdk(O.socket_listen or 0x14d440); local CLOSE=sdk(O.socket_close or 0x14d510)
local QM=sdk(0x168b0c)

local scr,scratch,aux,saBuf,infoBuf,pageBuf,fd

-- step 1: small scratch alloc (0x100)
if BOUND>=1 then scr=N.alloc(0x100); print("STEP 1 scr="..hx(scr)) end
-- step 2: BIG scratch alloc (0x81000) -- prime hang suspect
if BOUND>=2 then scratch=N.alloc(0x80000+0x1000); print("STEP 2 scratch="..hx(scratch)) end
-- step 3: aux alloc
if BOUND>=3 then aux=N.alloc(0x400); saBuf=aux; infoBuf=aux+0x100; pageBuf=aux+0x140; print("STEP 3 aux="..hx(aux)) end
-- step 4: svcQueryMemory(sdk_base) -> base
if BOUND>=4 then local r=N.call_deep(QM,infoBuf,pageBuf,N.sdk_base,0,0); print("STEP 4 qm(sdk) r="..hx(r).." base="..hx(N.peek(infoBuf))) end
-- step 5: svcQueryMemory(main_base) -> base  (second hang suspect)
if BOUND>=5 then local r=N.call_deep(QM,infoBuf,pageBuf,N.main_base,0,0); print("STEP 5 qm(main) r="..hx(r).." base="..hx(N.peek(infoBuf))) end
-- step 6: socket()
if BOUND>=6 then fd=s32(N.call_deep(SOCKET,2,1,0,0,0)); print("STEP 6 socket fd="..fd) end
-- step 7: bind :39380
if BOUND>=7 then for o=0,0x18,8 do N.poke(saBuf+o,0) end
  N.write_bytes(saBuf,string.char(16,2,0x99,0xCC,0,0,0,0))
  print("STEP 7 bind="..s32(N.call_deep(BIND,fd,saBuf,16,0,0))) end
-- step 8: listen then close (clean return, NO accept)
if BOUND>=8 then print("STEP 8 listen="..s32(N.call_deep(LISTEN,fd,4,0,0,0)))
  N.call_deep(CLOSE,fd,0,0,0,0); print("STEP 8 closed, setup fully clean") end
return
