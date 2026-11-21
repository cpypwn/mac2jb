-- s2_prim.lua — Standalone Lua 5.1 Primitives, HIPC/CMIF Framing & ROP Worker Builder
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)
-- Credits: pepsipu, kurumuz (ns2jb / kaiHEN), Gezine (CivSwitch), Slapah, ItsNerisma (CivSwitchFS),
--          s8n / aveao, Netfreak25 (CivSwitchFS-kaiHEN), alula (switch-artemis-launcher),
--          Malev0, manupear, McGlowSticks, TheCrazy8 (seedsow-fs-kaihen).
-- License: GPL-2.0 / MIT (see PORT_PLAN.md)

local M = {}

local math_floor = math.floor
local math_ceil  = math.ceil
local math_max   = math.max
local math_min   = math.min
local str_byte   = string.byte
local str_char   = string.char
local str_sub    = string.sub
local str_rep    = string.rep
local str_format = string.format
local tbl_concat = table.concat

-- ---------------------------------------------------------------------------
-- 1. Verified Seedsow Lullaby Native Offsets (MAIN & nnSdk)
-- ---------------------------------------------------------------------------
M.OFFSETS = {
    MAIN = {
        MALLOC          = 0x262160,
        FREE            = 0x2621b0,
        G_LOAD_X0       = 0x0828ac,
        G_LOAD_X19      = 0x002f34,
        G_CALL3_VOID    = 0x0c1530,
        G_CALL2         = 0x0c27d8,
        G_STORE_X0_X19  = 0x173db4,
        G_PEEK_X0_X19   = 0x173dc8,
    },
    SDK = {
        FS_COMMIT_SAVE      = 0x0a7f70,
        EVENT_INIT          = 0x1324e0,
        EVENT_FINALIZE      = 0x132510,
        EVENT_SIGNAL        = 0x132520,
        EVENT_CLEAR         = 0x132640,
        EVENT_WAIT          = 0x132680,
        EVENT_TRY_WAIT      = 0x1327e0,
        OS_GET_PRIO         = 0x1370c0,
        OS_YIELD            = 0x1370f0,
        OS_SLEEP            = 0x137100,
        TRY_WAIT_THREAD     = 0x137110,
        AVAILABLE_CORES     = 0x1371e0,
        OS_GET_THREAD_ID    = 0x1371f0,
        OS_TICK             = 0x137240,
        OS_TICK_FREQ        = 0x137270,
        PTHREAD_SETPRIO     = 0x141d80,
        PTHREAD_CREATE      = 0x142180,
        PTHREAD_EXIT        = 0x142410,
        PTHREAD_JOIN        = 0x142480,
        PTHREAD_ATTR_INIT   = 0x1426c0,
        PTHREAD_ATTR_DESTROY= 0x142700,
        PTHREAD_SETAFFINITY = 0x1428f0,
        GET_TLS             = 0x14ba80,
        IPC_DISPATCHER      = 0x14ba90,
        SM_GET_SERVICE      = 0x14cc90,
        SVC_SET_MEM_PERM    = 0x168aec,
        SVC_QUERY_MEM       = 0x168b0c,
        SVC_EXIT_THREAD     = 0x168b4c,
        SVC_SLEEP_THREAD    = 0x168b54,
        EVENT_SYSCALL_SCAN  = 0x168b20, -- 1477408 / 1477376 scan window
        SVC_SIGNAL_EVENT    = 0x168bac,
        SVC_CLEAR_EVENT     = 0x168bb4,
        SVC_CLOSE_HANDLE    = 0x168be4,
        SVC_WAIT_SYNC       = 0x168bf4, -- 1477620 (0x168bf4)
        SVC_CANCEL_SYNC     = 0x168c0c, -- 1477644 (0x168c0c)
        SVC_CONNECT_PORT    = 0x168c34,
        SVC_SEND_SYNC_TLS   = 0x168c4c,
        SVC_SEND_SYNC_USER  = 0x168c54, -- svc #0x22: (buf, size, handle)
        SVC_GET_THREAD_ID   = 0x168c74, -- 1477748 (0x168c74)
        SVC_GET_INFO        = 0x168ca4, -- 1477796 (0x168ca4)
        SVC_WAIT_ADDRESS    = 0x168d1c, -- 1477916 (0x168d1c)
        SVC_SIGNAL_ADDRESS  = 0x168d24, -- 1477924 (0x168d24)
        VCALL8_RESTORE      = 0x3d9e54,
        MEMCPY              = 0x5224e0,
        MEMSET              = 0x522af0,
        LONGJMP             = 0x5511b4,
        MOUNT_TABLE_HEAD    = 0xB35868,
        APP_SM_HANDLE_SLOT  = 0xB5459C,
    }
}

