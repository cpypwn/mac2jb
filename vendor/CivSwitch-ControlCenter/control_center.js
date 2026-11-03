(async function civ7ControlCenter() {
    "use strict";

    if (typeof window.__canCommanderStop === "function") {
        try { window.__canCommanderStop(); } catch (_) {}
    }
    if (typeof window.__controllerMenuStop === "function") {
        try { window.__controllerMenuStop(); } catch (_) {}
    }
    if (typeof window.__controlCenterStop === "function") {
        try { window.__controlCenterStop(); } catch (_) {}
    }

    var WIDTH = 1280;
    var HEIGHT = 720;
    var RUN_MS = 30 * 60 * 1000;
    var STATUS_START = 0;
    var STATUS_HOLD = 3;
    var running = true;
    var startedAt = Date.now();
    var selectedModule = 0;
    var contentIndex = 0;
    var focusArea = "SIDEBAR";
    var lastMoveAt = 0;
    var lastEventKey = "";
    var lastEventAt = 0;
    var animationId = 0;
    var autoExitTimer = 0;
    var refreshTimer = 0;
    var inputSubscription = null;
    var inputContextToken = {owner: "civswitch-control-center"};
    var padButtons = [];
    var padAxisDirection = 0;
    var currentContext = "SHELL";
    var currentDevice = "CONTROLLER";
    var lastAction = "WAITING FOR INPUT";
    var lastStatus = 0;
    var lastX = 0;
    var lastY = 0;
    var notice = "READY";
    var noticeColor = "#51f59a";
    var saveEntries = [];
    var saveError = "";
    var mods = [];
    var modError = "";
    var refreshCount = 0;
    var selfTestPassed = false;
    var terminalActive = false;
    var terminalLines = [];
    var exportRunning = false;
    var exportProgress = 0;
    var exportBytes = 0;
    var exportSize = 0;
    var exportChunks = 0;
    var exportExpectedChunks = 0;
    var lastExport = "NOT RUN";
    var payloadModeActive = false;
    var payloadStageState = "IDLE";
    var payloadStageName = "NO PAYLOAD";
    var payloadStageSize = 0;
    var payloadStageReceived = 0;
    var payloadStageChunk = 0;
    var payloadStageChunks = 0;
    var payloadStageSha256 = "";
    var payloadStageAutostart = false;
    var payloadCodeChunks = [];
    var payloadDecisionSubscription = null;
    var payloadDecisionKeyHandler = null;
    var instanceToken = {createdAt: Date.now()};
    var lifetimeResolve = null;
    var lifetime = new Promise(function (resolve) { lifetimeResolve = resolve; });
    var embeddedFontBase64 = "";
    var embeddedFontAtlasBase64 = "";
    var vectorFontData = "";
    var embeddedFontStyle = null;
    var vectorFontReady = false;
    var vectorOutlineReady = typeof vectorFontData === "object" && vectorFontData && vectorFontData.g && vectorFontData.g.A;
    var fontAtlas = null;
    var fontAtlasReady = false;
    var tintedAtlasCache = {};

    var live = {
        ip: "UNKNOWN",
        connected: false,
        authenticated: false,
        websocket: typeof WebSocket === "function",
        localStorage: typeof localStorage === "object",
        touch: false,
        keyboard: false,
        rumble: false,
        graphicsProfile: "UNKNOWN",
        masterVolume: 0,
        loaderPort: 9026
    };

    var modules = [
        {name: "HOME", subtitle: ""},
        {name: "SAVE EXTRACTOR", subtitle: "READ-ONLY EXPORT"},
        {name: "SAVE BROWSER", subtitle: "READ-ONLY FILES"},
        {name: "INSTALLED CONTENT", subtitle: "MOD METADATA"},
        {name: "INPUT MONITOR", subtitle: "CONTROLLER EVENTS"},
        {name: "PAYLOAD MODE", subtitle: "STAGED PAYLOAD TRANSPORT"},
        {name: "ABOUT", subtitle: "PROJECT INFORMATION"}
    ];

    var homeActions = [
        "EXTRACT CURRENT SAVE",
        "BROWSE SAVE FILES",
        "VIEW INSTALLED CONTENT",
        "OPEN INPUT MONITOR",
        "OPEN PAYLOAD MODE",
        "CLOSE CONTROL CENTER"
    ];
    var homeActionValues = ["EXPORT", "BROWSE", "VIEW", "OPEN", "RECEIVE", "EXIT"];

    var actionMap = [
        ["ACCEPT", "9"], ["CANCEL", "14"], ["NAV DOWN", "31"], ["NAV LEFT", "32"],
        ["NAV RIGHT", "36"], ["NAV UP", "39"], ["NAV NEXT", "34"], ["NAV PREVIOUS", "35"],
        ["SYSTEM MENU", "63"], ["TOGGLE CHAT", "64"], ["RADIAL MENU", "68"], ["TOOLTIP", "70"]
    ];

    var C = {
        bg: "#050a0f", panel: "#09131b", panel2: "#0e1a24", line: "#1d3a4c",
        text: "#e7f2f7", muted: "#8eb0c0", cyan: "#39dcff", green: "#62f5a5",
        amber: "#ffca58", red: "#e60012", white: "#ffffff", blue: "#2d7fff"
    };

    var FONT = {
        " ":["00000","00000","00000","00000","00000","00000","00000"],
        "A":["01110","10001","10001","11111","10001","10001","10001"],
        "B":["11110","10001","10001","11110","10001","10001","11110"],
        "C":["01111","10000","10000","10000","10000","10000","01111"],
        "D":["11110","10001","10001","10001","10001","10001","11110"],
        "E":["11111","10000","10000","11110","10000","10000","11111"],
        "F":["11111","10000","10000","11110","10000","10000","10000"],
        "G":["01111","10000","10000","10111","10001","10001","01111"],
        "H":["10001","10001","10001","11111","10001","10001","10001"],
        "I":["11111","00100","00100","00100","00100","00100","11111"],
        "J":["00111","00010","00010","00010","10010","10010","01100"],
        "K":["10001","10010","10100","11000","10100","10010","10001"],
        "L":["10000","10000","10000","10000","10000","10000","11111"],
        "M":["10001","11011","10101","10101","10001","10001","10001"],
        "N":["10001","11001","10101","10011","10001","10001","10001"],
        "O":["01110","10001","10001","10001","10001","10001","01110"],
        "P":["11110","10001","10001","11110","10000","10000","10000"],
        "Q":["01110","10001","10001","10001","10101","10010","01101"],
        "R":["11110","10001","10001","11110","10100","10010","10001"],
        "S":["01111","10000","10000","01110","00001","00001","11110"],
        "T":["11111","00100","00100","00100","00100","00100","00100"],
        "U":["10001","10001","10001","10001","10001","10001","01110"],
        "V":["10001","10001","10001","10001","10001","01010","00100"],
        "W":["10001","10001","10001","10101","10101","10101","01010"],
        "X":["10001","10001","01010","00100","01010","10001","10001"],
        "Y":["10001","10001","01010","00100","00100","00100","00100"],
        "Z":["11111","00001","00010","00100","01000","10000","11111"],
        "0":["01110","10001","10011","10101","11001","10001","01110"],
        "1":["00100","01100","00100","00100","00100","00100","01110"],
        "2":["01110","10001","00001","00010","00100","01000","11111"],
        "3":["11110","00001","00001","01110","00001","00001","11110"],
        "4":["00010","00110","01010","10010","11111","00010","00010"],
        "5":["11111","10000","10000","11110","00001","00001","11110"],
        "6":["01110","10000","10000","11110","10001","10001","01110"],
        "7":["11111","00001","00010","00100","01000","01000","01000"],
        "8":["01110","10001","10001","01110","10001","10001","01110"],
        "9":["01110","10001","10001","01111","00001","00001","01110"],
        "|":["00100","00100","00100","00100","00100","00100","00100"],
        "/":["00001","00010","00010","00100","01000","01000","10000"],
        ".":["00000","00000","00000","00000","00000","00110","00110"],
        ",":["00000","00000","00000","00000","00110","00110","00100"],
        ":":["00000","00110","00110","00000","00110","00110","00000"],
        "-":["00000","00000","00000","11111","00000","00000","00000"],
        "_":["00000","00000","00000","00000","00000","00000","11111"],
        "%":["11001","11010","00100","01000","10110","00110","00000"],
        "+":["00000","00100","00100","11111","00100","00100","00000"],
        "=":["00000","00000","11111","00000","11111","00000","00000"],
        "?":["01110","10001","00001","00010","00100","00000","00100"],
        "(":["00010","00100","01000","01000","01000","00100","00010"],
        ")":["01000","00100","00010","00010","00010","00100","01000"],
        "#":["01010","11111","01010","01010","11111","01010","00000"],
        "@":["01110","10001","10111","10101","10111","10000","01110"]
    };

    var canvas = document.createElement("canvas");
    canvas.id = "civswitch-control-center";
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.position = "fixed";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100vw";
    canvas.style.height = "100vh";
    canvas.style.zIndex = "2147483647";
    canvas.style.pointerEvents = "auto";
    document.body.appendChild(canvas);
    var ctx = canvas.getContext("2d");

    async function loadFontAtlas() {
        if (!embeddedFontAtlasBase64 || embeddedFontAtlasBase64.length < 1000) return false;
        try {
            fontAtlas = new Image();
            await Promise.race([
                new Promise(function (resolve, reject) {
                    fontAtlas.onload = resolve;
                    fontAtlas.onerror = reject;
                    fontAtlas.src = "data:image/png;base64," + embeddedFontAtlasBase64;
                }),
                new Promise(function (_, reject) {
                    setTimeout(function () { reject(new Error("font atlas timeout")); }, 1500);
                })
            ]);
            fontAtlasReady = fontAtlas.width === 288 && fontAtlas.height === 1024;
        } catch (_) {
            fontAtlasReady = false;
        }
        return fontAtlasReady;
    }

    async function loadEmbeddedFont() {
        if (!embeddedFontBase64 || embeddedFontBase64.length < 1000) return false;
        try {
            embeddedFontStyle = document.createElement("style");
            embeddedFontStyle.textContent = "@font-face{font-family:'CivSwitchUI';src:url(data:application/font-woff;base64," + embeddedFontBase64 + ") format('woff');font-weight:400;font-style:normal;}";
            (document.head || document.documentElement).appendChild(embeddedFontStyle);
            if (document.fonts && typeof document.fonts.load === "function") {
                await Promise.race([
                    document.fonts.load("16px CivSwitchUI"),
                    new Promise(function (resolve) { setTimeout(resolve, 1000); })
                ]);
            } else {
                await new Promise(function (resolve) { setTimeout(resolve, 250); });
            }
            ctx.font = "16px CivSwitchUI";
            var narrow = ctx.measureText("IIII").width;
            var wide = ctx.measureText("WWWW").width;
            vectorFontReady = wide > narrow * 1.35;
        } catch (_) {
            vectorFontReady = false;
        }
        return vectorFontReady;
    }

    function vectorSize(size) {
        if (size <= 11) return size + 3;
        if (size <= 20) return size + 2;
        return size + 1;
    }

    function atlasMetrics(size) {
        var fontPixels = vectorSize(size);
        var scale = fontPixels / 24;
        return {
            advance: fontPixels * 0.64,
            cellWidth: 18 * scale,
            cellHeight: 32 * scale,
            baseline: 26 * scale
        };
    }

    function atlasBand(color) {
        var value = String(color || C.text).toLowerCase();
        var bands = {
            "#e7f2f7": 0, "#8eb0c0": 1, "#39dcff": 2, "#62f5a5": 3,
            "#ffca58": 4, "#e60012": 5, "#ffffff": 6, "#2d7fff": 7
        };
        return Object.prototype.hasOwnProperty.call(bands, value) ? bands[value] : 0;
    }

    function tintedAtlas(color) {
        var key = String(color || C.text).toLowerCase();
        if (tintedAtlasCache[key]) return tintedAtlasCache[key];
        var tinted = document.createElement("canvas");
        tinted.width = 288;
        tinted.height = 128;
        var tintedContext = tinted.getContext("2d");
        // Gameface preserves the PNG alpha mask but decodes its RGB channels as
        // black. Re-color the first atlas band on an offscreen canvas so only
        // the reliable alpha channel crosses the image-decoder boundary.
        tintedContext.drawImage(fontAtlas, 0, 0, 288, 128, 0, 0, 288, 128);
        tintedContext.globalCompositeOperation = "source-in";
        tintedContext.fillStyle = key;
        tintedContext.fillRect(0, 0, 288, 128);
        tintedContext.globalCompositeOperation = "source-over";
        tintedAtlasCache[key] = tinted;
        return tinted;
    }

    function bitmapScale(size) {
        return {sx: size / 10, sy: size / 8};
    }

    function outlineMetrics(value, size) {
        var stringValue = String(value).toUpperCase();
        var scale = vectorSize(size) / vectorFontData.u;
        var units = 0;
        for (var i = 0; i < stringValue.length; i++) {
            var glyph = vectorFontData.g[stringValue.charAt(i)] || vectorFontData.g["?"];
            units += glyph.a;
        }
        return {scale: scale, width: units * scale};
    }

    function outlineText(value, x, y, size, color, align) {
        var stringValue = String(value).toUpperCase();
        var metrics = outlineMetrics(stringValue, size);
        var start = x;
        if (align === "center") start -= metrics.width / 2;
        else if (align === "right") start -= metrics.width;
        ctx.save();
        ctx.fillStyle = color || C.text;
        ctx.translate(start, y);
        ctx.scale(metrics.scale, -metrics.scale);
        for (var i = 0; i < stringValue.length; i++) {
            var glyph = vectorFontData.g[stringValue.charAt(i)] || vectorFontData.g["?"];
            ctx.beginPath();
            for (var j = 0; j < glyph.p.length; j++) {
                var command = glyph.p[j];
                if (command[0] === "M") ctx.moveTo(command[1], command[2]);
                else if (command[0] === "L") ctx.lineTo(command[1], command[2]);
                else if (command[0] === "C") ctx.bezierCurveTo(command[1], command[2], command[3], command[4], command[5], command[6]);
                else if (command[0] === "Z") ctx.closePath();
            }
            ctx.fill();
            ctx.translate(glyph.a, 0);
        }
        ctx.restore();
    }

    function rect(x, y, w, h, fill, stroke, lineWidth) {
        if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); }
        if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lineWidth || 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }
    }

    function roundedRect(x, y, w, h, radius, fill, stroke, lineWidth) {
        rect(x, y, w, h, fill, stroke, lineWidth);
    }

    function measure(value, size) {
        var stringValue = String(value).toUpperCase();
        if (vectorOutlineReady) return outlineMetrics(stringValue, size).width;
        if (fontAtlasReady) {
            var atlas = atlasMetrics(size);
            return Math.max(0, stringValue.length * atlas.advance);
        }
        if (vectorFontReady) {
            ctx.save();
            ctx.font = vectorSize(size) + "px CivSwitchUI";
            var vectorWidth = ctx.measureText(stringValue).width;
            ctx.restore();
            return vectorWidth;
        }
        var sx = bitmapScale(size).sx;
        return Math.max(0, stringValue.length * sx * 6 - sx);
    }

    function text(value, x, y, size, color, align) {
        var stringValue = String(value).toUpperCase();
        if (vectorOutlineReady) {
            outlineText(stringValue, x, y, size, color, align);
            return;
        }
        if (fontAtlasReady) {
            var atlas = atlasMetrics(size);
            var atlasWidth = measure(stringValue, size);
            var atlasCursor = x;
            if (align === "center") atlasCursor -= atlasWidth / 2;
            else if (align === "right") atlasCursor -= atlasWidth;
            var atlasTop = y - atlas.baseline;
            var coloredAtlas = tintedAtlas(color);
            var inset = (atlas.cellWidth - atlas.advance) / 2;
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            for (var atlasIndex = 0; atlasIndex < stringValue.length; atlasIndex++) {
                var codepoint = stringValue.charCodeAt(atlasIndex);
                if (codepoint < 32 || codepoint > 95) codepoint = 63;
                var glyphIndex = codepoint - 32;
                var sourceColumn = glyphIndex % 16;
                var sourceRow = Math.floor(glyphIndex / 16);
                ctx.drawImage(
                    coloredAtlas,
                    sourceColumn * 18,
                    sourceRow * 32,
                    18,
                    32,
                    atlasCursor - inset,
                    atlasTop,
                    atlas.cellWidth,
                    atlas.cellHeight
                );
                atlasCursor += atlas.advance;
            }
            ctx.restore();
            return;
        }
        if (vectorFontReady) {
            ctx.save();
            ctx.font = vectorSize(size) + "px CivSwitchUI";
            ctx.textBaseline = "alphabetic";
            ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
            ctx.fillStyle = color || C.text;
            ctx.fillText(stringValue, x, y);
            ctx.restore();
            return;
        }
        var bitmap = bitmapScale(size);
        var sx = bitmap.sx;
        var sy = bitmap.sy;
        var advance = sx * 6;
        var width = measure(stringValue, size);
        var cursor = x;
        if (align === "center") cursor -= width / 2;
        else if (align === "right") cursor -= width;
        var top = Math.round(y - sy * 7);
        ctx.fillStyle = color || C.text;
        for (var i = 0; i < stringValue.length; i++) {
            var glyph = FONT[stringValue.charAt(i)] || FONT["?"];
            for (var row = 0; row < 7; row++) {
                var bits = glyph[row];
                var runStart = -1;
                for (var col = 0; col <= 5; col++) {
                    var isSet = col < 5 && bits.charAt(col) === "1";
                    if (isSet && runStart < 0) runStart = col;
                    if (!isSet && runStart >= 0) {
                        // Snap every bitmap edge to the physical canvas grid.
                        // Fractional, undersized cells made 8-10 px text look
                        // dotted after HDMI scaling; full snapped cells stay
                        // solid while preserving the same compact glyph widths.
                        var left = Math.round(cursor + runStart * sx);
                        var right = Math.round(cursor + col * sx);
                        var glyphTop = Math.round(top + row * sy);
                        var glyphBottom = Math.round(top + (row + 1) * sy);
                        ctx.fillRect(left, glyphTop, Math.max(1, right - left), Math.max(1, glyphBottom - glyphTop));
                        runStart = -1;
                    }
                }
            }
            cursor += advance;
        }
    }

    function wrapped(value, x, y, maxChars, size, color, lineHeight, maxLines) {
        var words = String(value).toUpperCase().split(" ");
        var line = "";
        var lines = [];
        for (var i = 0; i < words.length; i++) {
            var candidate = line ? line + " " + words[i] : words[i];
            if (candidate.length > maxChars && line) { lines.push(line); line = words[i]; }
            else line = candidate;
        }
        if (line) lines.push(line);
        if (maxLines) lines = lines.slice(0, maxLines);
        for (var j = 0; j < lines.length; j++) text(lines[j], x, y + j * lineHeight, size, color);
    }

    function safeCall(object, name, fallback) {
        try {
            if (!object || typeof object[name] !== "function") return fallback;
            return object[name]();
        } catch (_) { return fallback; }
    }

    function setNotice(value, color) {
        notice = String(value);
        noticeColor = color || C.green;
    }

    function updateDeviceInfo() {
        try {
            var context = Input.getActiveContext();
            currentContext = ["INVALID", "SHELL", "WORLD", "UNIT", "PANEL"][context] || String(context);
        } catch (_) { currentContext = "UNKNOWN"; }
        try {
            var device = Input.getActiveDeviceType();
            currentDevice = ["KEYBOARD", "MOUSE", "CONTROLLER", "XR", "TOUCH"][device] || String(device);
        } catch (_) { currentDevice = "UNKNOWN"; }
    }

    function updateLive() {
        updateDeviceInfo();
        try { live.ip = get_current_ip() || "NO ROUTE"; } catch (_) { live.ip = "UNKNOWN"; }
        live.connected = Boolean(safeCall(window.Network, "isConnectedToNetwork", false));
        live.authenticated = Boolean(safeCall(window.Network, "isAuthenticated", false));
        live.touch = Boolean(safeCall(window.UI, "isTouchEnabled", false));
        live.keyboard = Boolean(safeCall(window.UI, "canDisplayKeyboard", false));
        live.rumble = Boolean(safeCall(window.UI, "isRumbleAvailable", false));
        live.graphicsProfile = String(safeCall(window.UI, "getCurrentGraphicsProfile", "UNKNOWN"));
        live.masterVolume = Number(safeCall(window.Sound, "volumeGetMaster", 0));
        refreshCount++;
    }

    function formatBytes(value) {
        var number = Number(value || 0);
        if (number >= 1024 * 1024) return (number / (1024 * 1024)).toFixed(1) + " MB";
        if (number >= 1024) return (number / 1024).toFixed(1) + " KB";
        return number + " B";
    }

    function loadSaveEntries() {
        var F_OpenDir = sdk_base + 0xa7bb0n;
        var F_ReadDir = sdk_base + 0xa5840n;
        var F_CloseDir = sdk_base + 0xa57b0n;
        var BATCH = 32;
        var handleOut = 0n;
        var countOut = 0n;
        var pathBuffer = 0n;
        var entryBuffer = 0n;
        var handle = null;
        saveEntries = [];
        saveError = "";
        try {
            handleOut = malloc(8);
            countOut = malloc(8);
            pathBuffer = malloc(0x400);
            entryBuffer = malloc(0x310 * BATCH);
            if (!handleOut || !countOut || !pathBuffer || !entryBuffer) throw new Error("ALLOCATION FAILED");
            var path = "save:/saves";
            var encoded = text_encode(path);
            for (var i = 0; i < encoded.length; i++) write8(pathBuffer + BigInt(i), BigInt(encoded[i]));
            write8(pathBuffer + BigInt(encoded.length), 0n);
            var openResult = BigInt.asUintN(32, call_rop(F_OpenDir, handleOut, pathBuffer, 3n));
            if (openResult !== 0n) throw new Error("OPEN 0X" + openResult.toString(16));
            handle = read64(handleOut);
            write64(countOut, 0n);
            var readResult = BigInt.asUintN(32, call_rop(F_ReadDir, countOut, entryBuffer, handle, BigInt(BATCH)));
            if (readResult !== 0n) throw new Error("READ 0X" + readResult.toString(16));
            var count = Math.min(Number(read64(countOut)), BATCH);
            for (var entryIndex = 0; entryIndex < count; entryIndex++) {
                var entry = entryBuffer + BigInt(entryIndex * 0x310);
                var name = "";
                for (var k = 0; k < 0x300; k++) {
                    var character = Number(read8(entry + BigInt(k)));
                    if (character === 0) break;
                    if (name.length < 60) name += String.fromCharCode(character);
                }
                saveEntries.push({
                    name: name || "UNNAMED",
                    type: Number(read32(entry + 0x304n) & 0xffn),
                    size: Number(read64(entry + 0x308n))
                });
            }
            setNotice("SAVE DIRECTORY REFRESHED", C.green);
        } catch (error) {
            saveError = String(error.message || error);
            setNotice("SAVE SCAN ERROR", C.red);
        } finally {
            if (handle !== null) {
                try { call_rop(F_CloseDir, handle); } catch (_) {}
            }
            if (entryBuffer) free(entryBuffer);
            if (pathBuffer) free(pathBuffer);
            if (countOut) free(countOut);
            if (handleOut) free(handleOut);
        }
    }

    function terminalAdd(message, color) {
        terminalLines.push({text: String(message), color: color || C.text});
        if (terminalLines.length > 18) terminalLines.shift();
        render();
    }

    function delay(milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
    }

    function saveDumpEmit(kind, data) {
        return log("SAVE_DUMP|" + kind + "|" + JSON.stringify(data));
    }

    function fsResultCode(value) {
        return "0x" + BigInt.asUintN(32, value).toString(16).padStart(8, "0");
    }

    function writeFsPath(buffer, path) {
        var encoded = text_encode(path);
        if (encoded.length >= 0x400) throw new Error("path too long");
        for (var i = 0; i < encoded.length; i++) write8(buffer + BigInt(i), BigInt(encoded[i]));
        write8(buffer + BigInt(encoded.length), 0n);
    }

    function readFsName(entry) {
        var name = "";
        for (var i = 0; i < 0x300; i++) {
            var value = Number(read8(entry + BigInt(i)));
            if (value === 0) break;
            name += String.fromCharCode(value);
        }
        return name;
    }

    function hexChunk(buffer, length) {
        var output = "";
        for (var i = 0; i < length; i++) {
            output += Number(read8(buffer + BigInt(i))).toString(16).padStart(2, "0");
        }
        return output;
    }

    function findExportTargetSize(directory, name) {
        var F_OpenDir = sdk_base + 0xa7bb0n;
        var F_ReadDir = sdk_base + 0xa5840n;
        var F_CloseDir = sdk_base + 0xa57b0n;
        var BATCH = 16;
        var handleOut = malloc(8);
        var countOut = malloc(8);
        var pathBuffer = malloc(0x400);
        var entries = malloc(0x310 * BATCH);
        var handle = null;
        try {
            writeFsPath(pathBuffer, directory);
            var openResult = BigInt.asUintN(32, call_rop(F_OpenDir, handleOut, pathBuffer, 3n));
            if (openResult !== 0n) throw new Error("OpenDir failed " + fsResultCode(openResult));
            handle = read64(handleOut);
            for (;;) {
                write64(countOut, 0n);
                var readResult = BigInt.asUintN(32, call_rop(F_ReadDir, countOut, entries, handle, BigInt(BATCH)));
                if (readResult !== 0n) throw new Error("ReadDir failed " + fsResultCode(readResult));
                var count = Number(read64(countOut));
                if (count <= 0) break;
                for (var i = 0; i < count; i++) {
                    var entry = entries + BigInt(i * 0x310);
                    var type = Number(read32(entry + 0x304n) & 0xffn);
                    if (type === 1 && readFsName(entry) === name) {
                        var size = read64(entry + 0x308n);
                        if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("file too large");
                        return Number(size);
                    }
                }
                if (count < BATCH) break;
            }
            throw new Error("target save not found");
        } finally {
            if (handle !== null) {
                try { call_rop(F_CloseDir, handle); } catch (_) {}
            }
            free(entries);
            free(pathBuffer);
            free(countOut);
            free(handleOut);
        }
    }

    async function runSaveExport() {
        if (exportRunning) return;
        var DIRECTORY = "save:/saves/Single";
        var NAME = "XSTRIG.Civ7Save";
        var PATH = DIRECTORY + "/" + NAME;
        var CHUNK_SIZE = 512;
        var F_OpenFile = sdk_base + 0xa78a0n;
        var F_CloseFile = sdk_base + 0xa5a70n;
        var F_ReadFile = sdk_base + 0xa5bf0n;
        var handleOut = 0n;
        var pathBuffer = 0n;
        var dataBuffer = 0n;
        var fileHandle = null;

        exportRunning = true;
        terminalActive = true;
        terminalLines = [];
        exportProgress = 0;
        exportBytes = 0;
        exportSize = 0;
        exportChunks = 0;
        exportExpectedChunks = 0;
        terminalAdd("SAVE EXPORT STARTED", C.cyan);
        terminalAdd("LOCATING ACTIVE SAVE");

        try {
            exportSize = findExportTargetSize(DIRECTORY, NAME);
            exportExpectedChunks = Math.ceil(exportSize / CHUNK_SIZE);
            terminalAdd("FOUND  " + NAME);
            terminalAdd("SIZE   " + formatBytes(exportSize));
            terminalAdd("MODE   READ ONLY", C.green);

            await saveDumpEmit("BEGIN", {
                version: 1,
                path: PATH,
                size: exportSize,
                chunk_size: CHUNK_SIZE,
                expected_chunks: exportExpectedChunks,
                policy: "directory lookup plus read-only OpenFile/ReadFile/CloseFile; no filesystem mutations"
            });

            handleOut = malloc(8);
            pathBuffer = malloc(0x400);
            dataBuffer = malloc(CHUNK_SIZE);
            writeFsPath(pathBuffer, PATH);
            var openResult = BigInt.asUintN(32, call_rop(F_OpenFile, handleOut, pathBuffer, 1n));
            if (openResult !== 0n) throw new Error("OpenFile failed " + fsResultCode(openResult));
            fileHandle = read64(handleOut);
            terminalAdd("STREAMING TO HOST", C.cyan);

            var offset = 0;
            while (offset < exportSize) {
                var length = Math.min(CHUNK_SIZE, exportSize - offset);
                var readResult = BigInt.asUintN(32, call_rop(F_ReadFile, fileHandle, BigInt(offset), dataBuffer, BigInt(length)));
                if (readResult !== 0n) throw new Error("ReadFile failed at " + offset + " " + fsResultCode(readResult));
                await log(
                    "SAVE_DUMP|CHUNK|" + offset.toString(16).padStart(16, "0") + "|" +
                    length + "|" + hexChunk(dataBuffer, length)
                );
                offset += length;
                exportChunks++;
                exportBytes = offset;
                exportProgress = exportSize ? offset / exportSize : 0;
                if (exportChunks === 1 || exportChunks % 32 === 0 || offset === exportSize) render();
            }

            await saveDumpEmit("END", {
                version: 1,
                bytes: exportSize,
                chunks: exportChunks,
                complete: exportBytes === exportSize && exportChunks === exportExpectedChunks
            });
            lastExport = formatBytes(exportSize) + " TRANSFERRED";
            terminalAdd("TRANSFER COMPLETE", C.green);
            terminalAdd("HOST VERIFYING BACKUP", C.green);
            await delay(2200);
            setNotice("SAVE EXPORT COMPLETE", C.green);
        } catch (error) {
            var message = String(error.message || error);
            try { await saveDumpEmit("ERROR", {message: message, stack: String(error.stack || "")}); } catch (_) {}
            lastExport = "FAILED";
            terminalAdd("EXPORT FAILED", C.red);
            terminalAdd(message.slice(0, 70), C.red);
            await delay(3200);
            setNotice("SAVE EXPORT FAILED", C.red);
        } finally {
            if (fileHandle !== null) {
                try { call_rop(F_CloseFile, fileHandle); } catch (_) {}
            }
            if (dataBuffer) free(dataBuffer);
            if (pathBuffer) free(pathBuffer);
            if (handleOut) free(handleOut);
            exportRunning = false;
            terminalActive = false;
            render();
        }
    }

    function clearPayloadDecisionInput() {
        if (payloadDecisionSubscription && typeof payloadDecisionSubscription.clear === "function") {
            try { payloadDecisionSubscription.clear(); } catch (_) {}
        }
        payloadDecisionSubscription = null;
        if (payloadDecisionKeyHandler) {
            window.removeEventListener("keydown", payloadDecisionKeyHandler, true);
            payloadDecisionKeyHandler = null;
        }
    }

    function suspendControlCenterForPayload() {
        if (animationId) cancelAnimationFrame(animationId);
        animationId = 0;
        if (autoExitTimer) clearTimeout(autoExitTimer);
        autoExitTimer = 0;
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = 0;
        if (inputSubscription && typeof inputSubscription.clear === "function") {
            try { inputSubscription.clear(); } catch (_) {}
        }
        inputSubscription = null;
        window.removeEventListener("navigate-input", onDomInput, true);
        window.removeEventListener("engine-input", onDomInput, true);
        window.removeEventListener("keydown", onKey, true);
        canvas.removeEventListener("mousedown", onPointer, true);
        canvas.removeEventListener("touchstart", onPointer, true);
        if (lifetimeResolve) {
            var resolveLifetime = lifetimeResolve;
            lifetimeResolve = null;
            resolveLifetime();
        }
    }

    async function resumeControlCenterFromPayload() {
        clearPayloadDecisionInput();
        payloadModeActive = false;
        payloadStageState = "IDLE";
        payloadCodeChunks = [];
        selectedModule = 0;
        contentIndex = 0;
        focusArea = "SIDEBAR";
        setNotice("READY", C.green);
        render();
        // Let the B release finish before restoring the Control Center's native
        // subscription so the same press cannot immediately close it again.
        await delay(300);
        lifetime = new Promise(function (resolve) { lifetimeResolve = resolve; });
        window.addEventListener("navigate-input", onDomInput, true);
        window.addEventListener("engine-input", onDomInput, true);
        window.addEventListener("keydown", onKey, true);
        canvas.addEventListener("mousedown", onPointer, true);
        canvas.addEventListener("touchstart", onPointer, true);
        if (window.engine && typeof engine.on === "function") {
            inputSubscription = engine.on("InputAction", onEngineInput, {owner: "civswitch-control-center-resumed", started: Date.now()});
        }
        autoExitTimer = setTimeout(stop, RUN_MS);
        refreshTimer = setInterval(function () { updateLive(); render(); }, 2000);
        animationId = requestAnimationFrame(frame);
        render();
        return lifetime;
    }

    async function startStagedPayload() {
        clearPayloadDecisionInput();
        payloadStageState = "RUNNING";
        renderPayloadMode();
        await delay(350);
        var stagedCode = payloadCodeChunks.join("");
        stop();
        var result = (0, eval)(stagedCode);
        await Promise.resolve(result);
        return {action: "started", name: payloadStageName};
    }

    function installPayloadDecisionInput(resolve, reject) {
        var settled = false;
        function decide(name, status) {
            if (settled || Number(status) !== STATUS_START) return;
            if (name === "accept") {
                settled = true;
                startStagedPayload().then(resolve, reject);
            } else if (name === "cancel" || name === "keyboard-escape") {
                settled = true;
                payloadStageState = "CANCELLED";
                renderPayloadMode();
                resumeControlCenterFromPayload().then(
                    function () { resolve({action: "back"}); },
                    reject
                );
            }
        }
        if (window.engine && typeof engine.on === "function") {
            payloadDecisionSubscription = engine.on("InputAction", decide, {owner: "civswitch-payload-decision", started: Date.now()});
        }
        payloadDecisionKeyHandler = function payloadKey(event) {
            if (settled) return;
            if (event.key === "Enter") decide("accept", STATUS_START);
            else if (event.key === "Escape") decide("cancel", STATUS_START);
        };
        window.addEventListener("keydown", payloadDecisionKeyHandler, true);
    }

    function createPayloadStageApi() {
        return {
            version: 1,
            begin: function (metadata) {
                if (!payloadModeActive) throw new Error("Payload Mode is not active");
                payloadStageName = String(metadata.name || "PAYLOAD").slice(0, 48);
                payloadStageSize = Number(metadata.bytes || 0);
                payloadStageReceived = 0;
                payloadStageChunk = 0;
                payloadStageChunks = Number(metadata.chunks || 0);
                payloadStageSha256 = String(metadata.sha256 || "");
                payloadStageAutostart = metadata.autostart === true;
                payloadCodeChunks = [];
                payloadStageState = "RECEIVING";
                renderPayloadMode();
                return {ready: true, version: 1};
            },
            append: function (chunk, progress) {
                if (payloadStageState !== "RECEIVING") throw new Error("Payload receiver is not active");
                payloadCodeChunks.push(String(chunk));
                payloadStageReceived = Number(progress.received || 0);
                payloadStageChunk = Number(progress.index || payloadCodeChunks.length);
                payloadStageChunks = Number(progress.chunks || payloadStageChunks);
                renderPayloadMode();
                return {received: payloadStageReceived, chunk: payloadStageChunk};
            },
            complete: function (metadata) {
                if (payloadStageState !== "RECEIVING") throw new Error("Payload receiver is not active");
                var characters = 0;
                for (var i = 0; i < payloadCodeChunks.length; i++) characters += payloadCodeChunks[i].length;
                if (characters !== Number(metadata.characters)) throw new Error("Payload character count mismatch");
                payloadStageReceived = payloadStageSize;
                payloadStageSha256 = String(metadata.sha256 || payloadStageSha256);
                payloadStageAutostart = metadata.autostart === true;
                payloadStageState = "READY";
                renderPayloadMode();
                if (payloadStageAutostart) return startStagedPayload();
                return new Promise(function (resolve, reject) {
                    installPayloadDecisionInput(resolve, reject);
                });
            },
            status: function () {
                return {
                    state: payloadStageState,
                    name: payloadStageName,
                    received: payloadStageReceived,
                    bytes: payloadStageSize,
                    chunk: payloadStageChunk,
                    chunks: payloadStageChunks,
                    autostart: payloadStageAutostart
                };
            }
        };
    }

    function enterPayloadMode() {
        if (payloadModeActive) return;
        payloadModeActive = true;
        payloadStageState = "WAITING";
        payloadStageName = "NO PAYLOAD";
        payloadStageSize = 0;
        payloadStageReceived = 0;
        payloadStageChunk = 0;
        payloadStageChunks = 0;
        payloadStageSha256 = "";
        payloadStageAutostart = false;
        payloadCodeChunks = [];
        window.__civPayloadStage = createPayloadStageApi();
        renderPayloadMode();
        suspendControlCenterForPayload();
    }

    function loadMods() {
        mods = [];
        modError = "";
        try {
            var values = Modding.getInstalledMods() || [];
            for (var i = 0; i < values.length; i++) {
                mods.push({
                    handle: Number(values[i].handle || 0),
                    id: String(values[i].id || "UNKNOWN"),
                    name: String(values[i].name || values[i].id || "UNKNOWN"),
                    enabled: values[i].enabled !== false,
                    official: values[i].official === true
                });
            }
            setNotice("MOD INVENTORY REFRESHED", C.green);
        } catch (error) {
            modError = String(error.message || error);
            setNotice("MOD SCAN ERROR", C.red);
        }
    }

    function refreshAll() {
        updateLive();
        loadSaveEntries();
        loadMods();
        setNotice("ALL STATUS REFRESHED", C.green);
    }

    function contentCount() {
        if (selectedModule === 0) return homeActions.length;
        if (selectedModule === 1) return 1;
        if (selectedModule === 2) return Math.max(1, saveEntries.length);
        if (selectedModule === 3) return Math.max(1, mods.length);
        if (selectedModule === 4) return actionMap.length;
        if (selectedModule === 5) return 1;
        if (selectedModule === 6) return 1;
        return 1;
    }

    function move(delta) {
        if (terminalActive) return;
        if (focusArea === "SIDEBAR") {
            selectedModule = (selectedModule + delta + modules.length) % modules.length;
            contentIndex = 0;
        } else {
            var count = contentCount();
            contentIndex = (contentIndex + delta + count) % count;
        }
    }

    function enterModule() {
        focusArea = "CONTENT";
        contentIndex = 0;
        if (selectedModule === 2 && saveEntries.length === 0) loadSaveEntries();
        if (selectedModule === 3 && mods.length === 0) loadMods();
    }

    function executeHomeAction(index) {
        if (index === 5) {
            stop();
            return;
        }
        selectedModule = index + 1;
        contentIndex = 0;
        focusArea = "CONTENT";
        if (selectedModule === 1) runSaveExport();
        else if (selectedModule === 2 && saveEntries.length === 0) loadSaveEntries();
        else if (selectedModule === 3 && mods.length === 0) loadMods();
        else if (selectedModule === 5) enterPayloadMode();
    }

    function activate() {
        if (focusArea === "SIDEBAR") {
            enterModule();
            return;
        }
        if (selectedModule === 0) executeHomeAction(contentIndex);
        else if (selectedModule === 1) runSaveExport();
        else if (selectedModule === 2 && saveEntries.length) {
            setNotice("READ-ONLY ENTRY SELECTED: " + saveEntries[contentIndex].name, C.cyan);
        } else if (selectedModule === 3 && mods.length) {
            setNotice("MOD SELECTED: " + mods[contentIndex].name, C.cyan);
        } else if (selectedModule === 5) {
            enterPayloadMode();
        } else if (selectedModule === 6) {
            setNotice("ABOUT CIVSWITCH", C.cyan);
        } else {
            updateLive();
        }
    }

    function goBack() {
        if (terminalActive || exportRunning) return;
        if (focusArea === "CONTENT") {
            focusArea = "SIDEBAR";
            contentIndex = 0;
        } else stop();
    }

    function consumeInput(source, name, status, x, y) {
        if (!running || !name) return;
        if (terminalActive) return;
        var now = Date.now();
        var eventKey = String(name) + ":" + String(status) + ":" + Number(x || 0).toFixed(2) + ":" + Number(y || 0).toFixed(2);
        if (eventKey === lastEventKey && now - lastEventAt < 50) return;
        lastEventKey = eventKey;
        lastEventAt = now;
        updateDeviceInfo();
        lastAction = source.toUpperCase() + " / " + String(name).toUpperCase();
        lastStatus = Number(status || 0);
        lastX = Number(x || 0);
        lastY = Number(y || 0);

        if (status !== STATUS_START && status !== STATUS_HOLD) { render(); return; }
        if ((name === "nav-up" || name === "nav-down" || name === "nav-move") && now - lastMoveAt < 140) {
            render();
            return;
        }
        if (name === "nav-up") { lastMoveAt = now; move(-1); }
        else if (name === "nav-down") { lastMoveAt = now; move(1); }
        else if (name === "nav-move") {
            if (Number(y) > 0.55) { lastMoveAt = now; move(-1); }
            else if (Number(y) < -0.55) { lastMoveAt = now; move(1); }
        } else if (name === "nav-left") {
            if (focusArea === "CONTENT") goBack();
        } else if (name === "nav-right") {
            if (focusArea === "SIDEBAR") enterModule();
        } else if (name === "nav-next" || name === "shell-next") {
            if (focusArea === "SIDEBAR") move(1);
        } else if (name === "nav-previous" || name === "shell-previous") {
            if (focusArea === "SIDEBAR") move(-1);
        } else if (name === "accept" && status === STATUS_START) activate();
        else if ((name === "cancel" || name === "keyboard-escape" || name === "mousebutton-right") && status === STATUS_START) goBack();
        if (running) render();
    }

    function onDomInput(event) {
        var detail = event && event.detail ? event.detail : {};
        consumeInput(event.type, detail.name, detail.status, detail.x, detail.y);
        try { event.preventDefault(); } catch (_) {}
        try { event.stopImmediatePropagation(); } catch (_) {
            try { event.stopPropagation(); } catch (__) {}
        }
    }

    function onEngineInput(name, status, x, y) {
        consumeInput("INPUTACTION", name, status, x, y);
    }

    function onKey(event) {
        if (event.key === "ArrowUp") consumeInput("KEYBOARD", "nav-up", STATUS_START, 0, 0);
        else if (event.key === "ArrowDown") consumeInput("KEYBOARD", "nav-down", STATUS_START, 0, 0);
        else if (event.key === "ArrowLeft") consumeInput("KEYBOARD", "nav-left", STATUS_START, 0, 0);
        else if (event.key === "ArrowRight") consumeInput("KEYBOARD", "nav-right", STATUS_START, 0, 0);
        else if (event.key === "Enter") consumeInput("KEYBOARD", "accept", STATUS_START, 0, 0);
        else if (event.key === "Escape") consumeInput("KEYBOARD", "cancel", STATUS_START, 0, 0);
    }

    function pointerPosition(event) {
        var source = event;
        if (event.touches && event.touches.length) source = event.touches[0];
        var bounds = canvas.getBoundingClientRect();
        return {
            x: (Number(source.clientX) - bounds.left) * WIDTH / bounds.width,
            y: (Number(source.clientY) - bounds.top) * HEIGHT / bounds.height
        };
    }

    function onPointer(event) {
        if (!running) return;
        var point;
        try { point = pointerPosition(event); } catch (_) { return; }
        if (point.x >= 26 && point.x <= 291 && point.y >= 145 && point.y < 145 + modules.length * 66) {
            selectedModule = Math.max(0, Math.min(modules.length - 1, Math.floor((point.y - 145) / 66)));
            focusArea = "CONTENT";
            contentIndex = 0;
            if (selectedModule === 2 && saveEntries.length === 0) loadSaveEntries();
            if (selectedModule === 3 && mods.length === 0) loadMods();
        } else if (focusArea === "CONTENT" && point.x >= 330) {
            var row = -1;
            var visibleStart = 0;
            if (selectedModule === 4 && point.y >= 370) {
                visibleStart = Math.max(0, Math.min(actionMap.length - 6, contentIndex - 2));
                row = visibleStart + Math.floor((point.y - 370) / 43);
            } else if ((selectedModule === 2 || selectedModule === 3) && point.y >= 238) {
                var listLength = selectedModule === 2 ? saveEntries.length : mods.length;
                visibleStart = Math.max(0, Math.min(listLength - 8, contentIndex - 3));
                row = visibleStart + Math.floor((point.y - 238) / 47);
            } else if (selectedModule === 0 && point.y >= 304) {
                row = Math.floor((point.y - 304) / 46);
            } else if ((selectedModule === 1 || selectedModule === 5) && point.y >= 380 && point.y < 440) {
                row = 0;
            }
            if (row >= 0 && row < contentCount()) {
                contentIndex = row;
                activate();
            }
        }
        try { event.preventDefault(); } catch (_) {}
        render();
    }

    function pollGamepads(now) {
        var getter = navigator.getGamepads || navigator.webkitGetGamepads;
        if (typeof getter !== "function") return;
        var pads;
        try { pads = getter.call(navigator) || []; } catch (_) { return; }
        var pad = null;
        for (var i = 0; i < pads.length; i++) {
            if (pads[i] && pads[i].connected !== false) { pad = pads[i]; break; }
        }
        if (!pad) return;
        function pressed(index) {
            var button = pad.buttons && pad.buttons[index];
            return !!(button && (button.pressed || Number(button.value || 0) > 0.5));
        }
        var buttonMap = [[12,"nav-up"],[13,"nav-down"],[14,"nav-left"],[15,"nav-right"],[0,"accept"],[1,"cancel"]];
        for (var b = 0; b < buttonMap.length; b++) {
            var index = buttonMap[b][0];
            var down = pressed(index);
            if (down && !padButtons[index]) consumeInput("GAMEPAD", buttonMap[b][1], STATUS_START, 0, 0);
            padButtons[index] = down;
        }
        var axisY = pad.axes && pad.axes.length > 1 ? Number(pad.axes[1]) : 0;
        var direction = axisY < -0.6 ? -1 : axisY > 0.6 ? 1 : 0;
        if (direction !== 0 && direction !== padAxisDirection && now - lastMoveAt >= 140) {
            consumeInput("GAMEPAD", direction < 0 ? "nav-up" : "nav-down", STATUS_START, 0, axisY);
        }
        padAxisDirection = direction;
    }

    function drawBackground() {
        var gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
        gradient.addColorStop(0, "#04090d");
        gradient.addColorStop(0.55, "#07131b");
        gradient.addColorStop(1, "#09202c");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.save();
        ctx.globalAlpha = 0.026;
        ctx.strokeStyle = C.cyan;
        ctx.lineWidth = 1;
        for (var gridX = 0; gridX <= WIDTH; gridX += 104) {
            ctx.beginPath(); ctx.moveTo(gridX + 0.5, 0); ctx.lineTo(gridX + 0.5, HEIGHT); ctx.stroke();
        }
        for (var gridY = 0; gridY <= HEIGHT; gridY += 78) {
            ctx.beginPath(); ctx.moveTo(0, gridY + 0.5); ctx.lineTo(WIDTH, gridY + 0.5); ctx.stroke();
        }
        ctx.globalAlpha = 0.075;
        for (var diagonalX = -760; diagonalX < WIDTH; diagonalX += 84) {
            ctx.beginPath();
            ctx.moveTo(diagonalX, HEIGHT);
            ctx.lineTo(diagonalX + 820, 0);
            ctx.stroke();
        }
        ctx.restore();
        rect(0, 0, WIDTH, 5, C.red);
    }

    function drawBadge(x, y, label, value, color, width) {
        roundedRect(x, y, width, 62, 8, "rgba(12,27,37,0.96)", C.line);
        text(label, x + 15, y + 21, 10, C.muted);
        text(value, x + 15, y + 49, 13, color || C.green);
    }

    function drawRow(y, label, value, active, valueColor) {
        roundedRect(345, y, 875, 42, 7, active ? "rgba(35,215,255,0.13)" : "rgba(14,29,39,0.88)", active ? C.cyan : C.line, active ? 2 : 1);
        if (active) roundedRect(345, y + 7, 4, 28, 2, C.cyan);
        text(label, 365, y + 27, 11, active ? C.white : C.text);
        text(value, 1198, y + 27, 10, valueColor || C.muted, "right");
    }

    function drawHeader(now) {
        text("CIVSWITCH CONTROL CENTER", 28, 48, 25, C.white);
        text("SYSTEM UTILITIES", 28, 76, 10, C.cyan);
        text("KUKANICH", 1252, 43, 10, C.white, "right");
        text("CAN BUS", 1252, 69, 10, C.cyan, "right");
        rect(28, 90, 1226, 1, C.line);
    }

    function drawSidebar() {
        roundedRect(26, 105, 275, 544, 11, "rgba(6,14,20,0.96)", C.line);
        text("TOOLS", 46, 130, 10, C.muted);
        for (var i = 0; i < modules.length; i++) {
            var y = 145 + i * 66;
            var active = i === selectedModule;
            var focused = active && focusArea === "SIDEBAR";
            roundedRect(43, y, 241, 54, 8, active ? "rgba(35,215,255,0.12)" : "rgba(14,29,39,0.82)", focused ? C.cyan : C.line, focused ? 2 : 1);
            roundedRect(56, y + 10, 35, 34, 7, active ? "rgba(35,215,255,0.18)" : "rgba(7,17,24,0.9)", active ? "rgba(57,220,255,0.6)" : C.line);
            text(String(i + 1).padStart(2, "0"), 73, y + 32, 10, active ? C.cyan : C.muted, "center");
            text(modules[i].name, 106, y + 34, 13, active ? C.white : C.text);
        }
    }

    function drawContentFrame() {
        roundedRect(319, 105, 935, 544, 11, "rgba(6,14,20,0.965)", focusArea === "CONTENT" ? "rgba(35,215,255,0.72)" : C.line, focusArea === "CONTENT" ? 2 : 1);
        text(modules[selectedModule].name, 344, 145, 20, C.white);
        if (modules[selectedModule].subtitle) text(modules[selectedModule].subtitle, 344, 170, 11, C.cyan);
        rect(344, 187, 885, 1, C.line);
    }

    function renderHome() {
        drawBadge(344, 211, "SAVE FILES", String(saveEntries.length), C.green, 270);
        drawBadge(626, 211, "INSTALLED CONTENT", String(mods.length), C.amber, 270);
        drawBadge(908, 211, "INPUT", currentDevice, C.cyan, 321);
        text("QUICK ACTIONS", 344, 289, 10, C.muted);
        for (var i = 0; i < homeActions.length; i++) {
            drawRow(304 + i * 46, homeActions[i], homeActionValues[i], focusArea === "CONTENT" && contentIndex === i, i === 5 ? C.amber : C.cyan);
        }
        text("LAST EXPORT", 344, 616, 10, C.muted);
        text(lastExport, 1229, 616, 10, lastExport === "FAILED" ? C.red : C.text, "right");
    }

    function renderSaveExtractor() {
        text("TARGET", 344, 220, 10, C.muted);
        text("SAVE / SAVES / SINGLE / XSTRIG.CIV7SAVE", 344, 250, 11, C.text);
        drawBadge(344, 286, "ACCESS", "READ ONLY", C.green, 270);
        drawBadge(626, 286, "LAST EXPORT", lastExport, lastExport === "FAILED" ? C.red : C.text, 603);
        drawRow(386, "START SAVE EXPORT", "RUN", focusArea === "CONTENT", C.cyan);
        text("OUTPUT", 344, 472, 10, C.muted);
        text("VERIFIED BACKUP ON CONNECTED HOST", 344, 502, 11, C.text);
        text("TRANSFER PROGRESS WILL REPLACE THIS SCREEN DURING EXPORT", 344, 558, 10, C.muted);
    }

    function renderDiagnostics() {
        var rows = [
            ["COHTML RUNTIME", "1.59.0.0"], ["SURFACE", "1280 X 720"],
            ["PAGE", "ROOT SHELL"], ["INPUT CONTEXT", currentContext],
            ["ACTIVE DEVICE", currentDevice], ["GRAPHICS PROFILE", live.graphicsProfile],
            ["WEBSOCKET", live.websocket ? "AVAILABLE" : "NO"], ["XMLHTTPREQUEST", "AVAILABLE"],
            ["LOCAL STORAGE", live.localStorage ? "AVAILABLE" : "NO"], ["CANVAS 2D", "DRAWING READY"],
            ["WEBASSEMBLY", "UNAVAILABLE"], ["WEBGL", "UNAVAILABLE"],
            ["BLUETOOTH", "DENIED 0X1015"], ["SERVICE ACCESS", "FSP BSD NIFM SSL HID AUDIO"]
        ];
        for (var i = 0; i < rows.length; i++) drawRow(211 + i * 29, rows[i][0], rows[i][1], false, rows[i][1].indexOf("DENIED") >= 0 ? C.amber : C.green);
    }

    function renderInput() {
        drawBadge(344, 211, "CONTEXT", currentContext, C.green, 202);
        drawBadge(558, 211, "DEVICE", currentDevice, C.cyan, 202);
        drawBadge(772, 211, "STATUS", String(lastStatus), C.amber, 202);
        drawBadge(986, 211, "RUMBLE", live.rumble ? "AVAILABLE" : "CONDITIONAL", live.rumble ? C.green : C.amber, 243);
        text("LAST EVENT", 344, 294, 10, C.muted);
        text(lastAction.slice(0, 72), 344, 319, 11, C.white);
        text("X " + lastX.toFixed(2) + "  Y " + lastY.toFixed(2), 1229, 319, 10, C.cyan, "right");
        text("SEMANTIC ACTION MAP", 344, 353, 10, C.muted);
        var start = Math.max(0, Math.min(actionMap.length - 6, contentIndex - 2));
        for (var i = 0; i < 6; i++) {
            var index = start + i;
            if (index >= actionMap.length) break;
            drawRow(370 + i * 43, actionMap[index][0], "ID " + actionMap[index][1], focusArea === "CONTENT" && index === contentIndex, C.cyan);
        }
        text("CONTROLLER EVENTS ARE READ ONLY", 344, 640, 10, C.muted);
    }

    function renderPayloadTool() {
        text("STAGED PAYLOAD RECEIVER", 344, 220, 13, C.white);
        wrapped(
            "RELEASES THE LOADER FOR A CHUNKED PAYLOAD TRANSFER WHILE KEEPING TRANSFER STATUS VISIBLE ON SCREEN.",
            344, 258, 72, 11, C.text, 24, 3
        );
        drawBadge(344, 328, "TRANSPORT", "TCP 9026", C.cyan, 270);
        drawBadge(626, 328, "START MODE", "PROMPT OR AUTO", C.green, 603);
        drawRow(424, "ENTER PAYLOAD MODE", "OPEN", focusArea === "CONTENT", C.cyan);
        text("AFTER ENTERING, RUN THE STAGED PAYLOAD SENDER ON THE HOST", 344, 510, 10, C.muted);
        text("A STARTS A RECEIVED PAYLOAD  /  B RETURNS HERE", 344, 548, 10, C.text);
    }

    function renderPayloadMode() {
        drawBackground();
        text("PAYLOAD MODE", 42, 58, 25, C.white);
        text("KUKANICH", 1238, 43, 10, C.white, "right");
        text("CAN BUS", 1238, 69, 10, C.cyan, "right");
        rect(42, 88, 1196, 1, C.line);
        rect(42, 116, 1196, 486, "rgba(5,12,17,0.97)", C.line);

        var stateColor = payloadStageState === "READY" ? C.green :
            payloadStageState === "RUNNING" ? C.amber :
            payloadStageState === "CANCELLED" ? C.muted : C.cyan;
        text("STATE", 70, 155, 10, C.muted);
        text(payloadStageState, 70, 187, 14, stateColor);

        if (payloadStageState === "WAITING") {
            text("WAITING FOR HOST", 70, 250, 18, C.white);
            text("THE LOADER IS READY TO RECEIVE A STAGED PAYLOAD", 70, 292, 11, C.text);
            text("HOST COMMAND", 70, 362, 10, C.muted);
            text("PYTHON3 CIVSWITCH / TOOLS / SEND_STAGED_PAYLOAD.PY", 70, 397, 11, C.cyan);
            text("ADD --AUTOSTART TO RUN IMMEDIATELY AFTER TRANSFER", 70, 435, 10, C.muted);
        } else {
            text("PAYLOAD", 70, 238, 10, C.muted);
            text(payloadStageName, 70, 270, 15, C.white);
            text("SIZE", 70, 314, 10, C.muted);
            text(formatBytes(payloadStageSize), 70, 345, 12, C.text);
            text("SHA256", 340, 314, 10, C.muted);
            text(payloadStageSha256.slice(0, 32), 340, 345, 10, C.text);
            text(payloadStageSha256.slice(32, 64), 340, 372, 10, C.text);

            var payloadProgress = payloadStageSize > 0 ? Math.min(1, payloadStageReceived / payloadStageSize) : 0;
            rect(70, 424, 1140, 24, C.panel2, C.line);
            if (payloadProgress > 0) rect(72, 426, Math.max(0, 1136 * payloadProgress), 20, C.cyan);
            text(formatBytes(payloadStageReceived) + " / " + formatBytes(payloadStageSize), 70, 480, 11, C.text);
            text(payloadStageChunk + " / " + payloadStageChunks + " CHUNKS", 1210, 480, 11, C.muted, "right");

            if (payloadStageState === "READY") {
                text("TRANSFER COMPLETE", 70, 538, 14, C.green);
                text(payloadStageAutostart ? "AUTOSTART ENABLED" : "A  START PAYLOAD     B  BACK TO CONTROL CENTER", 70, 575, 11, payloadStageAutostart ? C.amber : C.white);
            } else if (payloadStageState === "RUNNING") {
                text("STARTING PAYLOAD", 70, 548, 14, C.amber);
            } else {
                text("RECEIVING PAYLOAD", 70, 548, 14, C.cyan);
            }
        }

        rect(42, 636, 1196, 1, C.line);
        text(payloadStageState === "READY" && !payloadStageAutostart ? "A START     B BACK" : "DO NOT CLOSE THE GAME DURING TRANSFER", 42, 682, 11, payloadStageState === "READY" ? C.green : C.amber);
    }

    function renderSaveBrowser() {
        text("PATH  SAVE / SAVES", 344, 215, 10, C.cyan);
        text("OPEN / READ / CLOSE ONLY", 1229, 215, 10, C.green, "right");
        if (saveError) {
            wrapped("SAVE SCAN ERROR " + saveError, 344, 265, 72, 11, C.red, 24, 4);
            return;
        }
        if (!saveEntries.length) {
            text("NO ENTRIES REPORTED", 344, 265, 12, C.amber);
            return;
        }
        var start = Math.max(0, Math.min(saveEntries.length - 8, contentIndex - 3));
        for (var i = 0; i < 8; i++) {
            var index = start + i;
            if (index >= saveEntries.length) break;
            var entry = saveEntries[index];
            var type = entry.type === 0 ? "DIRECTORY" : formatBytes(entry.size);
            drawRow(238 + i * 47, entry.name, type, focusArea === "CONTENT" && index === contentIndex, entry.type === 1 ? C.cyan : C.green);
        }
        text(String(saveEntries.length) + " ENTRIES / READ-ONLY", 344, 628, 10, C.muted);
    }

    function renderModBrowser() {
        text("INSTALLED CONTENT", 344, 215, 10, C.cyan);
        text("METADATA ONLY", 1229, 215, 10, C.green, "right");
        if (modError) {
            wrapped("MOD SCAN ERROR " + modError, 344, 265, 72, 11, C.red, 24, 4);
            return;
        }
        if (!mods.length) {
            text("NO INSTALLED MODS REPORTED", 344, 265, 12, C.amber);
            return;
        }
        var start = Math.max(0, Math.min(mods.length - 8, contentIndex - 3));
        for (var i = 0; i < 8; i++) {
            var index = start + i;
            if (index >= mods.length) break;
            var mod = mods[index];
            var status = (mod.enabled ? "ENABLED" : "DISABLED") + (mod.official ? " / OFFICIAL" : " / USER");
            drawRow(238 + i * 47, mod.name, status, focusArea === "CONTENT" && index === contentIndex, mod.enabled ? C.green : C.amber);
        }
        text(String(mods.length) + " INSTALLED CONTENT MODULES", 344, 628, 10, C.muted);
    }

    function renderAbout() {
        text("CIVSWITCH CONTROL CENTER", 344, 220, 13, C.white);
        wrapped(
            "A CONTROLLER DRIVEN UTILITY PANEL FOR CIVILIZATION VII ON NINTENDO SWITCH 2.",
            344, 258, 72, 11, C.text, 24, 3
        );
        text("TOOLS", 344, 330, 10, C.muted);
        text("01  READ ONLY SAVE EXPORT AND HOST VERIFICATION", 344, 362, 11, C.text);
        text("02  SAVE DIRECTORY BROWSER", 344, 394, 11, C.text);
        text("03  INSTALLED CONTENT INVENTORY", 344, 426, 11, C.text);
        text("04  CONTROLLER INPUT MONITOR", 344, 458, 11, C.text);
        text("05  STAGED PAYLOAD TRANSPORT", 344, 490, 11, C.text);
        rect(344, 512, 885, 1, C.line);
        text("CREATED BY", 344, 544, 10, C.cyan);
        text("MATTHEW KUKANICH", 344, 575, 13, C.cyan);
        text("PLATFORM ANALYSIS ASSISTANCE", 760, 544, 10, C.muted);
        text("@RASTAPASTA", 760, 575, 13, C.cyan);
        text("SAVE ACCESS IS READ ONLY", 344, 625, 10, C.green);
    }

    function renderNetworkPayload() {
        drawBadge(344, 211, "LOCAL IP", live.ip, C.cyan, 270);
        drawBadge(626, 211, "LOADER", "TCP " + live.loaderPort, C.green, 180);
        drawBadge(818, 211, "90DNS", "VERIFIED", C.green, 180);
        drawBadge(1010, 211, "IPV6", "DISABLED", C.green, 219);
        text("CLOSE THIS OVERLAY BEFORE SENDING ANOTHER PAYLOAD", 344, 294, 10, C.muted);
        for (var i = 0; i < toolActions.length; i++) {
            drawRow(318 + i * 50, toolActions[i], i === 4 ? "EXIT" : "RUN", focusArea === "CONTENT" && i === contentIndex, i === 4 ? C.amber : C.cyan);
        }
        text("LAST PAYLOAD  CONTROL CENTER", 344, 598, 10, C.muted);
        text("REFRESH COUNT " + refreshCount + (selfTestPassed ? " / SELF TEST PASS" : ""), 1229, 598, 10, C.green, "right");
    }

    function renderFooter() {
        rect(26, 666, 1228, 1, C.line);
        roundedRect(26, 676, 210, 30, 7, "rgba(14,29,39,0.8)", C.line);
        roundedRect(248, 676, 156, 30, 7, "rgba(14,29,39,0.8)", C.line);
        roundedRect(416, 676, 244, 30, 7, "rgba(14,29,39,0.8)", C.line);
        text("D-PAD  NAVIGATE", 40, 697, 10, C.text);
        text("A  OPEN / RUN", 266, 697, 10, C.green);
        text("B / LEFT  RETURN / CLOSE", 434, 697, 10, C.amber);
        text(notice.slice(0, 42), 1253, 696, 11, noticeColor, "right");
    }

    function renderTerminal() {
        ctx.fillStyle = "#020607";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        rect(0, 0, WIDTH, 5, C.red);
        text("SAVE EXPORT", 42, 56, 25, C.white);
        roundedRect(42, 86, 1196, 500, 9, "#050b0e", C.line);
        for (var i = 0; i < terminalLines.length; i++) {
            text(terminalLines[i].text, 68, 124 + i * 24, 11, terminalLines[i].color);
        }
        var barWidth = 1144;
        roundedRect(68, 520, barWidth, 22, 11, C.panel2, C.line);
        if (exportProgress > 0) roundedRect(70, 522, Math.max(0, (barWidth - 4) * exportProgress), 18, 9, C.cyan);
        text(formatBytes(exportBytes) + " / " + formatBytes(exportSize), 68, 568, 11, C.text);
        text(exportChunks + " / " + exportExpectedChunks + " CHUNKS", 1212, 568, 11, C.muted, "right");
        text("DO NOT CLOSE THE GAME DURING EXPORT", 42, 672, 11, C.amber);
    }

    function render() {
        if (!running) return;
        if (payloadModeActive) {
            renderPayloadMode();
            return;
        }
        if (terminalActive) {
            renderTerminal();
            return;
        }
        var now = Date.now();
        drawBackground();
        drawHeader(now);
        drawSidebar();
        drawContentFrame();
        if (selectedModule === 0) renderHome();
        else if (selectedModule === 1) renderSaveExtractor();
        else if (selectedModule === 2) renderSaveBrowser();
        else if (selectedModule === 3) renderModBrowser();
        else if (selectedModule === 4) renderInput();
        else if (selectedModule === 5) renderPayloadTool();
        else renderAbout();
        renderFooter();
    }

    function frame(now) {
        if (!running) return;
        pollGamepads(now || Date.now());
        animationId = requestAnimationFrame(frame);
    }

    function stop() {
        if (!running) return;
        running = false;
        clearPayloadDecisionInput();
        if (animationId) cancelAnimationFrame(animationId);
        if (autoExitTimer) clearTimeout(autoExitTimer);
        if (refreshTimer) clearInterval(refreshTimer);
        if (inputSubscription && typeof inputSubscription.clear === "function") {
            try { inputSubscription.clear(); } catch (_) {}
        }
        window.removeEventListener("navigate-input", onDomInput, true);
        window.removeEventListener("engine-input", onDomInput, true);
        window.removeEventListener("keydown", onKey, true);
        canvas.removeEventListener("mousedown", onPointer, true);
        canvas.removeEventListener("touchstart", onPointer, true);
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        if (embeddedFontStyle && embeddedFontStyle.parentNode) embeddedFontStyle.parentNode.removeChild(embeddedFontStyle);
        if (window.__controlCenterOwner === instanceToken) {
            if (window.__controlCenterStop === stop) window.__controlCenterStop = null;
            window.__controlCenterInject = null;
            window.__controlCenterState = null;
            window.__controlCenterUpdate = null;
            window.__controlCenterStartExport = null;
            window.__controlCenterOwner = null;
        }
        window.__civPayloadStage = null;
        if (lifetimeResolve) {
            var resolveLifetime = lifetimeResolve;
            lifetimeResolve = null;
            resolveLifetime();
        }
    }

    function getState() {
        return {
            running: running,
            module: modules[selectedModule].name,
            moduleIndex: selectedModule,
            focus: focusArea,
            contentIndex: contentIndex,
            saveEntries: saveEntries.length,
            mods: mods.length,
            ip: live.ip,
            connected: live.connected,
            context: currentContext,
            device: currentDevice,
            exportRunning: exportRunning,
            exportProgress: exportProgress,
            lastExport: lastExport,
            payloadMode: payloadModeActive,
            payloadState: payloadStageState,
            font: vectorOutlineReady ? "DEJAVU OUTLINES" : fontAtlasReady ? "DEJAVU ATLAS" : vectorFontReady ? "DEJAVU WOFF" : "BITMAP FALLBACK"
        };
    }

    // Experimental font paths are disabled on this Gameface build. Use the
    // verified bitmap renderer only.
    fontAtlasReady = false;
    if (!vectorOutlineReady) await loadEmbeddedFont();
    refreshAll();
    focusArea = "SIDEBAR";
    selectedModule = 0;
    contentIndex = 0;
    setNotice("READY", C.green);

    window.addEventListener("navigate-input", onDomInput, true);
    window.addEventListener("engine-input", onDomInput, true);
    window.addEventListener("keydown", onKey, true);
    canvas.addEventListener("mousedown", onPointer, true);
    canvas.addEventListener("touchstart", onPointer, true);
    if (window.engine && typeof engine.on === "function") {
        inputSubscription = engine.on("InputAction", onEngineInput, inputContextToken);
    }

    autoExitTimer = setTimeout(stop, RUN_MS);
    refreshTimer = setInterval(function () { updateLive(); render(); }, 2000);
    animationId = requestAnimationFrame(frame);

    window.__controlCenterOwner = instanceToken;
    window.__controlCenterStop = stop;
    window.__controlCenterInject = function (name, status, x, y) {
        consumeInput("SELF TEST", name, status, x, y);
        return {module: selectedModule, focus: focusArea, index: contentIndex};
    };
    window.__controlCenterState = getState;
    window.__controlCenterStartExport = runSaveExport;
    window.__controlCenterUpdate = function (message, ok) {
        setNotice(message, ok === false ? C.red : C.green);
        render();
    };

    render();

    var initialModule = selectedModule;
    consumeInput("SELF TEST", "nav-down", STATUS_START, 0, 0);
    await new Promise(function (resolve) { setTimeout(resolve, 180); });
    consumeInput("SELF TEST", "nav-up", STATUS_START, 0, 0);
    selfTestPassed = selectedModule === initialModule;
    setNotice(selfTestPassed ? "READY" : "INPUT ERROR", selfTestPassed ? C.green : C.red);
    render();

    await log("CONTROL_CENTER_READY " + JSON.stringify(getState()));
    // Keep the native InputAction subscription owned by an active payload.
    // Gameface leaves the DOM/canvas behind after a payload returns, but Civ VII
    // can later retire the native engine subscription associated with it.
    await lifetime;
})();
