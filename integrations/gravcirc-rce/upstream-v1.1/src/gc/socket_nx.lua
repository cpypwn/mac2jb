-- Switch socket transport using nn::nifm / nn::socket via FFI gadget dispatch.
-- Same API as socket_pc.lua: new() returns {initialize, listener, close, transport}.
-- Ported from balatro-switch-rce's bl/socket.lua for love-save-shadow.
local ffi_call = require("gc.ffi_call")
local types = require("gc.socket_types")
local bit = require("bit")
local M = {}

local POOL_SIZE, ALLOC_POOL, CONCURRENCY = 0x100000, 0x20000, 8
local MAX_IO = 4096
local WOULD_BLOCK = { [11] = true, [35] = true, [4] = true }

function M.new(ffi, victim, info, dispatch)
    assert(ffi and victim and info and info.sdk_base and info.off,
           "socket adapter needs resolved SDK and a C victim")
    dispatch = dispatch or ffi_call.gp_invoke
    local self = { ffi = ffi, info = info, dispatch = dispatch,
                   ip = nil, pool = nil, initialized = false }

    function self:raw(name, args)
        local off = self.info.off[name]
        if not off then return nil, "missing SDK offset " .. tostring(name) end
        return self.dispatch(self.ffi, victim, self.info,
                             self.info.sdk_base + off, args or {})
    end

    function self:i32(name, args)
        local r, why = self:raw(name, args)
        if not r then return nil, why end
        return tonumber(r.int32)
    end

    function self:i64(name, args)
        local r, why = self:raw(name, args)
        if not r then return nil, why end
        local value = tonumber(r.int64)
        if math.abs(value) > 9007199254740991 then return nil, "inexact byte count" end
        return value
    end

    function self:last_error()
        local n = self:i32("sock_error", {})
        return n or -1
    end

    local function socket_error(label, value)
        return ("%s returned %s (errno %s)"):format(label, tostring(value),
                                                      tostring(self:last_error()))
    end

    function self:refresh_ip()
        local ip_out = ffi.new("uint32_t[1]", 0)
        local ip_result, ip_why = self:i32("nifm_ip", {ip_out})
        if ip_result == nil then return nil, "nifm IP dispatch: " .. tostring(ip_why) end
        local ip_n = tonumber(ip_out[0])
        if ip_n == 0 then
            self.ip = nil
            return nil, ("pending: IP not yet available (Result %#x)")
                :format(bit.band(ip_result, 0xffffffff))
        end
        if ip_result ~= 0 then
            return nil, ("nifm IP Result %#x despite address"):format(
                bit.band(ip_result, 0xffffffff))
        end
        self.ip = types.ipv4(ip_n)
        return true
    end

    function self:initialize()
        if self.initialized then return self:refresh_ip() end
        if not self.nifm_started then
            local ni, why = self:i32("nifm_init", {})
            if ni == nil then return nil, "nifm::Initialize dispatch: " .. tostring(why) end
            if ni ~= 0 then return nil, ("nifm::Initialize Result %#x"):format(bit.band(ni, 0xffffffff)) end
            self.nifm_started = true
            local submitted, submit_why = self:raw("nifm_submit_now", {})
            if not submitted then return nil, "nifm request: " .. tostring(submit_why) end
        end
        local ready, ip_why = self:refresh_ip()
        if not ready then return nil, ip_why end

        self.pool = ffi.new("uint8_t[?]", POOL_SIZE + 0x4000)
        local raw = tonumber(ffi.cast("uintptr_t", self.pool))
        local aligned = raw + (0x4000 - raw % 0x4000) % 0x4000
        local si, si_why = self:i32("sock_init", {aligned, POOL_SIZE,
                                                 ALLOC_POOL, CONCURRENCY})
        if si == nil then return nil, "socket::Initialize dispatch: " .. tostring(si_why) end
        if si ~= 0 then
            return nil, ("socket::Initialize Result %#x"):format(bit.band(si, 0xffffffff))
        end
        self.initialized = true
        return true
    end

    function self:nonblocking(fd)
        local flags, why = self:i32("fcntl", {fd, types.F_GETFL, 0})
        if flags == nil then return nil, why end
        if flags < 0 then return nil, socket_error("F_GETFL", flags) end
        local r, rwhy = self:i32("fcntl", {fd, types.F_SETFL,
                                          bit.bor(flags, types.O_NONBLOCK_NX)})
        if r == nil then return nil, rwhy end
        if r < 0 then return nil, socket_error("F_SETFL", r) end
        return true
    end

    function self:close(fd)
        if type(fd) ~= "number" or fd < 0 then return false end
        return self:i32("close", {fd})
    end

    function self:listener(port, backlog)
        if not self.initialized then return nil, "socket service not initialized" end
        local fd, why = self:i32("socket", {types.AF_INET, types.SOCK_STREAM,
                                           types.IPPROTO_TCP})
        if fd == nil then return nil, why end
        if fd < 0 then return nil, socket_error("socket", fd) end
        local function fail(msg) self:close(fd); return nil, msg end
        local nb, nbwhy = self:nonblocking(fd)
        if not nb then return fail(nbwhy) end
        local yes = ffi.new("int[1]", 1)
        local reuse, reusewhy = self:i32("setsockopt", {fd, types.SOL_SOCKET,
                              types.SO_REUSEADDR, yes, ffi.sizeof("int")})
        if reuse == nil then return fail(reusewhy) end
        if reuse < 0 then return fail(socket_error("SO_REUSEADDR", reuse)) end
        local sa = ffi.new("ls_sockaddr[1]")
        sa[0] = types.sockaddr_in(port, 0)
        local b, bwhy = self:i32("bind", {fd, sa, ffi.sizeof(sa[0])})
        if b == nil then return fail(bwhy) end
        if b < 0 then return fail(socket_error("bind", b)) end
        local l, lwhy = self:i32("listen", {fd, backlog or 4})
        if l == nil then return fail(lwhy) end
        if l < 0 then return fail(socket_error("listen", l)) end
        return fd
    end

    self.pollfd = ffi.new("ls_pollfd[1]")
    self.iobuf = ffi.new("uint8_t[?]", MAX_IO)
    self.addrbuf = ffi.new("ls_sockaddr[1]")
    self.addrlen = ffi.new("uint32_t[1]", 16)

    function self:ready(fd, events)
        local fds = self.pollfd
        fds[0].revents = 0
        fds[0].fd, fds[0].events = fd, events
        local count, why = self:i32("poll", {fds, 1, 0})
        if count == nil then return nil, why end
        if count < 0 then return nil, socket_error("poll", count) end
        if count == 0 then return false end
        local revents = tonumber(fds[0].revents)
        return bit.band(revents, bit.bor(events, types.POLLHUP, types.POLLERR)) ~= 0
    end

    function self:transport()
        local io = {}
        function io.accept(listener)
            local ready, why = self:ready(listener, types.POLLIN)
            if ready == nil then return nil, why end
            if not ready then return nil, "would_block" end
            local sa, n = self.addrbuf, self.addrlen
            n[0] = ffi.sizeof("ls_sockaddr")
            local fd, err = self:i32("accept", {listener, sa, n})
            if fd == nil then return nil, err end
            if fd < 0 then
                local code = self:last_error()
                return nil, WOULD_BLOCK[code] and "would_block" or socket_error("accept", fd)
            end
            local nb, nbwhy = self:nonblocking(fd)
            if not nb then self:close(fd); return nil, nbwhy end
            local peer = "peer unknown"
            if tonumber(n[0]) >= 8 and sa[0].family == types.AF_INET then
                peer = ("%s:%d"):format(types.ipv4(tonumber(sa[0].addr)),
                    tonumber(sa[0].port_hi) * 256 + tonumber(sa[0].port_lo))
            end
            return fd, peer
        end
        function io.recv(fd, requested)
            local ready, why = self:ready(fd, types.POLLIN)
            if ready == nil then return nil, why end
            if not ready then return nil, "would_block" end
            local size = math.min(MAX_IO, requested)
            local buf = self.iobuf
            local n, err = self:i64("recv", {fd, buf, size, 0})
            if n == nil then return nil, err end
            if n == 0xffffffff then n = -1 end
            if n < 0 then
                local code = self:last_error()
                return nil, WOULD_BLOCK[code] and "would_block" or socket_error("recv", n)
            end
            if n == 0 then return "", "eof" end
            if n > size then return nil, "recv exceeded supplied buffer" end
            return ffi.string(buf, n)
        end
        function io.send(fd, data)
            if type(data) ~= "string" then return nil, "send expects bytes" end
            if #data == 0 then return 0 end
            local ready, why = self:ready(fd, types.POLLOUT)
            if ready == nil then return nil, why end
            if not ready then return nil, "would_block" end
            local size = math.min(MAX_IO, #data)
            local buf = self.iobuf
            ffi.copy(buf, data, size)
            local n, err = self:i64("send", {fd, buf, size, 0})
            if n == nil then return nil, err end
            if n == 0xffffffff then n = -1 end
            if n < 0 then
                local code = self:last_error()
                return nil, WOULD_BLOCK[code] and "would_block" or socket_error("send", n)
            end
            if n > size then return nil, "send exceeded supplied buffer" end
            return n
        end
        function io.close(fd) return self:close(fd) end
        return io
    end

    return self
end

return M
