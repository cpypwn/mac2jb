/** Build a standalone CivSwitchFS image and its save installer. */

import {createHash} from "node:crypto";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import esbuild from "esbuild";
import {buildPayload, ROOT} from "./bundle.mjs";

const PROFILE = "civ7-sdk-19f22ec5";
const CORE_SHA256 =
    "a22ca2f93b7fd7f7083df8ca42158e69f990acac9a397bfef58470558caa7df5";
const TEMPLATE_SHA256 =
    "32fa8a0d6dd0a480d8e541e63ea44c4619bc6f7be4282cfc3cb6a4f6d305dfae";
const DECODER_SHA256 =
    "2c02d3c9f9a6db1f30c58deb50b8e50a7e1f18f10e86ee4e20da13de7c805f5a";
const MAX_LOADER_BYTES = 500_000;
const MAX_STAGE_BYTES = 200_000;
const BOOTSTRAP_ANCHOR = "            let setupFails = 0;";
const EARLY_VISUALS_ANCHOR = "    function sleep(ms) {";
const LOG_RELAY_ANCHOR = "        const _loader_old_log = window.log;";
const PERSIST_DIR = path.join(ROOT, "persist");

export async function buildPersistentImage(options = {}) {
    const debugPayload = options.debugPayload === true;
    const minifyPayload = options.minifyPayload === true;
    if (debugPayload && minifyPayload)
        throw new Error("Choose either --debug-payload or --minify-payload");
    const corePath = options.corePath || path.join(PERSIST_DIR, "core.js");
    const templatePath = options.templatePath || path.join(PERSIST_DIR, "save_template.bin");
    const decoderPath = options.decoderPath || path.join(PERSIST_DIR, "compress_stage.js");
    const outputDir = path.join(ROOT, "dist/persist");

    const [core, template, decoderSource, upstreamLicense, localLicense, packageJson] = await Promise.all([
        readFile(corePath, "utf8"),
        readFile(templatePath),
        readFile(decoderPath, "utf8"),
        readFile(path.join(PERSIST_DIR, "LICENSE"), "utf8"),
        readFile(path.join(ROOT, "LICENSE"), "utf8"),
        readFile(path.join(ROOT, "package.json"), "utf8")
    ]);
    if (sha256(core) !== CORE_SHA256)
        throw new Error("CivSwitch bootstrap not recognized: different fingerprint");
    if (sha256(template) !== TEMPLATE_SHA256)
        throw new Error("Civ VII template not recognized: different fingerprint");
    if (sha256(decoderSource) !== DECODER_SHA256)
        throw new Error("Stage decoder not recognized: different fingerprint");
    if (!upstreamLicense.includes("Copyright (c) 2026 Gezine") ||
        !upstreamLicense.includes("Permission is hereby granted"))
        throw new Error("CivSwitch bootstrap license not recognized");

    const decoderMatch = decoderSource.match(/const DECODER = `([\s\S]*?)`;/);
    if (!decoderMatch) throw new Error("Stage decoder missing");

    const [payload, visualPrelude] = await Promise.all([
        buildPayload({
            entry: options.chain ?
                path.join(ROOT, "src/chain.mjs") : undefined,
            debug: debugPayload,
            minifyIdentifiers: minifyPayload
        }),
        buildPersistedVisualPrelude()
    ]);
    const visualCore = injectPersistedVisuals(core, visualPrelude);
    const assembled = injectPayload(visualCore, payload.payload);
    // Keep every outer lexical name visible to the direct eval in the payload.
    // Whitespace-only minification keeps the bootstrap's compatibility contract.
    const transformed = await esbuild.transform(assembled, {
        loader: "js",
        target: "es2020",
        minifyWhitespace: true,
        minifyIdentifiers: false,
        minifySyntax: false,
        charset: "ascii",
        legalComments: "none"
    });
    const standalone = transformed.code.trim() + "\n";
    const compressed = deflateRawSync(Buffer.from(standalone, "ascii"), {level: 9});
    if (inflateRawSync(compressed).toString("ascii") !== standalone)
        throw new Error("Stage compression round-trip failed");

    const decoder = decoderMatch[1];
    const encoded = compressed.toString("base64");
    const decodeExpression = "str(inflate(B64(" + JSON.stringify(encoded) + ")))";
    const stage =
        "/*civswitchfs profile=" + PROFILE + "*/\n" +
        licenseBlock("CivSwitchFS", localLicense) +
        licenseBlock("CivSwitch", upstreamLicense) +
        decoder + "\neval(" + decodeExpression + ");\n";
    const stageBytes = Buffer.from(stage, "ascii");
    if (!/^[\x00-\x7f]*$/.test(stage) || stageBytes.length > MAX_STAGE_BYTES)
        throw new Error("Persistent image too large or not ASCII");

    const image = {
        profile: PROFILE,
        version: "civswitchfs-" + JSON.parse(packageJson).version +
            (options.chain ? "+kaihen" : ""),
        stage,
        bytes: stageBytes.length,
        sha256: sha256(stageBytes),
        chain: options.chain === true,
        triggerTiming: false,
        hideTriggerText: !options.showText,
        debugPayload,
        minifyPayload
    };
    const sources = await Promise.all(
        ["save-codec", "save-fs", "installer"].map(name =>
            readFile(path.join(PERSIST_DIR, name + ".js"), "utf8"))
    );
    const persistCore = `var __cfsPersistCore = {
        sdk_base:sdk_base, read32:read32, read64:read64, read8:read8,
        write32:write32, write8:write8, read_buffer:read_buffer,
        write_buffer:write_buffer, malloc:malloc, free:free, call_rop:call_rop
    };`;
    const installerEntry = `
        var __cfsPersistMessage = '';
        window.__cfsPersistInstaller = window.__cfsCreateInstaller({
            openFS:function(){return window.__cfsCreateSaveFS(__cfsPersistCore);},
            exclusive:function(task){return task();},
            status:function(state){
                if(state.busy && state.message.indexOf('Failure:') !== 0 &&
                    state.message !== 'Installed. Restart the game, then open Load Game menu.' &&
                    state.message !== __cfsPersistMessage){
                    __cfsPersistMessage = state.message;
                    log(state.message);
                }
            }
        });
        window.__cfsPersistInstaller.offer(${JSON.stringify(image)});
        log('CivSwitchFS persistence installer ready.');
    `;
    const bootstrap = await esbuild.transform(
        sources.join("\n;\n") + "\n" + persistCore + "\n" + installerEntry,
        {
            loader: "js",
            target: "es2020",
            minifyWhitespace: true,
            minifyIdentifiers: false,
            minifySyntax: false,
            charset: "ascii",
            legalComments: "none"
        }
    );
    const bootstrapText = bootstrap.code.trim() + "\n";
    if (!/^[\x00-\x7f]*$/.test(bootstrapText) ||
        Buffer.byteLength(bootstrapText, "ascii") >= MAX_LOADER_BYTES)
        throw new Error("Bootstrap d'installation trop grand ou non ASCII");

    const probe = decoder + "\nvar decoded = " + decodeExpression + ";\n" +
        "log('STAGE DECODE ' + (decoded.length === " + standalone.length +
        " && decoded.slice(0, 16) === " + JSON.stringify(standalone.slice(0, 16)) +
        " ? 'OK' : 'FAILED'));\n";
    const manifest = {
        profile: PROFILE,
        version: image.version,
        bytes: image.bytes,
        sha256: image.sha256,
        coreSha256: CORE_SHA256,
        payloadSha256: sha256(payload.payload),
        templateSha256: TEMPLATE_SHA256,
        hideTriggerText: image.hideTriggerText,
        debugPayload: image.debugPayload,
        minifyPayload: image.minifyPayload
    };

    await mkdir(outputDir, {recursive: true});
    await Promise.all([
        writeFile(path.join(outputDir, "standalone.js"), stage, "ascii"),
        writeFile(path.join(outputDir, "persist-bootstrap.js"), bootstrapText, "ascii"),
        writeFile(path.join(outputDir, "save-template.bin"), template),
        writeFile(path.join(outputDir, "stage-probe.js"), probe, "ascii"),
        writeFile(path.join(outputDir, "LICENSE-CivSwitchFS.txt"), localLicense),
        writeFile(path.join(outputDir, "LICENSE-CivSwitch.txt"), upstreamLicense),
        writeFile(path.join(outputDir, "install-image.json"), JSON.stringify(manifest, null, 2) + "\n")
    ]);
    const payloadMode = image.debugPayload
        ? "diagnostic, sans minification"
        : image.minifyPayload
            ? "minified (ESM names shortened)"
            : "whitespace compacted, names preserved";
    console.log(
        `Persistent image: ${image.bytes} bytes; bootstrap: ` +
        `${Buffer.byteLength(bootstrapText)} bytes; payload: ${payload.bytes}` +
        ` bytes (${payloadMode}).`
    );
    console.log("No installation was started.");
    return {image, standalone, bootstrap: bootstrapText, manifest};
}

