/* SPDX-License-Identifier: MIT; copyright (c) 2026 Gezine. */
/* Direct trigger replacement. The image is data for the next boot, never eval'd here. */
window.__cfsCreateInstaller = function (options) {
    var codec = window.__cfsSaveCodec;
    var sourcePath = 'save:/saves/Single/XSTRIG.Civ7Save';
    var PROFILE = 'civ7-sdk-19f22ec5';
    // Pristine template distributed with this persistence payload.
    var TEMPLATE_BYTES = 1159730;
    var TEMPLATE_SHA256 =
        '32fa8a0d6dd0a480d8e541e63ea44c4619bc6f7be4282cfc3cb6a4f6d305dfae';
    var TEMPLATE_B64 = 1546308;
    var MAX_CHUNK = 480000; // Stay under the transport 500 Kio payload limit.
    var B64_ALPHABET =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var B64MAP = {};
    for (var digit = 0; digit < 64; digit++)
        B64MAP[B64_ALPHABET[digit]] = digit;
    var family = null;
    var image = null,
        busy = false,
        disposed = false,
        installed = false,
        lastMessage = '';
    var template = { id: null, chunks: [] };
    function state(message) {
        lastMessage = message;
        if (options.status) options.status(description({ message: message }));
    }
    function description(extra) {
        var view = {
            family: family,
            available: !!image,
            sha256: image ? image.sha256 : null,
            installed: installed,
            ready:
                !!image &&
                !installed &&
                !busy &&
                family !== 'absent' &&
                family !== 'unknown',
            busy: busy,
            staged: template.id !== null,
            message: lastMessage
        };
        for (var name in extra) view[name] = extra[name];
        return view;
    }
    function offer(value) {
        if (busy || disposed) throw new Error('Installer unavailable');
        if (
            !value ||
            value.profile !== PROFILE ||
            typeof value.stage !== 'string' ||
            typeof value.version !== 'string' ||
            value.version.length > 80 ||
            value.bytes !== value.stage.length ||
            value.bytes < 1 ||
            value.bytes > 200000 ||
            codec.sha256(codec.ascii(value.stage)) !== value.sha256
        )
            throw new Error('Invalid or incompatible image');
        image = {
            profile: value.profile,
            version: value.version,
            bytes: value.bytes,
            stage: value.stage,
            triggerTiming: value.triggerTiming === true,
            hideTriggerText: value.hideTriggerText === true,
            sha256: value.sha256
        };
        installed = false;
        state('Image ready: ' + image.version);
    }
    // --- Template staging (RAM only; the PC sends pristine save chunks). ---
    function templateProgress() {
        var reached = 0;
        for (var i = 0; i < template.chunks.length; i++)
            if (template.chunks[i].offset <= reached)
                reached = Math.max(
                    reached,
                    template.chunks[i].offset + template.chunks[i].data.length
                );
        return {
            id: template.id,
            received: reached,
            total: TEMPLATE_B64,
            complete: templateChunks() !== null
        };
    }
    function templateChunks() {
        var sorted = template.chunks.slice().sort(function (a, b) {
            return a.offset - b.offset;
        });
        var acc = 0;
        for (var i = 0; i < sorted.length; i++) {
            if (sorted[i].offset !== acc) return null;
            acc += sorted[i].data.length;
        }
        return acc === TEMPLATE_B64 ? sorted : null;
    }
    function clearTemplate() {
        if (busy) throw new Error('Installer busy');
        template = { id: null, chunks: [] };
    }
    function decodeBase64(chunk, out, at) {
        var stop = chunk.length;
        while (stop && chunk[stop - 1] === '=') stop--;
        var pad = chunk.length - stop;
        for (var i = 0; i < stop; i += 4) {
            var quad =
                (B64MAP[chunk[i]] << 18) |
                (B64MAP[chunk[i + 1]] << 12) |
                (B64MAP[chunk[i + 2]] << 6) |
                B64MAP[chunk[i + 3]];
            var complete = i + 4 >= stop;
            out[at++] = (quad >> 16) & 255;
            if (!complete) {
                out[at++] = (quad >> 8) & 255;
                out[at++] = quad & 255;
            } else {
                if (pad < 2) out[at++] = (quad >> 8) & 255;
                if (pad < 1) out[at++] = quad & 255;
            }
        }
        return at;
    }
    async function stagedTemplate() {
        var sorted = templateChunks();
        if (!sorted) throw new Error('Template incomplete or missing');
        var out = new Uint8Array(TEMPLATE_BYTES),
            at = 0;
        for (var i = 0; i < sorted.length; i++)
            at = decodeBase64(sorted[i].data, out, (sorted[i].offset / 4) * 3);
        if (at !== TEMPLATE_BYTES) throw new Error('Unexpected template size');
        var digest = await codec.sha256Async(out);
        if (digest !== TEMPLATE_SHA256)
            throw new Error('Template fingerprint invalid');
        return out;
    }
    function stageChunk(id, index, offset, data) {
        if (busy || disposed) throw new Error('Installer busy or closed');
        if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(id))
            throw new Error('Invalid transfer identifier');
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index > offset + 1 ||
            !Number.isInteger(offset) ||
            offset < 0 ||
            offset % 4 ||
            offset > TEMPLATE_B64
        )
            throw new Error('Template chunk invalid');
        if (
            typeof data !== 'string' ||
            data.length % 4 ||
            data.length > MAX_CHUNK ||
            !/^[A-Za-z0-9+/]{4,}={0,2}$/.test(data) ||
            (data.indexOf('=') !== -1 && offset + data.length !== TEMPLATE_B64)
        )
            throw new Error('Base64 chunk invalid');
        if (offset + data.length > TEMPLATE_B64)
            throw new Error('Chunk out of template bounds');
        if (template.id !== id) template = { id: id, chunks: [] };
        for (var i = 0; i < template.chunks.length; i++) {
            if (template.chunks[i].index === index) {
                if (
                    template.chunks[i].offset === offset &&
                    template.chunks[i].data === data
                )
                    return templateProgress(); // Idempotent redelivery.
                throw new Error('Conflicting chunk: ' + index);
            }
            if (template.chunks[i].offset === offset)
                throw new Error('Overlapping chunks: ' + offset);
        }
        template.chunks.push({ index: index, offset: offset, data: data });
        return templateProgress();
    }
    // Prepare in RAM, delete the old trigger, write the new one, commit once.
    async function operate(publish, staged) {
        if (busy || disposed) throw new Error('Installer busy or closed');
        busy = true;
        state(publish ? 'Installing…' : 'Preparing save…');
        try {
            return await options.exclusive(async function () {
                if (!image) throw new Error('No image ready');
                var fs = options.openFS();
                try {
                    var source = staged
                        ? await stagedTemplate()
                        : await fs.read(sourcePath);
                    var candidate = codec.replace(
                        source,
                        image.stage,
                        image.triggerTiming,
                        image.hideTriggerText
                    );
                    var report = { bytes: candidate.length };
                    if (!publish) return report;
                    if (fs.exists(sourcePath)) fs.delete(sourcePath);
                    await fs.writeNew(sourcePath, candidate);
                    fs.commit();
                    installed = true;
                    state('Installed. Restart the game, then open Load Game menu.');
                    return report;
                } finally {
                    fs.dispose();
                }
            });
        } catch (error) {
            state('Failure: ' + error.message);
            throw error;
        } finally {
            busy = false;
            state(lastMessage);
        }
    }
    async function survey() {
        if (busy || disposed) throw new Error('Installer busy or closed');
        return await options.exclusive(async function () {
            var fs = options.openFS();
            try {
                family = fs.exists(sourcePath) ? 'existing' : 'absent';
                return {
                    family: family,
                    staged: !!templateChunks(),
                    stagedId: template.id
                };
            } finally {
                fs.dispose();
            }
        });
    }
    state('Installer unavailable: no image prepared');
    return {
        offer: offer,
        inspect: function () {
            return operate(false, false);
        },
        install: function () {
            return operate(true, false);
        },
        stageChunk: stageChunk,
        clearTemplate: clearTemplate,
        templateProgress: templateProgress,
        installFromTemplate: function () {
            if (disposed) throw new Error('Installer closed');
            if (!templateChunks())
                throw new Error('Template incomplete or missing');
            return operate(true, true).then(
                function (report) {
                    clearTemplate();
                    return report;
                },
                function (error) {
                    throw error;
                } // Keep staged template for retry.
            );
        },
        survey: survey,
        description: function () {
            return description({});
        },
        busy: function () {
            return busy;
        },
        dispose: function () {
            disposed = true;
            image = null;
            clearTemplate();
        }
    };
};
