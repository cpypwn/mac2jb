local N = assert(_G.n2h, "n2h not initialized")
local O = N.offsets_sdk
local function sdk(o) return N.sdk_base+o end
local function hx(v) return string.format("0x%x",v) end
local function s32(v) v=v%0x100000000; if v>=0x80000000 then return v-0x100000000 end return v end
-- socket + helper offsets
local SOCKET=sdk(O.socket_socket or 0x14d4c0); local BIND=sdk(O.socket_bind or 0x14d3b0)
local LISTEN=sdk(O.socket_listen or 0x14d440); local ACCEPT=sdk(O.socket_accept or 0x14d380)
local RECV=sdk(O.socket_recv or 0x14d300); local SEND=sdk(O.socket_send or 0x14d350)
local CLOSE=sdk(O.socket_close or 0x14d510); local QM=sdk(0x168b0c); local MEMMOVE_OFF=0x522830
local FCNTL=sdk(O.socket_fcntl or 0x14d560); local SLEEP=sdk(0x168b54)
-- exact 64-bit read/write of RPC words via 4-byte halves (avoids Lua double loss)
local function rd64(a) local lo=N.peek(a-a%8); return lo end  -- helper reused below via rd32 pairs
local function rd32(a) local w=N.peek(a-a%8); if a%8==0 then return w%0x100000000 end return math.floor(w/0x100000000) end
local scr=N.alloc(0x100)
local function r32(addr) N.poke(scr,0); N.call_deep(sdk(MEMMOVE_OFF),scr,addr,4,0,0); return N.peek(scr) end
local function r64(addr) return r32(addr) + r32(addr+4)*0x100000000 end

local SCRATCH_BYTES=0x80000
local scratch=N.alloc(SCRATCH_BYTES+0x1000)
local aux=N.alloc(0x400)
local saBuf=aux; local helloBuf=aux+0x40; local infoBuf=aux+0x100; local pageBuf=aux+0x140
print("nora_bridge: scratch="..hx(scratch))

-- query(addr).base via known svcQueryMemory offset (no .text scan; base@+0 is correct)
local function querybase(addr)
  local r=N.call_deep(QM, infoBuf, pageBuf, addr, 0, 0)
  if r~=0 then return nil end
  return N.peek(infoBuf)  -- base
end
local sdkbase = querybase(N.sdk_base) or N.sdk_base
local mainbase = querybase(N.main_base) or N.main_base
print("sdkbase="..hx(sdkbase).." mainbase="..hx(mainbase))

-- socket: bind :39380, listen
local fd=s32(N.call_deep(SOCKET,2,1,0,0,0)); assert(fd>=0,"socket() failed")
for o=0,0x18,8 do N.poke(saBuf+o,0) end
N.write_bytes(saBuf,string.char(16,2,0x99,0xD4,0,0,0,0))  -- :39380 (0x99D4 BE), INADDR_ANY -- matches engine default port (no NS2_PORT needed)
assert(s32(N.call_deep(BIND,fd,saBuf,16,0,0))==0,"bind failed")
assert(s32(N.call_deep(LISTEN,fd,4,0,0,0))==0,"listen failed")
-- non-blocking accept so a run with no PC connection RETURNS instead of wedging
-- nora's single-threaded /eval server. F_SETFL=4, O_NONBLOCK=0x800 (nnsocket).
N.call_deep(FCNTL,fd,4,0x800,0,0)
print("listening on :39380 (non-blocking accept, ~90s window) ...")
local nfd=-1
local ACCEPT_POLLS = tonumber(N.env and N.env.ACCEPT_POLLS) or 1800  -- 1800*50ms = 90s
for _=1,ACCEPT_POLLS do
  nfd=s32(N.call_deep(ACCEPT,fd,aux+0x200,aux+0x240,0,0))
  if nfd>=0 then break end
  N.call_deep(SLEEP,50000000,0,0,0,0)  -- 50ms
end
if nfd<0 then N.call_deep(CLOSE,fd,0,0,0,0); print("no PC connected in window; bridge returned cleanly (nora free)"); return end
-- accepted fd must also be blocking for the RPC recv/send loop
N.call_deep(FCNTL,nfd,4,0,0,0)
print("PC engine connected (nfd="..nfd..")")

-- HELLO (16 u64 LE). got=0, backing=0, controller=0 for Civ7; sdkCrc32 from target.civ7.json.
local SDK_CRC32=157086863
local function put64(a,v) N.write_bytes(a, string.char(v%256,math.floor(v/256)%256,math.floor(v/65536)%256,math.floor(v/16777216)%256,
  math.floor(v/0x100000000)%256,math.floor(v/0x10000000000)%256,math.floor(v/0x1000000000000)%256,0)) end
