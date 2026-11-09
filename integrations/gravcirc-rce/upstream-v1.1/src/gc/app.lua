local log     = require("gc.log")
local console = require("gc.console")
local hooks   = require("gc.hooks")

local M = {state = "first-frame", log = log, console = console, hooks = hooks}
local REPL_PORT, FTP_PORT, PASV_PORT = 9026, 5000, 5001

local function detect_nx()
    if jit and jit.os == "Other" then return true end
    local ok, os_name = pcall(function()
        if love.system and love.system.getOS then return love.system.getOS() end
        return "Unknown"
    end)
    return ok and os_name == "Horizon"
end
local IS_NX = detect_nx()

local LABEL = {["first-frame"] = "BOOTING", connecting = "CONNECTING",
               ["network-error"] = "ERROR"}

function M.clock()
    local ok, now = pcall(os.date, "%H:%M:%S")
    return ok and now or "--:--:--"
end

local function status()
    local ip = M.net and M.net.ip or nil
    if M.state == "serving" and ip then
        return ("RPC %s:%d    FTP %s:%d"):format(ip, REPL_PORT, ip, FTP_PORT)
    end
    local label = LABEL[M.state] or M.state:upper()
    if ip then return ("%s   %s"):format(label, ip) end
    return label
end

local function events(tag)
    return function(kind, detail)
        log.log(("[%s] %s %s"):format(tag, kind, tostring(detail or "")))
    end
end

local function start_nx_network()
    local ffi = require("ffi")
    local resolve = require("gc.resolve")
    local info, why = resolve.resolve(ffi, M.game_id)
    if not info then return nil, "resolve: " .. tostring(why) end
    log.log("[NX] resolved: main=" .. string.format("0x%x", info.main_base)
            .. " sdk=" .. string.format("0x%x", info.sdk_base))

    local ffi_call = require("gc.ffi_call")
    local ok_pf, pf_why = ffi_call.preflight(ffi, info)
    if not ok_pf then return nil, "preflight: " .. tostring(pf_why) end
    log.log("[NX] gadget preflight passed")

    local victim = love.graphics.present
    local socket_nx = require("gc.socket_nx")
    local net = socket_nx.new(ffi, victim, info)
    M.nx_info = info
    return net
end

local function start_network()
    M.net_pending = false
    local net
    if IS_NX and not M.net then
        local nx_net, why = start_nx_network()
        if not nx_net then
            log.log("[ERROR] NX network: " .. tostring(why))
            return false
        end
        net = nx_net
    elseif not M.net then
        local socket_mod = require("gc.socket_pc")
        net = socket_mod.new()
    end
    net = M.net or net
    M.net = net
    local ok, why = net:initialize()
    if not ok then
        if type(why) == "string" and why:find("^pending:") then
            M.net_pending = true
            M.net_retry = love.timer.getTime() + 0.5
            if not M.net_pending_logged then
                M.net_pending_logged = true
                log.log("[NET] waiting for an IP")
            end
            return false
        end
        log.log("[ERROR] network initialization: " .. tostring(why))
        return false
    end
    log.log("[NET] IP " .. tostring(net.ip))
    local rpc_fd, rpc_err = net:listener(REPL_PORT)
    if not rpc_fd then log.log("[ERROR] RPC listener: " .. tostring(rpc_err)); return false end
    local ftp_fd, ftp_err = net:listener(FTP_PORT)
    if not ftp_fd then
        net:close(rpc_fd)
        log.log("[ERROR] FTP listener: " .. tostring(ftp_err)); return false
    end
    local pasv_fd, pasv_err = net:listener(PASV_PORT)
    if not pasv_fd then
        net:close(rpc_fd); net:close(ftp_fd)
        log.log("[ERROR] PASV listener: " .. tostring(pasv_err)); return false
    end

    local built, err = pcall(function()
        local io = net:transport()
        M.rpc = require("gc.rpc").new(io, rpc_fd, function(body)
            return require("gc.repl").evaluate(body, {LS = M})
        end, {on_event = events("RPC")})
        M.ftp = require("gc.ftp_server").new(io, love.filesystem,
            ftp_fd, pasv_fd, net.ip, PASV_PORT, nil, events("FTP"))
    end)
    if not built then
        net:close(rpc_fd); net:close(ftp_fd); net:close(pasv_fd)
        log.log("[ERROR] server construction: " .. tostring(err))
        return false
    end
    M.rpc_fd, M.ftp_fd, M.pasv_fd = rpc_fd, ftp_fd, pasv_fd
    log.log(("[NET] RPC %s:%d / FTP %s:%d / PASV :%d ready"):format(
        net.ip or "?", REPL_PORT, net.ip or "?", FTP_PORT, PASV_PORT))
    log.phase("net:serving")
    return true
end

local function halt_network(why)
    log.log("[ERROR] network stopped: " .. tostring(why))
    if M.rpc then pcall(M.rpc.close, M.rpc, "server stopped") end
    if M.ftp then pcall(M.ftp.close, M.ftp, "server stopped") end
    M.rpc, M.ftp = nil, nil
    M.state = "network-error"
end

function M.tick(dt)
    hooks.verify()
    if M.state == "first-frame" then
        if M.frame_ready then
            M.state = "connecting"
            log.banner(M.game_name)
            log.log("[SYS] starting network services")
        end
        return
    end
    if M.state == "connecting" then
        if M.net_pending and love.timer.getTime() < M.net_retry then return end
        local started = pcall(start_network)
        if M.net and M.net.ip and M.rpc then
            M.state = "serving"
            log.phase("app:serving")
        elseif not M.net_pending then
            M.state = "network-error"
            log.phase("app:network-error")
        end
        return
    end
    if M.state ~= "serving" then return end
    local rok, rstatus = pcall(M.rpc.step, M.rpc)
    if not rok then halt_network("RPC: " .. tostring(rstatus)); return end
    local fok, fstatus = pcall(M.ftp.step, M.ftp)
    if not fok then halt_network("FTP: " .. tostring(fstatus)); return end
end

function M.boot(game_name, game_id)
    if rawget(_G, "__LS") then return rawget(_G, "__LS") end
    rawset(_G, "__LS", M)
    M.game_name = game_name or "unknown"
    M.game_id = game_id or "gravity-circuit"
    console.clock = M.clock
    hooks.install({update = M.tick, status = status,
                   frame_drawn = function() M.frame_ready = true end})
    log.log("[SYS] platform: " .. (IS_NX and "Switch (Horizon)" or "PC"))
    return M
end

return M
