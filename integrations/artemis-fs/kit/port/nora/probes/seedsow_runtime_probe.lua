local checks = 0
local failures = 0

local function check(ok, name, detail)
	checks = checks + 1
	if not ok then
		failures = failures + 1
	end
	print((ok and "ok " or "FAIL ") .. name ..
		(detail and (" " .. detail) or ""))
end

local function aligned_base(value)
	return type(value) == "number" and value > 0 and
		value == math.floor(value) and value % 0x1000 == 0
end

local N = rawget(_G, "n2h")
check(type(N) == "table", "n2h.present", type(N))
if type(N) ~= "table" then
	print(string.format("SEEDSOW_PROBE FAIL checks=%d failures=%d", checks, failures))
	return
end

check(N.platform == "Ounce", "platform.Ounce", tostring(N.platform))
check(aligned_base(N.main_base), "main_base.aligned",
	type(N.main_base) == "number" and string.format("0x%x", N.main_base) or tostring(N.main_base))
check(aligned_base(N.sdk_base), "sdk_base.aligned",
	type(N.sdk_base) == "number" and string.format("0x%x", N.sdk_base) or tostring(N.sdk_base))

local required = {
	{ "thread", "thread_impl_create", 0x13dcc4 },
	{ "thread", "thread_impl_start", 0x13e0b4 },
	{ "thread", "svc_exit_thread", 0x168b4c },
	{ "thread", "get_message_buffer_on_tls", 0x14ba80 },
	{ "thread", "os_get_thread_id", 0x1371f0 },
	{ "thread", "get_thread_priority", 0x1370c0 },
	{ "ipc", "svc_get_info", 0x168ca4 },
	{ "ipc", "svc_send_sync", 0x168c4c },
	{ "ipc", "svc_send_sync_user", 0x168c54 },
	{ "ipc", "svc_wait_sync", 0x168bf4 },
	{ "ipc", "svc_close_handle", 0x168be4 },
	{ "timing", "svc_sleep_thread", 0x168b54 },
	{ "timing", "svc_wait_for_address", 0x168d1c },
	{ "timing", "svc_signal_to_address", 0x168d24 },
	{ "timing", "wait_for_address_eq1_inf", 0x132784 },
	{ "timing", "os_yield_thread", 0x1370f0 },
	{ "socket", "socket_initialize", 0x14d960 },
	{ "socket", "socket_is_initialized", 0x14d930 },
	{ "socket", "socket_socket", 0x14d4c0 },
	{ "socket", "socket_bind", 0x14d3b0 },
	{ "socket", "socket_listen", 0x14d440 },
	{ "socket", "socket_accept", 0x14d380 },
	{ "socket", "socket_recv", 0x14d300 },
	{ "socket", "socket_send", 0x14d350 },
	{ "socket", "socket_close", 0x14d510 },
	{ "socket", "socket_fcntl", 0x14d560 },
	{ "socket", "socket_get_last_error", 0x14d820 },
	{ "call_native", "longjmp", 0x5511b4 },
	{ "call_native", "vcall8_restore", 0x3d9e54 },
}

check(type(N.offsets_sdk) == "table", "offsets_sdk.present", type(N.offsets_sdk))
if type(N.offsets_sdk) == "table" then
	for i = 1, #required do
		local entry = required[i]
		local actual = N.offsets_sdk[entry[2]]
		check(actual == entry[3], entry[1] .. "." .. entry[2],
			type(actual) == "number" and string.format("0x%x", actual) or tostring(actual))
	end
else
	failures = failures + #required
	checks = checks + #required
end

print(string.format("SEEDSOW_PROBE %s checks=%d failures=%d",
	failures == 0 and "PASS" or "FAIL", checks, failures))
