// Stage-logging helpers for the payload supervisor.
//
// Stage messages stay visible in every mode; raw helper logs stay hidden.
// Stage output is written without per-line attempt prefixes; core.js emits one
// standalone attempt header.

import coreRuntime, {waitMs} from "./runtime.mjs";

const {log} = coreRuntime;

const STAGE_LOG_MARKER = "\u0001stage:";
const LOG_PAUSE_MS = 30;

let verboseLogging = false;

export function setVerboseLogging(enabled) {
    const previous = verboseLogging;
    verboseLogging = enabled === true;
    return previous;
}

export function isVerboseLogging() {
    return verboseLogging;
}

export function stageOnlyLog(message) {
    if (typeof message === "string" && message.startsWith(STAGE_LOG_MARKER))
        return message.slice(STAGE_LOG_MARKER.length);
    return null;
}

export async function emitFastStage(message) {
    await log(STAGE_LOG_MARKER + message);
}

export async function emitVerboseStage(message) {
    if (verboseLogging && message)
        await emitFastStage(message);
}

export async function emitStage(message) {
    await emitFastStage(message);
    await waitMs(LOG_PAUSE_MS);
}