local hf={0x31545344,1,2, scratch, SCRATCH_BYTES, mainbase, sdkbase, 0, sdkbase+MEMMOVE_OFF, 0, 0, 0,0,0,0, SDK_CRC32}
for i=0,15 do put64(helloBuf+i*8, hf[i+1]) end
-- sendAll HELLO (128 bytes)
local function sendAll(buf,len) local off=0 while off<len do local r=s32(N.call_deep(SEND,nfd,buf+off,len-off,0,0)); if r<=0 then return false end off=off+r end return true end
local function recvFull(buf,len) local off=0 while off<len do local r=s32(N.call_deep(RECV,nfd,buf+off,len-off,0,0)); if r<=0 then return false end off=off+r end return true end
if not sendAll(helloBuf,128) then print("HELLO send failed"); return end
print("HELLO sent; entering RPC loop")

-- RPC loop (BRIDGE-CONTRACT §2)
local inBuf=scratch+0x40000
local REQ,RESP=0x8080,0x8010
local hdr=N.alloc(0x40)  -- staging for the 16-byte result header (see below)
local deep_stack, six_result
local function call6(target, a0, a1, a2, a3, a4, a5)
  assert(type(N.run_chain)=="function" and type(N.new_emitter)=="function" and
    O.vcall8_restore==0x3d9e54 and N.game_id=="seedsow" and N.platform=="Ounce",
    "six-argument call requires the verified Seedsow v2 emitter")
  if not deep_stack then
    deep_stack=N.alloc(0x20000)
    six_result=N.alloc(0x20)
    assert(deep_stack and deep_stack~=0 and six_result and six_result~=0,
      "six-argument call allocation failed")
  end
  local sentinel=0x4d324a42
  N.poke(six_result,sentinel)
  local patched=0
  N.run_chain(function(E)
    E:call_native(target,a0,a1,a2,a3,a4,six_result)
    local x5=E.cursor-0x68
    for i=1,#E.words do
      if E.words[i][1]==x5 then
        assert(E.words[i][2]==0,"Seedsow x5 frame was not empty")
        E.words[i][2]=a5
        patched=patched+1
      end
    end
    assert(patched==1,"Seedsow x5 frame was not found exactly once")
  end,deep_stack+0x1e000,deep_stack+0x20000)
  assert(patched==1,"six-argument call was not emitted")
  local result=N.peek(six_result)
  assert(result~=sentinel,"six-argument call did not return a result")
  return result
end
local rpc=0
while true do
  if not recvFull(inBuf,REQ) then print("recv ended"); break end
  -- termination: record A first 20 bytes zero
  if r64(inBuf)==0 and r64(inBuf+8)==0 and r32(inBuf+16)==0 then print("termination"); break end
  local resA,resB=0,0
  local fnA=r64(inBuf); local bb=inBuf+0x28; local fnB=r64(bb)
  if fnB==2 then
    if fnA~=0 and fnA%4==0 then
      resA=call6(fnA, r64(inBuf+8),r64(inBuf+16),r64(inBuf+24),r64(inBuf+32), r64(bb+8), r64(bb+16))
    end
  else
    if fnA~=0 then resA=N.call_deep(fnA, r64(inBuf+8),r64(inBuf+16),r64(inBuf+24),r64(inBuf+32)) end
    if fnB~=0 then resB=N.call_deep(fnB, r64(bb+8),r64(bb+16),r64(bb+24),r64(bb+32)) end
  end
  -- Store the 16-byte result header [resB:8][resA:8] at scratch+0x4030 WITHOUT
  -- poke/write_bytes: nora's poke spills forward at 16-misaligned slots, so a
  -- poke at 0x4038 corrupts output@0x4040. memmove copies exactly 16 bytes.
  N.poke(hdr, resB%0x10000000000000000); N.poke(hdr+8, resA%0x10000000000000000)
  N.call_deep(sdk(MEMMOVE_OFF), scratch+0x4030, hdr, 16, 0, 0)
  if not sendAll(scratch+0x4030, RESP) then print("send ended"); break end
  rpc=rpc+1
end
N.call_deep(CLOSE,nfd,0,0,0,0); N.call_deep(CLOSE,fd,0,0,0,0)
print("nora_bridge done, rpc="..rpc)
