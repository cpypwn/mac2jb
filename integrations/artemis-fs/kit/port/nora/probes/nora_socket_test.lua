-- Validate n2h BSD sockets (foundation for the bridge adapter: console LISTENS,
-- PC engine connects in). Create a TCP socket, bind :39381, listen.
local N = assert(_G.n2h, "n2h not initialized")
local function sdk(o) return N.sdk_base+o end
local function hx(v) return string.format("0x%x",v) end
local O = N.offsets_sdk
-- prefer n2h-provided socket offsets; fall back to the dump-derived ones
local SOCK = {
  init  = (O and O.socket_initialize) or 0x14d960,
  isini = (O and O.socket_is_initialized) or 0x14d930,
  socket= (O and O.socket_socket) or 0x14d4c0,
  bind  = (O and O.socket_bind) or 0x14d3b0,
  listen= (O and O.socket_listen) or 0x14d440,
  fcntl = (O and O.socket_fcntl) or 0x14d560,
  close = (O and O.socket_close) or 0x14d510,
  lasterr=(O and O.socket_get_last_error) or 0x14d820,
}
-- signed-32 interpretation of a call_deep return
local function s32(v) v = v % 0x100000000; if v >= 0x80000000 then return v - 0x100000000 end return v end

print("sockets initialized? "..hx(N.call_deep(sdk(SOCK.isini),0,0,0,0,0)))

local fd = s32(N.call_deep(sdk(SOCK.socket), 2, 1, 0, 0, 0))  -- AF_INET=2, SOCK_STREAM=1
print("socket() fd = "..fd.." (lasterr "..hx(N.call_deep(sdk(SOCK.lasterr),0,0,0,0,0))..")")
if fd < 0 then print("SOCKETS NOT USABLE (socket() failed)"); return end

-- sockaddr_in @ sa: [0]=len 16, [1]=AF_INET 2, [2..3]=port BE 39381=0x99D5, [4..7]=INADDR_ANY 0
local sa = N.alloc(0x40); sa = sa - sa%16
for o=0,0x18,8 do N.poke(sa+o,0) end
N.write_bytes(sa, string.char(16, 2, 0x99, 0xD5, 0,0,0,0))  -- len,family,port(BE),addr=0
local br = s32(N.call_deep(sdk(SOCK.bind), fd, sa, 16, 0, 0))
print("bind(:39381) = "..br.." (lasterr "..hx(N.call_deep(sdk(SOCK.lasterr),0,0,0,0,0))..")")
local lr = s32(N.call_deep(sdk(SOCK.listen), fd, 4, 0, 0, 0))
print("listen() = "..lr)
N.call_deep(sdk(SOCK.close), fd, 0,0,0,0)
print((fd>=0 and br==0 and lr==0) and "*** n2h SOCKETS WORK (bridge adapter feasible) ***" or "*** socket setup failed ***")
