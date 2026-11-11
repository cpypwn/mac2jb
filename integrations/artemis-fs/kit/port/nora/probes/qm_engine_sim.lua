-- Replicate the bridge's EXACT query exchange and watch output+0 (MemoryInfo.
-- address) at each step, to find what clobbers it to 0x300000000.
local N = assert(_G.n2h, "n2h not initialized")
local function sdk(o) return N.sdk_base+o end
local function hx(v) return string.format("0x%x",v) end
local QM=sdk(0x168b0c); local MEMMOVE=sdk(0x522830)
local scratch=N.alloc(0x80000+0x1000)
local scr=N.alloc(0x40)
local function r32(a) N.poke(scr,0); N.call_deep(MEMMOVE,scr,a,4,0,0); return N.peek(scr) end
local function r64(a) return r32(a)+r32(a+4)*0x100000000 end
local function put64(a,v) N.write_bytes(a, string.char(v%256,math.floor(v/256)%256,math.floor(v/65536)%256,math.floor(v/16777216)%256,
  math.floor(v/0x100000000)%256,math.floor(v/0x10000000000)%256,math.floor(v/0x1000000000000)%256,0)) end
local output=scratch+0x4040
-- zero the output + result region
for o=0x4030,0x4100,8 do N.poke(scratch+o,0) end
print("output="..hx(output))
-- step A: svcQueryMemory(output, output+0x40, sdk_base)
local resA=N.call_deep(QM, output, output+0x40, N.sdk_base, 0, 0)
print("after QM:    resA="..hx(resA).." output+0="..hx(r64(output)).." +8="..hx(r64(output+8)).." +16="..hx(r64(output+16)))
-- step B: memmove(output, output, 0, 0)  (the padding no-op)
local resB=N.call_deep(MEMMOVE, output, output, 0, 0)
print("after memmv: resB="..hx(resB).." output+0="..hx(r64(output)))
-- step C: FIX -- build the 16-byte result header in a temp buffer, then memmove
-- it into place (memmove copies exactly N bytes, no forward spill).
local tmp=N.alloc(0x40)
N.poke(tmp, resB); N.poke(tmp+8, resA)         -- spill into tmp+0x10 is harmless
N.call_deep(MEMMOVE, scratch+0x4030, tmp, 16, 0, 0)  -- exactly 16 bytes -> 0x4030..0x403F
print("after memmove-header: output+0="..hx(r64(output)).." resB@0x4030="..hx(r64(scratch+0x4030)).." resA@0x4038="..hx(r64(scratch+0x4038)))
print("FINAL MemoryInfo: addr="..hx(r64(output)).." size="..hx(r64(output+8)).." type="..r32(output+16).." attr="..r32(output+20).." perm="..r32(output+24))
