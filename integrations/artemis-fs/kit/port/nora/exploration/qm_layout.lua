-- Diagnostic: dump the raw svcQueryMemory MemoryInfo struct for known regions
-- so we can fix base/size/type/perm offsets. Single eval, read-only, safe.
local N = assert(_G.n2h, "no n2h")
local QM = 0x168b0c
local function hx(v) return string.format("0x%x", v) end

local aux = N.alloc(0x200)
local function dump(label, addr)
  -- zero the output area first so stale data is obvious
  for o = 0, 0x40, 8 do N.poke(aux + o, 0) end
  local res = N.call_deep(N.sdk_base + QM, aux, aux + 0x60, addr, 0, 0)
  print(string.format("%s query(%s) res=%s", label, hx(addr), hx(res)))
  for o = 0, 0x28, 8 do
    print(string.format("   aux+0x%02x = %s", o, hx(N.peek(aux + o))))
  end
end

dump("SELF ", aux)                 -- our own heap allocation
dump("SDK  ", N.sdk_base)          -- the sdk code module (large R-X region)
dump("SDK+q", N.sdk_base + QM)     -- inside .text specifically
print("done")
