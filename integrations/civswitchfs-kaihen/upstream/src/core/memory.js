// Memory helpers — allocation, tracking, and byte/string access.

var activeAllocationTracker = null;

function beginAllocationTracking() {
    if (activeAllocationTracker !== null) return null;
    activeAllocationTracker = [];
    return activeAllocationTracker;
}

function endAllocationTracking(tracker) {
    if (activeAllocationTracker !== tracker) return false;
    activeAllocationTracker = null;
    return true;
}

// Track raw game-heap allocations for a payload that owns a bounded
// allocation scope. The tracked pointer is the original malloc result, not
// the page-aligned address returned by allocPage.
function allocRawTracked(bytes) {
    const raw = malloc(bytes);
    if (raw && activeAllocationTracker !== null)
        activeAllocationTracker.push(raw);
    return raw;
}

function freeTrackedAllocations(allocations) {
    var errors = [];
    var callsCompleted = 0;
    for (var i = allocations.length - 1; i >= 0; i--) {
        try {
            free(allocations[i]);
            callsCompleted++;
        } catch (error) {
            errors.push("allocation-" + i + ":" + String(error));
        }
    }
    // The target's C free() is void; this reports normal ROP-call completion,
    // not an allocator-side proof that the block was reclaimed.
    return {ok: errors.length === 0, attempted: allocations.length,
        callsCompleted: callsCompleted, errors: errors};
}

// Page-aligned allocation (required by kernel for IPC buffers)
function allocPage(bytes) {
    const raw = allocRawTracked(bytes + 0x2000);
    return (raw + 0xFFFn) / 0x1000n * 0x1000n;
}

// Write a null-terminated string into a buffer
function writeStr(buf, str) {
    for (let i = 0; i < str.length; i++)
        write8(buf + BigInt(i), BigInt(str.charCodeAt(i)));
    write8(buf + BigInt(str.length), 0n);
}

function read_bytes(addr, len) {
    const out = [];
    for (let i = 0; i < len; i++) {
        out.push(Number(read8(addr + BigInt(i))));
    }
    return out;
}

function read_string(addr, maxLen) {
    maxLen = maxLen || 256;
    let s = "";
    for (let i = 0; i < maxLen; i++) {
        const c = Number(read8(addr + BigInt(i)));
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

function write_bytes(addr, bytes) {
    for (let i = 0; i < bytes.length; i++) {
        write8(addr + BigInt(i), BigInt(bytes[i]));
    }
}

// Copy a memory region into a JS array (no log calls, no IPC side-effects)
function snapshot_buffer(addr, len) {
    const out = [];
    for (let i = 0; i < len; i++) {
        out.push(Number(read8(addr + BigInt(i))));
    }
    return out;
}
