-- Full-ABI native calls via SDK gadgets.
-- Ported from balatro-switch-rce's bl/ffi_call.lua for love-save-shadow.
--
-- Rebuilds the missing lj_vm_ffi_call dispatch using instructions the SDK
-- already contains. Supports up to 8 GP + 8 FP arguments and
-- void/integer/pointer/float/double returns.
--
-- See bl/ffi_call.lua in balatro-switch-rce for the complete chain
-- explanation and the two measured LuaJIT defects (broken 64-bit literals
-- and broken cdata equality).

local jffi = require("gc.jffi")

local M = {}

M.CTX = { X = function(n) return 8 * n end, SP = 0xf8, LR = 0x100,
          D = function(n) return 0x110 + 8 * n end, SIZE = 0x210 }

M.layout = {
    RESULT = 0x10,
    SAVED  = 0x120,
    FAKE   = 0x128,
    FAKE_FRAME_SIZE = 0xf0,
    FP_SLOT = 0x180,
    STACK_SIZE = 0x20100,
    CAPTURE_FRAME = 0x30,
}

local U32 = 4294967296

local function u64_hi(ffi, v)
    return tonumber(ffi.cast("uint32_t", ffi.cast("uint64_t", v) / U32))
end

local function u64_lo(ffi, v)
    return tonumber(ffi.cast("uint32_t", ffi.cast("uint64_t", v)))
end

local function u64_eq(ffi, a, b)
    return u64_hi(ffi, a) == u64_hi(ffi, b) and u64_lo(ffi, a) == u64_lo(ffi, b)
end

local function u64_is_zero(ffi, v)
    return u64_hi(ffi, v) == 0 and u64_lo(ffi, v) == 0
end

M.u64_eq, M.u64_is_zero = u64_eq, u64_is_zero

M.SENTINEL_HI, M.SENTINEL_LO = 0xbadc0ffe, 0xe0ddf00d

local function sentinel(ffi)
    return ffi.cast("uint64_t", M.SENTINEL_HI) * U32 + M.SENTINEL_LO
end
M.sentinel = sentinel

-- Gadget byte signatures — must match before any transfer of control.
-- These are from the Balatro SDK and should be identical in any game built
-- with the same nnSdk version. Verify per-image.
M.SIGNATURE = {
    ctx_restore = "020c41a9041442a9061c43a9082444a90a2c45a90c3446a90e3c47a9124c49a914544aa9165c4ba918644ca91a6c4da91c744ea91e8040f90004516d020c526d0414536d061c546d0824556d0a2c566d0c34576d0e3c586d1044596d124c5a6d14545b6d165c5c6d18645d6d1a6c5e6d1c745f6d1e0041fd1f0441fd107c40f9000440a91f020091c0035fd6",
    ctx_save = "000400a9020c01a9041402a9061c03a9082404a90a2c05a90c3406a90e3c07a9104408a9124c09a914540aa9165c0ba918640ca91a6c0da91c740ea91e7800f9e1030091017c00f91e8000f90004116d",
    fp_capture = "081940f900013fd6e0031f2a600200fdf44f42a9f50b40f9fd7bc3a8c0035fd6",
    fiber_switch  = "ffc303d1020080d2e24f00a9f45701a9f65f02a9f86703a9fa6f04a9fc7705a9fe0b06a9e8a703adeaaf04adecb705adeebf06ade2030091020000f9220040f95f000091e04f40a9f45741a9f65f42a9f86743a9fa6f44a9fc7745a9fe3340f9e8a743adeaaf44adecb745adeebf46adffc30391c0035fd6",
    fiber_pop_gp  = "e00740a9e20f41a9e41742a9e61f43a9fd7b44a9ff4301911f2003d5c0035fd6",
    -- thunk_ptr moved to VARIANTS: the movz constants differ between SDK builds
}

