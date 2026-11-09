local M = {}

function M.new(io, listener, evaluate, options)
    assert(type(io) == "table" and type(evaluate) == "function")
    options = options or {}
    local self = {io=io, listener=listener, evaluate=evaluate,
                  max_request=options.max_request or 32768,
                  max_reply=options.max_reply or 65536,
                  chunk=options.chunk or 4096,
                  on_event=options.on_event, client=nil, handled=0}
    local function emit(kind, detail)
        if self.on_event then pcall(self.on_event, kind, detail) end
    end

    function self:close(reason)
        local st = self.client
        if st then
            self.io.close(st.fd)
            self.client = nil
            emit("disconnect", ("%s fd=%s %s"):format(st.peer or "?",
                tostring(st.fd), reason or "done"))
        end
    end

    function self:step()
        local st = self.client
        if not st then
            local fd, peer_or_err = self.io.accept(self.listener)
            if not fd then
                return peer_or_err == "would_block" and "idle"
                    or ("accept: " .. tostring(peer_or_err))
            end
            self.client = {fd=fd, peer=peer_or_err, parts={}, bytes=0, state="reading"}
            emit("connect", ("%s fd=%s"):format(peer_or_err or "?", tostring(fd)))
            return "accepted"
        end

        if st.state == "reading" then
            local data, err = self.io.recv(st.fd, self.chunk)
            if data and #data > 0 then
                st.bytes = st.bytes + #data
                if st.bytes > self.max_request then
                    st.parts, st.reply, st.sent = nil, "request too large\n", 0
                    st.state = "writing"
                    return "too-large"
                end
                st.parts[#st.parts + 1] = data
                return "read"
            end
            if err == "would_block" then return "waiting" end
            if data == "" or err == "eof" then
                local request = table.concat(st.parts)
                st.parts = nil
                local preview = request:gsub("[%c]", " "):gsub("%s+", " "):sub(1, 160)
                emit("call", ("#%d %s %dB %s"):format(self.handled + 1,
                    st.peer or "?", #request, preview))
                local ok, reply = pcall(self.evaluate, request)
                reply = ok and reply or "internal evaluation error\n"
                if type(reply) ~= "string" then reply = "invalid reply\n" end
                self.handled = self.handled + 1
                st.reply = (#reply <= self.max_reply) and reply or "reply too large\n"
                emit("reply", ("#%d %dB"):format(self.handled, #st.reply))
                st.sent = 0
                st.state = "writing"
                return "evaluated"
            end
            self:close("recv: " .. tostring(err))
            return "recv: " .. tostring(err)
        end

        if st.sent == #st.reply then self:close("reply sent"); return "done" end
        local n, err = self.io.send(st.fd, st.reply:sub(st.sent + 1))
        if not n then
            if err == "would_block" then return "waiting" end
            self:close("send: " .. tostring(err))
            return "send: " .. tostring(err)
        end
        st.sent = st.sent + n
        if st.sent == #st.reply then self:close("reply sent"); return "done" end
        return "partial-send"
    end
    return self
end

return M
