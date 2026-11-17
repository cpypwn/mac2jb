local M = {}

local REQUEST_BYTES = 0x8080
local RESPONSE_BYTES = 0x8010
local SCRATCH_BYTES = 0x80000
local INPUT_OFFSET = 0x40000
local OUTPUT_OFFSET = 0x4040
local HEADER_OFFSET = 0x4030
local PROGRESS_MAGIC = 0x47504353
local COMPACT_MAGIC = 0x504d4347
local PROGRESS_LABELS = {
    "1/4 Checking the console",
    "2/4 Acquiring FS memory",
    "3/4 Starting the native helper",
    "4/4 Running the FS demo",
    "2/4 Acquiring FS memory",
    "2/4 Measuring FS canary geometry",
}

local function exact_address(value)
    return type(value) == "number" and value % 1 == 0 and value >= 0x1000
        and value < 2 ^ 39 and value % 4 == 0
end

local function signature_matches(ffi, address, expected)
    if type(expected) ~= "string" or #expected < 8 or #expected > 512
        or #expected % 2 ~= 0 or expected:find("[^0-9a-f]") then return false end
    local bytes = ffi.cast("const uint8_t*", ffi.cast("uintptr_t", address))
    for i = 0, #expected / 2 - 1 do
        if tonumber(bytes[i]) ~= tonumber(expected:sub(i * 2 + 1, i * 2 + 2), 16) then
            return false
        end
    end
    return true
end