-- Sentinel 0xfedcba9876543210 as 8-byte little-endian binary string
M.SENTINEL_BYTES = str_char(0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe)
M.ZERO8          = str_rep("\0", 8)
M.POISON_A5_8    = str_rep(str_char(0xA5), 8)
M.SFCI_MAGIC     = 0x49434653 -- "SFCI" LE
M.SFCO_MAGIC     = 0x4F434653 -- "SFCO" LE

-- ---------------------------------------------------------------------------
-- 2. Pure 53-Bit-Safe Bitwise & Integer Helpers (Lua 5.1)
-- ---------------------------------------------------------------------------
function M.u32_norm(v)
    v = math_floor(v or 0)
    return v % 4294967296
end

function M.signed32(v)
    v = M.u32_norm(v)
    if v >= 2147483648 then return v - 4294967296 end
    return v
end

function M.signed_ret(v)
    v = v or 0
    if v >= 9223372036854775808 then v = v - 18446744073709551616
    elseif v >= 2147483648 and v < 4294967296 then v = v - 4294967296 end
    return v
end

function M.band32(a, b)
    a = M.u32_norm(a)
    b = M.u32_norm(b)
    local res, bit = 0, 1
    while a > 0 and b > 0 do
        local ra, rb = a % 2, b % 2
        if ra == 1 and rb == 1 then res = res + bit end
        a = (a - ra) / 2
        b = (b - rb) / 2
        bit = bit * 2
    end
    return res
end

function M.bor32(a, b)
    a = M.u32_norm(a)
    b = M.u32_norm(b)
    local res, bit = 0, 1
    while a > 0 or b > 0 do
        local ra, rb = a % 2, b % 2
        if ra == 1 or rb == 1 then res = res + bit end
        a = (a - ra) / 2
        b = (b - rb) / 2
        bit = bit * 2
    end
    return res
end

function M.bxor32(a, b)
    a = M.u32_norm(a)
    b = M.u32_norm(b)
    local res, bit = 0, 1
    while a > 0 or b > 0 do
        local ra, rb = a % 2, b % 2
        if ra ~= rb then res = res + bit end
        a = (a - ra) / 2
        b = (b - rb) / 2
        bit = bit * 2
    end
    return res
end

function M.lshift32(a, n)
    return M.u32_norm(M.u32_norm(a) * (2 ^ n))
end

function M.rshift32(a, n)
    return math_floor(M.u32_norm(a) / (2 ^ n))
end

function M.align_up(val, align)
    local rem = val % align
    if rem == 0 then return val end
    return val + (align - rem)
end

-- ---------------------------------------------------------------------------
-- 3. 0-Based Binary String Packing & Unpacking (Lua 5.1)
-- ---------------------------------------------------------------------------
-- Every off0 argument is a 0-based byte offset into string s.
function M.u8(s, off0)
    return str_byte(s, off0 + 1) or 0
end

function M.u16(s, off0)
    local a, b = str_byte(s, off0 + 1, off0 + 2)
    return (a or 0) + (b or 0) * 256
end

function M.u32(s, off0)
    local a, b, c, d = str_byte(s, off0 + 1, off0 + 4)
    return (a or 0) + (b or 0) * 256 + (c or 0) * 65536 + (d or 0) * 16777216
end

function M.u64(s, off0)
    return M.u32(s, off0) + M.u32(s, off0 + 4) * 4294967296
end

function M.u64_pair(s, off0)
    return M.u32(s, off0), M.u32(s, off0 + 4)
end

function M.u16s(v)
    v = math_floor(v or 0) % 65536
    local a = v % 256
    local b = (v - a) / 256
    return str_char(a, b)
