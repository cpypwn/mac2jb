-- Phase-A BORROW sequence for Seedsow/nora, .text-free + crash-localizable.
--
-- Ports the borrow half of ns2jb-part3/port/probes/probe_raw_svc_thread.js
-- (HW-proven on Civ7) to n2h, with two Seedsow-specific changes:
--   (1) NO .text reads. Seedsow code pages are X-only; peek/scan of .text
--       crashes the process. The Civ7 probe scans sdk for the svcQueryMemory
--       signature and verifies every gadget's bytes -- both impossible here.
--       We use the svc-wrapper offsets recovered offline from the dumped NSO.
--   (2) Every step is gated on the injected STOP bound so nora_debug.py can bisect the
--       exact faulting op across separate evals (buffered output is lost on a
--       crash, so one giant eval is un-debuggable).
--
-- Run with:  nora_debug.py <host> phaseA_borrow_seedsow.lua --max 11
-- A clean assert (bad svc result) returns via HTTP (process alive); a bad
-- memory access returns nothing (process dies) and the driver names the step.

local STOP = __STOP_AT__
local N = assert(_G.n2h, "n2h not initialized")

-- svc-wrapper offsets from the dumped Seedsow sdk NSO (same nnSdk build as
-- Civ7's probe). Prefer n2h.offsets_sdk if it carries them; else these.
local function off(name, fallback)
  local t = N.offsets_sdk
  if t and type(t[name]) == "number" then return t[name] end
  return fallback
end
local O = {
  query_memory       = off("svc_query_memory",        0x168b0c),
  get_thread_prio    = off("svc_get_thread_priority",  0x168b5c),
  get_core_mask      = off("svc_get_thread_core_mask", 0x168b7c),
}
local MANAGER_PTR = 0xB22280   -- *(sdk+MANAGER_PTR) -> ThreadManager
local MANAGER_BIAS, LIST_SENTINEL, NODE_HANDLE = 0xF0, 0x1D0, 0x1B0

local function hx(v) return string.format("0x%x", v) end
-- alignment-aware 32-bit read (Lua 5.1 doubles): read the 8-aligned word
-- containing x and take the correct half.
local function rd32(x)
  local a = x - x % 8
  local w = N.peek(a)
  if x % 8 == 0 then return w % 0x100000000 end
  return math.floor(w / 0x100000000)
end

-- state shared across steps within THIS eval (process-local; a crash loses it,
-- which is fine -- the driver re-runs 1..STOP each time).
local S = {}

local function step(n, name, fn)
  if n > STOP then return end
  local r = fn()
  print(string.format("STEP %d OK %s %s", n, name, r or ""))
end

-- svcQueryMemory(out=aux, page_out=aux+0x40, address) -> result; fills aux.
local function query(addr)
  local res = N.call_deep(N.sdk_base + O.query_memory, S.aux, S.aux + 0x40, addr, 0, 0)
  if res ~= 0 then return nil end
  return {
    base = N.peek(S.aux), size = N.peek(S.aux + 8),
    typ = rd32(S.aux + 0x10), attr = rd32(S.aux + 0x14), perm = rd32(S.aux + 0x18),
    ipc = rd32(S.aux + 0x1c), dev = rd32(S.aux + 0x20),
  }
end
-- owned-readable guard: region exists, covers [addr, addr+len), is readable.
local function readable(addr, len)
  local r = query(addr)
  assert(r and r.base <= addr and addr + len <= r.base + r.size,
    "unmapped/short region at " .. hx(addr))
  assert(r.perm % 2 == 1, "region not readable (perm=" .. r.perm .. ") at " .. hx(addr))
  return r
end

step(1, "env", function()
  assert(N.sdk_base and N.sdk_base ~= 0, "no sdk_base")
  assert(N.offsets_sdk, "no offsets_sdk")
  return "sdk=" .. hx(N.sdk_base) .. " q=" .. hx(O.query_memory) ..
         " gp=" .. hx(O.get_thread_prio)
end)

step(2, "alloc-aux", function()
  S.aux = N.alloc(0x200)
  assert(S.aux and S.aux ~= 0, "aux alloc failed")
  S.ctrl = N.alloc(0x100)
  assert(S.ctrl and S.ctrl ~= 0, "ctrl alloc failed")
  return "aux=" .. hx(S.aux) .. " ctrl=" .. hx(S.ctrl)
end)

step(3, "query-self", function()
  -- Prove svcQueryMemory works via call_deep on our own owned allocation.
  local r = query(S.aux)
  assert(r, "svcQueryMemory returned nonzero on aux")
  S.selfType, S.selfPerm = r.typ, r.perm
  return "type=" .. r.typ .. " perm=" .. r.perm .. " base=" .. hx(r.base) .. " size=" .. hx(r.size)
end)

step(4, "manager-ptr-readable", function()
  -- sdk+0xB22280 is in sdk .data (past .text ~0x5F0000), so it is readable --
  -- but verify with svcQueryMemory before peeking, never assume.
  local r = readable(N.sdk_base + MANAGER_PTR, 8)
  return "dataPerm=" .. r.perm
end)

step(5, "read-manager", function()
  S.manager = N.peek(N.sdk_base + MANAGER_PTR) + MANAGER_BIAS
  assert(S.manager ~= MANAGER_BIAS, "manager pointer is null")
  return "manager=" .. hx(S.manager)
end)

step(6, "manager-readable", function()
  readable(S.manager, 0x1F0)
  return "ok"
end)

step(7, "read-node", function()
  S.sentinel = S.manager + LIST_SENTINEL
  S.node = N.peek(S.sentinel)
  assert(S.node ~= S.sentinel, "thread manager list is empty")
  assert(S.node % 8 == 0, "node misaligned: " .. hx(S.node))
  return "node=" .. hx(S.node)
end)

step(8, "node-readable", function()
  readable(S.node, 0x1b4)
  return "ok"
end)

step(9, "read-handle", function()
  S.handle = rd32(S.node + NODE_HANDLE)
  assert(S.handle > 0 and S.handle < 0xffff8000, "bad borrowed handle: " .. hx(S.handle))
  return "handle=" .. hx(S.handle)
end)

step(10, "get-priority", function()
  local res = N.call_deep(N.sdk_base + O.get_thread_prio, S.ctrl + 0x20, S.handle, 0, 0, 0)
  assert(res == 0, "svcGetThreadPriority failed: " .. hx(res))
  S.prio = rd32(S.ctrl + 0x20)
  assert(S.prio > 0 and S.prio < 64, "invalid borrowed priority: " .. S.prio)
  return "priority=" .. S.prio
end)

step(11, "get-core-mask", function()
  local res = N.call_deep(N.sdk_base + O.get_core_mask, S.ctrl + 0x18, S.ctrl + 0x38, S.handle, 0, 0)
  assert(res == 0, "svcGetThreadCoreMask failed: " .. hx(res))
  S.mask = N.peek(S.ctrl + 0x38)
  local cores = {}
  for b = 0, 7 do if math.floor(S.mask / 2^b) % 2 == 1 then cores[#cores+1] = b end end
  return "mask=" .. hx(S.mask) .. " cores=" .. table.concat(cores, ",")
end)

print("BORROW-PROBE bound=" .. STOP .. " reached end")
