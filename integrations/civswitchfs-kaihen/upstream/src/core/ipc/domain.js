// Domain IPC helpers - build and send commands to CMIF domain objects.

// Send a CMIF domain message targeting a domain object.
// buf must be an allocPage'd buffer (at least 0x2000).
// Returns { ok, result, objCount, transport }.
// Domain layout:
//   +0x10: domain header (type=1, payload size, target obj)
//   +0x20: SFCI (magic, cmd)
//   +0x30: input data
// Domain response:
//   +0x10: out_object_count
//   +0x20: SFCO (magic, result)
//   +0x30: response data, then domain object IDs
function sendDomainCmd(handle, targetObj, cmdId, buf, inputFn, inputBytes) {
    inputBytes = inputBytes || 0;
    var sfciPayload = 16 + inputBytes;
    for (var i = 0n; i < 0x200n; i += 8n) write64(buf + i, 0n);
    write32(buf, 4n);
    write32(buf + 4n, BigInt(12 + Math.ceil(inputBytes / 4)));
    write32(buf + 0x10n, BigInt(1 | (sfciPayload << 16)));
    write32(buf + 0x14n, BigInt(targetObj));
    write32(buf + 0x20n, 0x49434653n);
    write32(buf + 0x28n, BigInt(cmdId));
    if (inputFn) inputFn();
    var trc = sendIPC(handle, buf);
    var transport = Number(trc) >>> 0;
    var rspMagic = Number(read32(buf + 0x20n)) >>> 0;
    if (rspMagic !== 0x4F434653) {
        return { ok: false, result: -1, transport: transport, objCount: 0 };
    }
    var result = Number(read32(buf + 0x28n)) >>> 0;
    var objCount = Number(read32(buf + 0x10n)) >>> 0;
    return { ok: true, result: result, transport: transport, objCount: objCount };
}

// Read domain object IDs from a domain response buffer.
// dataSize = bytes of response data before the object IDs.
function readDomainObjects(buf, objCount, dataSize) {
    var objs = [];
    var off = 0x30 + (dataSize || 0);
    for (var i = 0; i < objCount && i < 8; i++) {
        objs.push(Number(read32(buf + BigInt(off + i * 4))) >>> 0);
    }
    return objs;
}

// -- Domain commands with descriptors ---------------------------------

// Domain command with 1 X descriptor (client->server data, <= 0x800 bytes).
// Layout: HIPC(+0) X(+0x08) domain(+0x10) SFCI(+0x20) input(+0x30)
// Response: domain(+0x10) SFCO(+0x20) data(+0x30)
// inputFn(buf, base): write extra SFCI params at buf + BigInt(base).
function sendDomainCmdX(handle, targetObj, cmdId, buf, xAddr, xSize, inputFn, inputBytes) {
    inputBytes = inputBytes || 0;
    for (var i = 0n; i < 0x200n; i += 8n) write64(buf + i, 0n);
    write32(buf, BigInt((4 | (1 << 16)) >>> 0));
    write32(buf + 4n, BigInt(12 + Math.ceil(inputBytes / 4)));
    writeXDesc(buf, 8, xAddr, xSize);
    write32(buf + 0x10n, BigInt((1 | ((16 + inputBytes) << 16)) >>> 0));
    write32(buf + 0x14n, BigInt(targetObj));
    write32(buf + 0x20n, 0x49434653n);
    write32(buf + 0x28n, BigInt(cmdId));
    if (inputFn) inputFn(buf, 0x30);
    var trc = sendIPC(handle, buf);
    var rspMagic = Number(read32(buf + 0x20n)) >>> 0;
    if (rspMagic !== 0x4F434653)
        return { ok: false, result: -1, transport: Number(trc) >>> 0, objCount: 0, data: 0x30 };
    return {
        ok: true,
        result: Number(read32(buf + 0x28n)) >>> 0,
        transport: Number(trc) >>> 0,
        objCount: Number(read32(buf + 0x10n)) >>> 0,
        data: 0x30
    };
}

// Domain command with 1 B descriptor (server->client receive buffer).
// Layout: HIPC(+0) B(+0x08,12B) domain(+0x20) SFCI(+0x30) input(+0x40)
// Response (no descs): domain(+0x10) SFCO(+0x20) data(+0x30)
// inputFn(buf, base): write extra SFCI params at buf + BigInt(base).
function sendDomainCmdB(handle, targetObj, cmdId, buf, bAddr, bSize, inputFn, inputBytes) {
    inputBytes = inputBytes || 0;
    for (var i = 0n; i < 0x200n; i += 8n) write64(buf + i, 0n);
    write32(buf, BigInt((4 | (1 << 24)) >>> 0));
    write32(buf + 4n, BigInt(12 + Math.ceil(inputBytes / 4)));
    var bLow  = Number(bAddr & 0xFFFFFFFFn);
    var bHi32 = Number((bAddr >> 32n) & 0x1Fn);
    var bHi37 = Number((bAddr >> 37n) & 0x3n);
    write32(buf + 0x08n, BigInt(bSize));
    write32(buf + 0x0Cn, BigInt(bLow >>> 0));
    write32(buf + 0x10n, BigInt(((bHi32 << 2) | (bHi37 << 28)) >>> 0));
    write32(buf + 0x20n, BigInt((1 | ((16 + inputBytes) << 16)) >>> 0));
    write32(buf + 0x24n, BigInt(targetObj));
    write32(buf + 0x30n, 0x49434653n);
    write32(buf + 0x38n, BigInt(cmdId));
    if (inputFn) inputFn(buf, 0x40);
    var trc = sendIPC(handle, buf);
    var rspMagic = Number(read32(buf + 0x20n)) >>> 0;
    if (rspMagic !== 0x4F434653)
        return { ok: false, result: -1, transport: Number(trc) >>> 0, objCount: 0, data: 0x30 };
    return {
        ok: true,
        result: Number(read32(buf + 0x28n)) >>> 0,
        transport: Number(trc) >>> 0,
        objCount: Number(read32(buf + 0x10n)) >>> 0,
        data: 0x30
    };
}
