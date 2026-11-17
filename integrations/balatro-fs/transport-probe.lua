local M = {}

local HELLO_BYTES = 128
local SCRATCH_BYTES = 0x80000
local SCRATCH_OFFSET = 0x10000

local function greeting(ffi, bridge)
    local words = ffi.new("uint64_t[16]")
    local values = {
        0x31545344, 1, 2, bridge.scratch, SCRATCH_BYTES,
        bridge.info.main_base, bridge.info.sdk_base, 0,
        bridge.info.sdk_base + bridge.memmoveOffset, 0, 0,
        0, 0, 0, 0, bridge.sdkCrc32,
    }
    for index = 1, 16 do words[index - 1] = ffi.cast("uint64_t", values[index]) end
    return ffi.string(ffi.cast("const char*", words), HELLO_BYTES)
end

function M.install(b, options)
    assert(type(b) == "table" and b.state == "serving" and b.rpc and b.net,
           "Balatro RPC and network must be serving")
    assert(type(options) == "table" and type(options.hostIp) == "string" and
           type(options.nonce) == "string" and type(options.sdkCrc32) == "number" and
           type(options.memmoveOffset) == "number" and
           type(options.port) == "number" and options.port >= 1024 and
           options.port <= 65535 and options.port % 1 == 0,
           "Invalid Balatro transport profile")
    local existing = b.fs_transport
    if existing and existing.stage ~= "closed" then
        assert(existing.hostIp == options.hostIp and existing.owner == options.nonce and
               existing.port == options.port,
               "Another Balatro transport owns the listener")
        return "BAL_TRANSPORT_V1\treused\t" .. tostring(existing.port)
    end
    local held = b.fs_bridge
    assert(held and held.stage == "ready" and held.owner == options.nonce and
           held.bytes == 0x200000 and held.base % 4096 == 0 and
           held.buf and not b.fs_worker_hold, "Verified Balatro arena is unavailable")
    local ffi = require("ffi")
    local raw = tonumber(ffi.cast("uintptr_t", held.buf))
    assert(raw and held.base >= raw + 64 and
           held.base + held.bytes + 64 <= raw + ffi.sizeof(held.buf) and
           held.before == held.base - raw - 64 and
           held.after == held.base - raw + held.bytes,
           "Balatro arena bounds changed")
    for index = 0, 63 do
        assert(tonumber(held.buf[held.before + index]) == 165 and
               tonumber(held.buf[held.after + index]) == 165,
               "Balatro arena guard changed")
    end
    local listener, reason = b.net:listener(options.port)
    assert(listener, "Balatro transport listener failed: " .. tostring(reason))
    local bridge = {
        port = options.port, owner = options.nonce, hostIp = options.hostIp,
        sdkCrc32 = options.sdkCrc32, memmoveOffset = options.memmoveOffset,
        info = b.info, arena = held, listener = listener, client = nil,
        scratch = held.base + SCRATCH_OFFSET, sent = 0,
        io = b.net:transport(), stage = "accept", accepted = 0,
        rejectedPeers = 0, lastPeer = "",
    }
    bridge.hello = greeting(ffi, bridge)

    function bridge:close()
        if self.client then pcall(self.io.close, self.client); self.client = nil end
        if self.listener then pcall(self.io.close, self.listener); self.listener = nil end
        self.stage = "closed"
    end

    function bridge:step()
        if self.stage == "closed" then return end
        if self.native then return self:stepNative() end
        if self.stage == "accept" then
            local fd, peer = self.io.accept(self.listener)
            if not fd then
                if peer == "would_block" then return end
                error("Balatro transport accept failed: " .. tostring(peer))
            end
            if type(peer) ~= "string" or
               peer:match("^([^:]+):") ~= self.hostIp then
                self.io.close(fd)
                return
            end
            self.client = fd
            self.sent = 0
            self.stage = "send-hello"
            self.accepted = self.accepted + 1
            return
        end
        local sent, reason = self.io.send(self.client, self.hello:sub(self.sent + 1))
        if not sent then
            if reason == "would_block" then return end
            error("Balatro transport hello failed: " .. tostring(reason))
        end
        assert(sent > 0 and self.sent + sent <= HELLO_BYTES,
               "Balatro transport sent an invalid byte count")
        self.sent = self.sent + sent
        if self.sent == HELLO_BYTES then
            self.io.close(self.client)
            self.client = nil
            self.stage = "accept"
        end
    end

    if not b.fs_transport_original_step then
        b.fs_transport_original_step = b.rpc.step
        b.rpc.step = function(rpc)
            local status = b.fs_transport_original_step(rpc)
            local active = b.fs_transport
            if active and active.stage ~= "closed" then
                local ok, reason = pcall(active.step, active)
                if not ok then
                    b.fs_transport_last_error = tostring(reason)
                    active:close()
                    b.log.log("[FS] Balatro transport: " .. tostring(reason))
                end
            end
            return status
        end
    end
    b.fs_transport_last_error = nil
    b.fs_transport = bridge
    return "BAL_TRANSPORT_V1\tlistening\t" .. tostring(options.port)
end

return M