M.VARIANTS = {
    fiber_capture = {
        "c0023fd6600a00f9f44f42a9f65741a9fd7bc3a8c0035fd6",
        "a0023fd6600a00f9f44f42a9f65741a9fd7bc3a8c0035fd6",
    },
    launder = {
        "fd7bbea9f30b00f9fd030091a00100b4011c40f9f30300aa410100b4682640f9080100b4602a40f900013fd6e0031f2a7f1e00f9f30b40f9fd7bc2a8c0035fd6",
        "fd7bbea9f30b00f9fd030091011c40f9f30300aa810100b4682640f9480100b4602a40f900013fd6e0031f2a7f1e00f9f30b40f9fd7bc2a8c0035fd620008012",
    },
    thunk_ptr = {
        "000c40f90207805203018052080040f9040d40f980001fd6",  -- balatro SDK
        "000c40f902078052080040f9040d40f90301805280001fd6",  -- GC SDK 14.3.1
        "000c40f9020b8052080040f9040d40f90301805280001fd6",  -- GC SDK 14.3.1 variant 2
    },
}

-- ---------------------------------------------------------------- type model
local GP = function(size, signed) return { class = "gp", size = size, signed = signed } end
local FP = function(size) return { class = "fp", size = size } end

local KIND = {
    ["void"]           = { class = "void" },
    ["bool"]           = { class = "gp", size = 1, signed = false, bool = true },
    ["char"]           = GP(1, true),
    ["signed char"]    = GP(1, true),
    ["unsigned char"]  = GP(1, false),
    ["short"]          = GP(2, true),
    ["unsigned short"] = GP(2, false),
    ["int"]            = GP(4, true),
    ["unsigned"]       = GP(4, false),
    ["unsigned int"]   = GP(4, false),
    ["long"]           = GP(8, true),
    ["unsigned long"]  = GP(8, false),
    ["long long"]      = GP(8, true),
    ["unsigned long long"] = GP(8, false),
    ["int8_t"]   = GP(1, true),  ["uint8_t"]  = GP(1, false),
    ["int16_t"]  = GP(2, true),  ["uint16_t"] = GP(2, false),
    ["int32_t"]  = GP(4, true),  ["uint32_t"] = GP(4, false),
    ["int64_t"]  = GP(8, true),  ["uint64_t"] = GP(8, false),
    ["intptr_t"] = GP(8, true),  ["uintptr_t"]= GP(8, false),
    ["size_t"]   = GP(8, false), ["ssize_t"]  = GP(8, true),
    ["ptrdiff_t"]= GP(8, true),
    ["float"]  = FP(4),
    ["double"] = FP(8),
}

local REFUSED = {
    ["long double"] = "long double is not supported by this bridge",
    ["..."] = "variadic calls are not supported by this bridge",
}

local function classify(spec, what)
    if type(spec) ~= "string" then
        error(("%s: type must be a string, got %s"):format(what, type(spec)), 0)
    end
    local t = spec:gsub("^%s+", ""):gsub("%s+$", ""):gsub("%s+", " ")
    if REFUSED[t] then error(("%s: %s"):format(what, REFUSED[t]), 0) end
    if t:find("%*$") then
        return { class = "gp", size = 8, signed = false, ptr = true, ctype = t }
    end
    local k = KIND[t]
    if not k then
        error(("%s: unsupported type %q"):format(what, t), 0)
    end
    return { class = k.class, size = k.size, signed = k.signed,
             bool = k.bool, ctype = t }
end

