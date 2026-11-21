-- s2_fshlp.lua — High-Level `fsp-srv` / `IFileSystem` / `IStorage` / Reservation Wrappers
-- Target: Switch 2 (Ounce) — Seedsow Lullaby (Artemis Lua 5.1 VM)
-- Split from s2_fs.lua to stay under the 32,768-byte http.lua PUT /save upload cap.

local P = require("s2_prim")

local math_min   = math.min
local str_char   = string.char
local str_sub    = string.sub
local str_format = string.format

local H = {}

function H.attach(M)
    function M.bind_fs(rt)
        local fs = {rt = rt}

        -- Reusable scratch packet/path buffers for synchronous single-thread IPC
        local shared_pkt = rt.alloc_page(0x2000, false)
        local shared_path0 = rt.alloc_page(0x1000, false)
        local shared_path1 = rt.alloc_page(0x1000, false)

        function fs.send_packet(handle, pkt_str, pkt_addr, parse_opts)
            pkt_addr = pkt_addr or shared_pkt
            rt.memset(pkt_addr, 0, 0x200)
            rt.wr(pkt_addr, pkt_str)
            local trc = rt.send_ipc(handle, pkt_addr)
            if trc ~= 0 then
                return {transport = trc, result = 0xFFFFFFFF, canonical_result = 0x3FFFFF, moves = {}, copies = {}, objects = {}}
            end
            local raw_reply = rt.rd(pkt_addr, 256)
            local parsed = P.parse_response(raw_reply, parse_opts)
            parsed.transport = 0
            parsed.pkt_addr = pkt_addr
            return parsed
        end

        function fs.open_fsp_session()
            local handle = rt.get_service_sm("fsp-srv")
            if not handle or handle == 0 then return 0 end
            -- SetCurrentProcess (cmd 1, u64(0), pid=true)
            local pkt = P.packet(1, P.u64s(0), {pid = true})
            local rep = fs.send_packet(handle, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 then
                rt.close_handle(handle)
                return 0
            end
            return handle
        end

        function fs.clone_object(session_handle, domain_obj_id)
            local pkt = P.domain_control(1, P.u32s(domain_obj_id))
            local rep = fs.send_packet(session_handle, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 or #rep.moves == 0 then
                return 0
            end
            return rep.moves[1]
        end

        function fs.clone_fs_session(source_handle)
            local pkt = P.domain_control(2, "")
            local rep = fs.send_packet(source_handle, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 or #rep.moves == 0 then
                return 0
            end
            return rep.moves[1]
        end

        function fs.open_domain_session()
            local h = fs.open_fsp_session()
            if h == 0 then return nil end
            local pkt = P.domain_control(0, "")
            local rep = fs.send_packet(h, pkt)
            if rep.transport ~= 0 or not rep.sfco or rep.result ~= 0 then
                rt.close_handle(h)
                return nil
            end
            local root_obj = P.u32(rep.data, 0)
            return {handle = h, rootObj = root_obj}
        end

        function fs.open_mount(mount_name)
            local m = rt.get_mount_handle(mount_name or "save")
            if not m then return nil end
            local cloned = fs.clone_object(m.handle, m.objId)
            if cloned == 0 then return nil end
            return {handle = cloned, mount = m}
        end

        -- IFileSystem operations
        function fs.ipc_free_space(handle, path_str)
            path_str = path_str or "/"
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(11, "", {
                x = {{addr = shared_path0, size = #path_str + 1}}
            })
            local rep = fs.send_packet(handle, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 then
                return {error = rep.result, transport = rep.transport, bytes = -1}
            end
            return {error = 0, transport = 0, bytes = P.u64(rep.data, 0)}
        end

        function fs.ipc_get_entry_type(handle, path_str, x_size_override)
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(7, "", {
                x = {{addr = shared_path0, size = x_size_override or (#path_str + 1)}}
            })
            local rep = fs.send_packet(handle, pkt)
            if rep.transport ~= 0 then
                return {transport = rep.transport, error = 0xFFFFFFFF, result = nil, type = -1}
            end
            if rep.result ~= 0 then
                return {transport = 0, error = rep.result, result = rep.result, type = -1}
            end
            local etype = P.u32(rep.data, 0)
            return {transport = 0, error = 0, result = 0, type = etype}
        end

        function fs.ipc_get_entry_type_raw_bytes(handle, raw_bytes)
            local s = P.bytes_to_str(raw_bytes)
            rt.wr(shared_path0, s)
            local readback = rt.rd(shared_path0, #s)
            local input_matches = (readback == s)
            local pkt = P.packet(7, "", {
                x = {{addr = shared_path0, size = #s}}
            })
            local rep = fs.send_packet(handle, pkt)
            if rep.transport ~= 0 or not rep.sfco then
                return {
                    ok = false,
                    transport = rep.transport,
                    result = 0xFFFFFFFF,
                    canonical = 0xFFFFFFFF,
                    inputMatches = input_matches
                }
            end
            return {
                ok = true,
                transport = 0,
                result = rep.result,
                canonical = rep.canonical_result,
                inputMatches = input_matches
            }
        end

        function fs.check_address_header_encoding(header_bytes, saved_handle)
            local prefix = str_char(0x2F, 0x2E, 0x2E, 0x5C) -- "/..\"
            local invalid_str = prefix .. str_char(0xFF, 0)
            local encoded_str = prefix .. P.bytes_to_str(header_bytes) .. "\0"
            local invalid = fs.ipc_get_entry_type_raw_bytes(saved_handle, invalid_str)
            local encoded = fs.ipc_get_entry_type_raw_bytes(saved_handle, encoded_str)
            return {
                invalid = invalid,
                encoded = encoded,
                ok = invalid.ok and encoded.ok and invalid.inputMatches and encoded.inputMatches and
                     invalid.canonical == 0x2EEA02 and encoded.canonical == 0x2EEC02
            }
        end

        function fs.ipc_create_directory(handle, path_str)
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(2, "", {
                x = {{addr = shared_path0, size = #path_str + 1}}
            })
            local rep = fs.send_packet(handle, pkt)
            return rep.result, rep.transport
        end

        function fs.ipc_create_file(handle, path_str, size)
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(0, P.u64s(0) .. P.u64s(size or 0), {
                x = {{addr = shared_path0, size = #path_str + 1}}
            })
            local rep = fs.send_packet(handle, pkt)
            return rep.result, rep.transport
        end

        function fs.ipc_delete_file(handle, path_str)
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(1, "", {
                x = {{addr = shared_path0, size = #path_str + 1}}
            })
            local rep = fs.send_packet(handle, pkt)
            return rep.result, rep.transport
        end

        function fs.ipc_rename_file(handle, old_path, new_path, sz0, sz1)
            rt.wr_str(shared_path0, old_path)
            rt.wr_str(shared_path1, new_path)
            local pkt = P.packet(5, "", {
                x = {
                    {addr = shared_path0, size = sz0 or (#old_path + 1), index = 0},
                    {addr = shared_path1, size = sz1 or (#new_path + 1), index = 1}
                }
            })
            local rep = fs.send_packet(handle, pkt)
            return rep.result, rep.transport
        end

        function fs.ipc_delete_directory_recursively(handle, path_str)
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(4, "", {
                x = {{addr = shared_path0, size = #path_str + 1}}
            })
            local rep = fs.send_packet(handle, pkt)
            return rep.result, rep.transport
        end

        function fs.ipc_commit(handle)
            local pkt = P.packet(10, "")
            local rep = fs.send_packet(handle, pkt)
            return rep.result, rep.transport
        end

        function fs.ipc_open_file(handle, path_str, mode, x_size)
            rt.wr_str(shared_path0, path_str)
            local pkt = P.packet(8, P.u32s(mode or 1), {
                x = {{addr = shared_path0, size = x_size or (#path_str + 1)}}
            })
            local rep = fs.send_packet(handle, pkt)
            if rep.transport == 0 and rep.result == 0 and #rep.moves > 0 then
                return rep.moves[1], 0
            end
            return 0, rep.result
        end

        function fs.ipc_file_get_size(file_handle)
            local pkt = P.packet(4, "")
            local rep = fs.send_packet(file_handle, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 then
                return nil, rep.result
            end
            return P.u64(rep.data, 0), 0
        end

        function fs.ipc_file_invalidate(fs_handle, path_str, size)
            local fh = fs.ipc_open_file(fs_handle, path_str, 1)
            if fh == 0 then return -1 end
            local pkt = P.packet(5, P.u32s(2) .. P.u32s(0) .. P.u64s(0) .. P.u64s(size))
            local rep = fs.send_packet(fh, pkt)
            rt.close_handle(fh)
            return rep.result
        end

        function fs.write_dirty_data(handle, dirty_path, dirty_size, write_buf, write_pkt)
            local writer = fs.ipc_open_file(handle, dirty_path, 3)
            if writer == 0 then return false end
            local pkt = P.packet(1, P.u64s(0) .. P.u64s(0) .. P.u64s(dirty_size), {
                a = {{addr = write_buf, size = dirty_size, mode = 1}}
            })
            local rep = fs.send_packet(writer, pkt, write_pkt)
            rt.close_handle(writer)
            return rep.transport == 0 and rep.result == 0
        end

        function fs.ipc_list_directory(handle, path_str, mode)
            mode = mode or 3
            rt.wr_str(shared_path0, path_str or "/")
            local open_pkt = P.packet(9, P.u32s(mode), {
                x = {{addr = shared_path0, size = 0x301}}
            })
            local open_rep = fs.send_packet(handle, open_pkt)
            if open_rep.transport ~= 0 or open_rep.result ~= 0 or #open_rep.moves == 0 then
                return {error = open_rep.result or 0xFFFF, entries = {}}
            end
            local dir_handle = open_rep.moves[1]
            local ENTRY_SIZE = 0x310
            local BATCH_ENTRIES = 64
            local out_size = ENTRY_SIZE * BATCH_ENTRIES
            local out_buf, out_raw = rt.alloc_page(out_size + 0x1000, false)
            local read_pkt = P.packet(0, "", {
                b = {{addr = out_buf, size = out_size, mode = 0}}
            })
            local entries = {}
            local total_count = 0
            local last_rep = nil
            for _ = 1, 64 do
                local read_rep = fs.send_packet(dir_handle, read_pkt)
                last_rep = read_rep
                if read_rep.transport ~= 0 or read_rep.result ~= 0 then break end
                local count = math_min(BATCH_ENTRIES, P.u64(read_rep.data, 0))
                if count <= 0 then break end
                total_count = total_count + count
                local raw_entries = rt.rd(out_buf, count * ENTRY_SIZE)
                for i = 0, count - 1 do
                    local base = i * ENTRY_SIZE
                    local raw_name = str_sub(raw_entries, base + 1, base + 0x301)
                    local name = raw_name:gsub("%z.*$", "")
                    local etype = P.u8(raw_entries, base + 0x304)
                    local esize = P.u64(raw_entries, base + 0x308)
                    entries[#entries + 1] = {name = name, type = etype, size = esize}
                end
            end
            rt.free_raw(out_raw)
            rt.close_handle(dir_handle)
            return {
                error = (last_rep and last_rep.transport == 0) and last_rep.result or (last_rep and last_rep.transport or 0),
                readTransport = last_rep and last_rep.transport or 0,
                entriesRead = total_count,
                entries = entries
            }
        end

        function fs.remove_scratch_tree(handle, scratch_dir)
            local rem_rc, rem_tx = fs.ipc_delete_directory_recursively(handle, scratch_dir)
            if rem_tx ~= 0 or (rem_rc ~= 0 and (rem_rc % 0x400000) ~= 0x202) then
                -- Fallback manual tree walk if recursive delete is rejected
                local stack = {scratch_dir}
                local dirs = {}
                while #stack > 0 do
                    local d = stack[#stack]
                    stack[#stack] = nil
                    dirs[#dirs + 1] = d
                    local list = fs.ipc_list_directory(handle, d, 3)
                    for _, item in ipairs(list.entries or {}) do
                        local sub = d .. "/" .. item.name
                        if item.type == 0 then
                            stack[#stack + 1] = sub
                        else
                            fs.ipc_delete_file(handle, sub)
                        end
                    end
                end
                for i = #dirs, 1, -1 do
                    -- cmd 3 = DeleteDirectory
                    rt.wr_str(shared_path0, dirs[i])
                    local pkt = P.packet(3, "", {x = {{addr = shared_path0, size = #dirs[i] + 1}}})
                    fs.send_packet(handle, pkt)
                end
            end
            local com_rc, com_tx = fs.ipc_commit(handle)
            return {remove = rem_rc, deleteTransport = rem_tx, commit = com_rc, commitTransport = com_tx}
        end

        -- IStorage operations
        function fs.open_content_storage(root_session)
            local pkt = P.packet(200, "")
            local rep = fs.send_packet(root_session, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 or #rep.moves ~= 1 then
                for i = 1, #rep.moves do rt.close_handle(rep.moves[i]) end
                for i = 1, #rep.copies do rt.close_handle(rep.copies[i]) end
                return 0
            end
            return rep.moves[1]
        end

        function fs.ipc_storage_get_size(storage_handle)
            local pkt = P.packet(4, "")
            local rep = fs.send_packet(storage_handle, pkt)
            if rep.transport ~= 0 or rep.result ~= 0 then
                return {error = rep.result, size = 0}
            end
            return {error = 0, size = P.u64(rep.data, 0)}
        end

        function fs.ipc_storage_read(storage_handle, offset, size, output_buf)
            local pkt = P.packet(0, P.u64s(offset) .. P.u64s(size), {
                b = {{addr = output_buf, size = size, mode = 1}}
            })
            local rep = fs.send_packet(storage_handle, pkt)
            if rep.transport ~= 0 then
                return {error = rep.transport, canonicalError = nil, transport = rep.transport, cmifError = nil}
            end
            return {
                error = rep.result,
                canonicalError = rep.canonical_result,
                transport = 0,
                cmifError = rep.result
            }
        end

        function fs.ipc_storage_write(storage_handle, offset, input_buf, size)
            local pkt = P.packet(1, P.u64s(offset) .. P.u64s(size), {
                a = {{addr = input_buf, size = size, mode = 1}}
            })
            local rep = fs.send_packet(storage_handle, pkt)
            return {
                error = rep.result,
                canonicalError = rep.canonical_result,
                transport = rep.transport
            }
        end

        function fs.ipc_storage_invalidate(storage_handle, offset, size)
            local pkt = P.packet(5, P.u32s(2) .. P.u32s(0) .. P.u64s(offset) .. P.u64s(size))
            local rep = fs.send_packet(storage_handle, pkt)
            return rep.result
        end

        -- Allocation counters (cmd 1009, always read twice and return the second reading)
        function fs.read_allocation_counters(root_session, pkt_buf)
            local pkt = P.packet(1009, "")
            local rep
            for _ = 1, 2 do
                rep = fs.send_packet(root_session, pkt, pkt_buf)
                if rep.transport ~= 0 or rep.result ~= 0 then return nil end
            end
            local raw = rt.rd((pkt_buf or shared_pkt) + rep.data_offset, 128)
            local counters = {}
            for i = 0, 15 do
                counters[i + 1] = P.u64(raw, i * 8) -- 1-based: counters[6] is 0-based counter[5]
            end
            return counters
        end

        function fs.close_domain_object_now(session_handle, object_id, pkt_buf)
            if not session_handle or session_handle == 0 or not object_id or object_id == 0 then
                return 0xFFFFFFFF
            end
            local pkt = P.domain_close_object(object_id)
            local addr = pkt_buf or shared_pkt
            rt.memset(addr, 0, 0x200)
            rt.wr(addr, pkt)
            return rt.send_ipc(session_handle, addr)
        end

        function fs.open_reservation_group(reader_session, pkt_buf, count)
            count = count or 59
            local expected_alloc = count * 208 -- 12272 bytes
            for attempt = 1, 3 do
                local dom = fs.open_domain_session()
                if not dom then return {ok = false, error = "open domain fsp-srv"} end
                local session_handle = dom.handle
                local root_obj = dom.rootObj
                local root_copy = fs.clone_object(session_handle, root_obj)
                if root_copy == 0 then
                    rt.close_handle(session_handle)
                    return {ok = false, error = "CopyFromCurrentDomain failed"}
                end

                local before = fs.read_allocation_counters(reader_session, pkt_buf)
                if not before then
                    rt.close_handle(root_copy)
                    rt.close_handle(session_handle)
                    return {ok = false, error = "allocation counters unavailable before reservations"}
                end

                local obj_ids = {}
                local failures = {}
                local cmd1200_pkt = P.domain_packet(root_obj, 1200, "")
                for i = 1, count do
                    local rep = fs.send_packet(session_handle, cmd1200_pkt, pkt_buf, {domain = true, data_size = 0})
                    if rep.transport == 0 and rep.result == 0 and #rep.objects == 1 and rep.objects[1] ~= 0 then
                        obj_ids[#obj_ids + 1] = rep.objects[1]
                    else
                        failures[#failures + 1] = str_format("#%d:tx=0x%x,rc=0x%x", i, rep.transport, rep.result)
                    end
                end

                local held = fs.read_allocation_counters(reader_session, pkt_buf)
                local delta = (before and held) and (before[6] - held[6]) or nil
                if #obj_ids ~= count or not held or delta ~= expected_alloc then
                    for i = #obj_ids, 1, -1 do
                        fs.close_domain_object_now(session_handle, obj_ids[i], pkt_buf)
                    end
                    rt.close_handle(root_copy)
                    rt.close_handle(session_handle)
                    if attempt < 3 then
                        -- Retry reservation group
                    else
                        return {
                            ok = false,
                            error = str_format("reservation delta=%s expected=%d", tostring(delta), expected_alloc),
                            reserved = #obj_ids,
                            failures = failures,
                            before = before,
                            held = held,
                            allocationDelta = delta
                        }
                    end
                else
                    -- Wrap domain session into outer object via Control cmd 0
                    local wrap_pkt = P.domain_control(0, "")
                    local wrap_rep = fs.send_packet(session_handle, wrap_pkt, pkt_buf)
                    local outer = (wrap_rep.transport == 0 and wrap_rep.result == 0) and P.u32(wrap_rep.data, 0) or 0
                    if outer == 0 then
                        for i = #obj_ids, 1, -1 do
                            fs.close_domain_object_now(session_handle, obj_ids[i], pkt_buf)
                        end
                        rt.close_handle(root_copy)
                        rt.close_handle(session_handle)
                        return {ok = false, error = "group wrap failed"}
                    end
                    return {
                        ok = true,
                        session = session_handle,
                        root = root_obj,
                        rootCopy = root_copy,
                        outer = outer,
                        reserved = #obj_ids,
                        failures = failures,
                        before = before,
                        held = held,
                        allocationDelta = delta,
                        attempts = attempt
                    }
                end
            end
            return {ok = false, error = "reservation retries exhausted"}
        end

        function fs.close_reservation_group(group, outer_still_open, pkt_buf)
            if not group then return end
            if group.session and outer_still_open and group.outer and group.outer ~= 0 then
                fs.close_domain_object_now(group.session, group.outer, pkt_buf)
            end
            if group.rootCopy and group.rootCopy ~= 0 then rt.close_handle(group.rootCopy) end
            if group.session and group.session ~= 0 then rt.close_handle(group.session) end
        end

        return fs
    end
end

return H