end

function M.u32s(v)
    v = M.u32_norm(v)
    local a = v % 256; v = (v - a) / 256
    local b = v % 256; v = (v - b) / 256
    local c = v % 256; local d = (v - c) / 256
    return str_char(a, b, c, d)
end

function M.u64s(v)
    if type(v) == "string" then
        if #v == 8 then return v end
        error("u64s string must be 8 bytes")
    elseif type(v) == "table" then
        return M.u32s(v[1] or v.lo or 0) .. M.u32s(v[2] or v.hi or 0)
    end
    v = math_floor(v or 0)
    if v < 0 then
        -- Two's complement for negative values within 53-bit range
        local pos = -v
        local bytes = {}
        local carry = 1
        for i = 1, 8 do
            local q = math_floor(pos / 256)
            local rem = pos - q * 256
            local inv = (255 - rem) + carry
            bytes[i] = str_char(inv % 256)
            carry = math_floor(inv / 256)
            pos = q
        end
        return tbl_concat(bytes)
    end
    local t = {}
    for i = 1, 8 do
        local q = math_floor(v / 256)
        t[i] = str_char(v - q * 256)
        v = q
    end
    return tbl_concat(t)
end

-- Replace bytes in `s` starting at 0-based `off0` with `sub`
function M.put_bytes(s, off0, sub)
    local n = #sub
    if n == 0 then return s end
    return str_sub(s, 1, off0) .. sub .. str_sub(s, off0 + n + 1)
end

function M.put_u8(s, off0, v)
    return M.put_bytes(s, off0, str_char(math_floor(v or 0) % 256))
end

function M.put_u16(s, off0, v)
    return M.put_bytes(s, off0, M.u16s(v))
end

function M.put_u32(s, off0, v)
    return M.put_bytes(s, off0, M.u32s(v))
end

function M.put_u64(s, off0, v)
    return M.put_bytes(s, off0, M.u64s(v))
end

function M.hex(s)
    if not s or #s == 0 then return "" end
    local out = {}
    for i = 1, #s do
        out[i] = str_format("%02x", str_byte(s, i))
    end
    return tbl_concat(out)
end

function M.unhex(h)
    if not h or #h == 0 then return "" end
    return (h:gsub("%x%x", function(pair)
        return str_char(tonumber(pair, 16))
    end))
end

function M.hex32(v)
    if v == nil then return "null" end
    return str_format("0x%x", M.u32_norm(v))
end

function M.hex64(v)
    if type(v) == "string" and #v == 8 then
        local lo, hi = M.u32(v, 0), M.u32(v, 4)
        if hi == 0 then return str_format("0x%x", lo) end
        return str_format("0x%x%08x", hi, lo)
    end
    if not v then return "0x0" end
    local hi = math_floor(v / 4294967296)
    local lo = v - hi * 4294967296
    if hi == 0 then return str_format("0x%x", lo) end
    return str_format("0x%x%08x", hi, lo)
end

function M.bytes_to_str(arr)
    if type(arr) == "string" then return arr end
    local t = {}
    for i = 1, #arr do t[i] = str_char(arr[i] % 256) end
    return tbl_concat(t)
end

function M.str_to_bytes(s)
    local t = {}
    for i = 1, #s do t[i] = str_byte(s, i) end
    return t
end

-- UTF-8 validator step: state = {remaining, low, high}
function M.utf8_step(state, byte)
    local remaining, low, high = state[1], state[2], state[3]
    if remaining ~= 0 then
        if byte < low or byte > high then return nil end
        if remaining > 1 then return {remaining - 1, 0x80, 0xBF} end
        return {0, 0, 0}
    end
    if byte >= 1 and byte <= 0x7F then return {0, 0, 0} end
    if byte >= 0xC2 and byte <= 0xDF then return {1, 0x80, 0xBF} end
    if byte == 0xE0 then return {2, 0xA0, 0xBF} end
    if byte >= 0xE1 and byte <= 0xEF then
        return {2, 0x80, (byte == 0xED) and 0x9F or 0xBF}
    end
    if byte == 0xF0 then return {3, 0x90, 0xBF} end
    if byte >= 0xF1 and byte <= 0xF4 then
        return {3, 0x80, (byte == 0xF4) and 0x8F or 0xBF}
    end
    return nil
