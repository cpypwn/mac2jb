-- Single-worker proof derived from 040a357b (Ryujinx-only); no hardware claim.
local N = assert(_G.n2h, "n2h is not initialized")
local L = {
	stride = 0x3000,
	tt = 0x000,
	tt_alloc = 0x200,
	handle = 0x1B8,
	priority = 0x44,
	stack_size_field = 0x50,
	stack_ptr = 0x58,
	stack = 0x200,
	stack_size = 0x800,
	pd = 0xBB0,
	pd_x29 = 0xBE0,
	pd_x30 = 0xBE8,
	chain = 0xBF0,
	desc = 0x1000,
	desc_size = 0xC00,
	out = 0x1C00,
	wait_index = 0x1C08,
	marker = 0x1C10,
	cmd = 0x1C80,
	ack = 0x1CA0,
	status = 0x1CC0,
	job = 0x1D00,
	loop_scratch = 0x1D60,
	job_signal = 0x1D80,
	thread_priority = 0x10,
	slack = 0x10
}
local G = {
	thread_pivot = 0x111DCC,
	pivot = 0x14A94C,
	call2 = 0x0B7A88
}
local ARMED, GO = 1, 2
local SEQ = 0x4E4F5241
local SLEEP_NS = 1000000
local POLL_LIMIT = 100
local JOIN_NS = 250000000
local R = {}

local function hex(v)
	if type(v) == "number" then
		return string.format("0x%x", v)
	end
	return tostring(v)
end

