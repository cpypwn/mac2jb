// Mount helpers - inspect the SDK mount table and clone a mount handle.

// -- Mount table access --------------------------------------------

// Walk the SDK mount table to extract session handle + domain object ID.
// Returns { handle, objId, accessor, slots } or null on failure.
function getMountHandle(name) {
    const nameBuf = allocRawTracked(16);
    writeStr(nameBuf, name);
    const accOut = allocRawTracked(8);
    write64(accOut, 0n);
    const r = call_rop(F_FindMount, accOut, nameBuf);
    const a = read64(accOut);
    if (r !== 0n || a === 0n) return null;
    const impl    = read64(a + 0x28n);
    const service = read64(impl + 0x10n);
    const objId   = Number(read32(service + 0x18n)) >>> 0;
    const manager = read64(service + 0x10n);
    const slots   = read64(manager + 0x10n);
    const handle  = Number(read32(slots)) >>> 0;
    return { handle, objId, accessor: a, slots };
}

// Convenience: get a cloned non-domain handle for a mount.
// Returns { handle, objId, borrowed } or null on failure.
// Caller must closeHandle(result.handle) when done.
function openMount(name) {
    const mount = getMountHandle(name);
    if (!mount) return null;
    const handle = cloneObject(mount.handle, mount.objId);
    if (!handle) return null;
    return { handle, objId: mount.objId, borrowed: mount.handle };
}
