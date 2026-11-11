-- Borrow scheduling params from the CURRENT thread (pseudo-handle 0xFFFF8000)
-- instead of walking the ThreadManager. Pure syscalls + reads of our own ctrl
-- buffer -> no svcQueryMemory, no manager offset, no .text. Single safe eval.
local N = assert(_G.n2h, "no n2h")
local GET_PRIO = 0x168b5c
local GET_MASK = 0x168b7c
local CUR_THREAD = 0xFFFF8000
local function hx(v) return string.format("0x%x", v) end
local function rd32(x)
  local a = x - x % 8
  local w = N.peek(a)
  if x % 8 == 0 then return w % 0x100000000 end
  return math.floor(w / 0x100000000)
end

local ctrl = N.alloc(0x100)
assert(ctrl and ctrl ~= 0, "ctrl alloc failed")
for o = 0, 0x40, 8 do N.poke(ctrl + o, 0) end

-- svcGetThreadPriority(out_u32 @ x0, handle @ x1)
local pr = N.call_deep(N.sdk_base + GET_PRIO, ctrl + 0x20, CUR_THREAD, 0, 0, 0)
print(string.format("GetThreadPriority res=%s  word@0x20=%s  prio=%d",
  hx(pr), hx(N.peek(ctrl + 0x20)), rd32(ctrl + 0x20)))

-- svcGetThreadCoreMask(out_ideal_u32 @ x0, out_mask_u64 @ x1, handle @ x2)
local mk = N.call_deep(N.sdk_base + GET_MASK, ctrl + 0x18, ctrl + 0x38, CUR_THREAD, 0, 0)
print(string.format("GetThreadCoreMask res=%s  ideal=%d  mask=%s",
  hx(mk), rd32(ctrl + 0x18), hx(N.peek(ctrl + 0x38))))

-- also sanity: current processor number (svcGetCurrentProcessorNumber 0x168ba4)
local cc = N.call_deep(N.sdk_base + 0x168ba4, 0, 0, 0, 0, 0)
print(string.format("GetCurrentProcessorNumber res/core=%s", hx(cc)))
print("done")
