local log = require("gc.log")
local console = require("gc.console")

local M = { installed = {}, original = {}, ours = {}, wrappers = nil }

function M.install(handlers)
    handlers = handlers or {}
    local wrappers = {}

    wrappers.update = function(real)
        return function(dt, ...)
            if handlers.update then log.try("tick", handlers.update, dt) end
            if real and not M.app_update_dead then
                local ok, err = pcall(real, dt, ...)
                if not ok then
                    M.app_update_dead = true
                    log.log("[ls] app update disabled after: " .. tostring(err))
                end
            end
        end
    end

    wrappers.draw = function(real)
        return function(...)
            M.verify()
            if real then pcall(real, ...) end
            if handlers.frame_drawn then pcall(handlers.frame_drawn) end
            if console.visible then
                local status_ok, text = pcall(handlers.status or function() return "" end)
                local ok, err = pcall(console.draw, status_ok and text or "status unavailable")
                if not ok and not M.console_failed then
                    M.console_failed = true
                    log.log("[ERROR] console draw: " .. tostring(err))
                end
            end
        end
    end

    wrappers.keypressed = function(real)
        return function(key, ...)
            if key == "f8" then console.visible = not console.visible; return end
            if real then return real(key, ...) end
        end
    end

    wrappers.gamepadpressed = function(real)
        return function(js, button, ...)
            if button == "back" then console.visible = not console.visible; return end
            if real then return real(js, button, ...) end
        end
    end

    for _, name in ipairs({"focus", "visible"}) do
        local event = name
        wrappers[event] = function(real)
            return function(value, ...)
                if handlers[event] then log.try(event, handlers[event], value) end
                if real then return real(value, ...) end
            end
        end
    end

    wrappers.threaderror = function()
        return function(t, err)
            log.log(("[ls] thread error (%s): %s"):format(tostring(t), tostring(err)))
        end
    end

    wrappers.errhand = function()
        return function(msg)
            pcall(log.log, "[ls] FATAL " .. tostring(msg))
            pcall(log.log, tostring(debug.traceback("", 2)))
            console.visible = true
            pcall(function()
                while true do
                    if love.event then
                        pcall(love.event.pump)
                        for e in love.event.poll() do
                            if e == "quit" then return end
                        end
                    end
                    pcall(console.draw, "FATAL")
                    pcall(love.graphics.present)
                    if love.timer then pcall(love.timer.sleep, 0.1) end
                end
            end)
        end
    end

    -- LÖVE 11.x uses errorhandler, 0.10.x uses errhand
    if love._version_major and love._version_major >= 11 then
        wrappers.errorhandler = wrappers.errhand
    end

    M.wrappers = wrappers
    local love_t = rawget(_G, "love")
    local mt = getmetatable(love_t) or {}
    local prev = mt.__newindex
    mt.__newindex = function(t, k, v)
        local wrap = wrappers[k]
        if wrap and type(v) == "function" then
            M.original[k] = v
            local ok, wrapped = pcall(wrap, v)
            rawset(t, k, ok and wrapped or v)
            M.ours[k] = ok and wrapped or nil
            M.installed[k] = true
            return
        end
        if prev then return prev(t, k, v) end
        rawset(t, k, v)
    end
    setmetatable(love_t, mt)

    for k, wrap in pairs(wrappers) do
        local cur = rawget(love_t, k)
        if cur and not M.installed[k] then
            M.original[k] = cur
            local ok, wrapped = pcall(wrap, cur)
            if ok then
                rawset(love_t, k, wrapped)
                M.ours[k] = wrapped
                M.installed[k] = true
            end
        end
    end

    for _, name in ipairs({"focus", "visible"}) do
        if not M.installed[name] then
            local wrapped = wrappers[name](nil)
            rawset(love_t, name, wrapped)
            M.ours[name], M.installed[name] = wrapped, true
        end
    end
    return M
end

function M.verify()
    if not M.wrappers then return end
    local love_t = rawget(_G, "love")
    for k, wrap in pairs(M.wrappers) do
        local cur = rawget(love_t, k)
        if type(cur) == "function" and M.ours[k] ~= nil and cur ~= M.ours[k] then
            M.original[k] = cur
            local ok, wrapped = pcall(wrap, cur)
            if ok then
                rawset(love_t, k, wrapped)
                M.ours[k] = wrapped
                log.log("[ls] re-wrapped love." .. k)
            end
        end
    end
end

return M
