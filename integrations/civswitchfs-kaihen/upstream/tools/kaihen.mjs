// Build and send the kaiHEN payload: stage the kaiHEN files that are missing
// from the SD card (bare chunk payloads into a game-memory sink), then send
// the kaiHEN start payload and stream its log.
//
// Usage:
//   node tools/kaihen.mjs CONSOLE-IP [--dir DIR] [--status-only]
//                         [--force] [--no-hbmenu] [--no-programs]
//
// DIR is the unpacked kaiHEN release, in our SD-shaped layout (default:
// kaiHEN-20261117.1 next to this
// repository). The main CivSwitchFS payload must have succeeded on this boot.

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {buildPayload, ROOT} from "./bundle.mjs";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
// ROOT is the repo root; the default ship sits NEXT TO the repo
// (../kaiHEN-20261117.1), per the README.
const DEFAULT_SHIP = path.join(ROOT, "..", "kaiHEN-20261117.1");
const TIMEOUT_MS = 900_000;

const sdPath = {
    "bootstrap": "/kaihen/bin/bootstrap.bin",
    "ro": "/kaihen/bin/ro/main",
    "hen": "/kaihen/bin/hen/main",
    "game": "/kaihen/bin/game/main",
    "hbmenu": "/hbmenu.nro",
    "programs": "/switch/ounceshell/ounceshell.nro"
};

function usage(code) {
    console.log(`Usage: node tools/kaihen.mjs CONSOLE-IP [options]
  --dir DIR        kaiHEN release folder (default: ${path.relative(process.cwd(), DEFAULT_SHIP)})
  --status-only    report SD state and exit without staging or starting
  --force          restage files even when their size already matches
  --no-hbmenu      skip hbmenu.nro
  --no-programs    skip programs/
  --no-stage       skip the SD status probe and staging entirely (files
                   must already be on the card)
  --probes         also run the TS/SR/SB diagnostics (off by default: their
                   doomed code-opens close the shared loader session copy —
                   fs closes a session when a request errors before its
                   handler, and every later dispatch, including the
                   bootstrap's op-16, fails with kernel 0xF601
                   SessionClosed; runs 140-141)
  --dx             also run the DX experiments (off by default: DX19 swaps
                   loaderCopy for a promoted-session copy that is only ever
                   cmd-810-probed, never cmd-0)
  --skip A,B       explicit skip list (overrides the defaults above)
Requires the CivSwitch Remote JS Loader with a successful CivSwitchFS run.`);
    process.exit(code);
}

function parse(args) {
    const options = {ship: DEFAULT_SHIP, force: false, statusOnly: false,
        hbmenu: true, programs: true};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = () => {
            if (++i === args.length) usage(1);
            return args[i];
        };
        if (arg === "--help" || arg === "-h") usage(0);
        else if (arg === "--dir") options.ship = path.resolve(value());
        else if (arg === "--force") options.force = true;
        else if (arg === "--status-only") options.statusOnly = true;
        else if (arg === "--skip") {
            options.skip = value().split(",")
                .map(name => name.trim()).filter(Boolean);
            options.skipExplicit = true;
        }
        else if (arg === "--probes") options.runProbes = true;
        else if (arg === "--dx") options.runDx = true;
        else if (arg === "--no-hbmenu") options.hbmenu = false;
        else if (arg === "--no-programs") options.programs = false;
        else if (arg === "--no-stage") options.noStage = true;
        else if (!options.console && /^\d+\.\d+\.\d+\.\d+$/.test(arg))
            options.console = arg;
        else usage(1);
    }
    if (!options.console) usage(1);
    if (!options.skipExplicit) {
        // Default to the safe path: the TS/SR/SB diagnostics and the DX
        // experiments each break the loader copy the bootstrap needs (see
        // usage). Opt back in with --probes / --dx.
        options.skip = ["dx", "probes"];
        if (options.runProbes)
            options.skip = options.skip.filter(name => name !== "probes");
        if (options.runDx)
            options.skip = options.skip.filter(name => name !== "dx");
    }
    return options;
}

function send(host, port, code, label) {
    return new Promise(resolve => {
        const chunks = [];
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString());
        };
        const socket = net.createConnection({host, port}, () => {
            socket.write(code, () => socket.end());
        });
        socket.setTimeout(TIMEOUT_MS);
        socket.on("data", chunk => {
            chunks.push(chunk);
            process.stdout.write(chunk);
        });
        socket.on("end", finish);
        socket.on("timeout", () => {
            console.error(`\n[${label}] receive timeout`);
            socket.destroy();
            finish();
        });
        socket.on("error", error => {
            console.error(`\n[${label}] connection error: ${error.message}`);
            finish();
        });
    });
}

