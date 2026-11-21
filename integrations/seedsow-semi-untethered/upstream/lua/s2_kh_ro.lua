-- s2_kh_ro.lua — API Workers, Donor Stage, Gate Controller, RO Launch & Bootstrap NRO
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)
-- Split from s2_kaihen.lua to stay under the 32,768-byte http.lua PUT /save upload cap.

local P = require("s2_prim")

local str_byte   = string.byte
local str_char   = string.char
local str_sub    = string.sub
local str_rep    = string.rep
local str_format = string.format

local R = {}

function R.run_ro_and_bootstrap(M, env)
    local rt                    = env.rt
    local fs                    = env.fs
    local ctx                   = env.ctx
    local slots                 = env.slots
    local ep                    = env.ep
    local kh_log                = env.kh_log
    local arena_alloc           = env.arena_alloc
    local track                 = env.track
    local open_sd_card          = env.open_sd_card
    local sd_read_file          = env.sd_read_file
    local read_fs               = env.read_fs
    local write_fs_unverified   = env.write_fs_unverified
    local compare_write_fs      = env.compare_write_fs
    local export_handle         = env.export_handle
    local verify_and_relocate_sd = env.verify_and_relocate_sd
    local arm_endpoint          = env.arm_endpoint
    local derive_layout_and_loader = env.derive_layout_and_loader
    local open_notifier         = env.open_notifier
    local open_pm_sessions      = env.open_pm_sessions
    local copy_loader_and_open_codefs = env.copy_loader_and_open_codefs

    local function cancel_api_workers()
        local CANCEL = rt.SDK + P.OFFSETS.SDK.SVC_CANCEL_SYNC
        for _, w in ipairs(ctx.apiWorkers) do
            rt.N.call_deep(CANCEL, w.handle, 0, 0, 0, 0)
        end
    end

    local function prepare_workers_and_donor()
        require("s2_rt").prepare_kh_workers_and_donor(P, M, env)
    end

    -- Bind server sessions & prepare gate event
    local function bind_sessions_and_gate_event()
        local sbytes = read_fs(ctx.layout.slots, 0x10000)
        local hv_s   = P.u64s(ctx.layout.holderVptr)
        local d1     = ctx.loaderCopy.ownDomain
        local d2     = ctx.loaderRoot.domain
        local rows   = {}
        for off = 0, #sbytes - 0x88, 0x88 do
            if str_sub(sbytes, off + 1, off + 8) == hv_s then
                local dom = P.u64(sbytes, off + 0x70)
                if dom == d1 or dom == d2 then
                    rows[#rows + 1] = {
                        address       = ctx.layout.slots + off,
                        vptr          = ctx.layout.holderVptr,
                        domain        = dom,
                        parent        = P.u64(sbytes, off + 0x28),
                        wait          = P.u32(sbytes, off + 0x30),
                        state         = P.u32(sbytes, off + 0x40),
                        receiveResult = P.u32(sbytes, off + 0x44),
                        receive       = P.u32(sbytes, off + 0x48),
                        request       = P.u64(sbytes, off + 0x60),
                        metadata      = P.u64(sbytes, off + 0x78),
                        raw           = P.hex(str_sub(sbytes, off + 1, off + 0x88))
                    }
                end
            end
        end
        assert(#rows == 2, "KH: server session bindings not unique")
        ctx.bound = {rows = rows, waiters = ctx.layout.waiters}

        local nb = read_fs(ctx.notifier.B + 0x20, 16)
        local write_ev_fs = P.u32(nb, 8)
        local exp_ev = export_handle(write_ev_fs, "notifier-write-event")
        ctx.gateEvent = {
            sourceHandle = ctx.notifier.eventHandle,
            read         = ctx.notifier.readEvent,
            write        = exp_ev.handle
        }
    end

    -- Gate controller on Loader server session
    local wait_zero_buf = arena_alloc(0x40)
    local function wait_zero(h)
        rt.wr_u64(wait_zero_buf, 0)
        rt.wr_u64(wait_zero_buf + 8, h)
        local rc = P.u32_norm(rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.SVC_WAIT_SYNC, wait_zero_buf, wait_zero_buf + 8, 1, 0, 0))
        return rc == 0
    end

    local function new_gate(row, server_copy, gate_ev)
        local g = {
            row        = row,
            serverCopy = server_copy,
            event      = gate_ev,
            park       = gate_ev.sourceHandle,
            waiters    = ctx.layout.waiters,
            parked     = false,
        }
        local waiter_set = {}
        for _, w in ipairs(g.waiters) do waiter_set[w] = true end

        function g.inspect()
            local b = read_fs(g.row.address, 0x88)
            return {
                parent        = P.u64(b, 0x28),
                state         = P.u32(b, 0x40),
                receiveResult = P.u32(b, 0x44)
            }
        end

        function g.selections()
            local b = read_fs(g.waiters[1] + 0x10, 6 * 0x110 + 8)
            local sel = {}
            for i = 0, 6 do sel[i + 1] = P.u64(b, i * 0x110) end
            return sel
        end

        function g.pending()
            return wait_zero(g.serverCopy)
        end

        function g.step(empty_mode)
            local orig4 = read_fs(g.row.request, 4)
            local ffff4 = str_char(0xFF, 0xFF, 0xFF, 0xFF)
            compare_write_fs(g.row.request, orig4, ffff4)
            local last_inj = nil
            for _ = 1, 30 do
                local sel = g.selections()
                local ses = g.inspect()
                local epoch = waiter_set[ses.parent] and P.u64(read_fs(ses.parent + 0x18, 8), 0) or nil
                local hdr = P.u32(read_fs(g.row.request, 4), 0)
                local row_selected = false
                for _, sv in ipairs(sel) do if sv == g.row.address then row_selected = true end end

                if empty_mode and last_inj and not row_selected and hdr == 0xFFFFFFFF and
                   ses.state == 1 and ses.receiveResult == 3 and waiter_set[ses.parent] then
                    -- On Seedsow the waiter parent/epoch can stay the same after cancellation (gate.cjs:253)
                    compare_write_fs(g.row.request, ffff4, orig4)
                    return {rebuilt = true}
                end
                if hdr ~= 0xFFFFFFFF and ses.state == 1 and waiter_set[ses.parent] then
                    local req_bytes = read_fs(g.row.request, 0x100)
                    return {request = req_bytes}
                end
                if hdr ~= 0xFFFFFFFF or row_selected or ses.state ~= 1 or not waiter_set[ses.parent] then
                    cancel_api_workers()
                else
                    -- Wait 25 ms before injecting on non-empty step so a newly arriving Loader request lands cleanly (gate.cjs:282)
                    if not empty_mode then
                        rt.wait_ms(25)
                        if P.u32(read_fs(g.row.request, 4), 0) ~= 0xFFFFFFFF then
                            -- Request landed during settle window; next loop iteration will return it
                        else
                            local w18 = read_fs(ses.parent + 0x10, 0x18)
                            if P.u64(w18, 0) == 0 then
                                write_fs_unverified(ses.parent + 0x10, P.u64s(g.row.address))
                                cancel_api_workers()
                                last_inj = {parent = ses.parent, epoch = P.u64(w18, 8)}
                            end
                        end
                    else
                        local w18 = read_fs(ses.parent + 0x10, 0x18)
                        if P.u64(w18, 0) == 0 then
                            write_fs_unverified(ses.parent + 0x10, P.u64s(g.row.address))
                            cancel_api_workers()
                            last_inj = {parent = ses.parent, epoch = P.u64(w18, 8)}
                        end
                    end
                end
            end
            error("KH: gate step did not settle")
        end

        function g.park_session()
            compare_write_fs(g.row.address + 0x30, P.u32s(g.row.wait), P.u32s(g.park))
            g.parked = true
            cancel_api_workers()
            -- Drain any stale pre-launch request before idle rebuild (gate.cjs:178-186)
            if g.pending() and P.u32(read_fs(g.row.request, 4), 0) ~= 0xFFFFFFFF then
                pcall(g.step, false)
            end
            g.step(true)
        end

        function g.restore()
            if not g.parked then return end
            local ses = g.inspect()
            compare_write_fs(g.row.address + 0x30, P.u32s(g.park), P.u32s(g.row.wait))
            g.parked = false
            local epoch = P.u64(read_fs(ses.parent + 0x18, 8), 0)
            rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.SVC_SIGNAL_EVENT, g.event.write, 0, 0, 0, 0)
            for _ = 1, 30 do
                local cur_epoch = P.u64(read_fs(ses.parent + 0x18, 8), 0)
                local cur = g.inspect()
                if cur_epoch ~= epoch or cur.state == 2 or cur.state == 3 or cur.parent ~= ses.parent then
                    rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.SVC_CLEAR_EVENT, g.event.read, 0, 0, 0, 0)
                    return
                end
            end
            error("KH: gate restore event wake did not retire snapshot")
        end

        return g
    end

    local function domain_entries(dom_addr)
        local sentinel = dom_addr + 0x20
        local rows, seen = {}, {}
        local at = P.u64(read_fs(sentinel, 8), 0)
        while at ~= sentinel do
            assert(not seen[at] and #rows < 128, "KH: domain entry list loop")
            seen[at] = true
            local b = read_fs(at, 0x30)
            rows[#rows + 1] = {
                id       = ((at - ctx.layout.table) / 0x30) + 1,
                entry    = at,
                object   = P.u64(b, 0x20),
                metadata = P.u64(b, 0x28),
            }
            at = P.u64(b, 0)
        end
        return rows
    end

    local function parse_captured_request(req_str)
        local at = P.domain_data_start(req_str)
        local htype = P.u32(req_str, 0) % 0x10000
        if htype == 5 or htype == 7 then
            return {kind = "control", command = P.u32(req_str, at + 8)}
        end
        local id = P.u32(req_str, at + 4)
        if str_byte(req_str, at + 1) == 2 then
            return {kind = "close", object = id}
        end
        local dlen = P.u16(req_str, at + 2)
        return {
            kind    = "request",
            object  = id,
            command = P.u32(req_str, at + 24),
            input   = str_sub(req_str, at + 33, at + 16 + dlen)
        }
    end

    -- Launch replacement RO with gated worker + swap mount 2 + activate
    local function launch_and_activate_ro()
        local loader_dom = ctx.loaderRoot.domain
        local root_id    = ((ctx.loaderRoot.entry - ctx.layout.table) / 0x30) + 1
        local donor      = ctx.donorRow
        local lrow       = nil
        for _, r in ipairs(ctx.bound.rows) do
            if r.domain == loader_dom then lrow = r; break end
        end
        assert(lrow, "KH: Loader bound row missing")

        local srv_exp = export_handle(lrow.receive, "loader-server-readiness")
        ctx.loaderServerExport = srv_exp
        local gate = new_gate(lrow, srv_exp.handle, ctx.gateEvent)

        -- Pre-build pm:shell LaunchTitle (cmd 0, flags=0x10, RO_TITLE, storageId=3)
        local pm_pkt = arena_alloc(0x1000)
        local launch_in = P.u64s(0x10) .. M.RO_TITLE_STR .. P.u64s(3)
        rt.wr(pm_pkt, P.packet(0, launch_in, {raw_words = 16}))

        local w_gate = arena_alloc(0x100)
        rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.EVENT_INIT, w_gate, 0, 0, 0, 0)
        local w_frame = arena_alloc(0x10000)
        local w_slot  = arena_alloc(0x40)
        local w_built = rt.write_worker_frame(w_frame, 0x10000, {
            {fn = rt.SDK + P.OFFSETS.SDK.EVENT_WAIT, args = {w_gate, 0, 0, 0}},
            {fn = rt.SDK + P.OFFSETS.SDK.SVC_SEND_SYNC_USER, args = {pm_pkt, 0x1000, ctx.pm.shell, 0}},
        })
        local rc_c = P.signed_ret(rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.PTHREAD_CREATE,
            w_slot, 0, rt.SDK + P.OFFSETS.SDK.LONGJMP, w_frame, 0))
        assert(rc_c == 0, "KH: pm-launch pthread_create failed")
        local w_thread = rt.rd_u64(w_slot)

        local function worker_done()
            return rt.rd(w_frame + w_built.proof.resultOffset, 8) ~= P.SENTINEL_BYTES
        end

        local mounts = 0
        local swapped = false
        local last_target = nil
        _G.__KH.stages.launch = true
        gate.park_session()
        rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.EVENT_SIGNAL, w_gate, 0, 0, 0, 0)

        local ok_l, err_l = pcall(function()
            local deadline = rt.now_ms() + 180000
            for _ = 1, 160 do
                while not gate.pending() do
                    if worker_done() then break end
                    assert(rt.now_ms() < deadline, "KH: PM launch timed out waiting for Loader")
                    rt.wait_ms(20)
                end
                if worker_done() then break end
                local before = domain_entries(loader_dom)
                local b_map = {}
                for _, b in ipairs(before) do b_map[b.id .. ":" .. b.object] = true end

                local st = gate.step(false)
                local info = parse_captured_request(st.request)
                local after = domain_entries(loader_dom)
                local added = {}
                for _, a in ipairs(after) do
                    if not b_map[a.id .. ":" .. a.object] then added[#added + 1] = a end
                end

                if info.kind == "request" and info.object == root_id and info.command == 0 then
                    mounts = mounts + 1
                    local fresh = (#added == 1 and added[1].metadata == donor.metadata) and added[1] or nil
                    local code = fresh
                    if not code and last_target then
                        local live = read_fs(last_target.entry, 0x30)
                        if P.u64(live, 0x18) == loader_dom and P.u64(live, 0x20) == last_target.object then
                            code = last_target
                        end
                    end
                    if code then
                        if mounts < 2 then
                            last_target = code
                        else
                            compare_write_fs(code.entry + 0x20, P.u64s(code.object), P.u64s(donor.object))
                            compare_write_fs(donor.entry + 0x20, P.u64s(donor.object), P.u64s(code.object))
                            swapped = true
                            break
                        end
                    end
                end
            end
            if not swapped and last_target then
                local live = read_fs(last_target.entry, 0x30)
                if P.u64(live, 0x18) == loader_dom and P.u64(live, 0x20) == last_target.object then
                    compare_write_fs(last_target.entry + 0x20, P.u64s(last_target.object), P.u64s(donor.object))
                    compare_write_fs(donor.entry + 0x20, P.u64s(donor.object), P.u64s(last_target.object))
                    swapped = true
                end
            end
        end)

        -- Drain remaining queued requests before restoring gate
        for _ = 1, 200 do
            local q = false
            pcall(function() q = gate.pending() end)
            if not q then break end
            pcall(function() gate.step(false) end)
        end
        pcall(function() gate.restore() end)

        while not worker_done() do rt.wait_ms(25) end
        rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.PTHREAD_JOIN, w_thread, w_slot + 8, 0, 0, 0)

        if ctx.loaderServerExport then
            pcall(rt.close_handle, ctx.loaderServerExport.handle)
            ctx.loaderServerExport = nil
        end
        if not ok_l then error(err_l) end
        assert(swapped, "KH: RO launch did not swap mount")

        local pm_rep = P.parse_response(rt.rd(pm_pkt, 256))
        assert(pm_rep.result == 0, "KH: PM LaunchTitle failed")
        local new_pid = P.u64(pm_rep.data, 0)
        assert(new_pid ~= ctx.pm.originalPid and new_pid > 1 and ctx.pm.originalPid > 1,
            "KH: replacement and original RO PIDs invalid")
        ctx.launch = {pid = new_pid, swapped = true}

        -- CRITICAL SEEDSOW ORDER (`NS2_STOCK_TERMINATE=pre`, runtime.cjs:88-100):
        -- Terminate stock RO via pm:shell (cmd 1) BEFORE starting replacement RO via pm:dmnt (cmd 1),
        -- otherwise duplicate `ldr:ro` service registration faults the console on start!
        local term_rep  = fs.send_packet(ctx.pm.shell, P.packet(1, P.u64s(ctx.pm.originalPid)), slots.pkt)
        assert(term_rep.transport == 0 and term_rep.result == 0, "KH: pm:shell TerminateProcess failed")
        local start_rep = fs.send_packet(ctx.pm.monitor, P.packet(1, P.u64s(new_pid)), slots.pkt)
        assert(start_rep.transport == 0 and start_rep.result == 0, "KH: pm:dmnt StartProcess failed")

        -- Verify Loader session handoff back to idle receive (activate.mjs:46-65)
        local hb = read_fs(lrow.address, 0x88)
        assert(P.u32(hb, 0x30) == lrow.receive and P.u32(hb, 0x48) == lrow.receive and P.u32(hb, 0x40) == 1,
            "KH: Loader session handoff not idle")
        kh_log(str_format("original RO terminated (old=%d); replacement RO started (pid=%d)", ctx.pm.originalPid, new_pid))
    end

    -- Connect to replacement `ldr:ro`, build NRO & 432-byte BootstrapArgs, and run bootstrap
    local function run_bootstrap_nro()
        local ro_h = rt.get_service_sm("ldr:ro")
        assert(ro_h ~= 0, "KH: GetService('ldr:ro') failed")
        track(ro_h, "ldr:ro")
        local init_rep = fs.send_packet(ro_h, P.packet(4, P.u64s(0), {pid = true, copies = {0xFFFF8001}}), slots.pkt)
        assert(init_rep.transport == 0 and init_rep.result == 0, "KH: ldr:ro Initialize failed")
        ctx.ro = {handle = ro_h, initialized = true}

        ctx.fsProcess = export_handle(0xFFFF8001, "fs-process")

        -- Probe which root session opens SD card via cmd 18
        local probe_rep = fs.send_packet(ctx.fsRootPlain, P.packet(18, ""), slots.pkt)
        if probe_rep.transport == 0 and probe_rep.result == 0 and #probe_rep.moves == 1 then
            rt.close_handle(probe_rep.moves[1])
            ctx.bootstrapFsRoot = ctx.fsRootPlain
        else
            ctx.bootstrapFsRoot = ctx.fsRootDedicated
        end

        local sdh = open_sd_card()
        local bs_file = sd_read_file(sdh, M.SD_MANIFEST.bootstrap.path, 0x100000)
        local adapter_off = P.align_up(#bs_file.str, 16)
        local try_wait_addr = rt.SDK + P.OFFSETS.SDK.TRY_WAIT_THREAD
        local full_text = bs_file.str
            .. str_rep("\0", adapter_off - #bs_file.str)
            .. M.try_wait_adapter_bytes(try_wait_addr)
        local nro_img = M.build_nro_image(full_text)

        local loader_dom = ctx.loaderRoot.domain
        local lrow = nil
        for _, r in ipairs(ctx.bound.rows) do
            if r.domain == loader_dom then lrow = r; break end
        end
        local bs_readiness = export_handle(lrow.receive, "bootstrap-gate-readiness")
        ctx.bootstrapReadiness = bs_readiness

        -- Map NRO via ldr:ro cmd 0 (LoadNRO)
        local nro_src = arena_alloc(#nro_img + 0x1000)
        rt.wr(nro_src, nro_img)
        local nro_bss = nro_src + #nro_img
        local load_in = P.u64s(0)
            .. P.u64s(nro_src)
            .. P.u64s(#nro_img)
            .. P.u64s(nro_bss)
            .. P.u64s(0x1000)
        local load_rep = fs.send_packet(ro_h, P.packet(0, load_in, {pid = true, raw_words = 18}), slots.pkt)
        assert(load_rep.transport == 0 and load_rep.result == 0, "KH: LoadNRO failed")
        local mapped_base = P.u64(load_rep.data, 0)
        local mapped_entry = mapped_base + 0x80

        local args_str = M.build_bootstrap_args({
            candidateHandle  = ctx.candidateHandle,
            dataOffset       = ep.dataOffset,
            dataEntryOffset  = ep.dataEntryOffset,
            row              = lrow,
            rowVptr          = lrow.vptr,
            waiters          = ctx.layout.waiters,
            apiWorkers       = ctx.apiWorkers,
            event            = ctx.gateEvent,
            exportedHandle   = bs_readiness.handle,
            table            = ctx.layout.table,
            loaderDomain     = loader_dom,
            loaderEntryIndex = ((ctx.loaderRoot.entry - ctx.layout.table) / 0x30) + 1,
            donor            = ctx.donorRow,
            pm               = ctx.pm,
            flags            = 0x14,
            storageId        = 3,
            pthreadCreate    = rt.SDK + P.OFFSETS.SDK.PTHREAD_CREATE,
            pthreadTryWait   = mapped_entry + adapter_off,
            pthreadJoin      = rt.SDK + P.OFFSETS.SDK.PTHREAD_JOIN,
            roHandle         = ro_h,
            fsRoot           = ctx.bootstrapFsRoot,
            packagePath      = "@Sdcard:/kaihen/bin/hen/exefs.nsp",
            fsProcessHandle  = ctx.fsProcess.handle,
            notifierHandle   = ctx.notifier.handle,
            loaderCopyHandle = ctx.loaderCopy.handle,
        })

        local args_addr = arena_alloc(512)
        rt.wr(args_addr, args_str)

        local th_slot = arena_alloc(0x40)
        local crc = P.signed_ret(rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.PTHREAD_CREATE,
            th_slot, 0, mapped_entry, args_addr, 0))
        assert(crc == 0, "KH: bootstrap pthread_create failed")
        local bs_thread = rt.rd_u64(th_slot)

        -- Poll args_addr + 408 (BootstrapOperation output) until operation == 10 or result ~= 0
        local deadline = rt.now_ms() + 120000
        rt.wait_ms(3000)
        while rt.now_ms() < deadline do
            local out24 = rt.rd(args_addr + 408, 24)
            local op  = P.u32(out24, 0)
            local res = P.u32(out24, 4)
            if op == 10 or res ~= 0 then break end
            rt.wait_ms(1000)
        end
        rt.N.call_deep(rt.SDK + P.OFFSETS.SDK.PTHREAD_JOIN, bs_thread, th_slot + 8, 0, 0, 0)

        local out24 = rt.rd(args_addr + 408, 24)
        local rec = {
            operation            = P.u32(out24, 0),
            result               = P.u32(out24, 4),
            pid                  = P.u64(out24, 8),
            gateRestoreResult    = P.u32(out24, 16),
            channelRestoreResult = P.u32(out24, 20),
        }
        kh_log(str_format("bootstrap record: op=%d result=0x%x pid=%d gateRestore=0x%x chanRestore=0x%x",
            rec.operation, rec.result, rec.pid, rec.gateRestoreResult, rec.channelRestoreResult))
        assert(rec.operation == 10 and rec.result == 0 and
            (rec.gateRestoreResult == 0 or rec.gateRestoreResult == 0xea01) and rec.channelRestoreResult == 0,
            str_format("KH: bootstrap failed op=%d rc=0x%x", rec.operation, rec.result))
        ctx.henStartup = rec
        _G.__KH.stages.complete = true
    end

    -- Execute Stage C pipeline with Stage D post-HEN alias retirement in `finally`
    local ok_chain, err_chain = pcall(function()
        verify_and_relocate_sd()
        arm_endpoint()
        derive_layout_and_loader()
        open_notifier()
        open_pm_sessions()
        copy_loader_and_open_codefs()
        prepare_workers_and_donor()
        bind_sessions_and_gate_event()
        launch_and_activate_ro()
        run_bootstrap_nro()
        -- Wait for OunceHEN's GameArm::openPackage initial retained-alias read before retiring
        local retire_wait_ms = (ctx.henStartup and ctx.henStartup.gateRestoreResult == 0xea01) and 8000 or 2000
        kh_log(str_format("=== HEN IS RUNNING === waiting %ds before retiring cache alias...", retire_wait_ms / 1000))
        rt.wait_ms(retire_wait_ms)
    end)

    -- Stage D: Neutralize stale heap pointers in save partition (commits e829f45 & d1846b2)
    pcall(function()
        if ctx.candidateHandle and ctx.candidateHandle ~= 0 then
            fs.ipc_storage_invalidate(ctx.candidateHandle, 0, 0x8000)
            local rbuf = arena_alloc(0x1000)
            rt.wr(rbuf, str_rep(str_char(0x42), 16))
            fs.ipc_storage_write(ctx.candidateHandle, 0, rbuf, 16)
            local sm = fs.open_mount("save")
            if sm and sm.handle ~= 0 then
                local cr, tx = fs.ipc_commit(sm.handle)
                rt.close_handle(sm.handle)
                kh_log(str_format("RETIRE: cache invalidated + alias neutralised tx=0x%x rc=0x%x", tx or 0, cr or 0))
            end
        end
    end)

    if not ctx.henStartup then
        for i = #ctx.handles, 1, -1 do
            pcall(rt.close_handle, ctx.handles[i].handle)
        end
        _G.__KH_TRACKED = nil
        if _G.__KH then _G.__KH.sd = nil end
    end

    if not ok_chain then error(err_chain) end
    kh_log("=== READY! Close Seedsow Lullaby and hold R while launching a game ===")
    return ctx.henStartup
end

return R