end

-- ---------------------------------------------------------------------------
-- 4. HIPC / CMIF / Domain / WithContext Packet Builders (Pure String Buffers)
-- ---------------------------------------------------------------------------
-- Map-alias descriptor (A or B, 12 bytes)
function M.descriptor(spec)
    local a = spec.address or spec.addr or 0
    local n = spec.size or 0
    local mode = spec.mode
    if mode == nil then mode = spec.attr or 0 end
    if a < 0 or a >= 549755813888 or n < 0 or n >= 68719476736 then
        error("Invalid map-alias descriptor")
    end
    if mode ~= 0 and mode ~= 1 and mode ~= 3 then
        error("Invalid map-alias descriptor mode")
    end
    local n_lo = n % 4294967296
    local n_hi = math_floor(n / 4294967296) % 16
    local a_lo = a % 4294967296
    local a_hi = math_floor(a / 4294967296)
    local a_32_35 = a_hi % 16
    local a_36_38 = math_floor(a_hi / 16) % 8
    local w2 = mode + a_36_38 * 4 + n_hi * 16777216 + a_32_35 * 268435456
    return M.u32s(n_lo) .. M.u32s(a_lo) .. M.u32s(w2)
end

-- Static pointer descriptor (X, 8 bytes)
function M.pointer_descriptor(spec)
    local a = spec.address or spec.addr or 0
    local n = spec.size or 0
    local idx = spec.index or 0
    if a < 0 or a >= 4398046511104 or n < 0 or n > 0xFFFF or idx < 0 or idx > 0x3F then
        error("Invalid pointer descriptor")
    end
    local a_lo = a % 4294967296
    local a_hi = math_floor(a / 4294967296)
    local a_32_35 = a_hi % 16
    local a_36_38 = math_floor(a_hi / 16) % 64
    local w0 = idx + a_36_38 * 64 + a_32_35 * 4096 + n * 65536
    return M.u32s(w0) .. M.u32s(a_lo)
end

-- Receive-list descriptor (C, 8 bytes)
function M.receive_descriptor(spec)
    local a = spec.address or spec.addr or 0
    local n = spec.size or 0
    if a < 0 or a >= 281474976710656 or n < 0 or n > 0xFFFF then
        error("Invalid receive pointer descriptor")
    end
    local a_lo = a % 4294967296
    local a_hi = math_floor(a / 4294967296) % 65536
    local w1 = a_hi + n * 65536
    return M.u32s(a_lo) .. M.u32s(w1)
end

