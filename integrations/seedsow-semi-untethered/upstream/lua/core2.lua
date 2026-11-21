-- core2.lua — Safe Bootstrap Wrapper for Seedsow Lullaby (save:/core2.lua)
-- Preserves stock save:/core.lua, save:/inject.iet, save:/inject.lua, and save:/http.lua.
-- Holding '-' (MINUS, key 114) at the launcher menu skips core2.lua and enters Recovery Mode.
-- Pressing 'Y' (key 113) starts the stock HTTP server on port 8080.
-- Pressing 'A' launches save:/exploita2.lua -> save:/s2_main.lua.

if not _G.n2h then
    local f = io.open("save:/core.lua", "rb")
    if f then
        f:close()
        dofile("save:/core.lua")
    else
        dofile("save:/ax_core.lua")
    end
end

if _G.e then
    package.path = "save:/?.lua;save:/lib/?.lua"
else
    package.path = "save:/?.lua;save:/lib/?.lua;./?.lua;" .. (package.path or "")
end

local is_minus = (_G.n2h_was_recovery == true)
local is_y     = false
if _G.e and type(_G.e.isDown) == "function" then
    local ok1, m = pcall(_G.e.isDown, _G.e, 114) -- KEYS.MINUS
    if ok1 and m then is_minus = true end
    local ok2, y = pcall(_G.e.isDown, _G.e, 113) -- KEYS.Y
    if ok2 and y then is_y = true end
end

if not is_minus and not is_y and _G.S2_AUTORUN_ON_CORE2 == true then
    _G.__s2_ran_from_core2 = true
    local ok, err = xpcall(function()
        dofile("save:/s2_main.lua")
    end, function(e) return tostring(e) end)
    if not ok then
        print("core2 error: " .. tostring(err))
    end
end