const sha256 = value => createHash("sha256").update(value).digest("hex");

function standaloneEntry(payload) {
    const payloadWithSourceName = payload +
        "\n//# sourceURL=CivSwitchFS-payload.js";
    return `
            {
                const __cfsStandalone = true;
                let sock_fd = null;
                const client_fd = null;
                const network_str = '';
                try {
                    await eval(${JSON.stringify(payloadWithSourceName)});
                    await log('Executed successfully');
                }
                catch (error) {
                    const position = error && (error.lineNumber || error.columnNumber)
                        ? ' (line=' + (error.lineNumber || '?') +
                            ', column=' + (error.columnNumber || '?') + ')'
                        : '';
                    await log('CivSwitchFS autonome : ' + error.message + position);
                    if (error && error.stack) await log(error.stack);
                }
                finally { if (sock_fd !== null) close(sock_fd); }
            }
`;
}

async function buildPersistedVisualPrelude() {
    const result = await esbuild.build({
        entryPoints: [path.join(ROOT, "src/core/visuals.mjs")],
        bundle: true,
        platform: "browser",
        format: "iife",
        globalName: "__CIVSWITCHFS_PERSIST_VISUALS__",
        target: ["es2020"],
        write: false,
        logLevel: "silent",
        legalComments: "none"
    });
    return result.outputFiles[0].text +
        "\n__CIVSWITCHFS_PERSIST_VISUALS__.installEarlyVisualLogPatch();\n";
}

