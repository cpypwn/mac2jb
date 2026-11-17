local M = {}

local REQUEST_BYTES = 0x8080
local RESPONSE_BYTES = 0x8010
local INPUT_OFFSET = 0x40000
local HEADER_OFFSET = 0x4030
local SCRATCH_BYTES = 0x80000
local SDK_CODE_BYTES = 6160384

local function word(ffi, address)
    return ffi.cast("const uint64_t*", ffi.cast("uintptr_t", address))[0]
end

local function writeWord(ffi, address, value)
    ffi.cast("uint64_t*", ffi.cast("uintptr_t", address))[0] =
        ffi.cast("uint64_t", value)
end

local function checkArena(ffi, arena)
    if not arena or arena.stage ~= "ready" or arena.bytes ~= 0x200000 or
       not arena.buf then return false end
    local raw = tonumber(ffi.cast("uintptr_t", arena.buf))
    if not raw or arena.base < raw + 64 or
       arena.base + arena.bytes + 64 > raw + ffi.sizeof(arena.buf) or
       arena.before ~= arena.base - raw - 64 or
       arena.after ~= arena.base - raw + arena.bytes then return false end
    for index = 0, 63 do
        if tonumber(arena.buf[arena.before + index]) ~= 165 or
           tonumber(arena.buf[arena.after + index]) ~= 165 then return false end
    end
    return true
end

local function nativeCall(self, address, args)
    assert(type(address) == "number" and
           address >= self.info.sdk_base and
           address + 4 <= self.info.sdk_base + SDK_CODE_BYTES and
           address % 4 == 0,
           "Native request has an invalid function address")
    local result, reason = self.invoke(self.ffi, self.victim, self.info, address, args)
    assert(result and result.raw, "Native call failed: " .. tostring(reason))
    return result.raw
end

local function dispatch(self)
    local ffi = self.ffi
    local packet = self.scratch + INPUT_OFFSET
    local first = tonumber(word(ffi, packet))
    local second = tonumber(word(ffi, packet + 0x28))
    assert(first and second, "Native request has an invalid function address")
    if first == 0 and second == 0 then
        local header = ffi.cast("const uint8_t*", packet)
        for index = 0, 0x7f do
            assert(header[index] == 0, "Unsupported native control request")
        end
        self:close()
        return "closed"
    end
    local function args(at, count)
        local values = {}
        for index = 1, count do values[index] = word(ffi, at + index * 8) end
        return values
    end
    local a, b = 0, 0
    if second == 2 then
        assert(first ~= 0, "Six-argument continuation has no function")
        local six = args(packet, 4)
        six[5] = word(ffi, packet + 0x30)
        six[6] = word(ffi, packet + 0x38)
        a = nativeCall(self, first, six)
    else
        if first ~= 0 then a = nativeCall(self, first, args(packet, 4)) end
        if second ~= 0 then b = nativeCall(self, second, args(packet + 0x28, 4)) end
    end
    writeWord(ffi, self.scratch + HEADER_OFFSET, b)
    writeWord(ffi, self.scratch + HEADER_OFFSET + 8, a)
    self.stage = "send-response"
    self.sent = 0
    return "processed"
end

local function accept(self)
    local fd, peer = self.io.accept(self.listener)
    if not fd then
        if peer == "would_block" then return "waiting" end
        error("Balatro native bridge accept failed: " .. tostring(peer))
    end
    if type(peer) ~= "string" or peer:match("^([^:]+):") ~= self.hostIp then
        self.rejectedPeers = (self.rejectedPeers or 0) + 1
        self.lastPeer = tostring(peer)
        self.io.close(fd)
        return "wrong-peer"
    end
    self.client = fd
    self.accepted = (self.accepted or 0) + 1
    self.lastPeer = peer
    self.sent = 0
    self.received = 0
    self.stage = "send-hello"
    return "accepted"
end

local function send(self)
    local data = self.stage == "send-hello" and self.hello or
        self.ffi.string(self.ffi.cast("const char*", self.scratch + HEADER_OFFSET),
                        RESPONSE_BYTES)
    local sent, reason = self.io.send(self.client, data:sub(self.sent + 1))
    if not sent then
        if reason == "would_block" then return "waiting" end
        error("Balatro native bridge send failed: " .. tostring(reason))
    end
    assert(sent > 0 and self.sent + sent <= #data,
           "Balatro native bridge sent an invalid byte count")
    self.sent = self.sent + sent
    if self.sent == #data then
        self.stage = "read-request"
        self.sent = 0
        self.received = 0
    end
    return "sending"
end

