-- s2_main.lua — Semi-Untethered Seedsow Lullaby Main Orchestrator (Stage A -> B -> C -> D)
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)

if _G.e then
    package.path = "save:/?.lua;save:/lib/?.lua"
else
    package.path = "save:/?.lua;save:/lib/?.lua;./?.lua;" .. (package.path or "")
end

local P       = require("s2_prim")
local FS      = require("s2_fs")
local RACE    = require("s2_race")
local PROMOTE = require("s2_promote")

local M = {}

local BASE_ATTEMPTS = 10
local RETRY_PAUSE_MS = 100

local function default_log(msg)
    local N = _G.n2h
    if N and N.log then
        N.log(tostring(msg))
    else
        print(tostring(msg))
    end
end

local function is_stop_pressed()
    -- Artemis engine `e:isDown`: 114 = MINUS, 111 = B
    if _G.e and type(_G.e.isDown) == "function" then
        local ok_m, down_m = pcall(_G.e.isDown, _G.e, 114)
        if ok_m and down_m then return true end
    end
    return _G.S2_STOP_REQUESTED == true
end

function M.run_single_attempt(rt, fs, attempt_idx, log_fn, carried_schedule)
    local function log(msg) if log_fn then log_fn(msg) end end
    log(string.format("======== ATTEMPT %d ========", attempt_idx))

    local tracker = rt.begin_alloc_tracking()
    if not tracker then
        log("FAIL: could not start allocation tracking")
        return {promoted = false, safeToRetry = false}
    end

    local config = RACE.create_config(attempt_idx)
    if carried_schedule and carried_schedule.roleDelays and carried_schedule.guardDelays then
        config.roleDelays  = {unpack(carried_schedule.roleDelays)}
        config.guardDelays = {unpack(carried_schedule.guardDelays)}
        config.timingBaseline = {
            roleDelays  = carried_schedule.baselineRoleDelays or {unpack(config.roleDelays)},
            guardDelays = carried_schedule.baselineGuardDelays or {unpack(config.guardDelays)},
        }
    end
    local setup  = nil
    local campaign_state = nil
    local alias_res      = nil
    local promoted_ok    = false
    local safe_to_retry  = false
    local t_attempt0     = rt.now_ms()
    local prep_ms, race_ms, promote_ms = 0, 0, 0

    local ok_try, err_try = pcall(function()
        local t0 = rt.now_ms()
        setup = RACE.setup_attempt(rt, fs, config, log)
        prep_ms = math.floor((rt.now_ms() - t0) + 0.5)
        if not setup.ok then
            log("SETUP FAIL: " .. tostring(setup.failureReason))
            RACE.log_attempt_summary(config, false, rt.now_ms() - t_attempt0, log)
            return
        end

        local t_r0 = rt.now_ms()
        campaign_state = RACE.run_control_wave_loop(rt, fs, setup, config, log, is_stop_pressed)
        if not campaign_state.canaryQualified then
            race_ms = math.floor((rt.now_ms() - t_r0) + 0.5)
            log("CAMPAIGN: canary did not flip in this attempt")
            RACE.log_attempt_summary(config, false, rt.now_ms() - t_attempt0, log)
            return
        end
        log("CAMPAIGN: qualified canary flip!")

        alias_res = RACE.prepare_and_install_alias(rt, fs, setup, config, campaign_state, log, is_stop_pressed)
        race_ms = math.floor((rt.now_ms() - t_r0) + 0.5)
        RACE.log_attempt_summary(config, alias_res.aliasInstalled, rt.now_ms() - t_attempt0, log)
        if not alias_res.aliasInstalled then
            log("ALIAS FAIL: " .. tostring(alias_res.failureReason or "copy steps incomplete"))
            return
        end

        M.last_alias = alias_res
        local t_p0 = rt.now_ms()
        PROMOTE.prepare_release_neighbors(rt, fs, setup, config, alias_res, log)
        local rel = PROMOTE.release_neighbors_and_find_pointers(rt, fs, setup, config, alias_res, log)
        if not rel.ok or #rel.pointerCandidates == 0 then
            promote_ms = math.floor((rt.now_ms() - t_p0) + 0.5)
            log("DISCOVERY FAIL: no pointer candidates")
            return
        end

        local prom = PROMOTE.qualify_and_promote(rt, fs, setup, config, campaign_state,
            alias_res, rel.pointerCandidates, log, is_stop_pressed)
        promote_ms = math.floor((rt.now_ms() - t_p0) + 0.5)
        if prom.ok and prom.promotionRetained then
            promoted_ok = true
        else
            log("PROMOTE FAIL: " .. tostring(prom.failureReason))
        end
    end)

    if not ok_try then
        log("ATTEMPT ERROR: " .. tostring(err_try))
    end

    if setup and setup.ok then
        local clean_ok, clean_res = pcall(PROMOTE.retire_and_cleanup_attempt,
            rt, fs, setup, config, campaign_state, alias_res, promoted_ok, log)
        if clean_ok and clean_res then
            safe_to_retry = clean_res.safeToRetry
        end
    else
        safe_to_retry = true
    end

    rt.end_alloc_tracking(tracker)
    local workers_quiesced = (not campaign_state) or (campaign_state.workerStateSafe == true)
    local retained_active  = (alias_res and alias_res.retainedEndpointActive == true)
    if not promoted_ok and not retained_active and workers_quiesced then
        rt.free_tracked_allocs(tracker)
    end

    local total_attempt_ms = math.floor((rt.now_ms() - t_attempt0) + 0.5)
    log(string.format("TIMING[#%d]: Prep=%dms Race=%dms Promote=%dms AttemptTotal=%dms",
        attempt_idx, prep_ms, race_ms, promote_ms, total_attempt_ms))

    return {
        promoted       = promoted_ok,
        safeToRetry    = safe_to_retry,
        prepMs         = prep_ms,
        raceMs         = race_ms,
        promoteMs      = promote_ms,
        attemptMs      = total_attempt_ms,
        timingSchedule = campaign_state and campaign_state.timingSchedule or carried_schedule,
    }