-- Build a 256-byte non-domain CMIF packet (matches engine/shared/ipc.cjs packet())
function M.packet(command, input, opts)
    input = M.bytes_to_str(input or "")
    opts = opts or {}
    local pid = opts.pid and true or false
    local copies = opts.copies or {}
    local send = opts.send or opts.a or {}
    local receive = opts.receive or opts.b or {}
    local pointers = opts.pointers or {}
    local send_ptrs = pointers.send or opts.x or {}
    local recv_ptrs = pointers.receive or opts.c or {}
    local unfixed = {}
    for i = 1, #recv_ptrs do
        if not recv_ptrs[i].fixed then unfixed[#unfixed + 1] = recv_ptrs[i] end
    end
    local special = pid or (#copies > 0)
    local num_data_words = opts.raw_words or math_ceil((32 + #input + 2 * #unfixed) / 4)
    local recv_mode = (#recv_ptrs > 0) and (2 + #recv_ptrs) or 0
    local buf = str_rep("\0", 256)

    local w0 = (opts.hipc_type or 4)
        + #send_ptrs * 65536
        + #send * 1048576
        + #receive * 16777216
    local w1 = num_data_words
        + recv_mode * 1024
        + (special and 0x80000000 or 0)
    buf = M.put_u32(buf, 0, w0)
    buf = M.put_u32(buf, 4, w1)

    local at = 8
    if special then
        buf = M.put_u32(buf, at, (pid and 1 or 0) + #copies * 2)
        at = at + 4
        if pid then at = at + 8 end
        for i = 1, #copies do
            buf = M.put_u32(buf, at, copies[i])
            at = at + 4
        end
    end
    for i = 1, #send_ptrs do
        local p = send_ptrs[i]
        local idx = p.index
        if idx == nil then idx = i - 1 end
        buf = M.put_bytes(buf, at, M.pointer_descriptor({
            address = p.address or p.addr,
            size = p.size,
            index = idx
        }))
        at = at + 8
    end
    local data_words = at
    for i = 1, #send do
        buf = M.put_bytes(buf, at, M.descriptor(send[i]))
        at = at + 12
    end
    for i = 1, #receive do
        buf = M.put_bytes(buf, at, M.descriptor(receive[i]))
        at = at + 12
    end
    local header = M.align_up(at, 16)
    local recv_list = data_words + num_data_words * 4
    local tbl_off = data_words + 32 + #input
    for i = 1, #unfixed do
        buf = M.put_u16(buf, tbl_off + 2 * (i - 1), unfixed[i].size)
    end
    buf = M.put_u32(buf, header, M.SFCI_MAGIC)
    buf = M.put_u32(buf, header + 8, command)
    if #input > 0 then
        buf = M.put_bytes(buf, header + 16, input)
    end
    for i = 1, #recv_ptrs do
        buf = M.put_bytes(buf, recv_list + 8 * (i - 1), M.receive_descriptor(recv_ptrs[i]))
    end
    return buf
end

-- Find 16-byte aligned CMIF data start in a 256-byte HIPC packet
function M.domain_data_start(bytes)
    local first = M.u32(bytes, 0)
    local second = M.u32(bytes, 4)
    local at = 8
    if second >= 0x80000000 then
        local special = M.u32(bytes, at)
        local has_pid = (special % 2) == 1
        local n_copy = math_floor(special / 2) % 16
        local n_move = math_floor(special / 32) % 16
        at = at + 4 + (has_pid and 8 or 0) + 4 * (n_copy + n_move)
    end
    local n_x = math_floor(first / 65536) % 16
    local n_a = math_floor(first / 1048576) % 16
    local n_b = math_floor(first / 16777216) % 16
    local n_w = math_floor(first / 268435456) % 16
    at = at + n_x * 8 + (n_a + n_b + n_w) * 12
    return M.align_up(at, 16)
end

-- Apply CMIF context suffix (type 6 RequestWithContext, value = 3 or 9)
function M.apply_context(bytes, value)
    if value == nil then value = 9 end
    local at = M.domain_data_start(bytes)
    local first = M.u32(bytes, 0)
    local hi16 = math_floor(first / 65536) * 65536
    bytes = M.put_u32(bytes, 0, hi16 + 6)
    bytes = M.put_u32(bytes, at + 4, 1)
    bytes = M.put_u32(bytes, at + 12, value)
    return bytes
end

-- Build a CMIF Control request (type 5 or 7)
function M.domain_control(command, input, ctx)
    ctx = ctx or 0
    local bytes = M.packet(command, input or "")
    bytes = M.put_u32(bytes, 0, (ctx ~= 0) and 7 or 5)
    local at = M.domain_data_start(bytes)
    bytes = M.put_u32(bytes, at + 4, (ctx ~= 0) and 1 or 0)
    bytes = M.put_u32(bytes, at + 12, ctx)
    return bytes
end

-- Build a CMIF Domain request (matches engine/shared/domain.cjs domain())
function M.domain_packet(object_id, command, input, opts)
    input = M.bytes_to_str(input or "")
    opts = opts or {}
    local ctx = opts.context or 0
    local bytes = M.packet(command, input, opts)
    local at = M.domain_data_start(bytes)
    local shifted = str_sub(bytes, at + 1, at + 16 + #input)
    bytes = M.put_bytes(bytes, at, str_rep("\0", 16) .. shifted)
    bytes = M.put_u8(bytes, at, 1)
    bytes = M.put_u16(bytes, at + 2, 16 + #input)
    bytes = M.put_u32(bytes, at + 4, object_id)
    bytes = M.put_u32(bytes, at + 12, ctx)
    bytes = M.put_u32(bytes, at + 20, (ctx ~= 0) and 1 or 0)
    local first = M.u32(bytes, 0)
    local hi16 = math_floor(first / 65536) * 65536
    bytes = M.put_u32(bytes, 0, hi16 + ((ctx ~= 0) and 6 or 4))
    bytes = M.put_u32(bytes, 4, M.u32(bytes, 4) + 4)
    return bytes
end

-- Build a CMIF Domain CloseVirtualHandle request (type=2 at data_start)
function M.domain_close_object(object_id, ctx)
    ctx = ctx or 0
    local bytes = str_rep("\0", 256)
    bytes = M.put_u32(bytes, 0, (ctx ~= 0) and 6 or 4)
    bytes = M.put_u32(bytes, 4, 8)
    bytes = M.put_u8(bytes, 16, 2)
    bytes = M.put_u32(bytes, 20, object_id)
    bytes = M.put_u32(bytes, 28, ctx)
    return bytes
end

-- Parse a CMIF / Domain reply from a binary string buffer
function M.parse_response(bytes, opts)
    opts = opts or {}
    if opts.domain then
        local at = M.domain_data_start(bytes)
        local count = M.u32(bytes, at)
        local data_size = opts.data_size or 0
        local obj_start = at + 32 + data_size
        local flat = M.put_bytes(bytes, at, str_sub(bytes, at + 17, #bytes))
        local parsed = M.parse_response(flat)
        local objects = {}
        if parsed.result == 0 then
            for i = 0, count - 1 do
                objects[#objects + 1] = M.u32(bytes, obj_start + 4 * i)
            end
        end
        parsed.objects = objects
        parsed.obj_count = count
        parsed.data = str_sub(parsed.data, 1, data_size)
        return parsed
    end

    local first = M.u32(bytes, 0)
    local second = M.u32(bytes, 4)
    local at = 8
    local pid = nil
    local copies, moves = {}, {}
    if second >= 0x80000000 then
        local special = M.u32(bytes, at)
        at = at + 4
        if (special % 2) == 1 then
            pid = M.u64(bytes, at)
            at = at + 8
        end
        local n_copy = math_floor(special / 2) % 16
        local n_move = math_floor(special / 32) % 16
        for i = 1, n_copy do
            copies[i] = M.u32(bytes, at)
            at = at + 4
        end
        for i = 1, n_move do
            moves[i] = M.u32(bytes, at)
            at = at + 4
        end
    end
    local n_x = math_floor(first / 65536) % 16
    local n_a = math_floor(first / 1048576) % 16
    local n_b = math_floor(first / 16777216) % 16
    local n_w = math_floor(first / 268435456) % 16
    at = at + n_x * 8 + (n_a + n_b + n_w) * 12
    at = M.align_up(at, 16)
    local magic = M.u32(bytes, at)
    local result = M.u32(bytes, at + 8)
    return {
        at = at,
        magic = magic,
        sfco = (magic == M.SFCO_MAGIC),
        result = result,
        canonical_result = result % 0x400000,
        copies = copies,
        moves = moves,
        pid = pid,
        data_offset = at + 16,
        data = str_sub(bytes, at + 17)
    }
end

-- Build a WithContext (type 6) domain-routed CMIF packet (matches wire-context.mjs)
function M.build_context_packet(options)
    local x_list = options.x or {}
    local b_list = options.b or {}
    local input  = M.bytes_to_str(options.input or "")
    local buf    = str_rep("\0", 512)
    local w0     = 6 + #x_list * 65536 + #b_list * 16777216
    local payload_words = 16 + math_ceil(#input / 4) + (options.pid and 3 or 0)
    local w1     = payload_words + (options.pid and 0x80000000 or 0)
    buf = M.put_u32(buf, 0, w0)
    buf = M.put_u32(buf, 4, w1)
    local at = 8
    if options.pid then
        buf = M.put_u32(buf, at, 1)
        at = at + 12
    end
    for i = 1, #x_list do
        local d = x_list[i]
        buf = M.put_bytes(buf, at, M.pointer_descriptor({
            address = d.addr or d.address,
            size = d.size,
            index = 0
        }))
        at = at + 8
    end
    for i = 1, #b_list do
        local d = b_list[i]
        buf = M.put_bytes(buf, at, M.descriptor({
            address = d.addr or d.address,
            size = d.size,
            mode = d.attr or d.mode or 0
        }))
        at = at + 12
    end
    local ctx_at = M.align_up(at, 16)
    buf = M.put_u32(buf, ctx_at, options.token or 0x00200001)
    buf = M.put_u32(buf, ctx_at + 4, options.object or 0)
    local sfci = ctx_at + 16
    buf = M.put_u32(buf, sfci, M.SFCI_MAGIC)
    buf = M.put_u32(buf, sfci + 4, 1)
    buf = M.put_u32(buf, sfci + 8, options.cmd or 0)
    if #input > 0 then
        buf = M.put_bytes(buf, sfci + 16, input)
    end
    return buf, sfci + 16
end

-- Build a TIPC sm: GetService packet (type 0x11, token 2, service name at +8)
function M.tipc_get_service_packet(name)
    local buf = str_rep("\0", 128)
    buf = M.put_u32(buf, 0, 0x11)
    buf = M.put_u32(buf, 4, 2)
    buf = M.put_bytes(buf, 8, str_sub(name, 1, 8))
    return buf
end

-- ---------------------------------------------------------------------------
-- 5. Seedsow Native Worker ROP Frame Builder (Matches seed-rop-chain.cjs)
-- ---------------------------------------------------------------------------
function M.build_worker_frame(base, limit, calls, sdk, main)
    if (base % 4096) ~= 0 or (sdk % 4096) ~= 0 or (main % 4096) ~= 0 then
        error("Invalid worker address or modules")
    end
    if type(calls) ~= "table" or #calls < 1 then
        error("Invalid worker call list")
    end

    local MEMCPY       = sdk + M.OFFSETS.SDK.MEMCPY
    local VCALL8       = sdk + M.OFFSETS.SDK.VCALL8_RESTORE
    local PTHREAD_EXIT = sdk + M.OFFSETS.SDK.PTHREAD_EXIT
    local G_CALL2      = main + M.OFFSETS.MAIN.G_CALL2
    local G_STORE      = main + M.OFFSETS.MAIN.G_STORE_X0_X19
    local STACK        = 0x8000
    local REGION       = 0x90
    local JOB          = 0x60

    local jobs, logical_indices = {}, {}
    for _, call in ipairs(calls) do
        local fn = call["function"] or call.fn
        if not fn then error("Invalid worker call target") end
        local args = call.args or {}
        local dynamic = {}
        for i = 1, 4 do
            local a = args[i]
            if type(a) == "table" then
                if a.u32 then
                    dynamic[#dynamic + 1] = {index = i, u32 = a.u32}
                elseif a.result ~= nil then
                    dynamic[#dynamic + 1] = {index = i, result = a.result}
                else
                    error("Dynamic arguments require u32 or result")
                end
            end
        end
        local call_job_index = #jobs + #dynamic -- 0-based job index
        for _, entry in ipairs(dynamic) do
            jobs[#jobs + 1] = {
                target = MEMCPY,
                args = {0, entry.u32 or 0, 4, 0},
                dynamic = {
                    call_job_index = call_job_index,
                    index = entry.index, -- 1..4
                    result = entry.result
                }
            }
        end
        local vals = {}
        for i = 1, 4 do
            local a = args[i]
            vals[i] = (type(a) == "table") and 0 or (a or 0)
        end
        jobs[#jobs + 1] = {target = fn, args = vals}
        logical_indices[#logical_indices + 1] = #jobs - 1 -- 0-based native call index
    end

    local count = #jobs
    local chain_start = STACK
    local chain_end   = chain_start + count * REGION
    local results     = M.align_up(chain_end, 4096)
    local jobs_base   = M.align_up(results + (count + 2) * 8, 4096)
    local size        = M.align_up(jobs_base + count * JOB, 4096)
    if size > limit then error("Worker frame exceeds reserved space") end

    -- Resolve dynamic memcpy destinations into target call argument slots
    for _, job in ipairs(jobs) do
        local d = job.dynamic
        if d then
            local cji = d.call_job_index
            local at  = chain_start + cji * REGION
            local jt  = jobs_base + cji * JOB
            local idx = d.index -- 1..4
            if idx == 1 then
                job.args[1] = base + jt + 0x50
            elseif idx == 2 then
                job.args[1] = base + jt + 0x38
            elseif idx == 3 then
                job.args[1] = base + at + 0x10
            else
                job.args[1] = base + at + 0x18
            end
            if d.result ~= nil then
                local r_job = logical_indices[d.result + 1]
                if r_job == nil then error("Dynamic result call index out of range") end
                job.args[2] = base + results + r_job * 8
            end
        end
    end

    local regs_list, jobs_list, result_offsets = {}, {}, {}
    for i = 1, count do
        local job = jobs[i]
        local r = str_rep("\0", REGION)
        -- V frame (+0x00)
        r = M.put_u64(r, 0x00, job.args[1])
        r = M.put_u64(r, 0x08, job.args[2])
        r = M.put_u64(r, 0x10, job.args[3])
        r = M.put_u64(r, 0x18, job.args[4])
        r = M.put_u64(r, 0x48, G_CALL2)
        -- B frame (+0x50)
        r = M.put_u64(r, 0x58, G_STORE)
        r = M.put_bytes(r, 0x60, M.SENTINEL_BYTES)
        r = M.put_u64(r, 0x68, base + results + (i - 1) * 8)
        -- S frame (+0x70)
        r = M.put_u64(r, 0x78, (i < count) and VCALL8 or PTHREAD_EXIT)
        r = M.put_u64(r, 0x88, (i < count) and (base + jobs_base + i * JOB) or 0)
        regs_list[i] = r

        local j = str_rep("\0", JOB)
        j = M.put_u64(j, 0x38, job.args[2])
        j = M.put_u64(j, 0x48, job.target)
        j = M.put_u64(j, 0x50, job.args[1])
        jobs_list[i] = j

        result_offsets[i] = results + (i - 1) * 8
    end

    local jmpbuf = str_rep("\0", 0x70)
    jmpbuf = M.put_u64(jmpbuf, 0x00, base + jobs_base)
    jmpbuf = M.put_u64(jmpbuf, 0x58, VCALL8)
    jmpbuf = M.put_u64(jmpbuf, 0x68, base + chain_start)

    local cancel_job = logical_indices[math_min(2, #logical_indices)]
    local proof = {
        bytes                  = size,
        logicalCalls           = #calls,
        nativeCalls            = count,
        chainStart             = chain_start,
        resultsOffset          = results,
        jobsBase               = jobs_base,
        resultOffsets          = result_offsets,
        logicalResultIndices   = logical_indices,
        resultOffset           = result_offsets[count],
        stackOffset            = STACK,
        tablesOffset           = 0,
        cancelCell             = base + jobs_base + cancel_job * JOB + 0x48,
    }
    return {
        jmpbuf       = jmpbuf,
        regs_blob    = tbl_concat(regs_list),
        results_blob = str_rep(M.SENTINEL_BYTES, count + 2),
        jobs_blob    = tbl_concat(jobs_list),
        proof        = proof
    }
end

-- Materialize a full `size`-byte binary string for offline verification tests
function M.materialize_worker_frame(built)
    local p = built.proof
    local parts = {}
    parts[1] = built.jmpbuf
    parts[2] = str_rep("\0", p.chainStart - #built.jmpbuf)
    parts[3] = built.regs_blob
    parts[4] = str_rep("\0", p.resultsOffset - (p.chainStart + #built.regs_blob))
    parts[5] = built.results_blob
    parts[6] = str_rep("\0", p.jobsBase - (p.resultsOffset + #built.results_blob))
    parts[7] = built.jobs_blob
    local tail_len = p.bytes - (p.jobsBase + #built.jobs_blob)
    if tail_len > 0 then parts[8] = str_rep("\0", tail_len) end
    return tbl_concat(parts)
end

-- ---------------------------------------------------------------------------
-- 6. Live Console Memory, Allocation Tracking & Mount Table Binding (`_G.n2h`)
-- ---------------------------------------------------------------------------
require("s2_rt").attach(M)

return M
