-- Probe svcQueryMemory(sdk_base) over nora and dump the full MemoryInfo, to see
-- whether the n2h runtime reports different permissions/attributes for the SDK
-- code region than the engine's target.civ7.json expects (type=3,perm=5,attr=0).
local N = assert(_G.n2h, "n2h not initialized")
local function sdk(o) return N.sdk_base+o end
local function hx(v) return string.format("0x%x",v) end
local QM=sdk(0x168b0c); local MEMMOVE=sdk(0x522830)
local aux=N.alloc(0x400); local info=aux; local page=aux+0x100; local scr=aux+0x200
-- exact 32-bit read: memmove 4 bytes into zeroed scratch, then peek
local function r32(addr) N.poke(scr,0); N.call_deep(MEMMOVE,scr,addr,4,0,0); return N.peek(scr) end
local function r64(addr) return r32(addr) + r32(addr+4)*0x100000000 end
for o=0,0x40,8 do N.poke(info+o,0) end
local r = N.call_deep(QM, info, page, N.sdk_base, 0, 0)
print("svcQueryMemory(sdk_base="..hx(N.sdk_base)..") ret="..hx(r))
print("  address     = "..hx(r64(info+0x00)))
print("  size        = "..hx(r64(info+0x08)))
print("  type        = "..r32(info+0x10))
print("  attributes  = "..r32(info+0x14).." ("..hx(r32(info+0x14))..")")
print("  permissions = "..r32(info+0x18))
print("  ipcRefs     = "..r32(info+0x1C))
print("  deviceRefs  = "..r32(info+0x20))
print("EXPECT: type=3 perm=5 attr=0 size=0x602000")
