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
	print(string.format("NORA_PROBE FAIL checks=%d failures=%d", checks, failures))
	return
end

check(N.platform == "Ounce", "platform.Ounce", tostring(N.platform))
check(aligned_base(N.main_base), "main_base.aligned",
	type(N.main_base) == "number" and string.format("0x%x", N.main_base) or tostring(N.main_base))
check(aligned_base(N.sdk_base), "sdk_base.aligned",
	type(N.sdk_base) == "number" and string.format("0x%x", N.sdk_base) or tostring(N.sdk_base))

local required = {
	{ "thread", "thread_impl_create", 0x0b39b0 },
	{ "thread", "thread_impl_start", 0x0b3c10 },
	{ "thread", "thread_impl_pop_x1_x4", 0x477dac },
	{ "thread", "svc_exit_thread", 0x0d96cc },
	{ "thread", "svc_sleep_thread", 0x0d96d4 },
	{ "thread", "wait_for_address_eq1_inf", 0x0aa86c },
	{ "thread", "get_message_buffer_on_tls", 0x0bfea0 },
	{ "thread", "get_thread_priority", 0x0ad7f0 },
	{ "ipc", "svc_get_info", 0x0d9824 },
	{ "ipc", "svc_send_sync", 0x0d97cc },
	{ "ipc", "svc_send_sync_user", 0x0d97d4 },
	{ "ipc", "svc_wait_sync", 0x0d9774 },
	{ "ipc", "svc_close_handle", 0x0d9764 },
	{ "ipc", "svc_wait_for_address", 0x0d989c },
	{ "ipc", "svc_signal_to_address", 0x0d98a4 },
	{ "fs", "fs_singleton", 0x0b16900 },
	{ "fs", "fs_proxy", 0x020 },
	{ "fs", "fs_session_pool", 0x03a8 },
	{ "fs", "fs_proxy_domain_id", 0x018 },
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

print(string.format("NORA_PROBE %s checks=%d failures=%d",
	failures == 0 and "PASS" or "FAIL", checks, failures))