local function receive(self)
    local chunk, reason = self.io.recv(self.client, REQUEST_BYTES - self.received)
    if not chunk then
        if reason == "would_block" then return "waiting" end
        error("Balatro native bridge receive failed: " .. tostring(reason))
    end
    if #chunk == 0 then self:close(); return "disconnected" end
    assert(#chunk <= REQUEST_BYTES - self.received,
           "Balatro native bridge request exceeded the frame")
    self.ffi.copy(self.ffi.cast("uint8_t*",
        self.scratch + INPUT_OFFSET + self.received), chunk, #chunk)
    self.received = self.received + #chunk
    if self.received == REQUEST_BYTES then return dispatch(self) end
    return "receiving"
end

function M.enable(b, options)
    assert(type(b) == "table" and b.state == "serving" and
           type(options) == "table" and options.approved == true,
           "Balatro native bridge requires explicit approval")
    assert(type(b.info) == "table" and b.info.version == "1.0.1f-FULL" and
           type(b.info.sdk_base) == "number" and
           b.info.sdk_base > 0 and b.info.sdk_base < 2 ^ 39,
           "Balatro native bridge requires the pinned runtime")
    local bridge = assert(b.fs_transport, "Balatro transport is absent")
    assert(bridge.stage == "accept" and not bridge.client and
           bridge.owner == options.nonce and bridge.hostIp == options.hostIp and
           bridge.port == options.port and bridge.port ~= 39380 and
           bridge.info == b.info and bridge.arena == b.fs_bridge and
           not b.fs_worker_hold,
           "Balatro transport does not match the verified owner")
    local ffi = require("ffi")
    assert(checkArena(ffi, bridge.arena) and
           bridge.scratch == bridge.arena.base + 0x10000 and
           bridge.scratch + SCRATCH_BYTES <= bridge.arena.base + bridge.arena.bytes,
           "Balatro arena or guard changed")
    if bridge.native then
        return "BAL_NATIVE_V1\treused\t" .. bridge.port .. "\t" .. bridge.owner
    end
    local native = options.invoke or require("bl.ffi_call").gp_invoke
    assert(type(native) == "function", "Balatro native adapter is unavailable")
    bridge.ffi = ffi
    bridge.invoke = native
    assert(love and love.graphics and type(love.graphics.present) == "function",
           "Balatro native bridge requires the graphics callback")
    bridge.victim = love.graphics.present
    bridge.received = 0
    bridge.native = true
    bridge.stepNative = function(self)
        if self.stage == "accept" then return accept(self) end
        if self.stage == "send-hello" or self.stage == "send-response" then
            return send(self)
        end
        if self.stage == "read-request" then return receive(self) end
        if self.stage == "closed" then return "closed" end
        error("Balatro native bridge has an invalid stage")
    end
    return "BAL_NATIVE_V1\tready\t" .. bridge.port .. "\t" .. bridge.owner
end

function M.reserveAppArena(b, options)
    local bridge = assert(b and b.fs_transport, "Balatro transport is absent")
    assert(bridge.native and bridge.stage == "accept" and not bridge.client and
           bridge.owner == options.nonce and bridge.hostIp == options.hostIp and
           bridge.port == options.port,
           "Balatro native bridge is busy or belongs to another owner")
    local bytes = options.bytes
    assert(bytes == 0x80000 or bytes == 0x2400000 and options.allowLarge == true,
           "Unsupported Balatro app arena request")
    if bridge.appArenaBytes and bridge.appArenaBytes >= bytes then
        return string.format("BAL_APP_ARENA_V1\t0x%x\t%d", bridge.appArenaBase,
                             bridge.appArenaBytes)
    end
    local ffi = bridge.ffi
    local buf = ffi.new("uint8_t[?]", bytes + 0x1000 + 128)
    local raw = tonumber(ffi.cast("uintptr_t", buf))
    local base = raw + (0x1000 - raw % 0x1000) % 0x1000
    assert(base >= raw + 64 and base + bytes + 64 <= raw + ffi.sizeof(buf) and
           base + bytes < 2 ^ 39 and
           (base + bytes <= bridge.scratch or
            base >= bridge.scratch + SCRATCH_BYTES),
           "Balatro app arena is outside the verified address range")
    local before, after = base - raw - 64, base - raw + bytes
    for index = 0, 63 do buf[before + index] = 165; buf[after + index] = 165 end
    local hello = ffi.new("uint8_t[128]")
    ffi.copy(hello, bridge.hello, 128)
    local words = ffi.cast("uint64_t*", hello)
    words[11] = ffi.cast("uint64_t", base)
    words[12] = ffi.cast("uint64_t", bytes)
    bridge.retiredAppArenas = bridge.retiredAppArenas or {}
    if bridge.appArena then
        bridge.retiredAppArenas[#bridge.retiredAppArenas + 1] = bridge.appArena
    end
    bridge.appArena, bridge.appArenaBase, bridge.appArenaBytes = buf, base, bytes
    bridge.appArenaBefore, bridge.appArenaAfter = before, after
    bridge.hello = ffi.string(hello, 128)
    return string.format("BAL_APP_ARENA_V1\t0x%x\t%d", base, bytes)
end

return M
