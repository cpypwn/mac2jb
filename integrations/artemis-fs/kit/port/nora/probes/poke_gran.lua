-- Determine nora poke/write_bytes granularity: does a write at a +8 (16-misaligned)
-- offset clobber the next 8-byte word?
local N = assert(_G.n2h, "n2h not initialized")
local function hx(v) return string.format("0x%x",v) end
local s = N.alloc(0x1000)
local MEMMOVE=N.sdk_base+0x522830
local scr=N.alloc(0x40)
local function r32(a) N.poke(scr,0); N.call_deep(MEMMOVE,scr,a,4,0,0); return N.peek(scr) end
local function r64(a) return r32(a)+r32(a+4)*0x100000000 end
-- seed three consecutive words with distinct markers via poke
N.poke(s+0x30, 0x111111); N.poke(s+0x38, 0x222222); N.poke(s+0x40, 0x333333); N.poke(s+0x48, 0x444444)
print("seed:   +0x30="..hx(r64(s+0x30)).." +0x38="..hx(r64(s+0x38)).." +0x40="..hx(r64(s+0x40)).." +0x48="..hx(r64(s+0x48)))
-- overwrite ONLY +0x38 with 0 via N.poke
N.poke(s+0x38, 0)
print("poke38: +0x30="..hx(r64(s+0x30)).." +0x38="..hx(r64(s+0x38)).." +0x40="..hx(r64(s+0x40)).." +0x48="..hx(r64(s+0x48)))
-- reseed +0x40, then overwrite +0x38 via write_bytes(8 bytes)
N.poke(s+0x40, 0x333333)
N.write_bytes(s+0x38, string.char(0,0,0,0,0,0,0,0))
print("wbyt38: +0x30="..hx(r64(s+0x30)).." +0x38="..hx(r64(s+0x38)).." +0x40="..hx(r64(s+0x40)).." +0x48="..hx(r64(s+0x48)))
