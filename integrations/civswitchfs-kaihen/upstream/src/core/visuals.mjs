// Keep payload logs inside better-console when its public logger is available.
// The fallback uses the same row layout and colors for standalone loaders.
const LOGGER_KEY = "__CIVSWITCHFS_VISUAL_LOGGER_V2__";
const LOGGER_STATE_KEY = "__CIVSWITCHFS_VISUAL_LOG_STATE_V2__";
const LEGACY_LOGGER_KEY = "__CIVSWITCHFS_VISUAL_LOGGER__";
const LEGACY_STATE_KEY = "__CIVSWITCHFS_VISUAL_LOG_STATE__";
const INPUT_CONTROL_STATE_KEY = "__CIVSWITCHFS_INPUT_CONTROL_STATE_V1__";
const INPUT_CONTROL_VERSION = 4;
const BETTER_CONSOLE_FORWARDER = "__civSwitchBetterConsoleForwarder";
const LOG_LABEL = "CivSwitchFS logs";

export function installVisualLogPatch() {
    const api = globalThis.__CIVSWITCH_CORE_API__;
    installVisualLogPatchFor(api);
}

// The persisted bootstrap uses the same logger before the payload is injected,
// so the first exploit and payload messages share one visual surface.
export function installEarlyVisualLogPatch() {
    const api = {log: globalThis.log};
    installVisualLogPatchFor(api);
}

function installVisualLogPatchFor(api) {
    const document = globalThis.document;
    if (!api || typeof api.log !== "function" || !document?.body) return;

    const betterConsole = globalThis.civConsole;
    if (betterConsole && typeof betterConsole.log === "function") {
        removeLegacyOutput(document);
        const existingLogger = globalThis[LOGGER_KEY];
        if (typeof existingLogger === "function" &&
            existingLogger[BETTER_CONSOLE_FORWARDER]) {
            api.log = existingLogger;
            globalThis.log = existingLogger;
            return;
        }

        const consoleLog = betterConsole.log;
        const forwardLog = function (...args) {
            forwardPersistedLog(args);
            return Reflect.apply(consoleLog, betterConsole, args);
        };
        forwardLog[BETTER_CONSOLE_FORWARDER] = true;
        globalThis[LOGGER_KEY] = forwardLog;
        globalThis.log = forwardLog;
        api.log = forwardLog;
        return;
    }

    const existingLogger = globalThis[LOGGER_KEY];
    if (typeof existingLogger === "function") {
        api.log = existingLogger;
        globalThis.log = existingLogger;
        return;
    }

    // If a payload using the former <pre> overlay already ran in this session,
    // restyle it in place so its persistent logger does not restore the black
    // panel on the next message.
    const legacyLogger = globalThis[LEGACY_LOGGER_KEY];
    if (typeof legacyLogger === "function") {
        const legacyState = globalThis[LEGACY_STATE_KEY];
        const legacyOutput = legacyState?.output ||
            document.querySelector('[aria-label="' + LOG_LABEL + '"]');
        if (legacyOutput) applyLegacyConsoleStyle(legacyOutput, document);
        const migratedLogger = function (...args) {
            forwardPersistedLog(args);
            const pending = Reflect.apply(legacyLogger, this, args);
            return Promise.resolve(pending).then(result => {
                const output = legacyState?.output ||
                    document.querySelector('[aria-label="' + LOG_LABEL + '"]');
                if (output) applyLegacyConsoleStyle(output, document);
                return result;
            });
        };
        globalThis[LOGGER_KEY] = migratedLogger;
        globalThis.log = migratedLogger;
        api.log = migratedLogger;
        return;
    }

    const state = globalThis[LOGGER_STATE_KEY] || {
        output: null,
        logQueue: Promise.resolve(),
        compact: false
    };
    globalThis[LOGGER_STATE_KEY] = state;
    let originalLog = api.log;

    function ensureOutput() {
        const nativeOutput = document.querySelector("pre");
        if (nativeOutput && nativeOutput !== state.output)
            nativeOutput.style.display = "none";

        if (!state.output || !state.output.isConnected) {
            state.output = document.createElement("div");
            state.output.setAttribute("aria-label", LOG_LABEL);
            state.output.setAttribute("role", "log");
            state.compact = applyConsoleStyle(state.output, document);
            document.body.appendChild(state.output);
        }
        return state.output;
    }

    const visualLog = function (...args) {
        const callThis = this;
        const callArgs = args.slice();
        const message = String(callArgs[0]);
        const timestamp = formatTimestamp(new Date());
        forwardPersistedLog(callArgs);

        const task = state.logQueue.then(async () => {
            const followTail = isNearBottom(state.output);
            const pendingLog = Reflect.apply(originalLog, callThis, callArgs);
            // The persisted bootstrap's first logger is lazy: its first call
            // replaces window.log with the underlying <pre> implementation.
            // Retain the visual wrapper after capturing that implementation.
            if (globalThis.log !== visualLog) {
                originalLog = globalThis.log;
                api.log = visualLog;
                globalThis.log = visualLog;
            }
            const logOutput = ensureOutput();
            const result = await pendingLog;

            addLogRows(logOutput, document, message, timestamp, state.compact);
            if (followTail) logOutput.scrollTop = logOutput.scrollHeight;
            return result;
        });

        state.logQueue = task.catch(() => {});
        return task;
    };

    globalThis[LOGGER_KEY] = visualLog;
    globalThis.log = visualLog;
    api.log = visualLog;
}

