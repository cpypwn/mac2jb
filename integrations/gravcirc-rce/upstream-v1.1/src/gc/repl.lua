local log = require("gc.log")
local M = {}

function M.evaluate(body, extras)
    local chunk, err = loadstring(body, "@repl")
    if not chunk then return "compile error: " .. tostring(err) .. "\n" end

    local out = {}
    local env = {
        print = function(...)
            local parts = {}
            for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
            out[#out + 1] = table.concat(parts, "\t")
        end,
        log = log.log,
    }
    for k, v in pairs(extras or {}) do env[k] = v end
    setmetatable(env, { __index = _G, __newindex = _G })
    if setfenv then setfenv(chunk, env) end

    local ok, ret = pcall(chunk)
    out[#out + 1] = ok and ("-> " .. tostring(ret)) or ("error: " .. tostring(ret))
    return table.concat(out, "\n") .. "\n"
end

return M
