local N = _G.n2h
local log = N.log or print

if N.block_raw and N.free then
	N.free(N.block_raw)
	N.block_raw = nil
end

local REQ_CAP = 0x8000
local BODY_CAP = 0x7000
local PORT = 8080

local CONCURRENCY = 14
local F_SETFL = 4
local O_NONBLOCK = 0x800
local EAGAIN = 11

local TSTRING_DATA = 0x18

local function i32(r)
	if r == nil or r ~= r then
		return -1
	end
	if r >= 0x80000000 then
		return -1
	end
	return r
end

-- core.lua parks the string in a pinned box and reads its TString* with the
-- non-destructive ROP peek: no temporary table, no header write, so the
-- collector can run between responses.
local function data_addr(s)
	return assert(N.str_addr(s), "httpd: no TString pointer") + TSTRING_DATA
end

local function aligned_block(size)
	local raw = N.alloc(size + 0xfff)
	assert(raw and raw ~= 0, "httpd: block allocation failed")
	local base = raw + 0xfff
	return base - base % 0x1000
end

local socket_pool = aligned_block(0xC0000)
log(string.format("[+] socket pool @ 0x%x (768 KiB)", socket_pool))

-- sockaddr_in at +0; socklen_t at +0x20
local addr_block = N.alloc(0x1000)
assert(addr_block and addr_block ~= 0, "httpd: sockaddr allocation failed")
local ADDR = addr_block
local ADDRLEN = addr_block + 0x20

local req_s = string.rep("\0", REQ_CAP)
local req_data = data_addr(req_s)

local probe = string.rep("A", 64)
local probe_addr = data_addr(probe)
N.poke(probe_addr, 0x44434241)
assert(probe:sub(1, 4) == "ABCD",
	"httpd: Lua TString data offset is not 0x18")

local function write_sockaddr(port)
	local hi = math.floor(port / 256) % 256
	local lo = port % 256
	local word = 16 + 2 * 256 + hi * 65536 + lo * 16777216
	N.poke(ADDR, word)
	N.poke(ADDR + 8, 0)
	N.poke(ADDRLEN, 16)
end
write_sockaddr(PORT)

