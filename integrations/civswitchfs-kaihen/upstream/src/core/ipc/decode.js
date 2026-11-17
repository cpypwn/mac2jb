// HIPC/CMIF decoding helpers - parse responses from memory or byte snapshots.

// Read a 32-bit little-endian value from a JS byte array
function arr_read32(arr, offset) {
    return arr[offset] | (arr[offset+1] << 8) | (arr[offset+2] << 16) | (arr[offset+3] << 24);
}

// Decode an IPC response from a snapshotted byte array.
// Works for both plain CMIF and domain CMIF sessions.
// Returns a structured object - all fields are plain JS numbers.
//
// Usage:
//   const msg = decode_ipc_response(byteArray);
//   if (msg.sfco) log("Result: " + msg.sfco.result);
//
function decode_ipc_response(buf) {
    const u32 = (off) => (arr_read32(buf, off) >>> 0);

    // HIPC header (first 8 bytes)
    const w0 = u32(0);
    const w1 = u32(4);
    const hipc = {
        type:       w0 & 0xFFFF,
        ptr_bufs:   (w0 >> 16) & 0xF,
        send_bufs:  (w0 >> 20) & 0xF,
        recv_bufs:  (w0 >> 24) & 0xF,
        exch_bufs:  (w0 >> 28) & 0xF,
        raw_words:  w1 & 0x3FF,
        recv_list:  (w1 >> 10) & 0xF,
        has_special: (w1 >> 31) & 1,
    };

    // Cursor after the HIPC header
    let pos = 8;

    // Special header (handle descriptor) - skip if present
    if (hipc.has_special) {
        const special_w = u32(pos);
        const has_pid = special_w & 1;
        const num_copy = (special_w >> 1) & 0xF;
        const num_move = (special_w >> 5) & 0xF;
        pos += 4;
        if (has_pid) pos += 8;
        pos += (num_copy + num_move) * 4;
    }

    // Skip pointer descriptors (8 bytes each)
    pos += hipc.ptr_bufs * 8;
    // Skip send descriptors (12 bytes each)
    pos += hipc.send_bufs * 12;
    // Skip receive descriptors (12 bytes each)
    pos += hipc.recv_bufs * 12;
    // Skip exchange descriptors (12 bytes each)
    pos += hipc.exch_bufs * 12;

    // Raw data section starts here
    const raw_start = pos;
    const raw_end = raw_start + hipc.raw_words * 4;

    // Within the raw section, find SFCI or SFCO by scanning for the magic.
    // Also detect domain-close messages (type=2 in domain header, no SFCI/SFCO).
    let sfci = null;
    let sfco = null;
    let domain = null;

    for (let off = raw_start; off + 16 <= buf.length; off += 4) {
        const magic = u32(off);
        if (magic === 0x49434653) {  // "SFCI" - request
            sfci = {
                offset: off,
                magic: "SFCI",
                version: u32(off + 4),
                command_id: u32(off + 8),
                token: u32(off + 12),
            };
            break;
        }
        if (magic === 0x4F434653) {  // "SFCO" - response
            sfco = {
                offset: off,
                magic: "SFCO",
                version: u32(off + 4),
                result: u32(off + 8),
                token: u32(off + 12),
            };
            break;
        }
    }

    // Check for domain header: CMIF data is aligned to 16 bytes from the
    // start of the message. Between raw_start and the aligned position is
    // padding (zeros). The domain header sits at the aligned offset, before
    // the SFCI/SFCO magic.
    const aligned_start = Math.ceil(raw_start / 16) * 16;
    let cmif_offset = -1;
    if (sfci) {
        cmif_offset = sfci.offset;
    } else if (sfco) {
        cmif_offset = sfco.offset;
    }

    if (cmif_offset > aligned_start) {
        const first_word = u32(aligned_start);
        // Domain response header: u32 num_output_objects
        // Domain request header: u8 type, u8 num_input_objects, u16 data_len, u32 domain_object_id
        if (sfco && first_word < 256) {
            domain = { num_output_objects: first_word };
        } else if (sfci) {
            domain = {
                type: buf[aligned_start],
                num_input_objects: buf[aligned_start + 1],
                data_len: buf[aligned_start + 2] | (buf[aligned_start + 3] << 8),
                object_id: u32(aligned_start + 4),
            };
        }
    }

    // Domain-close message: no SFCI/SFCO, but domain header type=2 at aligned_start
    if (!sfci && !sfco && aligned_start + 8 <= buf.length) {
        const dom_type = buf[aligned_start];
        if (dom_type === 2) {
            domain = {
                type: 2,
                num_input_objects: buf[aligned_start + 1],
                data_len: buf[aligned_start + 2] | (buf[aligned_start + 3] << 8),
                object_id: u32(aligned_start + 4),
                is_close: true,
            };
        }
    }

    return { hipc, domain, sfci, sfco, raw_start, raw_end };
}

