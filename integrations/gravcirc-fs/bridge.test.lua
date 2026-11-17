local directory = arg[0]:match("^(.*[/\\])") or "./"
local bridge_module = dofile(directory .. "bridge.lua")

local function word_bytes(value)
    local bytes = {}
    for i = 1, 8 do
        bytes[i] = string.char(value % 256)
        value = math.floor(value / 256)
    end
    return table.concat(bytes)
end

local function set_word(data, offset, value)
    return data:sub(1, offset) .. word_bytes(value) .. data:sub(offset + 9)
end

local function get_word(data, offset)
    local value = 0
    for i = 7, 0, -1 do value = value * 256 + data:byte(offset + i + 1) end
    return value
end

local function fixture()
    local memory = {}
    local sdk = 0x300000
    local scratch = 0x500000
    local closed = {}
    local calls = {}
    local sent = {}
    local received = {}
    local peers = {}
    local logs = {}
    local send_limit = 4096
    local arena_count = 0

    local function put_word(address, value)
        for i = 0, 7 do
            memory[address + i] = value % 256
            value = math.floor(value / 256)
        end
    end

    local function read_word(address)
        local value = 0
        for i = 7, 0, -1 do value = value * 256 + (memory[address + i] or 0) end
        return value
    end

    local function pointer(kind, address)
        return setmetatable({kind = kind, address = address}, {
            __index = function(self, index)
                if type(index) ~= "number" then return nil end
                if self.kind == "u64" then return read_word(self.address + index * 8) end
                return memory[self.address + index] or 0
            end,
            __newindex = function(self, index, value)
                if self.kind == "u64" then put_word(self.address + index * 8, value)
                else memory[self.address + index] = value end
            end,
        })
    end

    local ffi = {}
    function ffi.new(kind)
        if kind == "uint8_t[?]" then
            arena_count = arena_count + 1
            return {kind = "arena", address = arena_count == 1 and scratch or 0x700000}
        end
        if kind == "uint64_t[16]" then return {kind = "words"} end
        error("unexpected allocation " .. tostring(kind))
    end
    function ffi.cast(kind, value)
        if kind == "uintptr_t" then
            if type(value) == "table" and value.kind == "arena" then return value.address end
            return value
        end
        if kind == "uint64_t" then return value end
        if kind == "uint32_t" then return value % 0x100000000 end
        if kind == "uint8_t*" or kind == "const uint8_t*" or kind == "uint64_t*" then
            return pointer(kind == "uint64_t*" and "u64" or "u8", value)
        end
        if kind == "const char*" then
            if type(value) == "table" and value.kind == "words" then return value end
            return pointer("u8", value)
        end
        error("unexpected cast " .. tostring(kind))
    end
    function ffi.string(value, length)
        local bytes = {}
        for i = 0, length - 1 do
            local byte
            if value.kind == "words" then
                local word = value[math.floor(i / 8)] or 0
                byte = math.floor(word / 256 ^ (i % 8)) % 256
            else byte = value[i] end
            bytes[#bytes + 1] = string.char(byte)
        end
        return table.concat(bytes)
    end
    function ffi.copy(destination, data, length)
        for i = 0, length - 1 do destination[i] = data:byte(i + 1) end
    end

    local profile = {
        gameProfile = "gravity-circuit-v1.2.1", sdkBytes = 0x8000,
        sdkCrc32 = 0x12345678, hostIp = "10.0.0.205",
        memmove = {offset = 0x1000, bytes = "11223344"},
        queryMemory = {offset = 0x2000, bytes = "aabbccdd"},
    }
    for _, entry in ipairs({profile.memmove, profile.queryMemory}) do
        for i = 1, #entry.bytes, 2 do
            memory[sdk + entry.offset + (i - 1) / 2] = tonumber(entry.bytes:sub(i, i + 1), 16)
        end
    end

    local io = {}
    function io.accept()
        if #peers == 0 then return nil, "would_block" end
        return unpack(table.remove(peers, 1))
    end
    function io.recv(_, requested)
        if #received == 0 then return nil, "would_block" end
        local chunk = table.remove(received, 1)
        if #chunk > requested then
            table.insert(received, 1, chunk:sub(requested + 1))
            return chunk:sub(1, requested)
        end
        return chunk
    end
    function io.send(_, data)
        local count = math.min(#data, send_limit)
        sent[#sent + 1] = data:sub(1, count)
        return count
    end
    function io.close(fd) closed[#closed + 1] = fd end

    local net = {ip = "10.0.0.91"}
    function net:listener(port)
        assert(port == 39380)
        return 42
    end
    function net:transport() return io end
    local LS = {
        state = "serving", net = net, rpc = {step = function() return "rpc-idle" end},
        nx_info = {game_id = "gravity-circuit", profile = profile.gameProfile,
                   main_base = 0x100000, sdk_base = sdk},
        log = {log = function(message) logs[#logs + 1] = message end},
    }
    _G.love = {graphics = {present = function() end}}
    local options = {
        ffi = ffi, ffi_call = {}, io = io,
        invoke = function(_, _, _, address, args)
            calls[#calls + 1] = {address = address, args = args}
            return {raw = address == sdk + 0x1000 and 0x111 or 0x222}
        end,
    }
    return {
        ffi = ffi, profile = profile, LS = LS, options = options,
        peers = peers, received = received, sent = sent, closed = closed,
        calls = calls, logs = logs, memory = memory, scratch = scratch,
        set_send_limit = function(limit) send_limit = limit end,
        put_word = put_word,
    }
end

local function connect(test)
    local bridge = bridge_module.new(test.LS, test.profile, test.options)
    test.peers[#test.peers + 1] = {77, "10.0.0.205:49152"}
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-request" then break end
    end
    assert(bridge.stage == "read-request")
    return bridge
end

local function test_profile_guards()
    local t = fixture()
    t.LS.nx_info.sdk_base = 0
    assert(not pcall(bridge_module.new, t.LS, t.profile, t.options))
    t.LS.nx_info.sdk_base = 0x300000
    t.profile.hostIp = "999.0.0.1"
    assert(not pcall(bridge_module.new, t.LS, t.profile, t.options))
    t.profile.hostIp = "10.0.0.205"
    t.profile.memmove.offset = 0x1004
    assert(not pcall(bridge_module.new, t.LS, t.profile, t.options))
end

local function test_greeting_and_wrong_peer()
    local t = fixture()
    local bridge = bridge_module.new(t.LS, t.profile, t.options)
    t.peers[1] = {76, "10.0.0.206:49152"}
    assert(bridge:step() == "wrong-peer")
    assert(t.closed[1] == 76 and bridge.stage == "accept")
    t.peers[1] = {77, "10.0.0.205:49152"}
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-request" then break end
    end
    local greeting = table.concat(t.sent)
    assert(#greeting == 128)
    assert(get_word(greeting, 0) == 0x31545344)
    assert(get_word(greeting, 8) == 1 and get_word(greeting, 16) == 2)
    assert(get_word(greeting, 24) == t.scratch)
    assert(get_word(greeting, 64) == 0x301000)
    assert(get_word(greeting, 120) == 0x12345678)
end

local function test_owned_app_arena_greeting()
    local t = fixture()
    local bridge = bridge_module.new(t.LS, t.profile, t.options)
    assert(bridge:reserveAppArena(0x80000) == "GC_APP_ARENA_V1\t7340032\t524288")
    assert(not pcall(bridge.reserveAppArena, bridge, 0x1000))
    t.peers[1] = {77, "10.0.0.205:49152"}
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-request" then break end
    end
    local greeting = table.concat(t.sent)
    assert(get_word(greeting, 88) == 0x700000)
    assert(get_word(greeting, 96) == 0x80000)
    assert(not pcall(bridge.reserveAppArena, bridge, 0x2400000))
end

local function test_fragmented_exchange()
    local t = fixture()
    local bridge = connect(t)
    for i = 0, 3 do t.memory[t.scratch + 0x4040 + i] = 0x41 + i end
    local request = string.rep("\0", 0x8080)
    request = set_word(request, 0, 0x301000)
    request = set_word(request, 8, 11)
    request = set_word(request, 0x28, 0x302000)
    request = set_word(request, 0x30, 22)
    request = request:sub(1, 0x80) .. "abc" .. request:sub(0x84)
    for i = 1, #request, 3000 do
        t.received[#t.received + 1] = request:sub(i, i + 2999)
    end
    for _ = 1, 100 do
        bridge:step()
        if bridge.stage == "read-request" and bridge.inputCount == 0 and #t.received == 0 then
            break
        end
    end
    assert(#t.calls == 2)
    assert(t.calls[1].address == 0x301000 and t.calls[1].args[1] == 11)
    assert(t.calls[2].address == 0x302000 and t.calls[2].args[1] == 22)
    assert(bridge.stage == "read-request")
    local sent = table.concat(t.sent)
    local response = sent:sub(129)
    assert(#response == 0x8010)
    assert(get_word(response, 0) == 0x222 and get_word(response, 8) == 0x111)
    assert(response:sub(17, 20) == "ABCD")
    assert(t.memory[t.scratch + 0x40080] == string.byte("a"))
end

local function test_six_args_and_termination()
    local t = fixture()
    local bridge = connect(t)
    local request = string.rep("\0", 0x8080)
    request = set_word(request, 0, 0x301000)
    for i = 1, 4 do request = set_word(request, i * 8, i) end
    request = set_word(request, 0x28, 2)
    request = set_word(request, 0x30, 5)
    request = set_word(request, 0x38, 6)
    t.received[1] = request
    for _ = 1, 30 do
        bridge:step()
        if bridge.stage == "read-request" and bridge.inputCount == 0 and #t.received == 0 then
            break
        end
    end
    assert(#t.calls == 1 and #t.calls[1].args == 6)
    for i = 1, 6 do assert(t.calls[1].args[i] == i) end
    local termination = set_word(string.rep("\0", 0x8080), 16, 0x100000000)
    t.received[1] = termination
    assert(bridge:step() == "closed")
    assert(bridge.stage == "closed")
    assert(t.closed[#t.closed] == 42)
end

local function test_progress_uses_bridge_without_native_calls()
    local t = fixture()
    local bridge = connect(t)
    local labels = {
        "1/4 Checking the console", "2/4 Acquiring FS memory",
        "3/4 Starting the native helper", "4/4 Running the FS demo",
        "2/4 Acquiring FS memory", "2/4 Measuring FS canary geometry",
    }
    for step, label in ipairs(labels) do
        local request = string.rep("\0", 0x8080)
        request = set_word(request, 16, 0x47504353)
        request = set_word(request, 24, step)
        t.received[1] = request
        for _ = 1, 50 do
            bridge:step()
            if bridge.stage == "read-request" and bridge.inputCount == 0 and
               #t.received == 0 then break end
        end
        assert(bridge.stage == "read-request")
        assert(t.logs[#t.logs] == "[FS] " .. label)
        local sent = table.concat(t.sent)
        local response = sent:sub(129 + (step - 1) * 0x8010,
                                  128 + step * 0x8010)
        assert(get_word(response, 0) == 0x47504353)
        assert(get_word(response, 8) == step)
    end
    assert(#t.calls == 0)
    local bad = set_word(string.rep("\0", 0x8080), 16, 0x47504353)
    bad = set_word(bad, 24, 7)
    t.received[1] = bad
    local ok, why = pcall(bridge.step, bridge)
    assert(not ok and tostring(why):find("Invalid FS progress step", 1, true))
end

local function test_compact_upgrade_and_frames()
    local t = fixture()
    local bridge = connect(t)
    local upgrade = set_word(string.rep("\0", 0x8080), 16, 0x504d4347)
    t.received[1] = upgrade
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-header" then break end
    end
    assert(bridge.stage == "read-header" and bridge.compact)
    assert(#t.calls == 0)
    local sent = table.concat(t.sent)
    assert(#sent == 128 + 0x8010)
    assert(get_word(sent:sub(129), 0) == 0x504d4347)
    assert(get_word(sent:sub(129), 8) == 1)

    for i = 0, 3 do t.memory[t.scratch + 0x4040 + i] = 0x41 + i end
    local header = string.rep("\0", 0x80)
    header = set_word(header, 0, 0x301000)
    header = set_word(header, 8, 11)
    header = set_word(header, 0x28, 0x302000)
    header = set_word(header, 0x30, 22)
    header = set_word(header, 0x50, 0x504d4347)
    header = set_word(header, 0x58, 3)
    header = set_word(header, 0x60, 4)
    t.received[1] = header:sub(1, 31)
    t.received[2] = header:sub(32)
    t.received[3] = "abc"
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-header" and #t.received == 0 then break end
    end
    assert(#t.calls == 2)
    assert(t.calls[1].address == 0x301000 and t.calls[1].args[1] == 11)
    assert(t.calls[2].address == 0x302000 and t.calls[2].args[1] == 22)
    assert(t.memory[t.scratch + 0x40080] == string.byte("a"))
    sent = table.concat(t.sent)
    local response = sent:sub(129 + 0x8010)
    assert(#response == 20)
    assert(get_word(response, 0) == 0x222 and get_word(response, 8) == 0x111)
    assert(response:sub(17) == "ABCD")

    local large = string.rep("Z", 0x8000)
    header = set_word(header, 0x58, 0x8000)
    header = set_word(header, 0x60, 0x8000)
    t.received[1] = header
    t.received[2] = large
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-header" and #t.received == 0 then break end
    end
    sent = table.concat(t.sent)
    response = sent:sub(129 + 0x8010 + 20)
    assert(#response == 0x8010)
    assert(t.memory[t.scratch + 0x40080] == string.byte("Z"))

    local progress = string.rep("\0", 0x80)
    progress = set_word(progress, 16, 0x47504353)
    progress = set_word(progress, 24, 2)
    progress = set_word(progress, 0x50, 0x504d4347)
    t.received[1] = progress
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-header" and #t.received == 0 then break end
    end
    sent = table.concat(t.sent)
    response = sent:sub(129 + 0x8010 + 20 + 0x8010)
    assert(#response == 16 and get_word(response, 0) == 0x47504353)
    assert(get_word(response, 8) == 2)
    assert(t.logs[#t.logs] == "[FS] 2/4 Acquiring FS memory")

    local close = string.rep("\0", 0x80)
    t.received[1] = close
    assert(bridge:step() == "closed")
end

local function test_compact_rejects_oversized_frame()
    local t = fixture()
    local bridge = connect(t)
    t.received[1] = set_word(string.rep("\0", 0x8080), 16, 0x504d4347)
    for _ = 1, 50 do
        bridge:step()
        if bridge.stage == "read-header" then break end
    end
    local header = string.rep("\0", 0x80)
    header = set_word(header, 0, 0x301000)
    header = set_word(header, 0x50, 0x504d4347)
    header = set_word(header, 0x58, 0x8001)
    t.received[1] = header
    local ok, why = pcall(bridge.step, bridge)
    assert(not ok and tostring(why):find("Invalid compact FS frame size", 1, true))
end

local function test_zero_send_rejected()
    local t = fixture()
    t.set_send_limit(0)
    local bridge = bridge_module.new(t.LS, t.profile, t.options)
    t.peers[1] = {77, "10.0.0.205:49152"}
    local ok, why = pcall(bridge.step, bridge)
    assert(not ok and tostring(why):find("no progress", 1, true))
end

local function test_null_six_argument_call_is_skipped()
    local t = fixture()
    local bridge = connect(t)
    local request = string.rep("\0", 0x8080)
    request = set_word(request, 8, 1)
    request = set_word(request, 0x28, 2)
    t.received[1] = request
    assert(bridge:step() == "send-response")
    assert(#t.calls == 0)
    assert(bridge.stage == "send-response")
end

local function test_close_does_not_fail_the_parent_runtime()
    local t = fixture()
    local bridge = connect(t)
    bridge.io.close = function() error("native close failed") end
    assert(pcall(bridge.close, bridge))
    assert(bridge.stage == "closed" and bridge.client == nil and bridge.listener == nil)
end

local function test_closed_bridge_can_be_reinstalled_without_stacking_rpc_wrappers()
    local t = fixture()
    assert(bridge_module.install(t.LS, t.profile, t.options) ==
           "FS bridge listening on port 39380")
    local wrapped_step = t.LS.rpc.step
    assert(bridge_module.install(t.LS, t.profile, t.options) ==
           "FS bridge is already installed")
    local previous = t.LS.fs_bridge
    previous:reserveAppArena(0x80000)
    t.LS.fs_bridge:close()
    assert(bridge_module.install(t.LS, t.profile, t.options) ==
           "FS bridge listening on port 39380")
    assert(t.LS.fs_bridge_retired[1] == previous)
    assert(t.LS.rpc.step == wrapped_step)
    assert(t.LS.fs_bridge.stage == "accept")
    assert(t.LS.rpc.step(t.LS.rpc) == "rpc-idle")
end

test_profile_guards()
test_greeting_and_wrong_peer()
test_owned_app_arena_greeting()
test_fragmented_exchange()
test_six_args_and_termination()
test_progress_uses_bridge_without_native_calls()
test_compact_upgrade_and_frames()
test_compact_rejects_oversized_frame()
test_zero_send_rejected()
test_null_six_argument_call_is_skipped()
test_close_does_not_fail_the_parent_runtime()
test_closed_bridge_can_be_reinstalled_without_stacking_rpc_wrappers()
print("Gravity Circuit bridge mock tests passed")