function forwardPersistedLog(args) {
    const forwarder = globalThis.__CIVSWITCHFS_PERSIST_LOG_FORWARDER__;
    if (typeof forwarder !== "function") return;
    try {
        Reflect.apply(forwarder, globalThis, args);
    } catch (error) {}
}

export async function clearVisualLog() {
    const betterConsole = globalThis.civConsole;
    if (betterConsole && typeof betterConsole.clear === "function") {
        betterConsole.clear();
        return;
    }

    const state = globalThis[LOGGER_STATE_KEY] ||
        globalThis[LEGACY_STATE_KEY];
    if (!state) return;

    await state.logQueue.catch(() => {});
    const output = state.output ||
        globalThis.document?.querySelector('[aria-label="' + LOG_LABEL + '"]');
    if (output) output.textContent = "";
}

export function installRunInputControls({
    onResetTimings, onStop, onToggleVerbose
} = {}) {
    const window = globalThis.window;
    if (!window?.addEventListener) return {dispose() {}};

    const existingControls = globalThis[INPUT_CONTROL_STATE_KEY];
    if (existingControls) {
        if (existingControls.version === INPUT_CONTROL_VERSION &&
            typeof existingControls.setRunCallbacks === "function") {
            existingControls.setRunCallbacks({
                onResetTimings, onStop, onToggleVerbose
            });
            return existingControls;
        }
        existingControls.dispose?.();
    }

    const statuses = window.InputActionStatuses || {
        START: 0,
        FINISH: 1,
        UPDATE: 2
    };
    let disposed = false;
    let inputTimer = null;
    let lastResetRequest = 0;
    let runCallbacks = {onResetTimings, onStop, onToggleVerbose};
    let controllerPrevious = Object.create(null);
    let lastVerboseToggleAt = 0;
    const engineActionActive = {reset: false, stop: false};

    function consume(event) {
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
    }

    function requestReset(event) {
        if (typeof runCallbacks.onResetTimings !== "function") return false;
        consume(event);
        const now = Date.now();
        if (now - lastResetRequest < 100) return true;
        lastResetRequest = now;
        runCallbacks.onResetTimings();
        return true;
    }

    function requestStop(event) {
        if (typeof runCallbacks.onStop !== "function") return false;
        consume(event);
        runCallbacks.onStop();
        return true;
    }

    function requestToggleVerbose() {
        if (typeof runCallbacks.onToggleVerbose !== "function") return false;
        const now = Date.now();
        if (now - lastVerboseToggleAt < 180) return true;
        lastVerboseToggleAt = now;
        runCallbacks.onToggleVerbose();
        return true;
    }

    function handleEngineAction(event, action) {
        const callback = action === "reset"
            ? runCallbacks.onResetTimings : runCallbacks.onStop;
        if (typeof callback !== "function") return;

        const isFinished = event.detail?.status === statuses.FINISH;
        const isActive = engineActionActive[action];
        consume(event);
        if (!isActive) {
            if (action === "reset") requestReset(event);
            else requestStop(event);
        }
        engineActionActive[action] = !isFinished;
    }

    function handleEngineToggle(event) {
        if (typeof runCallbacks.onToggleVerbose !== "function") return;
        const status = event.detail?.status;
        const isStart = status === statuses.START ||
            String(status).toLowerCase() === "start";
        const isFinished = status === statuses.FINISH ||
            String(status).toLowerCase() === "finish";
        if (!isStart && !isFinished && status != null) return;
        consume(event);
        if (!isFinished) requestToggleVerbose();
    }

    function onEngineInput(event) {
        if (disposed) return;
        const detail = event.detail || {};
        const name = typeof detail.name === "string"
            ? detail.name.toLowerCase() : "";
        let isCancel = false;
        // Use the game's cancel helper when available; raw action names vary.
        try {
            isCancel = typeof event.isCancelInput === "function" &&
                event.isCancelInput() === true;
        } catch (ignored) {}

        if (isCancel || name === "back" ||
            name === "cancel" || name === "ui-back") {
            handleEngineAction(event, "stop");
            return;
        }

        if (name === "shell-action-1") {
            handleEngineAction(event, "reset");
            return;
        }

        if (name === "shell-action-2" || name === "shell-action-y" ||
            name === "button-y" || name === "gamepad-y" || name === "y") {
            handleEngineToggle(event);
            return;
        }
    }

    function pollGamepad() {
        const navigator = typeof window.navigator?.getGamepads === "function"
            ? window.navigator : globalThis.navigator;
        if (!navigator || typeof navigator.getGamepads !== "function") return;

        let pads;
        try {
            pads = navigator.getGamepads();
        } catch (ignored) {
            return;
        }

        let pad = null;
        let fallbackPad = null;
        for (let index = 0; index < pads.length; index++) {
            const candidate = pads[index];
            if (!candidate || candidate.connected === false) continue;
            if (!fallbackPad && candidate.buttons?.length >= 4)
                fallbackPad = candidate;
            if (candidate.mapping === "standard") {
                pad = candidate;
                break;
            }
        }
        if (!pad) pad = fallbackPad;
        if (!pad) {
            controllerPrevious = Object.create(null);
            return;
        }

        function pressed(index) {
            return Boolean(pad.buttons[index] && pad.buttons[index].pressed);
        }

        // Standard Gamepad layout: Nintendo B is south (0), Y is west (2), X is north (3).
        for (const button of [0, 2, 3]) {
            const current = pressed(button);
            if (current && controllerPrevious[button] !== true) {
                if (button === 3) requestReset();
                else if (button === 2) requestToggleVerbose();
                else requestStop();
            }
            controllerPrevious[button] = current;
        }
    }

    window.addEventListener("engine-input", onEngineInput, true);

    inputTimer = setInterval(pollGamepad, 40);

    const controls = {
        version: INPUT_CONTROL_VERSION,
        setRunCallbacks(callbacks = {}) {
            runCallbacks = callbacks;
            engineActionActive.reset = false;
            engineActionActive.stop = false;
            lastResetRequest = 0;
            lastVerboseToggleAt = 0;
        },
        clearRunActions() {
            runCallbacks = {onResetTimings: null, onStop: null,
                onToggleVerbose: null};
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (inputTimer !== null) clearInterval(inputTimer);
            window.removeEventListener("engine-input", onEngineInput, true);
            if (globalThis[INPUT_CONTROL_STATE_KEY] === controls)
                delete globalThis[INPUT_CONTROL_STATE_KEY];
        }
    };
    globalThis[INPUT_CONTROL_STATE_KEY] = controls;
    return controls;
}

