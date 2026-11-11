-- Diagnostic 2: fill the output with a sentinel, query, and show which 8-byte
-- slots svcQueryMemory actually overwrote. Compare a RW heap region vs an R-X
-- code region so the perm/type fields (which must differ) reveal their offset.
local N = assert(_G.n2h, "no n2h")
local QM = 0x168b0c
local SENT = 0xAAAAAAAAAAAAAAAA
local function hx(v) return string.format("0x%x", v) end

local aux = N.alloc(0x200)
local function probe(label, addr)
  for o = 0, 0x50, 8 do N.poke(aux + o, SENT) end
  local res = N.call_deep(N.sdk_base + QM, aux, aux + 0x80, addr, 0, 0)
  print(string.format("%s query(%s) res=%s", label, hx(addr), hx(res)))
  for o = 0, 0x30, 8 do
    local v = N.peek(aux + o)
    local tag = (v == SENT) and "  (untouched)" or ""
    print(string.format("   +0x%02x = %s%s", o, hx(v), tag))
  end
end

probe("HEAP(rw)", aux)            -- expect perm=3 somewhere
probe("CODE(rx)", N.sdk_base)     -- expect perm=5 somewhere (differs from heap)
probe("UNMAP   ", 0x1000)         -- expect type=0 (free) or res!=0
print("done")
