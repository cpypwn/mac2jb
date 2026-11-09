local ftp = require("gc.ftp")
local M = {}
local CHUNK, MAX_COMMAND, DATA_WAIT = 4096, 8192, 15
local MAX_SESSIONS = 4

local function host_of(peer)
    if type(peer) ~= "string" then return nil end
    return peer:match("^([^:]+):") or peer
end

function M.new(io, fs, control_listener, passive_listener, ip, passive_port, clock, on_event)
    assert(io and fs and control_listener and passive_listener and ip and passive_port)
    clock = clock or function() return love.timer.getTime() end
    local self = { io=io, fs=fs, control_listener=control_listener,
                   passive_listener=passive_listener,
                   sessions={}, transfers=0, commands=0, max_sessions=MAX_SESSIONS }
    local function emit(kind, detail)
        if on_event then pcall(on_event, kind, detail) end
    end
    local function enqueue(st, line)
        st.out = st.out .. line .. "\r\n"
    end
    local function drop_data(st, reason)
        if st.data_fd then
            io.close(st.data_fd)
            st.data_fd = nil
        end
        st.data_peer = nil
        st.plan, st.pasv = nil, false
        st.parts, st.total, st.data_pos = nil, nil, nil
    end
    local function forget(st, reason)
        drop_data(st, reason)
        io.close(st.fd)
        for i, other in ipairs(self.sessions) do
            if other == st then table.remove(self.sessions, i); break end
        end
        emit("disconnect", ("%s %s"):format(st.peer or "?", reason or "done"))
    end

    function self:close(reason)
        while self.sessions[1] do forget(self.sessions[1], reason) end
    end

    local function purge_passive(expect_host)
        local dropped = 0
        for _ = 1, 8 do
            local fd, peer = io.accept(self.passive_listener)
            if not fd then break end
            if expect_host and host_of(peer) == expect_host then
                return fd, peer, dropped
            end
            io.close(fd)
            dropped = dropped + 1
        end
        return nil, nil, dropped
    end

    local function accept_control()
        local fd, peer_or_err = io.accept(self.control_listener)
        if not fd then
            return peer_or_err == "would_block" and "idle"
                or "accept: " .. tostring(peer_or_err)
        end
        if #self.sessions >= self.max_sessions then
            io.send(fd, "421 too many connections\r\n")
            io.close(fd)
            return "refused"
        end
        local st = {fd=fd, peer=peer_or_err, core=ftp.new(fs, {ip=ip, port=passive_port}),
                    input="", out="", plan=nil, data_fd=nil, pasv=false,
                    closing=false, parts=nil, total=0, data_pos=1}
        self.sessions[#self.sessions + 1] = st
        emit("connect", ("%s %d/%d"):format(peer_or_err or "?",
            #self.sessions, self.max_sessions))
        enqueue(st, "220 love-save-shadow FTP")
        return "accepted"
    end

    local function advance(st)
        if #st.out > 0 then
            local n, err = io.send(st.fd, st.out:sub(1, CHUNK))
            if not n then
                if err == "would_block" then return "waiting-control" end
                forget(st, "control send: " .. tostring(err))
                return "control send error"
            end
            st.out = st.out:sub(n + 1)
            return "control-written"
        end
        if st.closing then forget(st, "QUIT"); return "closed" end

        if st.plan then
            if not st.data_fd then
                if clock() - st.plan_started > DATA_WAIT then
                    forget(st, "PASV data timeout")
                    return "data-timeout"
                end
                local fd, peer = purge_passive(host_of(st.peer))
                if not fd then return "waiting-data" end
                st.data_fd, st.data_peer = fd, peer
                st.parts, st.total, st.data_pos = {}, 0, 1
                return "data-accepted"
            end
            if st.plan.op == "send" then
                local data = st.plan.data or ""
                if st.data_pos > #data then
                    emit("transfer", ("RETR/LIST %s %dB"):format(st.plan.path or "/", #data))
                    drop_data(st); self.transfers = self.transfers + 1
                    enqueue(st, "226 transfer complete")
                    return "data-sent"
                end
                local n, err = io.send(st.data_fd, data:sub(st.data_pos, st.data_pos + CHUNK - 1))
                if not n then
                    if err == "would_block" then return "waiting-data" end
                    drop_data(st, "send error"); enqueue(st, "426 data send failed")
                    return "data-send-error"
                end
                st.data_pos = st.data_pos + n
                return "data-writing"
            end
            if st.plan.op == "receive" then
                local data, err = io.recv(st.data_fd, CHUNK)
                if not data then
                    if err == "would_block" then return "waiting-data" end
                    drop_data(st, "recv error"); enqueue(st, "426 data recv failed")
                    return "data-recv-error"
                end
                if #data > 0 then
                    st.total = st.total + #data
                    if st.total > st.plan.max_bytes then
                        drop_data(st, "oversize"); enqueue(st, "552 upload too large")
                        return "oversize"
                    end
                    st.parts[#st.parts + 1] = data
                    return "data-reading"
                end
                local result = st.plan.complete(table.concat(st.parts))
                emit("transfer", ("STOR %s %dB %s"):format(
                    st.plan.path or "?", st.total, tostring(result)))
                drop_data(st)
                self.transfers = self.transfers + 1
                enqueue(st, result)
                return "data-received"
            end
            drop_data(st); enqueue(st, "451 unknown transfer")
            return "bad-plan"
        end

        local newline = st.input:find("\n", 1, true)
        if not newline then
            local data, err = io.recv(st.fd, CHUNK)
            if not data then
                if err == "would_block" then return "waiting-control" end
                forget(st, "control recv: " .. tostring(err))
                return "control recv error"
            end
            if #data == 0 then forget(st, "client EOF"); return "control-eof" end
            st.input = st.input .. data
            if #st.input > MAX_COMMAND then
                enqueue(st, "500 command too long")
                st.input = ""; st.closing = true
                return "command-overflow"
            end
            return "control-read"
        end
        local line = st.input:sub(1, newline - 1):gsub("\r$", "")
        st.input = st.input:sub(newline + 1)
        local command = (line:match("^(%a+)") or "?"):upper()
        emit("command", ("%s %s"):format(st.peer or "?",
            command == "PASS" and "PASS [redacted]" or line:sub(1, 160)))
        local reply, plan = st.core:handle(line)
        self.commands = self.commands + 1
        if reply:match("^227 ") then
            st.pasv = true
            purge_passive(nil)
        end
        if plan and (plan.op == "send" or plan.op == "receive") then
            if not st.pasv then enqueue(st, "425 use PASV first"); return "need-pasv" end
            st.plan = plan
            st.plan_started = clock()
        elseif plan and plan.op == "close" then
            st.closing = true
        end
        enqueue(st, reply)
        return "command"
    end

    function self:step()
        if #self.sessions == 0 then return accept_control() end
        local outcome = "idle"
        self.cursor = ((self.cursor or 0) % #self.sessions) + 1
        local st = self.sessions[self.cursor]
        if st then outcome = advance(st) end
        local accepted = accept_control()
        if accepted ~= "idle" then return accepted end
        return outcome
    end

    return self
end

return M