function removeLegacyOutput(document) {
    const state = globalThis[LEGACY_STATE_KEY];
    const output = state?.output ||
        document.querySelector('[aria-label="' + LOG_LABEL + '"]');
    if (output?.parentNode) output.parentNode.removeChild(output);
}

function formatTimestamp(date) {
    const twoDigits = value => String(value).padStart(2, "0");
    const threeDigits = value => String(value).padStart(3, "0");
    return twoDigits(date.getHours()) + ":" +
        twoDigits(date.getMinutes()) + ":" +
        twoDigits(date.getSeconds()) + "." +
        threeDigits(date.getMilliseconds());
}

function applyConsoleStyle(output, document) {
    const viewportWidth = Number(document.documentElement?.clientWidth) ||
        Number(globalThis.innerWidth) || 0;
    const compact = viewportWidth > 0 && viewportWidth <= 700;

    Object.assign(output.style, {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "2147483647",
        boxSizing: "border-box",
        margin: "0",
        padding: "10px 0 22px",
        overflowY: "hidden",
        overflowX: "hidden",
        fontFamily: "Consolas, 'Liberation Mono', monospace",
        fontSize: compact ? "15px" : "18px",
        lineHeight: "1.5",
        background: "#282c34",
        color: "#f2f3f5",
        whiteSpace: "normal",
        overscrollBehavior: "contain"
    });
    return compact;
}

