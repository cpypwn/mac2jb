-- PC socket transport using luasocket (bundled with LÖVE).
-- Provides the same nonblocking transport API as the Switch FFI version.
local M = {}

function M.new()
    local socket = require("socket")
    local self = { ip = nil, listeners = {} }

    function self:initialize()
        local s = socket.udp()
        s:setpeername("8.8.8.8", 80)
        self.ip = s:getsockname()
        s:close()
        if not self.ip or self.ip == "0.0.0.0" then
            return nil, "pending: no IP available"
        end
        return true
    end

    function self:listener(port, backlog)
        local server, err = socket.bind("0.0.0.0", port, backlog or 4)
        if not server then return nil, "bind: " .. tostring(err) end
        server:settimeout(0)
        local fd = #self.listeners + 1
        self.listeners[fd] = server
        return fd
    end

    function self:close(fd)
        if type(fd) == "number" and self.listeners[fd] then
            self.listeners[fd]:close()
            self.listeners[fd] = nil
            return true
        end
        if type(fd) == "table" and fd.close then
            fd:close()
            return true
        end
        return false
    end

    function self:transport()
        local io = {}
        function io.accept(listener_fd)
            local server = self.listeners[listener_fd]
            if not server then return nil, "invalid listener" end
            local client, err = server:accept()
            if not client then
                return nil, err == "timeout" and "would_block" or tostring(err)
            end
            client:settimeout(0)
            local peer = client:getpeername()
            return client, peer or "peer unknown"
        end
        function io.recv(fd, requested)
            if not fd then return nil, "invalid fd" end
            local data, err, partial = fd:receive(requested)
            if data then return data end
            if partial and #partial > 0 then return partial end
            if err == "timeout" then return nil, "would_block" end
            if err == "closed" then return "", "eof" end
            return nil, tostring(err)
        end
        function io.send(fd, data)
            if not fd then return nil, "invalid fd" end
            local n, err = fd:send(data)
            if n then return n end
            if err == "timeout" then return nil, "would_block" end
            return nil, tostring(err)
        end
        function io.close(fd)
            if fd and type(fd) ~= "number" then pcall(fd.close, fd) end
            return true
        end
        return io
    end

    return self
end

return M