// Pretty-print a decoded IPC message (call after decode_ipc_response)
function log_ipc_message(msg) {
    const hipc_types = {
        0: "Response", 2: "Close", 4: "Request",
        5: "Control", 6: "RequestWithContext", 7: "ControlWithContext"
    };
    const type_name = hipc_types[msg.hipc.type] || ("Unknown(" + msg.hipc.type + ")");
    log("HIPC: type=" + msg.hipc.type + " (" + type_name + ")" +
        " raw=" + msg.hipc.raw_words + "w" +
        " ptr=" + msg.hipc.ptr_bufs +
        " send=" + msg.hipc.send_bufs +
        " recv=" + msg.hipc.recv_bufs +
        " special=" + msg.hipc.has_special);

    if (msg.domain) {
        if (msg.domain.is_close) {
            log("Domain CLOSE: object_id=" + msg.domain.object_id +
                " (destroying domain sub-object)");
        } else if (msg.domain.object_id !== undefined) {
            log("Domain request: target_object=" + msg.domain.object_id +
                " type=" + msg.domain.type +
                " input_objects=" + msg.domain.num_input_objects);
        } else {
            log("Domain response: output_objects=" + msg.domain.num_output_objects);
        }
    }

    if (msg.sfci) {
        log("SFCI at +" + msg.sfci.offset.toString(16) +
            ": cmd=" + msg.sfci.command_id +
            " token=0x" + msg.sfci.token.toString(16));
    }

    if (msg.sfco) {
        log("SFCO at +" + msg.sfco.offset.toString(16) +
            ": result=0x" + msg.sfco.result.toString(16) +
            (msg.sfco.result === 0 ? " (OK)" : " (ERROR)") +
            " token=0x" + msg.sfco.token.toString(16));
    }

    if (!msg.sfci && !msg.sfco && !(msg.domain && msg.domain.is_close)) {
        log("No SFCI/SFCO found in raw data section");
    }
}

// Parse a CMIF response (SFCO) from an IPC buffer.
// Handles: special header (copy/move handles), descriptor skipping,
// 16-byte alignment, SFCO magic + result + data offset.
function cmifReply(buf) {
    const U32 = (o) => Number(read32(buf + BigInt(o))) >>> 0;
    const t0 = U32(0), t1 = U32(4);
    let at = 8;
    const copies = [], moves = [];
    if ((t1 >>> 31) !== 0) {
        const sp = U32(8); at = 12;
        if (sp & 1) at += 8;
        let n = (sp >>> 1) & 15;
        for (let i = 0; i < n; i++) copies.push(U32(at + 4 * i));
        at += n * 4;
        n = (sp >>> 5) & 15;
        for (let i = 0; i < n; i++) moves.push(U32(at + 4 * i));
        at += n * 4;
    }
    at += (t0 >>> 16 & 15) * 8;
    at += ((t0 >>> 20 & 15) + (t0 >>> 24 & 15) + (t0 >>> 28 & 15)) * 12;
    at = (at + 15) & ~15;
    return { at, result: U32(at + 8), data: at + 16, copies, moves };
}