function injectPersistedVisuals(core, visualPrelude) {
    if (core.split(EARLY_VISUALS_ANCHOR).length !== 2)
        throw new Error("CivSwitch bootstrap not recognized: visual anchor ambiguous");

    let result = core.replace(
        EARLY_VISUALS_ANCHOR,
        visualPrelude + "\n" + EARLY_VISUALS_ANCHOR
    );

    const relayStart = result.indexOf(LOG_RELAY_ANCHOR);
    if (relayStart < 0 || result.indexOf(LOG_RELAY_ANCHOR, relayStart + 1) >= 0)
        throw new Error("CivSwitch bootstrap not recognized: log relay anchor ambiguous");
    const relayEndMarker = "        };\n\n        function create_socket() {";
    const relayEnd = result.indexOf(relayEndMarker, relayStart);
    if (relayEnd < 0)
        throw new Error("CivSwitch bootstrap not recognized: log relay end missing");

    const relay = `        globalThis.__CIVSWITCHFS_PERSIST_LOG_FORWARDER__ = function (message) {
            if (_log_socket_fd === null) return;
            try {
                const line = String(message) + "\\n";
                write_string(line_buf, line);
                send(_log_socket_fd, line_buf, text_encode(line).length, 0);
            } catch (e) {}
        };

        function create_socket() {`;
    return result.slice(0, relayStart) + relay +
        result.slice(relayEnd + relayEndMarker.length);
}

function injectPayload(core, payload) {
    if (core.split(BOOTSTRAP_ANCHOR).length !== 2)
        throw new Error("CivSwitch bootstrap not recognized: anchor ambiguous");
    return core.replace(BOOTSTRAP_ANCHOR, standaloneEntry(payload) + BOOTSTRAP_ANCHOR);
}

function licenseBlock(label, license) {
    return `/* ${label}\n${license.replaceAll("*/", "* /")}\n*/\n`;
}

function readOptions(args) {
    const options = {
        showText: false,
        debugPayload: false,
        // Readable build is the default: the minified chain stage fails to
        // eval in the save path ("Unexpected identifier", root cause open).
        minifyPayload: false,
        chain: false
    };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--chain") {
            options.chain = true;
            continue;
        }
        if (arg === "--show-text") {
            options.showText = true;
            continue;
        }
        if (arg === "--debug-payload") {
            options.debugPayload = true;
            options.minifyPayload = false;
            continue;
        }
        if (arg === "--minify-payload") {
            // Opt-in: the minified chain stage fails to eval in the save
            // path ("Unexpected identifier", root cause open).
            options.minifyPayload = true;
            continue;
        }
        if (arg === "--no-minify-payload") {
            // Readable build is the default now; the flag stays accepted
            // as an explicit no-op.
            options.minifyPayload = false;
            continue;
        }
        if (["--core", "--template", "--decoder"].includes(arg)) {
            const value = args[++index];
            if (!value) throw new Error(`Missing value for ${arg}`);
            options[arg.slice(2) + "Path"] = path.resolve(value);
            continue;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
    if (options.debugPayload && options.minifyPayload)
        throw new Error("Choose either --debug-payload or --minify-payload");
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await buildPersistentImage(readOptions(process.argv.slice(2)));
    } catch (error) {
        console.error("Persistence build failed: " + error.message);
        process.exitCode = 1;
    }
}