local function run()
	assert(N.gadgets.g_load_x0 and N.gadgets.g_load_x19 and
		N.gadgets.g_store_x0_x19, "missing core gadgets")
	assert(N.offsets_sdk.wait_for_address_eq1_inf and
		N.offsets_sdk.thread_impl_create and N.offsets_sdk.thread_impl_start and
		N.offsets_sdk.svc_signal_to_address and N.offsets_sdk.svc_wait_sync and
		N.offsets_sdk.svc_close_handle, "missing core SDK offsets")

	R.raw = N.alloc(L.stride + 0xFFF)
	assert(R.raw and R.raw ~= 0, "worker allocation failed")
	R.block = R.raw + 0xFFF
	R.block = R.block - R.block % 0x1000
	R.tt = R.block + L.tt

	local function owned(a)
		return type(a) == "number" and a >= R.block and a + 12 <= R.block + L.stride
	end
	local function poke(a, v)
		assert(owned(a), "worker poke outside owned block")
		N.poke(a, v)
	end
	local function peek(a)
		assert(owned(a), "worker peek outside owned block")
		return N.peek(a)
	end
	local function w(off)
		return R.block + off
	end
	local function sdk(name)
		return N.sdk_base + N.offsets_sdk[name]
	end
	local function main(va)
		return N.main_base + va
	end

	for off = 0, L.tt_alloc - 8, 8 do
		poke(R.tt + off, 0)
	end
	poke(R.tt + L.priority, L.thread_priority)
	poke(R.tt + L.stack_size_field, L.stack_size)
	poke(R.tt + L.stack_ptr, w(L.stack))

	for off = 0, 0x40, 8 do
		poke(w(L.pd) + off, 0)
	end
	poke(w(L.pd_x29), w(L.chain) + 0x50)
	poke(w(L.pd_x30), main(G.pivot))

	poke(w(L.out), 0)
	poke(w(L.wait_index), 0)
	poke(w(L.marker), 0)
	poke(w(L.cmd), ARMED)
	poke(w(L.ack), ARMED)
	poke(w(L.status), 0)
	poke(w(L.job) + 0x38, 0)
	poke(w(L.job) + 0x40, 0)
	poke(w(L.job) + 0x48, 0)
	poke(w(L.job) + 0x50, 0)
	poke(w(L.loop_scratch), 0)
	poke(w(L.job_signal) + 0x38, 0)
	poke(w(L.job_signal) + 0x48, sdk("svc_signal_to_address"))
	poke(w(L.job_signal) + 0x50, w(L.ack))

	for off = 0, 0x58, 8 do
		poke(w(L.chain) + off, 0)
	end
	poke(w(L.chain) + 0x50, 0)
	poke(w(L.chain) + 0x58, main(N.gadgets.g_load_x19))

	local E = N.new_emitter(w(L.chain) + 0x60, w(L.desc),
		w(L.desc) + L.desc_size, w(L.desc) - L.slack, w(L.loop_scratch))
	local function q(a, v)
		assert(owned(a), "worker emitter write outside owned block")
		E.words[#E.words + 1] = {a, v}
	end
	local function wait_eq1(a)
		E:g1(a)
		E:patch(sdk("wait_for_address_eq1_inf"))
		local b = E.cursor
		for off = 0, 0x30, 8 do
			q(b + off, 0)
		end
		E.cursor = b + 0x40
		E.pending = b + 0x38
	end
	local function vcall2(desc)
		E:g1(desc)
		E:patch(main(G.call2))
		local b = E.cursor
		q(b, 0)
		q(b + 8, desc)
		q(b + 0x10, 0)
		E.cursor = b + 0x20
		E.pending = b + 0x18
	end
	local function loop()
		E:patch(main(N.gadgets.g_load_x0))
		local b = E.cursor
		q(b, 0)
		q(b + 8, 0)
		q(b + 0x10, w(L.chain) + 0x50)
		q(b + 0x18, main(G.pivot))
		E.cursor = b + 0x20
		E.pending = nil
	end

	wait_eq1(w(L.cmd))
	vcall2(w(L.job))
	E:g1(w(L.marker))
	E:g2(0, 0)
	E:peek(w(L.job) + 0x40, w(L.status))
	E:g0(1)
	E:g1(w(L.cmd))
	E:g2(0, 0)
	E:g0(0)
	E:g1(w(L.ack))
	E:g2(0, 0)
	vcall2(w(L.job_signal))
	loop()
	assert(E.cursor <= E.chain_end, "worker chain overlaps descriptors")
	E:flush()

	R.may_have_thread = true
	N.run_chain(function(e)
		e:call3(sdk("thread_impl_create"), 0, R.tt, main(G.thread_pivot))
		e:call3(sdk("thread_impl_start"), 0, R.tt, 0)
	end)
	local raw_handle = peek(R.tt + L.handle)
	R.handle = raw_handle and raw_handle % 0x100000000 or nil
	assert(R.handle and R.handle ~= 0, "worker handle was not created")

	N.call_deep(sdk("svc_sleep_thread"), SLEEP_NS, 0, 0, 0, 0)
	assert(peek(w(L.cmd)) == ARMED and peek(w(L.ack)) == ARMED and
		peek(w(L.status)) == 0, "worker did not remain initially gated")

	poke(w(L.job) + 0x38, 0)
	poke(w(L.job) + 0x40, SEQ)
	poke(w(L.job) + 0x48, sdk("svc_sleep_thread"))
	poke(w(L.job) + 0x50, SLEEP_NS)
	poke(w(L.ack), ARMED)
	poke(w(L.cmd), GO)
	local signal_result = N.call_deep(sdk("svc_signal_to_address"),
		w(L.cmd), 0, 0, 0, 0)
	assert(signal_result == 0, "job signal failed: " .. hex(signal_result))

	local ack
	for _ = 1, POLL_LIMIT do
		ack = peek(w(L.ack))
		if ack == 0 then
			break
		end
		N.call_deep(sdk("svc_sleep_thread"), SLEEP_NS, 0, 0, 0, 0)
	end
	R.ack, R.status, R.cmd, R.marker = ack, peek(w(L.status)),
		peek(w(L.cmd)), peek(w(L.marker))
	assert(ack == 0, "bounded job acknowledgement timeout")
	assert(R.status == SEQ, "job sequence mismatch: " .. hex(R.status))
	assert(R.cmd == ARMED, "worker did not re-arm: " .. hex(R.cmd))

	poke(w(L.job) + 0x38, 0)
	poke(w(L.job) + 0x40, 0)
	poke(w(L.job) + 0x48, sdk("svc_exit_thread"))
	poke(w(L.job) + 0x50, 0)
	poke(w(L.cmd), GO)
	signal_result = N.call_deep(sdk("svc_signal_to_address"),
		w(L.cmd), 0, 0, 0, 0)
	assert(signal_result == 0, "exit signal failed: " .. hex(signal_result))

	poke(w(L.wait_index), 0)
	R.join_result = N.call_deep(sdk("svc_wait_sync"), w(L.out),
		R.tt + L.handle, 1, JOIN_NS, 0)
	assert(R.join_result == 0, "bounded join failed: " .. hex(R.join_result))
	R.wait_index = peek(w(L.wait_index))
	assert(R.wait_index == 0, "unexpected join index: " .. hex(R.wait_index))
	R.joined = true

	R.close_result = N.call_deep(sdk("svc_close_handle"), R.handle, 0, 0, 0, 0)
	assert(R.close_result == 0, "close failed: " .. hex(R.close_result))
	R.closed = true
	N.free(R.raw)
	R.freed = true

	print(string.format("PASS worker_probe seq=0x%x status=0x%x ack=%d marker=%s",
		SEQ, R.status, R.ack, hex(R.marker)))
	print("PASS worker_probe joined=1 handle_closed=1 memory_freed=1 raw=" ..
		hex(R.raw) .. " worker=" .. hex(R.block))
end

local ok, err = xpcall(run, function(e) return tostring(e) end)
if not ok then
	print("FAIL worker_probe: " .. tostring(err))
	if R.raw and not R.freed then
		print("RETAINED worker_probe cleanup=uncertain raw=" .. hex(R.raw) ..
			" worker=" .. hex(R.block) .. " thread_type=" .. hex(R.tt) ..
			" handle=" .. hex(R.handle))
		print("RETAINED worker_probe joined=" .. tostring(R.joined) ..
			" handle_closed=" .. tostring(R.closed) ..
			" ack=" .. hex(R.ack) .. " status=" .. hex(R.status))
	end
end
return ok and "PASS" or "FAIL"