function M.compile(sig)
    assert(type(sig) == "table", "signature must be a table")
    local ret = classify(sig.ret or "void", "return type")
    local args, ngp, nfp = {}, 0, 0
    local raw = sig.args or {}
    for i = 1, #raw do
        local a = classify(raw[i], ("argument #%d"):format(i))
        if a.class == "void" then
            error(("argument #%d: void is not an argument type"):format(i), 0)
        end
        if a.class == "gp" then
            if ngp >= 8 then error(("argument #%d: >8 GP args need stack slots"):format(i), 0) end
            a.reg = ngp; ngp = ngp + 1
        else
            if nfp >= 8 then error(("argument #%d: >8 FP args need stack slots"):format(i), 0) end
            a.reg = nfp; nfp = nfp + 1
        end
        args[i] = a
    end
    ret.path = (ret.class == "fp") and "fp" or "int"
    return { ret = ret, args = args, ngp = ngp, nfp = nfp, n = #args }
end

-- ------------------------------------------------------------- marshalling
local boxes = {}

local function box_for(ffi, ctype)
    local b = boxes[ctype]
    if not b then
        local ok, made = pcall(ffi.new, ctype .. "[1]")
        if not ok then error(("cannot box type %q: %s"):format(ctype, tostring(made)), 0) end
        b = { arr = made, u8 = ffi.cast("uint8_t*", made) }
        boxes[ctype] = b
    end
    return b
end

local function gp_word(ffi, a, v, what)
    if a.ptr then
        if v == nil then return ffi.cast("uint64_t", 0) end
        local tv = type(v)
        if tv == "number" then
            if v % 1 ~= 0 then error(("%s: pointer from non-integer number"):format(what), 0) end
            return ffi.cast("uint64_t", ffi.cast("uintptr_t", v))
        elseif tv == "cdata" or tv == "string" then
            local ok, p = pcall(ffi.cast, "uintptr_t", v)
            if not ok then error(("%s: cannot take an address of this value"):format(what), 0) end
            return ffi.cast("uint64_t", p)
        else
            error(("%s: pointer argument must be nil, number, cdata or string"):format(what), 0)
        end
    end
    if a.bool then
        if type(v) == "cdata" then v = not u64_is_zero(ffi, v) end
        return ffi.cast("uint64_t", (v and v ~= 0) and 1 or 0)
    end
    local b = box_for(ffi, a.ctype)
    pcall(function() b.arr[0] = v end)
    local u = ffi.cast(a.signed and "int64_t" or "uint64_t",
                       ffi.cast(("%s*"):format(a.ctype), b.arr)[0])
    return ffi.cast("uint64_t", u)
end

local function fp_word(ffi, a, v, what)
    local b = box_for(ffi, a.ctype)
    pcall(function() b.arr[0] = v end)
    if a.size == 4 then
        return ffi.cast("uint64_t", ffi.cast("uint32_t*", b.arr)[0])
    end
    return ffi.cast("uint64_t*", b.arr)[0]
end

function M.marshal(ffi, plan, ...)
    local n = select("#", ...)
    if n ~= plan.n then
        error(("native call expects %d argument(s), got %d"):format(plan.n, n), 0)
    end
    local gp, fp = {}, {}
    for i = 1, plan.n do
        local a = plan.args[i]
        local v = select(i, ...)
        local what = ("argument #%d (%s)"):format(i, a.ctype)
        if a.class == "gp" then gp[a.reg] = gp_word(ffi, a, v, what)
        else fp[a.reg] = fp_word(ffi, a, v, what) end
    end
    return gp, fp
end

function M.decode(ffi, ret, raw)
    local r = ret
    if r.class == "void" then return nil end
    if r.class == "fp" then
        if r.size == 4 then
            local b = box_for(ffi, "float")
            ffi.cast("uint32_t*", b.arr)[0] = ffi.cast("uint32_t", raw)
            return tonumber(b.arr[0])
        end
        local b = box_for(ffi, "double")
        ffi.cast("uint64_t*", b.arr)[0] = raw
        return tonumber(b.arr[0])
    end
    if r.bool then return not u64_is_zero(ffi, raw) end
    if r.ptr then return ffi.cast(r.ctype, ffi.cast("uintptr_t", raw)) end
    if r.size == 8 then
        return ffi.cast(r.signed and "int64_t" or "uint64_t", raw)
    end
    return tonumber(ffi.cast(r.ctype, ffi.cast(r.signed and "int64_t" or "uint64_t", raw)))
end

-- ------------------------------------------------------------------- arena
local arena = nil

local function reserve(ffi)
    if not arena then
        arena = {
            ctrl  = jffi.ctrl(ffi, 0x200),
            stack = ffi.new("uint8_t[?]", M.layout.STACK_SIZE),
            ctx   = ffi.new("uint8_t[?]", M.CTX.SIZE + 0x20),
        }
        local function align(buf)
            local raw = tonumber(ffi.cast("uintptr_t", buf))
            return raw + (0x10 - raw % 0x10) % 0x10
        end
        arena.ctx_addr = align(arena.ctx)
    end
    return arena
end

function M.reset() arena = nil; M.ready = nil end
function M.prime(ffi) return reserve(ffi) end

local function p64(ffi, addr) return ffi.cast("uint64_t*", ffi.cast("uintptr_t", addr)) end

-- ---------------------------------------------------------------- preflight
local function check_bytes(ffi, base, rva, expected)
    local p = ffi.cast("const uint8_t*", ffi.cast("uintptr_t", base + rva))
    local got = {}
    for i = 0, #expected / 2 - 1 do got[#got + 1] = ("%02x"):format(tonumber(p[i])) end
    return table.concat(got) == expected
end

function M.preflight(ffi, info)
    if not (info and info.sdk_base and info.off) then return nil, "unresolved SDK" end
    for key, expected in pairs(M.SIGNATURE) do
        local rva = info.off[key]
        if not rva then return nil, "missing SDK offset " .. key end
        if not check_bytes(ffi, info.sdk_base, rva, expected) then
            return nil, "wrong SDK bytes at " .. key
        end
    end
    for key, options in pairs(M.VARIANTS) do
        local rva = info.off[key]
        if not rva then return nil, "missing SDK offset " .. key end
        local matched = false
        for _, expected in ipairs(options) do
            if check_bytes(ffi, info.sdk_base, rva, expected) then matched = true; break end
        end
        if not matched then return nil, "wrong SDK bytes at " .. key end
    end
    return true
end

function M.ensure_ready(ffi, info)
    if M.ready then return true end
    local ok, why = M.preflight(ffi, info)
    if not ok then return nil, why end
    reserve(ffi)
    M.ready = true
    return true
end

-- ---------------------------------------------------------------- construct
function M.construct(ffi, info, plan, target, gp, fp)
    gp, fp = gp or {}, fp or {}
    local sdk, off, L = info.sdk_base, info.off, M.layout
    local target_word = ffi.cast("uint64_t", ffi.cast("uintptr_t", target))
    assert(not u64_is_zero(ffi, target_word), "null native callee")
    local held = reserve(ffi)
    local ctrl, ctx = held.ctrl, held.ctx_addr
    local raw = tonumber(ffi.cast("uintptr_t", held.stack))
    local P  = raw + 0x10000 + (16 - raw % 16) % 16
    local F  = P - L.FAKE_FRAME_SIZE
    local S0 = P + 0x50
    local Q  = S0 + L.CAPTURE_FRAME
    local function put(addr, v) p64(ffi, addr)[0] = ffi.cast("uint64_t", v) end

    ffi.fill(ffi.cast("uint8_t*", ffi.cast("uintptr_t", ctx)), M.CTX.SIZE, 0)

    for i = 0, 7 do
        put(ctx + M.CTX.X(i), gp[i] or 0)
        put(ctx + M.CTX.D(i), fp[i] or 0)
    end

    local cap_rva, x19
    if plan.ret.path == "fp" then
        cap_rva = off.fp_capture
        put(ctrl.addr + L.FP_SLOT + 0x30, target_word)
        put(ctx + M.CTX.X(8), ctrl.addr + L.FP_SLOT)
        x19 = ctrl.addr + L.RESULT
    else
        cap_rva = off.fiber_capture
        local cap_word = tonumber(ffi.cast("const uint32_t*",
            ffi.cast("uintptr_t", sdk + cap_rva))[0])
        if cap_word == 0xd63f02c0 then
            put(ctx + M.CTX.X(22), target_word)
        elseif cap_word == 0xd63f02a0 then
            put(ctx + M.CTX.X(21), target_word)
        else
            error(("unrecognised capture gadget: %08x"):format(cap_word))
        end
        put(ctx + M.CTX.X(8), 0)
        x19 = ctrl.addr
    end
    put(ctx + M.CTX.X(19), x19)
    put(ctx + M.CTX.X(29), F)
    put(ctx + M.CTX.SP, S0)
    put(ctx + M.CTX.LR, sdk + cap_rva)

    put(F + 0x08, ctrl.addr)
    put(F + 0x58, F)
    put(F + 0x60, sdk + off.fiber_pop_gp)

    put(P + 0x00, ctx)
    for i = 1, 7 do put(P + i * 8, 0) end
    put(P + 0x40, F)
    put(P + 0x48, sdk + off.ctx_restore)

    put(S0 + 0x00, F)
    put(S0 + 0x08, sdk + off.fiber_pop_gp)
    put(S0 + 0x10, 0)
    put(S0 + 0x18, 0)
    put(S0 + 0x20, 0)
    put(S0 + 0x28, ctrl.addr)

    put(Q + 0x00, ctrl.addr + L.FAKE)
    put(Q + 0x08, ctrl.addr + L.SAVED)
    for i = 2, 7 do put(Q + i * 8, 0) end
    put(Q + 0x40, F)
    put(Q + 0x48, sdk + off.fiber_switch)

    ctrl.u64(0)[0] = ctrl.addr + 0x80
    ctrl.u64(0x80 + jffi.VT_CALLEE)[0] = sdk + off.launder
    ctrl.u64(off.launder_arg1)[0] = ctrl.addr + L.FAKE
    ctrl.u64(off.launder_callee)[0] = sdk + off.fiber_switch
    ctrl.u64(off.launder_arg0)[0] = ctrl.addr + L.SAVED
    ctrl.u64(L.SAVED)[0] = 0
    ctrl.u64(L.FAKE)[0] = F
    ctrl.u64(L.RESULT)[0] = sentinel(ffi)
    return { ctrl = ctrl, ctx = ctx, stack = held.stack, fake_frame = F,
             fake_sp = P, target_sp = S0, unwind_sp = Q,
             capture = sdk + cap_rva, path = plan.ret.path }
end

-- ------------------------------------------------------------------- invoke
function M.invoke(ffi, victim, info, plan, target, ...)
    if not M.ready then
        local ok, why = M.ensure_ready(ffi, info)
        if not ok then return nil, why end
    end
    local gp, fp = M.marshal(ffi, plan, ...)
    local setup = M.construct(ffi, info, plan, target, gp, fp)
    local result, err = jffi.call_ptr(ffi, victim,
                                      info.sdk_base + info.off.thunk_ptr,
                                      setup.ctrl)
    if not result then return nil, err end
    if result.ret ~= 0 then return nil, "BC_FUNCC returned a nonzero result count" end
    local L = M.layout
    if u64_is_zero(ffi, setup.ctrl.u64(L.SAVED)[0]) or
       tonumber(setup.ctrl.u64(L.FAKE)[0]) == setup.fake_frame then
        return nil, "fiber switches did not complete"
    end
    local raw = setup.ctrl.u64(L.RESULT)[0]
    if u64_eq(ffi, raw, sentinel(ffi)) and plan.ret.class ~= "void" then
        return nil, "capture gadget did not store a result"
    end
    return { value = M.decode(ffi, plan.ret, raw), raw = raw }
end

-- -------------------------------------------------------- callable surface
local described = setmetatable({}, { __mode = "k" })

function M.declare(ffi, victim, info, ret, args, address)
    local plan = M.compile({ ret = ret, args = args })
    local addr = ffi.cast("uint64_t", ffi.cast("uintptr_t", address))
    assert(not u64_is_zero(ffi, addr), "null native callee")
    local target = tonumber(ffi.cast("uintptr_t", address))
    local fn = function(...)
        local res, err = M.invoke(ffi, victim, info, plan, target, ...)
        if not res then error("native call failed: " .. tostring(err), 2) end
        return res.value
    end
    described[fn] = { addr = target, plan = plan, ret = ret, args = args }
    return fn, plan
end

function M.describe(fn)
    local d = described[fn]
    if not d then return nil end
    return ("native<0x%x>(%s)->%s"):format(d.addr,
           table.concat(d.args, ","), d.ret), d
end

-- ----------------------------------------------- GP dispatch for socket layer
local gp_plans = {}

function M.gp_plan(n)
    local plan = gp_plans[n]
    if not plan then
        local spec = {}
        for i = 1, n do spec[i] = "void *" end
        plan = M.compile({ ret = "uint64_t", args = spec })
        gp_plans[n] = plan
    end
    return plan
end

function M.gp_invoke(ffi, victim, info, target, args)
    args = args or {}
    local n = #args
    local plan, why = M.gp_plan(n)
    if not plan then return nil, why end
    local res, err = M.invoke(ffi, victim, info, plan, target, unpack(args, 1, n))
    if not res then return nil, err end
    local raw = res.raw
    return { raw = raw,
             int32 = ffi.cast("int32_t", raw),
             int64 = ffi.cast("int64_t", raw) }
end

return M
