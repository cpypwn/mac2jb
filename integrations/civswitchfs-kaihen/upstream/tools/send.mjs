// Build and send the payload to a running CivSwitch Remote JS Loader.
//
// Usage:
//   node tools/send.mjs [--entry <file>] <console-ip> [port] [entry]
//   npm run send -- <console-ip> [port]
//   npm run example:user-storage -- <console-ip> [port]

import net from "node:net";
import path from "node:path";
import {StringDecoder} from "node:string_decoder";
import {buildPayload, DEFAULT_ENTRY, ROOT} from "./bundle.mjs";

// Whole-payload receive timeout. A full acquisition→promotion run can take
// several minutes after the canary flips; raise via env for full-chain runs.
const TIMEOUT_MS = Number(process.env.CIVSWITCHFS_SEND_TIMEOUT_MS) || 240_000;

function formatLogTimestamp(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, "0");
    return `[${pad(date.getHours())}:${pad(date.getMinutes())}:` +
        `${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}] `;
}

function send(host, port, code) {
    return new Promise(resolve => {
        const chunks = [];
        const decoder = new StringDecoder("utf8");
        let pendingLine = "";
        let settled = false;

        function writeTimestamped(text) {
            pendingLine += text;
            let newlineIndex;
            while ((newlineIndex = pendingLine.indexOf("\n")) >= 0) {
                const line = pendingLine.slice(0, newlineIndex + 1);
                process.stdout.write(formatLogTimestamp() + line);
                pendingLine = pendingLine.slice(newlineIndex + 1);
            }
        }

        function finish(result) {
            if (settled) return;
            settled = true;
            writeTimestamped(decoder.end());
            if (pendingLine) {
                process.stdout.write(formatLogTimestamp() + pendingLine);
                pendingLine = "";
            }
            resolve(result);
        }

        const socket = net.createConnection({host, port}, () => {
            socket.write(code, () => socket.end());
        });
        socket.setTimeout(TIMEOUT_MS);
        socket.on("data", chunk => {
            writeTimestamped(decoder.write(chunk));
            chunks.push(chunk);
        });
        socket.on("end", () => finish(Buffer.concat(chunks).toString()));
        socket.on("timeout", () => {
            console.error("receive timeout");
            process.exitCode = 1;
            socket.destroy();
            finish(Buffer.concat(chunks).toString());
        });
        socket.on("error", error => {
            console.error("connection error:", error.message);
            process.exitCode = 1;
            finish(Buffer.concat(chunks).toString());
        });
    });
}

const args = process.argv.slice(2);
let entry = DEFAULT_ENTRY;
if (args[0] === "--entry") {
    if (!args[1]) {
        console.log("Usage: node tools/send.mjs [--entry <file>] " +
            "<console-ip> [port] [entry]");
        process.exit(1);
    }
    entry = path.resolve(args[1]);
    args.splice(0, 2);
}
if (args.length < 1) {
    console.log("Usage: node tools/send.mjs [--entry <file>] " +
        "<console-ip> [port] [entry]");
    process.exit(1);
}

const host = args[0];
let port = 9026;

if (args.length >= 2 && /^\d+$/.test(args[1])) {
    port = Number.parseInt(args[1], 10);
    if (args[2]) entry = path.resolve(args[2]);
} else if (args[1]) {
    entry = path.resolve(args[1]);
}

const built = await buildPayload({entry});
console.log(
    `-- sending ${path.relative(ROOT, entry)} to ${host}:${port} ` +
    `(${built.bytes} bytes) --`
);
if (built.identifiersMinified)
    console.log("-- whitespace compacted; ESM locals shortened; core/API names preserved --");
if (built.minified)
    console.log("-- ESM syntax minified further to fit the 500 KB loader limit --");
if (built.modules.length)
    console.log("-- bundled modules: " + built.modules.join(", ") + " --");

await send(host, port, built.payload);
console.log("\n-- done --");
