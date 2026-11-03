
-- the SDK bitches and aborts on an invalid mount name
package.path = "./?.lua;save:/lib/?.lua"

local KEYS = {
	A = 13,
	B = 27,
	X = 112,
	Y = 113,
	MINUS = 114
}

local old_print = print
_G.n2h_orig_print = old_print

local current_msg = "debug_mw"
local msg_gen = 0

local LOG_MAX = 64
local log_lines = {}

local function log_push(line)
	log_lines[#log_lines + 1] = line
	while #log_lines > LOG_MAX do
		table.remove(log_lines, 1)
	end
end

local function apply_font()
	e:tag{
		"font",
		anchorcenter = "0",
		face = "save:/proggy.ttf",
		left = "5",
		top = "5",
		width = "1270",
		height = "710",
		size = "26",
		rubysize = "0",
		spacetop = "0",
		spacemiddle = "0",
		spacebottom = "0",
		color = "0xFFFFFF",
		shadowcolor = "0x000000",
		outlinecolor = "0x000000",
		shadow = "0",
		outline = "0",
		rubyshadow = "0",
		rubyoutline = "0",
		align = "left",
		style = "",
		hung = "1",
		stack = "0"
	}
end

local function init_console()
	e:tag{
		"lyc",
		color = "0xFF000000",
		width = "1280",
		height = "720",
		id = "0"
	}
	e:tag{"fontinit"}
	e:tag{
		"chgmsg",
		id = current_msg,
		stack = "0"
	}
	apply_font()

	print = function(...)
		local args = {...}
		local formatted_args = {}
		for i, v in ipairs(args) do
			if type(v) == "string" then
				formatted_args[i] = v
			else
				formatted_args[i] = tostring(v)
			end
		end
		local line = table.concat(formatted_args, " ")
		log_push(line)
		old_print(unpack(args))
		e:tag{
			"print",
			data = line
		}
		e:tag{"rt"}
	end
end

local function n2h_clear()
	local old = current_msg
	msg_gen = msg_gen + 1
	current_msg = "n2h_msg_" .. msg_gen
	e:tag{"lyprop", id = "~" .. old, visible = "0"}
	e:tag{"chgmsg", id = current_msg, stack = "0"}
	apply_font()
	for i = #log_lines, 1, -1 do
		log_lines[i] = nil
	end
end
_G.n2h_clear = n2h_clear

function n2h_launcher_idle() end

local selected = false
local is_recovery = false

local function launch(mode)
	if selected then
		return
	end

	local updated_payload = "save:/" .. mode .. "2.lua"
	local payload = "save:/" .. mode .. ".lua"

	if is_recovery then
		print("[*] recovery mode (ignoring script updates)")
	end

	if not is_recovery and e:isFileExists(updated_payload) then
		print("[*] launcher: using updated payload (hold - to ignore)")
		payload = updated_payload
	end

	if not e:isFileExists(payload) then
		print("[!] launcher: " .. payload .. " is missing")
		return
	end

	local core_path = "save:/core.lua"

	-- we want to potentially allow updating the code without bricking our HTTP server
	local updated_core_path = "save:/core2.lua"
	if not is_recovery and e:isFileExists(updated_core_path) then
		print("[*] launcher: using updated core from " .. updated_core_path)
		core_path = updated_core_path
	end

	selected = true

	e:setEventHandler{ onEnterFrame = "n2h_launcher_idle" }
	n2h_clear()
	if mode == "http" then print = _G.n2h_orig_print end
	e:include(core_path)
	e:include(payload)
end

function n2h_launcher_frame()
	if selected then
		return
	end

	-- for i = 1, 256 do
	-- 	if e:isDownEdge(i) then
	-- 		print("[*] launcher: key " .. i .. " pressed")
	-- 	end
	-- end

	if e:isDownEdge(KEYS.MINUS) and not is_recovery then
		is_recovery = true
		print("[!] RECOVERY MODE (ignoring script updates)")
	elseif e:isDownEdge(KEYS.A) then
		launch("exploita")
	elseif e:isDownEdge(KEYS.B) then
		launch("exploitb")
	elseif e:isDownEdge(KEYS.Y) then
		launch("http")
	end
end

local function launcher_main()
	init_console()

	print("==============================================")
	print(" switch-artemis-launcher by alula")
	print("==============================================")
	print(" Press a button on the controller to launch:")
	print(" A : slot 1 (exploit1.lua)")
	print(" B : slot 2 (exploit2.lua)")
	print(" Y : HTTP server")
	-- print(" - : Lua REPL") -- no nn::swkbd :(
	print("==============================================")

	if _G.n2h_was_recovery then
		print("[!] Ignored launcher update. Press - again to enable recovery mode for payloads.")
	end

	e:setEventHandler{ onEnterFrame = "n2h_launcher_frame" }
end

launcher_main()