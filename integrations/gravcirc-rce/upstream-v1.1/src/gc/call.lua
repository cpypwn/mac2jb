-- love.ffi API surface for the launcher.
-- Installs onto the love table: love.ffi.declare, love.ffi.invoke, etc.
-- Ported from balatro-switch-rce's bl/call.lua.
local ffi_call = require("gc.ffi_call")
local M = {}

function M.install(love_table, ffi, victim, info, backend)
    assert(love_table and ffi and victim and info and info.sdk_base)
    backend = backend or ffi_call.gp_invoke
    local api = setmetatable({ raw = ffi }, { __index = ffi })

    function api.invoke(target, ...)
        return backend(ffi, victim, info, target, {...})
    end

    function api.declare(ret, args, address)
        return ffi_call.declare(ffi, victim, info, ret, args, address)
    end

    function api.describe(fn) return ffi_call.describe(fn) end

    function api.u64_eq(a, b) return ffi_call.u64_eq(ffi, a, b) end
    function api.u64_is_zero(v) return ffi_call.u64_is_zero(ffi, v) end
    function api.native_ready() return ffi_call.preflight(ffi, info) end

    api.ffi_call = ffi_call
    love_table.ffi = api
    return api
end

return M
