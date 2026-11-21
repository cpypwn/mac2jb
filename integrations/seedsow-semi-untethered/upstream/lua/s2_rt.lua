-- s2_rt.lua — Live Console Memory, Allocation Tracking & Mount Table Binding (`_G.n2h`)
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)
-- Split from s2_prim.lua to stay under the 32,768-byte http.lua PUT /save upload cap.

local str_byte = string.byte
local str_char = string.char
local str_sub  = string.sub
local str_rep  = string.rep
local math_floor = math.floor
local math_max   = math.max
local math_min   = math.min

local R = {}

function R.attach(M)
    function M.bind_n2h(N)
        N = N or (_G and _G.n2h)
        if not N then return nil end

        local SDK  = N.sdk_base
        local MAIN = N.main_base
        local O    = M.OFFSETS
        local MEMCPY       = SDK + O.SDK.MEMCPY
        local MEMSET       = SDK + O.SDK.MEMSET
        local QUERY        = SDK + O.SDK.SVC_QUERY_MEM
        local SEND_USER    = SDK + O.SDK.SVC_SEND_SYNC_USER
        local CLOSE_HANDLE = SDK + O.SDK.SVC_CLOSE_HANDLE
        local GET_SERVICE  = SDK + O.SDK.SM_GET_SERVICE
        local MAIN_MALLOC  = MAIN + O.MAIN.MALLOC
        local MAIN_FREE    = MAIN + O.MAIN.FREE
        local TICK         = SDK + O.SDK.OS_TICK
        local FREQ         = SDK + O.SDK.OS_TICK_FREQ
        local SLEEP_SVC    = SDK + O.SDK.SVC_SLEEP_THREAD

        local rt = {
            N = N,
            SDK = SDK,
            MAIN = MAIN,
            sleep_scale = 19200000 / 31250000,
            active_tracker = nil,
        }

        -- Pinned scratch string buffer for fast `rd` without allocating Lua strings per call
        local RD_CAP = 0x42000
        local rd_buf = str_rep("\0", RD_CAP)
        local rd_buf_addr = N.str_addr(rd_buf) + 0x18

        function rt.rd(addr, n)
            if n <= 0 then return "" end
            if n <= RD_CAP then
                N.call_deep(MEMCPY, rd_buf_addr, addr, n, 0, 0)
                return str_sub(rd_buf, 1, n)
            end
            local big = str_rep("\0", n)
            N.call_deep(MEMCPY, N.str_addr(big) + 0x18, addr, n, 0, 0)
            return big
        end

        function rt.wr(addr, s)
            if not s or #s == 0 then return end
            N.call_deep(MEMCPY, addr, N.str_addr(s) + 0x18, #s, 0, 0)
        end

        function rt.memset(addr, val, n)
            if n <= 0 then return end
            N.call_deep(MEMSET, addr, val or 0, n, 0, 0)
        end

        function rt.memcpy(dst, src, n)
            if n <= 0 then return end
            N.call_deep(MEMCPY, dst, src, n, 0, 0)
        end

        function rt.rd_u8(addr)  return str_byte(rt.rd(addr, 1), 1) or 0 end
        function rt.rd_u16(addr) return M.u16(rt.rd(addr, 2), 0) end
        function rt.rd_u32(addr) return M.u32(rt.rd(addr, 4), 0) end
        function rt.rd_u64(addr) return M.u64(rt.rd(addr, 8), 0) end
        function rt.rd_u64_bytes(addr) return rt.rd(addr, 8) end

        function rt.wr_u8(addr, v)  rt.wr(addr, str_char(math_floor(v or 0) % 256)) end
        function rt.wr_u16(addr, v) rt.wr(addr, M.u16s(v)) end
        function rt.wr_u32(addr, v) rt.wr(addr, M.u32s(v)) end
        function rt.wr_u64(addr, v) rt.wr(addr, M.u64s(v)) end
        function rt.wr_str(addr, s) rt.wr(addr, (s or "") .. "\0") end

        -- Fast native buffer comparisons using chunked `rd` + Lua O(1) string equality
        function rt.buffers_equal_fast(addr_a, addr_b, len)
            local step = 0x10000
            local off = 0
            while off < len do
                local take = math_min(step, len - off)
                local sa = rt.rd(addr_a + off, take)
                local sb = rt.rd(addr_b + off, take)
                if sa ~= sb then return false end
                off = off + take
            end
            return true
        end

        function rt.has_byte_different_fast(addr, len, byte_val)
            local pat_4k = str_rep(str_char(byte_val % 256), 0x1000)
            local off = 0
            while off < len do
                local take = math_min(0x1000, len - off)
                local chunk = rt.rd(addr + off, take)
                local expected = (take == 0x1000) and pat_4k or str_sub(pat_4k, 1, take)
                if chunk ~= expected then return true end
                off = off + take
            end
            return false
        end

        -- Timing & Sleep
        local tick_freq = nil
        function rt.get_tick_freq()
            if not tick_freq then
                local f = N.call_deep(FREQ, 0, 0, 0, 0, 0)
                tick_freq = (f and f > 0) and f or 19200000
            end
            return tick_freq
        end

        function rt.get_tick()
            return N.call_deep(TICK, 0, 0, 0, 0, 0)
        end

        function rt.ticks_to_us(ticks)
            return (ticks * 1000000) / rt.get_tick_freq()
        end

        function rt.now_ms()
            return (rt.get_tick() * 1000) / rt.get_tick_freq()
        end

        function rt.sleep_ns(ns)
            local scaled = math_floor((ns or 0) * rt.sleep_scale + 0.5)
            N.call_deep(SLEEP_SVC, scaled, 0, 0, 0, 0)
        end

        function rt.wait_ms(ms)
            if not ms or ms <= 0 then return end
            rt.sleep_ns(ms * 1000000)
        end

        -- Allocation tracking
        function rt.begin_alloc_tracking()
            if rt.active_tracker then return nil end
            rt.active_tracker = {}
            return rt.active_tracker
        end

        function rt.end_alloc_tracking(tracker)
            if rt.active_tracker ~= tracker then return false end
            rt.active_tracker = nil
            return true
        end

        function rt.alloc_raw(size, track_override)
            local raw = N.call_deep(MAIN_MALLOC, size, 0, 0, 0, 0)
            if not raw or raw == 0 then return 0 end
            if track_override ~= false and rt.active_tracker then
                rt.active_tracker[#rt.active_tracker + 1] = raw
            end
            return raw
        end

        local aligned_to_raw = {}

        function rt.alloc_page(size, track_override)
            size = math_max(size or 0x1000, 0x1000)
            local total = M.align_up(size, 0x1000) + 0x1000
            local raw = rt.alloc_raw(total, track_override)
            if raw == 0 then return 0, 0 end
            local aligned = M.align_up(raw, 0x1000)
            aligned_to_raw[aligned] = raw
            rt.memset(aligned, 0, M.align_up(size, 0x1000))
            return aligned, raw
        end

        function rt.free_raw(ptr)
            if ptr and ptr ~= 0 then
                local actual = aligned_to_raw[ptr] or ptr
                aligned_to_raw[ptr] = nil
                N.call_deep(MAIN_FREE, actual, 0, 0, 0, 0)
            end
        end

        function rt.free_tracked_allocs(tracker)
            if not tracker then return {ok = false, attempted = 0, callsCompleted = 0} end
            local done = 0
            for i = #tracker, 1, -1 do
                local p = tracker[i]
                if p and p ~= 0 then
                    for k, v in pairs(aligned_to_raw) do
                        if v == p then aligned_to_raw[k] = nil end
                    end
                    N.call_deep(MAIN_FREE, p, 0, 0, 0, 0)
                    done = done + 1
                end
                tracker[i] = nil
            end
            return {ok = true, attempted = done, callsCompleted = done}
        end

        -- Query memory info
        local q_info = rt.alloc_raw(0x40, false)
        local q_state = rt.alloc_raw(0x10, false)
        function rt.query_memory(addr)
            rt.memset(q_info, 0, 0x40)
            rt.memset(q_state, 0, 0x10)
            local rc = M.signed_ret(N.call_deep(QUERY, q_info, q_state, addr, 0, 0))
            local b = rt.rd(q_info, 0x28)
            return {
                rc = rc,
                base = M.u64(b, 0),
                size = M.u64(b, 8),
                mem_type = M.u32(b, 16),
                attr = M.u32(b, 20),
                perm = M.u32(b, 24),
                ipc_ref = M.u32(b, 28),
                dev_ref = M.u32(b, 32),
                page_info = rt.rd_u32(q_state)
            }
        end

        function rt.safe_read(addr, n)
            if not addr or addr == 0 then return nil end
            local q = rt.query_memory(addr)
            if q.rc == 0 and q.size ~= 0 and (q.perm % 2) == 1 and
               addr >= q.base and (addr + n) <= (q.base + q.size) then
                return rt.rd(addr, n)
            end
            return nil
        end

        -- Direct IPC send via `svc #0x22` veneer (`SDK + 0x168c54`):
        -- CRITICAL: Switch 2 kernel ABI order is `(buf_addr, 0x1000, handle)`!
        function rt.send_ipc(handle, buf_addr)
            return M.u32_norm(N.call_deep(SEND_USER, buf_addr, 0x1000, handle, 0, 0))
        end

        function rt.close_handle(handle)
            if not handle or handle == 0 then return 0 end
            return M.u32_norm(N.call_deep(CLOSE_HANDLE, handle, 0, 0, 0, 0))
        end

        local sm_nbuf = rt.alloc_page(0x1000, false)
        function rt.get_service_sm(name)
            local nbuf = sm_nbuf
            local out  = nbuf + 0x100
            rt.memset(nbuf, 0, 0x200)
            rt.wr_str(nbuf, name)
            rt.wr_u64(out, 0)
            local rc = M.u32_norm(N.call_deep(GET_SERVICE, out, nbuf, #name, 0, 0))
            local h  = rt.rd_u32(out)
            if rc ~= 0 then return 0, rc end
            return h, 0
        end

        -- Read-only Mount Table walk (`SDK + 0xB35868`) from `console/n2h_accessor.lua`
        function rt.list_mounts()
            local head = SDK + O.SDK.MOUNT_TABLE_HEAD
            local hb = rt.safe_read(head, 0x20)
            if not hb then return {} end
            local nextp = M.u64(hb, 8)
            local mounts = {}
            for _ = 1, 32 do
                if nextp == head or nextp == 0 then break end
                local accessor = nextp - 8
                local ab = rt.safe_read(accessor, 128)
                if not ab then break end
                local raw_name = str_sub(ab, 25, 40)
                local name = raw_name:gsub("%z.*$", "")
                local impl = M.u64(ab, 40)
                local entry = {name = name, accessor = accessor, impl = impl}
                local ib = rt.safe_read(impl, 0x60)
                if ib then
                    local service = M.u64(ib, 16)
                    local sb = rt.safe_read(service, 0x80)
                    if sb then
                        entry.service = service
                        entry.vtable = M.u64(sb, 0)
                        entry.manager = M.u64(sb, 16)
                        entry.objId = M.u32(sb, 24)
                        local mb = rt.safe_read(entry.manager, 0x80)
                        if mb then
                            local slots = M.u64(mb, 16)
                            local sb4 = rt.safe_read(slots, 4)
                            if sb4 then
                                entry.handle = M.u32(sb4, 0)
                            end
                        end
                    end
                end
                mounts[#mounts + 1] = entry
                nextp = M.u64(ab, 16)
            end
            return mounts
        end

        function rt.get_mount_handle(mount_name)
            mount_name = mount_name or "save"
            local mounts = rt.list_mounts()
            for i = 1, #mounts do
                local m = mounts[i]
                if m.name == mount_name and m.handle and m.handle ~= 0 and m.objId and m.objId ~= 0 then
                    return m
                end
            end
            return nil
        end

        -- Write a built worker frame into native memory at `base` (size `limit`)
        function rt.write_worker_frame(base, limit, calls, snapshot_addr)
            local built = M.build_worker_frame(base, limit, calls, SDK, MAIN)
            local p = built.proof
            rt.memset(base, 0, limit)
            rt.wr(base, built.jmpbuf)
            rt.wr(base + p.chainStart, built.regs_blob)
            rt.wr(base + p.resultsOffset, built.results_blob)
            rt.wr(base + p.jobsBase, built.jobs_blob)
            if snapshot_addr and snapshot_addr ~= 0 then
                rt.memcpy(snapshot_addr, base, p.bytes)
            end
            return built
        end

        return rt
    end
end

function R.prepare_kh_workers_and_donor(P, M, env)
    local rt            = env.rt
    local fs            = env.fs
    local ctx           = env.ctx
    local slots         = env.slots
    local kh_log        = env.kh_log
    local arena_alloc   = env.arena_alloc
    local track         = env.track
    local open_sd_card  = env.open_sd_card
    local sd_read_file  = env.sd_read_file
    local read_fs       = env.read_fs
    local export_handle = env.export_handle

    -- Bind 7 FS API worker threads
    local groups = {}
    for _, node in ipairs(ctx.threadRing) do
        if node.state == 3 and node.size == 0xC000 and node.argument == 0 then
            local k = tostring(node.entry)
            groups[k] = groups[k] or {}
            groups[k][#groups[k] + 1] = node
        end
    end
    local matched = nil
    for _, list in pairs(groups) do
        if #list == 7 then matched = list; break end
    end
    assert(matched, "KH: 7-thread API worker group not found")

    local out_id = arena_alloc(0x40)
    local GET_TID = rt.SDK + P.OFFSETS.SDK.SVC_GET_THREAD_ID
    local CANCEL  = rt.SDK + P.OFFSETS.SDK.SVC_CANCEL_SYNC
    local workers = {}
    for _, node in ipairs(matched) do
        local exp = export_handle(node.handle, "api-worker-" .. tostring(node.id))
        rt.wr_u64(out_id, 0)
        local rc = P.u32_norm(rt.N.call_deep(GET_TID, out_id, exp.handle, 0, 0, 0))
        assert(rc == 0 and rt.rd_u64(out_id) == node.id, "KH: API worker thread ID mismatch")
        local crc = P.u32_norm(rt.N.call_deep(CANCEL, exp.handle, 0, 0, 0, 0))
        assert(crc == 0, "KH: API worker cancel rejected")
        workers[#workers + 1] = {
            address      = node.address,
            sourceHandle = node.handle,
            id           = node.id,
            handle       = exp.handle
        }
    end
    ctx.apiWorkers = workers
    kh_log("7 API workers bound")

    -- Capture `main.npdm` from CodeFS & stage `/main` + `/main.npdm` into donor `save:`
    local function send_with_context(obj_id, opts)
        local cpkt = P.build_context_packet({
            cmd    = opts.cmd,
            object = obj_id,
            token  = opts.token or 0x00200001,
            input  = opts.input or "",
            x      = opts.x,
            b      = opts.b,
        })
        local paddr = opts.pkt or slots.pkt
        rt.memset(paddr, 0, 0x200)
        rt.wr(paddr, cpkt)
        local trc = rt.send_ipc(ctx.inspectionDomain.handle, paddr)
        local r64b = rt.rd(paddr, 64)
        local res, added, sfco_idx = -1, 0, -1
        if trc == 0 then
            for w = 0, 14 do
                if P.u32(r64b, w * 4) == P.SFCO_MAGIC then
                    sfco_idx = w
                    res      = P.u32(r64b, (w + 1) * 4)
                    local a  = P.u32(r64b, (w + 4) * 4)
                    if a > 0 and a <= 0x4000 then added = a end
                    break
                end
            end
        end
        return {transport = trc, result = res, added = added, sfcoIdx = sfco_idx, raw = r64b}
    end

    local code_obj = ctx.instantCodeFsAdded
    rt.wr_str(slots.path, "/main.npdm")
    local opened = send_with_context(code_obj, {
        cmd   = 8,
        x     = {{addr = slots.path, size = 0x301}},
        input = P.u32s(1)
    })
    assert(opened.transport == 0 and opened.result == 0 and opened.added > 0, "KH: open /main.npdm failed")
    local fobj = opened.added
    local sz_rep = send_with_context(fobj, {cmd = 4, pkt = slots.pkt2})
    assert(sz_rep.transport == 0 and sz_rep.result == 0 and sz_rep.sfcoIdx >= 0, "KH: size /main.npdm failed")
    local npdm_size = P.u64(sz_rep.raw, (sz_rep.sfcoIdx + 2) * 4)
    if npdm_size <= 0 or npdm_size > 0x100000 then
        npdm_size = P.u64(sz_rep.raw, (sz_rep.sfcoIdx + 4) * 4)
    end
    assert(npdm_size > 0 and npdm_size <= 0x100000, "KH: implausible main.npdm size")

    local rrep = send_with_context(fobj, {
        cmd   = 0,
        token = 0x00280001,
        input = P.u64s(0) .. P.u64s(0) .. P.u64s(npdm_size),
        b     = {{addr = slots.data, size = npdm_size, attr = 1}}
    })
    fs.close_domain_object_now(ctx.inspectionDomain.handle, fobj, slots.pkt2)
    assert(rrep.transport == 0 and rrep.result == 0, "KH: read /main.npdm failed")
    local npdm_str = rt.rd(slots.data, npdm_size)

    local sdh = open_sd_card()
    local ro_main = sd_read_file(sdh, M.SD_MANIFEST.ro.path, 0x100000)

    local save_m = fs.open_mount("save")
    assert(save_m and save_m.handle ~= 0, "KH: open save mount for donor failed")
    local dh = track(save_m.handle, "donor-save")

    local function save_file_matches(fh, expected_str)
        local at = 0
        local total = #expected_str
        while at < total do
            local take = math_min(0x10000, total - at)
            local r_pkt = P.packet(0, P.u64s(0) .. P.u64s(at) .. P.u64s(take), {
                b = {{addr = slots.data, size = take, mode = 1}}
            })
            local rr = fs.send_packet(fh, r_pkt, slots.pkt)
            if rr.transport ~= 0 or rr.result ~= 0 then return false end
            if rt.rd(slots.data, take) ~= str_sub(expected_str, at + 1, at + take) then
                return false
            end
            at = at + take
        end
        return true
    end

    local files_to_stage = {
        {name = "main.npdm", str = npdm_str},
        {name = "main",      str = ro_main.str}
    }
    for _, item in ipairs(files_to_stage) do
        local path_s = "/" .. item.name
        local ex = fs.ipc_get_entry_type(dh, path_s, 0x301)
        local reused = false
        if ex.transport == 0 and ex.result == 0 then
            local fh = fs.ipc_open_file(dh, path_s, 1, 0x301)
            if fh ~= 0 then
                local fsz = fs.ipc_file_get_size(fh)
                if fsz == #item.str and save_file_matches(fh, item.str) then
                    reused = true
                end
                rt.close_handle(fh)
            end
            if not reused then
                fs.ipc_delete_file(dh, path_s)
                fs.ipc_commit(dh)
            end
        end
        if not reused then
            assert(fs.ipc_create_file(dh, path_s, #item.str) == 0, "KH: create donor " .. path_s .. " failed")
            local fh = fs.ipc_open_file(dh, path_s, 3, 0x301)
            assert(fh ~= 0, "KH: open donor " .. path_s .. " for write failed")
            local at = 0
            local total = #item.str
            while at < total do
                local take = math_min(0x10000, total - at)
                local chunk = str_sub(item.str, at + 1, at + take)
                rt.wr(slots.data, chunk)
                local w_pkt = P.packet(1, P.u32s(1) .. P.u32s(0) .. P.u64s(at) .. P.u64s(take), {
                    a = {{addr = slots.data, size = take, mode = 1}}
                })
                local wr_rep = fs.send_packet(fh, w_pkt, slots.pkt)
                if wr_rep.transport ~= 0 or wr_rep.result ~= 0 then
                    rt.close_handle(fh)
                    error("KH: write donor " .. path_s .. " failed")
                end
                at = at + take
            end
            local match_ok = save_file_matches(fh, item.str)
            rt.close_handle(fh)
            assert(match_ok, "KH: donor " .. path_s .. " readback differs")
        end
    end
    assert(fs.ipc_commit(dh) == 0, "KH: commit donor failed")

    local conv = fs.send_packet(dh, P.domain_control(0, ""), slots.pkt)
    assert(conv.transport == 0 and conv.result == 0, "KH: donor ConvertToDomain failed")
    local donor_root = P.u32(conv.data, 0)

    local function resolve_row(root_id, rname)
        local eaddr = ctx.layout.table + (root_id - 1) * 0x30
        local eb    = read_fs(eaddr, 0x30)
        local obj   = P.u64(eb, 0x20)
        local hdr   = read_fs(obj, 0x40)
        return {
            name      = rname,
            root      = root_id,
            entry     = eaddr,
            domain    = P.u64(eb, 0x18),
            object    = obj,
            metadata  = P.u64(eb, 0x28),
            vptr      = P.u64(hdr, 0),
            entryTail = str_sub(eb, 0x19, 0x30)
        }
    end
    ctx.codeRow  = resolve_row(code_obj, "code")
    ctx.donorRow = resolve_row(donor_root, "donor")
    assert(ctx.donorRow.metadata == ctx.codeRow.metadata and ctx.donorRow.vptr == ctx.codeRow.vptr,
        "KH: donor and CodeFS adapter types differ")
    kh_log(string.format("donor ready root=0x%x vptr=0x%x", donor_root, ctx.donorRow.vptr))
end

return R