local function respond(code, reason, body, ctype)
	body = body or ""
	return string.format(
		"HTTP/1.1 %d %s\r\n" ..
		"Content-Type: %s\r\n" ..
		"Content-Length: %d\r\n" ..
		"Connection: close\r\n" ..
		"\r\n%s",
		code, reason, ctype or "text/plain; charset=utf-8", #body, body)
end

local function percent_decode(s)
	return (s:gsub("%%(%x%x)", function(h)
		return string.char(tonumber(h, 16))
	end))
end

local function query_param(query, name)
	for pair in query:gmatch("[^&]+") do
		local k, v = pair:match("^([^=]*)=?(.*)$")
		if k and percent_decode(k) == name then
			return percent_decode(v)
		end
	end
	return nil
end

-- protect certain important files from being bricked
local protected_files = {
	["save:/core.lua"] = true,
	["save:/inject.iet"] = true,
	["save:/inject.lua"] = true,
	["save:/http.lua"] = true,
	["save:/proggy.ttf"] = true,
	["save:/save9999.dat"] = true,
	["save:/saveg.dat"] = true,
	["save:/system.dat"] = true,
}

local function save_target(name)
	if type(name) ~= "string" or name == "" then
		return nil, "empty path"
	end
	if #name > 200 then
		return nil, "path too long"
	end
	name = name:gsub("^save:/", "")
	if name == "" then
		return nil, "empty path"
	end
	if name:sub(1, 1) == "/" then
		return nil, "absolute path"
	end
	if name:find("%.%.") then
		return nil, "path escapes save:/"
	end
	if not name:match("^[%w%-%_%./]+$") then
		return nil, "bad path characters"
	end
	if protected_files["save:/" .. name] then
		return nil, "attempted to modify protected file, please use the update mechanism or modify the save using other means"
	end
	return "save:/" .. name
end

local function run_eval(src)
	local captured = {}
	local saved = print
	print = function(...)
		local n = select("#", ...)
		local parts = {}
		for i = 1, n do
			parts[i] = tostring((select(i, ...)))
		end
		captured[#captured + 1] = table.concat(parts, "\t")
	end
	local fn, lerr = loadstring(src)
	local ok, res
	if not fn then
		ok, res = false, lerr
	else
		ok, res = pcall(fn)
	end
	print = saved

	local lines = { ok and "status: ok" or "status: error" }
	if res ~= nil then
		lines[#lines + 1] = "result: " .. tostring(res)
	end
	if #captured > 0 then
		lines[#lines + 1] = "output:"
		for i = 1, #captured do
			lines[#lines + 1] = captured[i]
		end
	end
	return table.concat(lines, "\n") .. "\n"
end

local function run_save(name, body)
	local path, why = save_target(name)
	if not path then
		return nil, why
	end
	local f, err = io.open(path, "wb")
	if not f then
		return nil, tostring(err)
	end
	local ok, werr = f:write(body)
	f:close()
	if not ok then
		return nil, tostring(werr)
	end
	return #body .. " bytes to " .. path
end

local function handle(method, target, body)
	local path, query = target:match("^([^?]*)(.*)$")
	query = query:gsub("^%?", "")

	if method == "GET" and (path == "/" or path == "/status") then
		return respond(200, "OK", string.format(
			"nora2hax/seedsow HTTP server\n" ..
			"POST /eval body=<lua>\n" ..
			"PUT|POST /save?path=<name> body=<file>\n" ..
			"DELETE /delete?path=<name>\n"))
	end

	if path == "/eval" then
		if method ~= "POST" then
			return respond(405, "Method Not Allowed", "use POST /eval\n")
		end
		return respond(200, "OK", run_eval(body))
	end

	if path == "/save" then
		if method ~= "PUT" and method ~= "POST" then
			return respond(405, "Method Not Allowed", "use PUT /save?path=...\n")
		end
		local name = query_param(query, "path")
		local written, why = run_save(name, body)
		if not written then
			return respond(400, "Bad Request", "save failed: " .. tostring(why) .. "\n")
		end
		return respond(200, "OK", "wrote " .. written .. "\n")
	end

	if path == "/delete" then
		if method ~= "DELETE" then
			return respond(405, "Method Not Allowed", "use DELETE /delete?path=...\n")
		end
		local name = query_param(query, "path")
		local path, why = save_target(name)
		if not path then
			return respond(400, "Bad Request", "invalid path: " .. tostring(why) .. "\n")
		end
		local ok, err = os.remove(path)
		if not ok then
			return respond(500, "Internal Server Error", "delete failed: " .. tostring(err) .. "\n")
		end
		return respond(200, "OK", "deleted " .. path .. "\n")
	end

	return respond(404, "Not Found", "no such endpoint\n")
end

local st = {
	phase = "init",
	lfd = -1,
	cfd = -1,
	req = "",
	out = "",
	out_addr = 0,
	out_pos = 1,
}

local function parse_and_answer()
	local s = st.req
	local header_end, body_start
	local crlf = s:find("\r\n\r\n", 1, true)
	if crlf then
		header_end, body_start = crlf - 1, crlf + 4
	else
		local lf = s:find("\n\n", 1, true)
		if lf then
			header_end, body_start = lf - 1, lf + 2
		end
	end
	if not header_end then
		if #s >= REQ_CAP - 1 then
			return respond(431, "Request Header Fields Too Large", "request too large\n")
		end
		return "need"
	end
	local head = s:sub(1, header_end)
	local first = head:match("^([^\r\n]+)")
	if not first then
		return respond(400, "Bad Request", "bad request line\n")
	end
	local method, target = first:match("^(%u+)%s+(%S+)%s+HTTP/%d%.%d")
	if not method then
		return respond(400, "Bad Request", "bad request line\n")
	end

	local clen = 0
	local rest = head:sub(#first + 1)
	for line in rest:gmatch("[^\r\n]+") do
		local k, v = line:match("^([^:]+):%s*(.*)$")
		if k then
			k = k:lower()
			if k == "content-length" then
				clen = tonumber(v) or 0
			end
		end
	end

	if clen > BODY_CAP then
		return respond(413, "Payload Too Large", "body larger than " .. BODY_CAP .. "\n")
	end
	if #s < body_start + clen - 1 then
		return "need"
	end
	local body = (clen > 0) and s:sub(body_start, body_start + clen - 1) or ""
	return handle(method, target, body)
end

local function errno()
	return i32(N.call_deep(N.sdk("socket_get_last_error")))
end

local function close_client()
	if st.cfd >= 0 then
		N.call_deep(N.sdk("socket_close"), st.cfd, 0, 0, 0)
		st.cfd = -1
	end
	st.req = ""
	st.out = ""
	st.out_pos = 1
end

local function http_stop(what, res)
	if st.phase == "dead" then
		return
	end
	st.phase = "dead"
	log(string.format("[!] httpd: %s -> %s; server stopped", what, tostring(res)))
end

local function already_initialized(res)
	return res ~= 0 and res % 512 == 27
		and math.floor(res / 512) % 8192 == 2
end

local function post_init()
	local res = i32(N.call_deep(N.sdk("socket_initialize"), socket_pool,
		0xC0000, 0x20000, CONCURRENCY))
	log(string.format("[D] socket initialize -> 0x%x", res))
	if res ~= 0 and not already_initialized(res) then
		http_stop("socket initialize", string.format("0x%x", res))
		return
	end

	local fd = i32(N.call_deep(N.sdk("socket_socket"), 2, 1, 0))
	if fd < 0 then
		http_stop("socket", fd)
		return
	end
	st.lfd = fd
	log(string.format("[D] socket fd=%d", fd))

	local bind_res = i32(N.call_deep(N.sdk("socket_bind"), fd, ADDR, 16))
	if bind_res ~= 0 then
		http_stop("bind", bind_res)
		return
	end
	local listen_res = i32(N.call_deep(N.sdk("socket_listen"), fd, 4))
	if listen_res ~= 0 then
		http_stop("listen", listen_res)
		return
	end

	local fr = i32(N.call_deep(N.sdk("socket_fcntl"), fd,
		F_SETFL, O_NONBLOCK))
	if fr < 0 then
		http_stop("fcntl(listen)", errno())
		return
	end

	st.lfd = fd
	st.phase = "accept"
	log(string.format("HTTP server listening on http://CONSOLE_IP:%d", PORT))
end

local function pump_accept()
	local fd = i32(N.call_deep(N.sdk("socket_accept"), st.lfd, ADDR, ADDRLEN))
	if fd >= 0 then
		local fr = i32(N.call_deep(N.sdk("socket_fcntl"), fd,
			F_SETFL, O_NONBLOCK))
		if fr < 0 then
			log(string.format("[!] httpd: fcntl(%d) -> %d", fd, errno()))
			N.call_deep(N.sdk("socket_close"), fd, 0, 0, 0)
			return
		end
		st.cfd = fd
		st.req = ""
		st.out = ""
		st.out_pos = 1
		st.phase = "recv"
		-- log(string.format("[httpd] accept fd=%d", fd))
		return
	end
	local err = errno()
	if err ~= EAGAIN then
		http_stop("accept", err)
	end
end

local function pump_recv()
	local n = i32(N.call_deep(N.sdk("socket_recv"),
		st.cfd, req_data, REQ_CAP, 0))
	if n > 0 then
		st.req = st.req .. req_s:sub(1, n)
		local verdict = parse_and_answer()
		if verdict == "need" then
			return
		end
		st.out = verdict
		st.out_addr = data_addr(st.out)
		st.out_pos = 1
		st.phase = "send"
	elseif n == 0 then
		log("[httpd] peer closed")
		close_client()
		st.phase = "accept"
	else
		local err = errno()
		if err ~= EAGAIN then
			log(string.format("[httpd] recv errno=%d", err))
			close_client()
			st.phase = "accept"
		end
	end
end

local function pump_send()
	local remaining = #st.out - st.out_pos + 1
	local where = st.out_addr + st.out_pos - 1
	local n = i32(N.call_deep(N.sdk("socket_send"),
		st.cfd, where, remaining, 0))
	if n > 0 then
		st.out_pos = st.out_pos + n
		if st.out_pos > #st.out then
			close_client()
			st.phase = "accept"
		end
	elseif n == 0 then
		close_client()
		st.phase = "accept"
	else
		local err = errno()
		if err ~= EAGAIN then
			log(string.format("[httpd] send errno=%d", err))
			close_client()
			st.phase = "accept"
		end
	end
end

function n2h_http_frame()
	if st.phase == "accept" then
		pump_accept()
	elseif st.phase == "recv" then
		pump_recv()
	elseif st.phase == "send" then
		pump_send()
	end
end

post_init()
e:setEventHandler{ onEnterFrame = "n2h_http_frame" }

if _G.n2h_clear then _G.n2h_clear() end
local shades = {"0x8FFFD2", "0x62E9B5", "0xC4FFE8", "0x71D6B2"}
local patterns = {
    "< >     /\\     < >     \\/     < >",
    "  < >   /  \\   < >   /  \\   < >",
    "    < > /\\  /\\ < > /\\  /\\ < >",
    "  < >   \\/  /   < >   \\/  /   < >"
}
local active = 1
local frames = 0

local function draw(id, top, height, size, color, data)
    e:tag{"chgmsg", id = id, stack = "0"}
    e:tag{
        "font",
        anchorcenter = "0",
        face = "save:/proggy.ttf",
        left = "90",
        top = tostring(top),
        width = "1100",
        height = tostring(height),
        size = tostring(size),
        rubysize = "0",
        spacetop = "0",
        spacemiddle = "0",
        spacebottom = "0",
        color = color,
        shadowcolor = "0x000000",
        outlinecolor = "0x000000",
        shadow = "0",
        outline = "0",
        rubyshadow = "0",
        rubyoutline = "0",
        align = "center",
        style = "",
        hung = "1",
        stack = "0"
    }
    e:tag{"print", data = data}
    e:tag{"rt"}
end

e:tag{"lyc", color = "0xFF020B08", width = "1280", height = "720", id = "0"}
e:tag{"fontinit"}
for i = 1, #shades do
    draw("cpypwn_shape_" .. i, 206, 88, 34, shades[i], patterns[i])
    draw("cpypwn_name_" .. i, 292, 180, 112, shades[i], "cpypwn")
    if i ~= 1 then
        e:tag{"lyprop", id = "~cpypwn_shape_" .. i, visible = "0"}
        e:tag{"lyprop", id = "~cpypwn_name_" .. i, visible = "0"}
    end
end

function cpypwn_artemis_frame()
    frames = frames + 1
    if frames % 12 ~= 0 then
        return
    end
    e:tag{"lyprop", id = "~cpypwn_shape_" .. active, visible = "0"}
    e:tag{"lyprop", id = "~cpypwn_name_" .. active, visible = "0"}
    active = active % #shades + 1
    e:tag{"lyprop", id = "~cpypwn_shape_" .. active, visible = "1"}
    e:tag{"lyprop", id = "~cpypwn_name_" .. active, visible = "1"}
end


local http_label_visible = false

function cpypwn_artemis_http_frame()
    n2h_http_frame()
    local ready = st.phase ~= "init" and st.phase ~= "dead"
    if ready and not http_label_visible then
        draw("cpypwn_http_status", 534, 70, 36, "0xFFFFFF", "HTTP listening")
    elseif http_label_visible and not ready then
        e:tag{"lyprop", id = "~cpypwn_http_status", visible = "0"}
    end
    http_label_visible = ready
    cpypwn_artemis_frame()
end

e:setEventHandler{onEnterFrame = "cpypwn_artemis_http_frame"}
