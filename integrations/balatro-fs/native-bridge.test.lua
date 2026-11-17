local ffi = require('ffi')
local transport = assert(loadfile('integrations/balatro-fs/transport-probe.lua'))()
local native = assert(loadfile('integrations/balatro-fs/native-bridge.lua'))()
local nonce = 'd3b7e24c1a09f563'
local ip = '10.0.0.205'
local port = 39381
local sdk = 0x19618b4000
love = {graphics = {present = function() end}}

local data = ffi.new('uint8_t[?]', 0x200000 + 0x2000)
local raw = tonumber(ffi.cast('uintptr_t', data))
local base = raw + 0x1000 - raw % 0x1000
local before, after = base - raw - 64, base - raw + 0x200000
for i = 0, 63 do data[before + i] = 165; data[after + i] = 165 end

local inbound, outbound, accepted = '', {}, false
local io = {}
function io.accept()
    if accepted then return nil, 'would_block' end
    accepted = true
    return 17, ip .. ':51200'
end
function io.send(_, chunk)
    local count = math.min(#chunk, 9000)
    outbound[#outbound + 1] = chunk:sub(1, count)
    return count
end
function io.recv(_, limit)
    if #inbound == 0 then return nil, 'would_block' end
    local count = math.min(#inbound, limit, 5000)
    local chunk = inbound:sub(1, count)
    inbound = inbound:sub(count + 1)
    return chunk
end
function io.close() end

local b = {
    state = 'serving', rpc = {step = function() return 'idle' end},
    info = {version = '1.0.1f-FULL', main_base = 0x194ec04000,
            sdk_base = sdk},
    fs_bridge = {owner = nonce, stage = 'ready', bytes = 0x200000,
                 base = base, buf = data, before = before, after = after},
    net = {listener = function() return 21 end,
           transport = function() return io end},
    log = {log = function(message) error(message) end},
}
assert(transport.install(b, {hostIp = ip, nonce = nonce, port = port,
    sdkCrc32 = 0xac8a9d29, memmoveOffset = 5851952}) ==
    'BAL_TRANSPORT_V1\tlistening\t39381')
local calls = {}
local invoke = function(_, _, _, address, args)
    calls[#calls + 1] = {address = address, args = args}
    return {raw = ffi.cast('uint64_t', address + #args)}
end
local ok = pcall(native.enable, b, {approved = true, nonce = nonce,
    hostIp = ip, port = 39380, invoke = invoke})
assert(not ok)
assert(native.enable(b, {approved = true, nonce = nonce,
    hostIp = ip, port = port, invoke = invoke}) ==
    'BAL_NATIVE_V1\tready\t39381\t' .. nonce)
assert(native.reserveAppArena(b, {nonce = nonce, hostIp = ip,
    port = port, bytes = 0x80000}):match('^BAL_APP_ARENA_V1'))
local words = ffi.cast('const uint64_t*', b.fs_transport.hello)
assert(tonumber(words[11]) == b.fs_transport.appArenaBase)
assert(tonumber(words[12]) == 0x80000)

local bridge = b.fs_transport
local function untilStage(stage)
    for _ = 1, 100 do
        bridge:step()
        if bridge.stage == stage then return end
    end
    error('bridge did not reach ' .. stage)
end
untilStage('read-request')
assert(#table.concat(outbound) == 128)
outbound = {}

local function request(first, second, fifth, sixth)
    local frame = ffi.new('uint8_t[?]', 0x8080)
    local words = ffi.cast('uint64_t*', frame)
    words[0] = first
    words[1] = 11
    words[2] = 22
    words[3] = 33
    words[4] = 44
    words[5] = second
    if second == 2 then
        words[6] = fifth
        words[7] = sixth
    else
        words[6] = 55
        words[7] = 66
        words[8] = 77
        words[9] = 88
    end
    return ffi.string(frame, 0x8080)
end
local function exchange(frame)
    inbound = frame
    for _ = 1, 100 do
        bridge:step()
        if bridge.stage == 'read-request' and #inbound == 0 and
           #table.concat(outbound) == 0x8010 then break end
    end
    local response = table.concat(outbound)
    assert(#response == 0x8010)
    outbound = {}
    return ffi.cast('const uint64_t*', response)
end

local result = exchange(request(sdk + 0x1000, sdk + 0x2000))
assert(tonumber(result[0]) == sdk + 0x2004)
assert(tonumber(result[1]) == sdk + 0x1004)
assert(#calls == 2 and #calls[1].args == 4 and #calls[2].args == 4)
result = exchange(request(sdk + 0x3000, 2, 99, 100))
assert(tonumber(result[0]) == 0)
assert(tonumber(result[1]) == sdk + 0x3006)
assert(#calls == 3 and #calls[3].args == 6)
assert(tonumber(calls[3].args[5]) == 99 and tonumber(calls[3].args[6]) == 100)

inbound = request(0x1000, 0)
local failure
for _ = 1, 20 do
    local valid, why = pcall(bridge.step, bridge)
    if not valid then failure = tostring(why); break end
end
assert(failure and failure:match('invalid function address'))
bridge:close()
print('Balatro native bridge offline protocol and guard checks passed')