end

-- Load Stage C (`s2_kaihen.lua`) from `save:/` first so HTTP uploads are never shadowed
-- by a stale SD copy, falling back to `/kaihen/s2_kaihen.lua` on microSD if needed.
local function load_kaihen_module(rt, fs, log_fn)
    local ok_req, req_mod = pcall(require, "s2_kaihen")
    if ok_req and type(req_mod) == "table" and req_mod.run_kaihen then
        return req_mod
    end
    local state = _G.fsKaihen
    if state and state.domainSession then
        local ok_sd, sd_mod = pcall(function()
            local plain = fs.clone_object(state.domainSession.handle, state.domainSession.rootObj)
            if plain == 0 then return nil end
            local rep = fs.send_packet(plain, P.packet(18, ""))
            rt.close_handle(plain)
            if rep.transport ~= 0 or rep.result ~= 0 or #rep.moves ~= 1 then return nil end
            local sdh = rep.moves[1]
            local function read_sd_lua(sdh, sd_path)
                local fh = fs.ipc_open_file(sdh, sd_path, 1, 0x301)
                if fh == 0 then return nil end
                local fsz = fs.ipc_file_get_size(fh)
                local code_str = nil
                if fsz and fsz > 0 and fsz <= 0x40000 then
                    local dbuf, draw = rt.alloc_page(fsz + 0x1000, false)
                    local rpkt = P.packet(0, P.u64s(0) .. P.u64s(0) .. P.u64s(fsz), {
                        b = {{addr = dbuf, size = fsz, mode = 1}}
                    })
                    local rrep = fs.send_packet(fh, rpkt)
                    if rrep.transport == 0 and rrep.result == 0 then
                        code_str = rt.rd(dbuf, fsz)
                    end
                    rt.free_raw(draw)
                end
                rt.close_handle(fh)
                return code_str
            end
            local ro_str = read_sd_lua(sdh, "/kaihen/s2_kh_ro.lua")
            if ro_str then
                local ro_chunk = loadstring(ro_str, "@/kaihen/s2_kh_ro.lua")
                if ro_chunk then package.loaded["s2_kh_ro"] = ro_chunk() end
            end
            local code_str = read_sd_lua(sdh, "/kaihen/s2_kaihen.lua")
            rt.close_handle(sdh)
            if code_str then
                local chunk, cerr = loadstring(code_str, "@/kaihen/s2_kaihen.lua")
                if chunk then
                    if log_fn then log_fn("STAGE C: loaded /kaihen/s2_kaihen.lua from microSD") end
                    return chunk()
                else
                    if log_fn then log_fn("WARN: SD s2_kaihen.lua syntax error: " .. tostring(cerr)) end
                end
            end
            return nil
        end)
        if ok_sd and type(sd_mod) == "table" and sd_mod.run_kaihen then
            return sd_mod
        end
    end
    return require("s2_kaihen")