// Two ship layouts are supported, auto-detected per run:
// - official: the upstream kaiHEN release zip as extracted (bootstrap.bin
//   at the root, ro/main, hen/main, game/main, programs/ounceshell.nro)
// - shaped: our release format, already in the SD layout
const officialFiles = {
    "bootstrap": "bootstrap.bin",
    "ro": "ro/main",
    "hen": "hen/main",
    "game": "game/main",
    "hbmenu": "hbmenu.nro",
    "programs": "programs/ounceshell.nro"
};

const shapedFiles = {
    "bootstrap": "kaihen/bin/bootstrap.bin",
    "ro": "kaihen/bin/ro/main",
    "hen": "kaihen/bin/hen/main",
    "game": "kaihen/bin/game/main",
    "hbmenu": "hbmenu.nro",
    "programs": "switch/ounceshell/ounceshell.nro"
};

async function manifestFor(options) {
    const names = ["bootstrap", "ro", "hen", "game",
        ...(options.hbmenu ? ["hbmenu"] : []),
        ...(options.programs ? ["programs"] : [])];
    const shaped = await fsp.access(path.join(options.ship,
        "kaihen/bin/bootstrap.bin")).then(() => true, () => false);
    const localFiles = shaped ? shapedFiles : officialFiles;
    const files = [];
    for (const name of names) {
        const source = path.join(options.ship, localFiles[name]);
        const bytes = await fsp.readFile(source);
        files.push({name, path: sdPath[name],
            source, size: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex")});
    }
    return files;
}

function sinkPayload(files, total) {
    const manifest = {files: files.map((file, index) => ({
        name: file.name, path: file.path, size: file.size,
        sha256: file.sha256,
        offset: files.slice(0, index).reduce((sum, item) => sum + item.size, 0)
    })), total};
    return `(async()=>{
  globalThis.__KH_SINK_MANIFEST = ${JSON.stringify(manifest)};
  if (globalThis.__KH_SINK && globalThis.__KH_SINK.base) {
    await log("KH-SINK exists " + globalThis.__KH_SINK.wrote + "/" + ${total});
    return;
  }
  var base = malloc(${total} + 4096);
  if (!base) { await log("KH-SINK malloc failed for " + ${total}); return; }
  globalThis.__KH_SINK = {base: base, wrote: 0, total: ${total}, complete: false};
  await log("KH-SINK ready 0/" + ${total});
})()`;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0,
            b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64[b0 >> 2] + B64[(b0 & 3) << 4 | b1 >> 4];
        if (i + 1 < bytes.length) out += B64[(b1 & 15) << 2 | b2 >> 6]; else out += "=";
        if (i + 2 < bytes.length) out += B64[b2 & 63]; else out += "=";
    }
    return out;
}

function chunkPayload(base64) {
    return `(async()=>{
  var S = globalThis.__KH_SINK;
  if (!S || !S.base) { await log("KH-SINK missing; send the manifest first"); return; }
  var T = ${JSON.stringify(base64)};
  var lookup = ${JSON.stringify(B64)};
  var map = {};
  for (var i = 0; i < 64; i++) map[lookup.charAt(i)] = i;
  var at = S.base + BigInt(S.wrote), acc = 0, bits = 0, n = 0;
  for (var i = 0; i < T.length; i++) {
    var v = map[T.charAt(i)];
    if (v === undefined) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; write8(at + BigInt(n++), BigInt((acc >> bits) & 0xff)); }
  }
  S.wrote += n;
  if (S.wrote >= S.total) S.complete = true;
  await log("KH-SINK " + S.wrote + "/" + S.total);
})()`;
}

async function main() {
    const options = parse(process.argv.slice(2));
    for (const file of ["bootstrap.bin", "ro/main", "hen/main", "game/main"]) {
        const present = fs.statSync(path.join(options.ship, file),
            {throwIfNoEntry: false})?.isFile();
        if (!present) throw Error(`Missing ${path.join(options.ship, file)}`);
    }
    const files = await manifestFor(options);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const manifestSource = `globalThis.__KH_MANIFEST = ${JSON.stringify(
        Object.fromEntries(files.map(file => [file.name,
            {path: file.path, size: file.size}])))};`;
    const port = 9026;

    console.log(`-- kaiHEN launcher: ${options.console}:${port} --`);
    console.log(`-- ship: ${options.ship} (${files.length} files, ` +
        `${(total / 1048576).toFixed(1)} MiB) --`);

    // 1. Manifest + status probe through the full bundle in status mode.
    const built = await buildPayload({entry: path.join(ROOT, "src/kaihen.js")});
    console.log(`-- kaihen payload: ${built.bytes} bytes --`);
    await send(options.console, port,
        `(globalThis.__KH_MODE='status');${manifestSource}`, "manifest");
    if (options.noStage) {
        // Skip the SD status probe and any staging entirely: files must
        // already be on the card; the bootstrap stage's own presence
        // checks are the last-line guard.
        console.log("-- staging skipped (--no-stage) --");
    } else {
    const status = await send(options.console, port, built.payload, "status");
    if (/KH: NO SESSION/.test(status))
        throw Error("No promoted CivSwitchFS session; run the main payload first.");

    const okCount = files.filter(file =>
        new RegExp(`KH: SD file ${file.name} ok`).test(status)).length;
    if (okCount === files.length && !options.force) {
        console.log("-- SD card already has every file; skipping staging --");
    } else if (options.statusOnly) {
        console.log("-- status-only: stopping --");
        return;
    } else {
        const missing = files.filter(file => options.force ||
            !new RegExp(`KH: SD file ${file.name} ok`).test(status));
        if (!missing.length) {
            console.log("-- staging already complete --");
        } else {
            const stagingTotal = missing.reduce((sum, f) => sum + f.size, 0);
            console.log(`-- staging ${missing.map(f => f.name).join(", ")} ` +
                `(${(stagingTotal / 1048576).toFixed(1)} MiB) --`);
            // Reset any earlier sink, then send the manifest payload.
            await send(options.console, port,
                `globalThis.__KH_SINK = null;`, "sink-reset");
            const manifestFiles = missing.map((file, index) => ({
                name: file.name, path: file.path, size: file.size,
                sha256: file.sha256,
                offset: missing.slice(0, index)
                    .reduce((sum, item) => sum + item.size, 0)
            }));
            const sinkReply = await send(options.console, port,
                sinkPayload(manifestFiles, stagingTotal), "sink-manifest");
            if (/KH-SINK malloc failed/.test(sinkReply))
                throw Error(`Game heap rejected the ${stagingTotal}-byte sink; ` +
                    `stage files individually (drop --no-* flags)`);
            if (!/KH-SINK (ready|exists)/.test(sinkReply))
                throw Error("Sink did not initialize; see log above");
            const CHUNK = 240 * 1024; // base64 inflates 4/3; stay under 500 KiB
            let chunkIndex = 0;
            for (const file of missing) {
                const bytes = await fsp.readFile(file.source);
                for (let at = 0; at < bytes.length; at += CHUNK) {
                    const part = bytes.subarray(at, at + CHUNK);
                    const reply = await send(options.console, port,
                        chunkPayload(base64Encode(part)),
                        `chunk ${file.name}`);
                    chunkIndex++;
                    if (/Error in payload|TypeError/.test(reply))
                        throw Error(`chunk ${chunkIndex} (${file.name} @${at}) ` +
                            `failed on console: ${reply.match(/Error in payload.*/)?.[0] ?? reply.slice(-200)}`);
                    const wrote = Number(reply.match(/KH-SINK (\d+)/)?.[1] ?? -1);
                    if (wrote < 0)
                        throw Error(`chunk ${chunkIndex} (${file.name} @${at}): ` +
                            `no KH-SINK progress in reply`);
                }
                console.log(`-- staged ${file.name} --`);
            }
        }
    }
    }

    if (options.statusOnly) return;

    // 2. Run the chain.
    await send(options.console, port,
        `(globalThis.__KH_MODE='run');${manifestSource}`, "mode");
    if (options.skip) {
        await send(options.console, port,
            `globalThis.__KH_SKIP=${JSON.stringify(options.skip)};`,
            "skip prelude");
        console.log(`-- skipping stages: ${options.skip.join(", ")} --`);
    }    const result = await send(options.console, port, built.payload, "run");
    if (/HEN IS RUNNING/.test(result)) {
        console.log("\n-- kaiHEN is running. Close Civilization VII normally; " +
            "hold R while opening a Switch 2 game twice. --");
    } else {
        console.error("\n-- kaiHEN did not start; see the log above --");
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