function applyLegacyConsoleStyle(output, document) {
    const viewportWidth = Number(document.documentElement?.clientWidth) ||
        Number(globalThis.innerWidth) || 0;
    const compact = viewportWidth > 0 && viewportWidth <= 700;
    const fontSize = compact ? "15px" : "18px";
    const timeFontSize = compact ? "12px" : "14px";
    const timeMargin = compact ? "12px" : "18px";

    Object.assign(output.style, {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "2147483647",
        boxSizing: "border-box",
        margin: "0",
        padding: "10px 14px 22px",
        overflowY: "hidden",
        overflowX: "hidden",
        fontFamily: "Consolas, 'Liberation Mono', monospace",
        fontSize,
        lineHeight: "1.5",
        background: "#282c34",
        color: "#e8ece8",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        overscrollBehavior: "contain"
    });

    const children = output.children || [];
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child.tagName !== "SPAN") continue;
        Object.assign(child.style, {
            display: "inline-block",
            width: "13ch",
            marginRight: timeMargin,
            verticalAlign: "top",
            color: "#9bcaff",
            whiteSpace: "nowrap",
            fontSize: timeFontSize,
            lineHeight: "1.5",
            userSelect: "none"
        });
    }
}

function addLogRows(output, document, message, timestamp, compact) {
    const lines = message.replace(/\r\n?/g, "\n").split("\n");
    for (const line of lines) {
        const row = document.createElement("div");
        Object.assign(row.style, {
            display: "flex",
            alignItems: "center",
            boxSizing: "border-box",
            padding: compact ? "3px 10px" : "3px 14px",
            fontSize: compact ? "15px" : "18px",
            lineHeight: "1.5"
        });

        const stamp = document.createElement("span");
        stamp.textContent = timestamp;
        Object.assign(stamp.style, {
            color: "#9bcaff",
            flex: "0 0 13ch",
            whiteSpace: "nowrap",
            fontSize: compact ? "12px" : "14px",
            lineHeight: "1.5",
            userSelect: "none",
            marginRight: compact ? "12px" : "18px"
        });

        const content = document.createElement("span");
        content.textContent = line || "\u00a0";
        Object.assign(content.style, {
            minWidth: "0",
            color: "#e8ece8",
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
            wordBreak: "break-word"
        });

        row.appendChild(stamp);
        row.appendChild(content);
        output.appendChild(row);
    }
}

function isNearBottom(output) {
    if (!output) return true;
    const remaining = output.scrollHeight - output.clientHeight - output.scrollTop;
    const fontSize = Number.parseFloat(output.style.fontSize) || 16;
    return remaining <= Math.max(2, fontSize * 0.5);
}
