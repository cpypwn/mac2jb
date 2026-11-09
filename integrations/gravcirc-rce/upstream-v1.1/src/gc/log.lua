local M = { lines = {}, max = 160, build_id = "identifying",
            CREDIT = "https://github.com/figurophobia/GravCirc-Switch-rce" }

local LOG_FILE, PHASE_FILE = "gc_log.txt", "gc_phase.txt"

local anchor_wall, anchor_mono = nil, nil

local function monotonic()
    if love and love.timer and love.timer.getTime then return love.timer.getTime() end
    return os.clock()
end

function M.timestamp()
    local mono = monotonic()
    if not anchor_wall then anchor_wall, anchor_mono = os.time(), mono end
    local wall = anchor_wall + (mono - anchor_mono)
    local whole = math.floor(wall)
    local ms = math.floor((wall - whole) * 1000)
    local ok, clock = pcall(os.date, "%H:%M:%S", whole)
    return ("%s.%03d"):format(ok and clock or "--:--:--", ms)
end

local function append_file(msg)
    local fs = love and love.filesystem
    if fs and fs.append then pcall(fs.append, LOG_FILE, tostring(msg) .. "\n") end
end

function M.phase(name)
    local fs = love and love.filesystem
    if fs and fs.write then pcall(fs.write, PHASE_FILE, tostring(name)) end
    return name
end

function M.log(msg)
    msg = tostring(msg)
    local stamp = M.timestamp()
    for line in (msg .. "\n"):gmatch("(.-)\n") do
        local stamped = stamp .. "  " .. line
        M.lines[#M.lines + 1] = stamped
        append_file(stamped)
    end
    while #M.lines > M.max do table.remove(M.lines, 1) end
    return msg
end

function M.try(what, f, ...)
    local ok, a = pcall(f, ...)
    if not ok then
        M.log(("[ERROR] %s: %s"):format(tostring(what), tostring(a)))
        return nil
    end
    return a == nil and true or a
end

function M.banner(game, version)
    M.log(("[BOOT] %s / LOVE %s / %s / %s"):format(
        game or "unknown",
        tostring(love._version),
        tostring(jit and jit.version or "no JIT"),
        tostring(love.system and love.system.getOS and love.system.getOS() or "?")))
    M.log(("[BOOT] identity: %s"):format(tostring(love.filesystem.getIdentity())))
    M.log(("[BOOT] save: %s"):format(tostring(love.filesystem.getSaveDirectory())))
    M.log(("[BOOT] FFI: %s"):format(tostring(pcall(require, "ffi"))))
    append_file(M.timestamp() .. "  " .. M.CREDIT)
    return version
end

return M