local function checked_profile(ffi, info, profile)
    assert(info and info.game_id == "gravity-circuit", "Gravity Circuit native image is not verified")
    assert(info.profile == "gravity-circuit-v1.0" or
           info.profile == "gravity-circuit-v1.2.1", "Unknown Gravity Circuit build")
    assert(exact_address(info.main_base) and exact_address(info.sdk_base) and
           info.main_base % 4096 == 0 and info.sdk_base % 4096 == 0,
           "Native module bases are not exact page addresses")
    assert(type(profile) == "table" and profile.gameProfile == info.profile,
           "FS profile does not match the running Gravity Circuit build")
    assert(type(profile.sdkBytes) == "number" and profile.sdkBytes > 0x1000
           and profile.sdkBytes < 0x2000000, "FS profile needs a measured SDK size")
    assert(type(profile.sdkCrc32) == "number" and profile.sdkCrc32 >= 0
           and profile.sdkCrc32 <= 0xffffffff and profile.sdkCrc32 % 1 == 0,
           "FS profile needs a measured SDK CRC-32")
    local octets = type(profile.hostIp) == "string" and
        {profile.hostIp:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")} or nil
    assert(octets and #octets == 4 and
           tonumber(octets[1]) <= 255 and tonumber(octets[2]) <= 255 and
           tonumber(octets[3]) <= 255 and tonumber(octets[4]) <= 255,
           "FS profile needs the Mac IPv4 address")
    assert(profile.port == nil or type(profile.port) == "number" and
           profile.port % 1 == 0 and profile.port >= 1024 and profile.port <= 65535,
           "FS profile has an invalid TCP port")
    for _, name in ipairs({"memmove", "queryMemory"}) do
        local entry = profile[name]
        assert(type(entry) == "table" and type(entry.offset) == "number" and
               entry.offset % 4 == 0 and entry.offset >= 0 and
               entry.offset + #tostring(entry.bytes or "") / 2 <= profile.sdkBytes,
               "FS profile needs a measured " .. name .. " offset")
        assert(signature_matches(ffi, info.sdk_base + entry.offset, entry.bytes),
               "FS profile " .. name .. " instructions differ from the running SDK")
    end
    assert(profile.memmove.offset % 8 == 0,
           "FS profile memmove address must be eight-byte aligned")
    return profile
end

local function write_word(ffi, address, value)
    ffi.cast("uint64_t*", ffi.cast("uintptr_t", address))[0] = ffi.cast("uint64_t", value)
end

local function read_word(ffi, address)
    return ffi.cast("uint64_t*", ffi.cast("uintptr_t", address))[0]
end

local function hello(ffi, scratch, info, profile, appArenaBase, appArenaBytes)
    local bytes = ffi.new("uint64_t[16]")
    local fields = {
        0x31545344, 1, 2, scratch, SCRATCH_BYTES, info.main_base, info.sdk_base,
        0, info.sdk_base + profile.memmove.offset, 0, 0,
        appArenaBase or 0, appArenaBytes or 0, 0, 0, profile.sdkCrc32
    }
    for i = 1, 16 do bytes[i - 1] = ffi.cast("uint64_t", fields[i]) end
    return ffi.string(ffi.cast("const char*", bytes), 128)
end

local function call_native(bridge, address, args)
    if not exact_address(address) then error("Invalid native function address") end
    local result, why = bridge.invoke(bridge.ffi, bridge.victim, bridge.info, address, args)
    if not result then error("Native call failed: " .. tostring(why)) end
    return result.raw
end

function M.new(LS, profile, options)
    options = options or {}
    assert(LS and LS.state == "serving" and LS.nx_info and LS.net and LS.rpc,
           "Gravity Circuit native REPL is not serving")
    local ffi = options.ffi or require("ffi")
    local ffi_call = options.ffi_call or require("gc.ffi_call")
    local info = LS.nx_info
    checked_profile(ffi, info, profile)
    local arena = ffi.new("uint8_t[?]", SCRATCH_BYTES + 0x1000)
    local raw = tonumber(ffi.cast("uintptr_t", arena))
    local scratch = raw + (0x1000 - raw % 0x1000) % 0x1000
    assert(exact_address(scratch), "Scratch allocation is outside the protocol address range")
    local net = LS.net
    local listener, why = net:listener(profile.port or 39380)
    if not listener then error("FS bridge listener failed: " .. tostring(why)) end
    local self = {
        ffi = ffi, info = info, profile = profile, victim = love.graphics.present,
        invoke = options.invoke or ffi_call.gp_invoke, arena = arena, scratch = scratch,
        io = options.io or net:transport(), net = net, listener = listener,
        log = LS.log.log,
        client = nil, stage = "accept", inputCount = 0, outputCount = 0,
        compact = false, compactOutputBytes = 0, compactAfterResponse = false,
        greeting = hello(ffi, scratch, info, profile), error = nil
    }

    function self:reserveAppArena(bytes)
        assert(self.stage == "accept", "FS bridge is not idle")
        assert(bytes == 0x80000 or bytes == 0x2400000,
               "Unsupported Gravity Circuit app arena size")
        if not self.appArenaBase or self.appArenaBytes < bytes then
            local owned = ffi.new("uint8_t[?]", bytes + 0x1000)
            local rawOwned = tonumber(ffi.cast("uintptr_t", owned))
            local base = rawOwned + (0x1000 - rawOwned % 0x1000) % 0x1000
            assert(exact_address(base) and base % 0x1000 == 0 and
                   base + bytes < 2 ^ 39, "App arena is outside the protocol address range")
            assert(base + bytes <= self.scratch or base >= self.scratch + SCRATCH_BYTES,
                   "App arena overlaps RPC scratch")
            self.retainedAppArenas = self.retainedAppArenas or {}
            if self.appArena then
                self.retainedAppArenas[#self.retainedAppArenas + 1] = self.appArena
            end
            self.appArena, self.appArenaBase, self.appArenaBytes = owned, base, bytes
        end
        self.greeting = hello(ffi, self.scratch, self.info, self.profile,
                              self.appArenaBase, self.appArenaBytes)
        return "GC_APP_ARENA_V1\t" .. tostring(self.appArenaBase) ..
               "\t" .. tostring(self.appArenaBytes)
    end

    function self:close()
        if self.client then pcall(self.io.close, self.client); self.client = nil end
        if self.listener then pcall(self.io.close, self.listener); self.listener = nil end
        self.stage = "closed"
    end

    function self:dispatch()
        local packet = self.scratch + INPUT_OFFSET
        local first = tonumber(read_word(ffi, packet))
        local second = tonumber(read_word(ffi, packet + 0x28))
        local marker = tonumber(ffi.cast("uint32_t", read_word(ffi, packet + 16)))
        if first == 0 and second == 0 and marker == 0 then
            self:close()
            return
        end
        if not self.compact and first == 0 and second == 0 and marker == COMPACT_MAGIC then
            write_word(ffi, self.scratch + HEADER_OFFSET, COMPACT_MAGIC)
            write_word(ffi, self.scratch + HEADER_OFFSET + 8, 1)
            self.compactAfterResponse = true
            self.stage = "send-response"
            self.outputCount = 0
            return
        end
        if first == 0 and second == 0 and marker == PROGRESS_MAGIC then
            local step = tonumber(read_word(ffi, packet + 24))
            assert(step and step % 1 == 0 and PROGRESS_LABELS[step],
                   "Invalid FS progress step")
            self.log("[FS] " .. PROGRESS_LABELS[step])
            write_word(ffi, self.scratch + HEADER_OFFSET, PROGRESS_MAGIC)
            write_word(ffi, self.scratch + HEADER_OFFSET + 8, step)
            self.stage = "send-response"
            self.outputCount = 0
            self.compactOutputBytes = 0
            return
        end
        local function args(at, count)
            local result = {}
            for i = 1, count do result[i] = read_word(ffi, at + i * 8) end
            return result
        end
        local a, b = 0, 0
        if second == 2 then
            local six = args(packet, 4)
            six[5] = read_word(ffi, packet + 0x30)
            six[6] = read_word(ffi, packet + 0x38)
            if first ~= 0 then a = call_native(self, first, six) end
        else
            if first ~= 0 then a = call_native(self, first, args(packet, 4)) end
            if second ~= 0 then b = call_native(self, second, args(packet + 0x28, 4)) end
        end
        write_word(ffi, self.scratch + HEADER_OFFSET, b)
        write_word(ffi, self.scratch + HEADER_OFFSET + 8, a)
        self.stage = "send-response"
        self.outputCount = 0
    end

    function self:step()
        if self.stage == "closed" then return "closed" end
        if self.stage == "accept" then
            local fd, peer = self.io.accept(self.listener)
            if not fd then
                if peer == "would_block" then return "waiting" end
                error("FS bridge accept failed: " .. tostring(peer))
            end
            if type(peer) ~= "string" or peer:match("^([^:]+):") ~= self.profile.hostIp then
                self.io.close(fd)
                return "wrong-peer"
            end
            self.client = fd
            self.stage = "send-hello"
            self.outputCount = 0
        end
        if self.stage == "send-hello" or self.stage == "send-response" then
            local data = self.stage == "send-hello" and self.greeting or
                ffi.string(ffi.cast("const char*", ffi.cast("uintptr_t", self.scratch + HEADER_OFFSET)),
                           self.compact and 16 + self.compactOutputBytes or RESPONSE_BYTES)
            local size = #data
            local sent, why = self.io.send(self.client, data:sub(self.outputCount + 1))
            if not sent then
                if why == "would_block" then return "waiting" end
                error("FS bridge send failed: " .. tostring(why))
            end
            if sent == 0 then error("FS bridge send made no progress") end
            self.outputCount = self.outputCount + sent
            if self.outputCount == size then
                if self.compactAfterResponse then
                    self.compact = true
                    self.compactAfterResponse = false
                end
                self.stage = self.compact and "read-header" or "read-request"
                self.inputCount = 0
            end
            return "sending"
        end
        if self.stage == "read-request" or self.stage == "read-header" or
           self.stage == "read-data" then
            local needed = self.stage == "read-request" and REQUEST_BYTES or
                           self.stage == "read-header" and 0x80 or self.compactInputBytes
            local chunk, why = self.io.recv(self.client, needed - self.inputCount)
            if not chunk then
                if why == "would_block" then return "waiting" end
                error("FS bridge receive failed: " .. tostring(why))
            end
            if #chunk == 0 then self:close(); return "disconnected" end
            if #chunk > needed - self.inputCount then
                error("FS bridge request exceeded the expected size")
            end
            local destination = self.scratch + INPUT_OFFSET + self.inputCount
            if self.stage == "read-data" then destination = destination + 0x80 end
            ffi.copy(ffi.cast("uint8_t*", ffi.cast("uintptr_t",
                     destination)), chunk, #chunk)
            self.inputCount = self.inputCount + #chunk
            if self.inputCount == needed then
                if self.stage == "read-header" then
                    local packet = self.scratch + INPUT_OFFSET
                    local first = tonumber(read_word(ffi, packet))
                    local second = tonumber(read_word(ffi, packet + 0x28))
                    local marker = tonumber(ffi.cast("uint32_t", read_word(ffi, packet + 16)))
                    if first == 0 and second == 0 and marker == 0 then
                        self:close()
                        return "closed"
                    end
                    assert(tonumber(read_word(ffi, packet + 0x50)) == COMPACT_MAGIC,
                           "Invalid compact FS request marker")
                    self.compactInputBytes = tonumber(read_word(ffi, packet + 0x58))
                    self.compactOutputBytes = tonumber(read_word(ffi, packet + 0x60))
                    assert(self.compactInputBytes <= 0x8000 and self.compactOutputBytes <= 0x8000,
                           "Invalid compact FS frame size")
                    self.inputCount = 0
                    if self.compactInputBytes == 0 then self:dispatch()
                    else self.stage = "read-data" end
                else self:dispatch() end
            end
            return self.stage
        end
    end

    return self
end

function M.install(LS, profile, options)
    if LS.fs_bridge and LS.fs_bridge.stage ~= "closed" then
        return "FS bridge is already installed"
    end
    if LS.fs_bridge and LS.fs_bridge.appArena then
        LS.fs_bridge_retired = LS.fs_bridge_retired or {}
        assert(#LS.fs_bridge_retired < 8,
               "Too many retained FS arenas; restart Gravity Circuit")
        LS.fs_bridge_retired[#LS.fs_bridge_retired + 1] = LS.fs_bridge
    end
    local bridge = M.new(LS, profile, options)
    if not LS.fs_bridge_original_step then
        LS.fs_bridge_original_step = LS.rpc.step
        LS.rpc.step = function(rpc)
            local status = LS.fs_bridge_original_step(rpc)
            local active = LS.fs_bridge
            if active then
                local ok, why = pcall(active.step, active)
                if not ok then
                    active.error = tostring(why)
                    active:close()
                    LS.log.log("[FS] " .. active.error)
                end
            end
            return status
        end
    end
    LS.fs_bridge = bridge
    return "FS bridge listening on port " .. tostring(profile.port or 39380)
end

return M