end

-- Best-effort append of accumulated diagnostic log lines to `/kaihen/seedsow_run.log` on sdmc:
local function append_sd_log(rt, fs, log_lines, sd_path)
    local state = _G.fsKaihen
    if not (state and state.domainSession and log_lines and #log_lines > 0) then
        return false
    end
    sd_path = sd_path or "/kaihen/seedsow_run.log"
    local ok_write = pcall(function()
        local plain = fs.clone_object(state.domainSession.handle, state.domainSession.rootObj)
        if plain == 0 then return end
        local rep = fs.send_packet(plain, P.packet(18, ""))
        rt.close_handle(plain)
        if rep.transport ~= 0 or rep.result ~= 0 or #rep.moves ~= 1 then return end
        local sdh = rep.moves[1]
        fs.ipc_create_directory(sdh, "/kaihen")
        local ex = fs.ipc_get_entry_type(sdh, sd_path, 0x301)
        if ex.transport ~= 0 or ex.result ~= 0 then
            fs.ipc_create_file(sdh, sd_path, 0)
        end
        -- Open with mode = 7 (Read | Write | Append)
        local fh = fs.ipc_open_file(sdh, sd_path, 7, 0x301)
        if fh ~= 0 then
            local offset = fs.ipc_file_get_size(fh) or 0
            local text = table.concat(log_lines, "\n") .. "\n"
            local wbuf, wraw = rt.alloc_page(#text + 0x1000, false)
            if wbuf ~= 0 then
                rt.wr(wbuf, text)
                -- IFile::Write (cmd 1, WriteOption = 1 [Flush], offset, size)
                local wpkt = P.packet(1, P.u32s(1) .. P.u32s(0) .. P.u64s(offset) .. P.u64s(#text), {
                    a = {{addr = wbuf, size = #text, mode = 1}}
                })
                fs.send_packet(fh, wpkt)
                rt.free_raw(wraw)
            end
            rt.close_handle(fh)
        end
        fs.ipc_commit(sdh)
        rt.close_handle(sdh)
    end)
    return ok_write
end

function M.run(opts)
    opts = opts or {}
    local out_log = opts.log or default_log
    local N = _G.n2h
    assert(N, "s2_main: _G.n2h is not initialized (load save:/core.lua first)")

    -- Accumulate all log lines in memory during synchronous execution (zero mid-chain yields)
    local log_lines = {}
    M.last_logs = log_lines
    local function buf_log(msg)
        log_lines[#log_lines + 1] = tostring(msg)
    end
    local flushed = false
    local function flush_logs(rt, fs)
        if flushed then return end
        flushed = true
        if opts.sdLog ~= false and rt and fs then
            append_sd_log(rt, fs, log_lines, opts.sdLogPath)
        end
        if #log_lines <= 24 then
            for i = 1, #log_lines do out_log(log_lines[i]) end
        else
            for i = 1, #log_lines do
                local ln = log_lines[i]
                if not ln:find("^Wave %d") and not ln:find("^======== ATTEMPT") then
                    out_log(ln)
                end
            end
        end
    end

    buf_log("=== Seedsow Semi-Untethered fsp-srv + kaiHEN (No PC / No RPC) ===")
    buf_log("Credits: pepsipu, kurumuz, Gezine, Slapah, ItsNerisma, aveao, alula, Malev0")

    local rt = P.bind_n2h(N)
    local fs = FS.bind_fs(rt)
    local t_run0 = rt.now_ms()
    local prep_ms, race_ms, promote_ms = 0, 0, 0

    if not (_G.fsKaihen and _G.fsKaihen.domainSession) then
        local max_attempts = opts.maxAttempts or BASE_ATTEMPTS
        local carried_schedule = nil
        for attempt = 1, max_attempts do
            if is_stop_pressed() then
                buf_log("STOP: aborted by user button")
                flush_logs(rt, fs)
                return {ok = false, stopped = true, logs = log_lines}
            end
            local res = M.run_single_attempt(rt, fs, attempt, buf_log, carried_schedule)
            carried_schedule = nil
            prep_ms    = res.prepMs or 0
            race_ms    = res.raceMs or 0
            promote_ms = res.promoteMs or 0
            if res.promoted then
                buf_log("STAGE B COMPLETE: fsp-srv promoted to PID=1 & endpoint retained!")
                break
            end
            if not res.safeToRetry then
                buf_log("STOP: attempt cleanup could not verify retry safety; restart the Switch")
                flush_logs(rt, fs)
                return {ok = false, unsafeToRetry = true, logs = log_lines}
            end
            if attempt < max_attempts then
                rt.wait_ms(RETRY_PAUSE_MS)
            else
                buf_log("STOP: reached max attempts (" .. max_attempts .. ") without promotion; restart the Switch")
                flush_logs(rt, fs)
                return {ok = false, exhausted = true, logs = log_lines}
            end
        end
    else
        buf_log("STAGE B: reusing existing promoted _G.fsKaihen session")
    end

    if opts.skipKaihen then
        local total_ms = math.floor((rt.now_ms() - t_run0) + 0.5)
        buf_log(string.format("SUMMARY: Prep=%dms Race=%dms Promote=%dms | Total=%dms",
            prep_ms, race_ms, promote_ms, total_ms))
        flush_logs(rt, fs)
        return {ok = true, promoted = true, logs = log_lines}
    end

    local t_ro0 = rt.now_ms()
    local kaihen_mod = load_kaihen_module(rt, fs, buf_log)
    local ok_kh, startup_or_err = pcall(kaihen_mod.run_kaihen, rt, fs, buf_log)
    local ro_ms = math.floor((rt.now_ms() - t_ro0) + 0.5)
    local total_ms = math.floor((rt.now_ms() - t_run0) + 0.5)
    buf_log(string.format("SUMMARY: Prep=%dms Race=%dms Promote=%dms ro_takeover=%dms | Total=%dms",
        prep_ms, race_ms, promote_ms, ro_ms, total_ms))
    if not ok_kh then
        buf_log("KAIHEN ERROR: " .. tostring(startup_or_err))
        flush_logs(rt, fs)
        error(startup_or_err)
    end
    flush_logs(rt, fs)
    return {ok = true, promoted = true, henStartup = startup_or_err, logs = log_lines}
end

-- Plain onEnterFrame state machine (no coroutines, steps sub-stages across frames
-- so SETUP, CAMPAIGN, ALIAS, PROMOTE, CLEANUP, and KAIHEN each flush to screen immediately).
function M.start_frame_runner()
    local N = _G.n2h
    assert(N, "s2_main: _G.n2h is not initialized")
    local rt = P.bind_n2h(N)
    local fs = FS.bind_fs(rt)
    local log_lines = {}
    M.last_logs = log_lines
    local printed_idx = 0
    local screen_lines = 0
    local function buf_log(msg)
        log_lines[#log_lines + 1] = tostring(msg)
    end
    local function flush_new_lines()
        while printed_idx < #log_lines do
            printed_idx = printed_idx + 1
            local ln = log_lines[printed_idx]
            if not ln:find("^Wave %d") then
                if screen_lines >= 22 and _G.n2h_clear then
                    _G.n2h_clear()
                    screen_lines = 0
                end
                default_log(ln)
                screen_lines = screen_lines + 1
            end
        end
    end
    local t_run0 = rt.now_ms()
    local prep_ms, race_ms, promote_ms = 0, 0, 0
    local attempt = 1
    local max_attempts = BASE_ATTEMPTS
    local carried_schedule = nil
    local phase = (_G.fsKaihen and _G.fsKaihen.domainSession) and "kaihen" or "setup"

    -- Per-attempt state across sub-stage frames
    local tracker, config, setup, campaign_state, alias_res, rel_res = nil, nil, nil, nil, nil, nil
    local promoted_ok, safe_to_retry = false, false
    local t_attempt0, t_r0, t_p0 = 0, 0, 0

    if _G.n2h_clear then _G.n2h_clear() end
    buf_log("=== Seedsow Semi-Untethered fsp-srv + kaiHEN (No PC / No RPC) ===")
    flush_new_lines()

    local function finish_run()
        flush_new_lines()
        append_sd_log(rt, fs, log_lines)
        _G.e:setEventHandler{ onEnterFrame = "n2h_launcher_idle" }
        phase = "done"
    end

    function _G.s2_step_frame()
        if phase == "done" then return end
        local ok_step, err_step = xpcall(function()
            if is_stop_pressed() and phase ~= "cleanup" and phase ~= "kaihen" then
                buf_log("STOP: aborted by user button")
                if setup and setup.ok then
                    phase = "cleanup"
                else
                    return finish_run()
                end
            end

            if phase == "setup" then
                if attempt > 1 and _G.n2h_clear then
                    _G.n2h_clear()
                    screen_lines = 0
                end
                buf_log(string.format("======== ATTEMPT %d/%d ========", attempt, max_attempts))
                tracker = rt.begin_alloc_tracking()
                if not tracker then
                    buf_log("FAIL: could not start allocation tracking")
                    return finish_run()
                end
                config = RACE.create_config(attempt)
                if carried_schedule and carried_schedule.roleDelays and carried_schedule.guardDelays then
                    config.roleDelays  = {unpack(carried_schedule.roleDelays)}
                    config.guardDelays = {unpack(carried_schedule.guardDelays)}
                    config.timingBaseline = {
                        roleDelays  = carried_schedule.baselineRoleDelays or {unpack(config.roleDelays)},
                        guardDelays = carried_schedule.baselineGuardDelays or {unpack(config.guardDelays)},
                    }
                end
                setup, campaign_state, alias_res = nil, nil, nil
                promoted_ok, safe_to_retry = false, false
                t_attempt0 = rt.now_ms()
                prep_ms, race_ms, promote_ms = 0, 0, 0

                local t0 = rt.now_ms()
                setup = RACE.setup_attempt(rt, fs, config, buf_log)
                prep_ms = math.floor((rt.now_ms() - t0) + 0.5)
                if not setup.ok then
                    buf_log("SETUP FAIL: " .. tostring(setup.failureReason))
                    RACE.log_attempt_summary(config, false, rt.now_ms() - t_attempt0, buf_log)
                    phase = "cleanup"
                else
                    phase = "campaign"
                end
                flush_new_lines()

            elseif phase == "campaign" then
                t_r0 = rt.now_ms()
                campaign_state = RACE.run_control_wave_loop(rt, fs, setup, config, buf_log, is_stop_pressed)
                if not campaign_state.canaryQualified then
                    race_ms = math.floor((rt.now_ms() - t_r0) + 0.5)
                    buf_log("CAMPAIGN: canary did not flip in this attempt")
                    RACE.log_attempt_summary(config, false, rt.now_ms() - t_attempt0, buf_log)
                    phase = "cleanup"
                else
                    buf_log("CAMPAIGN: qualified canary flip! Installing cache alias...")
                    phase = "alias"
                end
                flush_new_lines()

            elseif phase == "alias" then
                alias_res = RACE.prepare_and_install_alias(rt, fs, setup, config, campaign_state, buf_log, is_stop_pressed)
                race_ms = math.floor((rt.now_ms() - t_r0) + 0.5)
                RACE.log_attempt_summary(config, alias_res.aliasInstalled, rt.now_ms() - t_attempt0, buf_log)
                if not alias_res.aliasInstalled then
                    buf_log("ALIAS FAIL: " .. tostring(alias_res.failureReason or "copy steps incomplete"))
                    phase = "cleanup"
                else
                    M.last_alias = alias_res
                    buf_log("ALIAS OK! Discovering pointers & promoting fsp-srv...")
                    phase = "discover"
                end
                flush_new_lines()

            elseif phase == "discover" then
                t_p0 = rt.now_ms()
                PROMOTE.prepare_release_neighbors(rt, fs, setup, config, alias_res, buf_log)
                rel_res = PROMOTE.release_neighbors_and_find_pointers(rt, fs, setup, config, alias_res, buf_log)
                if not rel_res.ok or #rel_res.pointerCandidates == 0 then
                    promote_ms = math.floor((rt.now_ms() - t_p0) + 0.5)
                    buf_log("DISCOVERY FAIL: no pointer candidates")
                    phase = "cleanup"
                else
                    phase = "promote"
                end
                flush_new_lines()

            elseif phase == "promote" then
                local prom = PROMOTE.qualify_and_promote(rt, fs, setup, config, campaign_state,
                    alias_res, rel_res.pointerCandidates, buf_log, is_stop_pressed)
                promote_ms = math.floor((rt.now_ms() - t_p0) + 0.5)
                if prom.ok and prom.promotionRetained then
                    promoted_ok = true
                else
                    buf_log("PROMOTE FAIL: " .. tostring(prom.failureReason))
                end
                phase = "cleanup"
                flush_new_lines()

            elseif phase == "cleanup" then
                if setup and setup.ok then
                    local clean_ok, clean_res = pcall(PROMOTE.retire_and_cleanup_attempt,
                        rt, fs, setup, config, campaign_state, alias_res, promoted_ok, buf_log)
                    if clean_ok and clean_res then
                        safe_to_retry = clean_res.safeToRetry
                    end
                else
                    safe_to_retry = true
                end
                rt.end_alloc_tracking(tracker)
                local workers_quiesced = (not campaign_state) or (campaign_state.workerStateSafe == true)
                local retained_active  = (alias_res and alias_res.retainedEndpointActive == true)
                if not promoted_ok and not retained_active and workers_quiesced then
                    rt.free_tracked_allocs(tracker)
                end
                -- Keep proven Seedsow roleDelays fixed across attempts (probe-reserved-gap-seedsow.cjs:541)
                carried_schedule = nil
                local total_attempt_ms = math.floor((rt.now_ms() - t_attempt0) + 0.5)
                buf_log(string.format("TIMING[#%d]: Prep=%dms Race=%dms Promote=%dms Total=%dms",
                    attempt, prep_ms, race_ms, promote_ms, total_attempt_ms))

                if promoted_ok then
                    flush_new_lines()
                    if _G.n2h_clear then
                        _G.n2h_clear()
                        screen_lines = 0
                    end
                    buf_log("STAGE B COMPLETE: fsp-srv promoted to PID=1 & endpoint retained!")
                    flush_new_lines()
                    phase = "kaihen"
                    return
                end
                if not safe_to_retry then
                    buf_log("STOP: attempt cleanup could not verify retry safety; restart the Switch")
                    return finish_run()
                end
                if attempt < max_attempts then
                    attempt = attempt + 1
                    rt.wait_ms(RETRY_PAUSE_MS)
                    phase = "setup"
                    flush_new_lines()
                else
                    buf_log("STOP: reached max attempts (" .. max_attempts .. ") without promotion; restart the Switch")
                    return finish_run()
                end

            elseif phase == "kaihen" then
                local t_ro0 = rt.now_ms()
                local kaihen_mod = load_kaihen_module(rt, fs, buf_log)
                local ok_kh, startup_or_err = pcall(kaihen_mod.run_kaihen, rt, fs, buf_log)
                local ro_ms = math.floor((rt.now_ms() - t_ro0) + 0.5)
                local total_ms = math.floor((rt.now_ms() - t_run0) + 0.5)
                buf_log(string.format("SUMMARY: Prep=%dms Race=%dms Promote=%dms ro_takeover=%dms | Total=%dms",
                    prep_ms, race_ms, promote_ms, ro_ms, total_ms))
                if not ok_kh then
                    buf_log("KAIHEN ERROR: " .. tostring(startup_or_err))
                end
                return finish_run()
            end
        end, function(er) return tostring(er) end)
        if not ok_step then
            buf_log("FATAL: " .. tostring(err_step))
            if tracker then
                rt.end_alloc_tracking(tracker)
            end
            finish_run()
        end
    end

    _G.e:setEventHandler{ onEnterFrame = "s2_step_frame" }
end

if _G.S2_AUTORUN_MAIN ~= false and _G.n2h then
    local ok, err = xpcall(function()
        if _G.e and type(_G.e.setEventHandler) == "function" then
            M.start_frame_runner()
        else
            M.run()
        end
    end, function(e) return tostring(e) end)
    if not ok then
        default_log("FATAL: " .. tostring(err))
    end
end

return M
