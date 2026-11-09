-- Socket constants and FFI struct definitions for Switch nn::socket.
-- No native calls here; just types used by socket_nx.lua and the dispatch chain.
local ffi = require("ffi")

ffi.cdef [[
typedef struct {
    unsigned char len, family, port_hi, port_lo;
    unsigned int addr;
    unsigned char zero[8];
} ls_sockaddr;
typedef struct { int fd; short events; short revents; } ls_pollfd;
]]

local M = {
    ffi = ffi,
    AF_INET = 2, SOCK_STREAM = 1, IPPROTO_TCP = 6,
    SOL_SOCKET = 0xffff, SO_REUSEADDR = 0x0004,
    F_GETFL = 3, F_SETFL = 4, O_NONBLOCK_NX = 0x800,
    POLLIN = 0x0001, POLLOUT = 0x0004, POLLERR = 0x0008, POLLHUP = 0x0010,
}

function M.sockaddr_in(port, addr)
    assert(type(port) == "number" and port % 1 == 0 and port >= 0 and port <= 65535,
           "invalid TCP port")
    addr = addr or 0
    assert(type(addr) == "number" and addr % 1 == 0 and addr >= 0 and addr <= 0xffffffff,
           "invalid IPv4 address")
    local sa = ffi.new("ls_sockaddr")
    sa.len, sa.family = 16, M.AF_INET
    sa.port_hi, sa.port_lo = math.floor(port / 256), port % 256
    sa.addr = addr
    return sa
end

function M.ipv4(n)
    local b = require("bit")
    n = tonumber(n) or 0
    return ("%d.%d.%d.%d"):format(
        b.band(n, 0xff), b.band(b.rshift(n, 8), 0xff),
        b.band(b.rshift(n, 16), 0xff), b.band(b.rshift(n, 24), 0xff))
end

return M
