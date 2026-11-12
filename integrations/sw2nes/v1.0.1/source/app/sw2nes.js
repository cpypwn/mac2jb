/* SW2NES: NES emulator app for CivHomebrew. Keep this script last: the async
 * IIFE's promise is the app lifetime and settles only after cleanup. */
(async function () {
  "use strict";
  var APP_ID = "sw2nes";
  var previous = window.__civswitchApp;
  if (previous && typeof previous.close === "function") await previous.close();

  var ROM_DIR = "save:/nes";
  var DATA_PARENT = "save:/civhomebrew/data";
  var DATA_DIR = DATA_PARENT + "/sw2nes";
  var NES_RATE = 60.0988;
  var MAX_CATCHUP = 6, MIN_DRAW = 1 / 6, TARGET_LOAD = 0.96;
  // Npad button bits (nn::hid::NpadButton).
  var BTN = { A: 1, B: 2, X: 4, Y: 8, L: 64, R: 128, ZL: 256, ZR: 512, PLUS: 1024, MINUS: 2048,
    LEFT: 4096, UP: 8192, RIGHT: 16384, DOWN: 32768, SL: 65536, SU: 131072, SR: 262144, SD: 524288 };
  var NES = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  var FACE_TARGETS = [1, 2];  // NES A, NES B (turbo variants reuse these)

  var N = typeof SW2NESNative !== "undefined" && SW2NESNative.available ? SW2NESNative : null;
  var nativeError = typeof SW2NESNative !== "undefined" && SW2NESNative.error ? SW2NESNative.error : "";
  var preview = window.SW2NESPreview || null;
  var finish, closed = false, lifetime = new Promise(function (r) { finish = r; });
  var removers = [], diagnostics = [];
  function record(message) { diagnostics.push({ time: Date.now(), message: String(message).slice(0, 400) }); if (diagnostics.length > 64) diagnostics.shift(); }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }

  /* ---------------- DOM ---------------- */
  function node(tag, parent, style, text) {
    var e = document.createElement(tag); Object.assign(e.style, style || {});
    if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e;
  }
  var C = { bg: "#0b0d12", panel: "#151924", line: "#2a3142", text: "#eef1f7", dim: "#9aa3b5", accent: "#e4463b", sel: "#2b3550" };
  var root = node("div", document.body, { position: "fixed", left: "0", top: "0", right: "0", bottom: "0", backgroundColor: C.bg,
    color: C.text, fontFamily: "Arial, sans-serif", zIndex: "10", overflow: "hidden", outline: "none" });
  root.id = APP_ID; root.tabIndex = -1;

  // ROM browser screen
  // ROM list: full-screen background with a centred window, 50% wide and as
  // tall as the list needs (up to 90% of the screen); a scrollbar shows when
  // there are more games than fit.
  var VISIBLE = 1, ROW_H = 40, rows = [];
  var browser = node("div", root, { position: "absolute", left: "0", top: "0", right: "0", bottom: "0", display: "flex", alignItems: "center", justifyContent: "center" });
  var browserWin = node("div", browser, { width: "50%", maxHeight: "90%", display: "flex", flexDirection: "column", padding: "18px 20px", boxSizing: "border-box",
    backgroundColor: C.panel, border: "1px solid " + C.line, borderRadius: "14px" });
  var header = node("div", browserWin, { display: "flex", flexDirection: "row", alignItems: "center", marginBottom: "12px", flexShrink: "0" });
  node("div", header, { width: "10px", height: "26px", backgroundColor: C.accent, marginRight: "10px", borderRadius: "2px" });
  node("div", header, { fontSize: "26px", fontWeight: "bold" }, "SW2NES");
  var count = node("div", header, { fontSize: "16px", color: C.dim, marginLeft: "12px" }, "");
  // View tabs above the list: All / Favourites (A-Z) / Recent (newest first).
  var LIST_VIEWS = ["All", "Favourites", "Recent"], listView = 0;
  var tabRow = node("div", browserWin, { display: "flex", flexDirection: "row", marginBottom: "10px", flexShrink: "0" });
  var tabBtns = LIST_VIEWS.map(function (t) { return node("div", tabRow, { padding: "6px 16px", marginRight: "8px", fontSize: "17px", borderRadius: "16px", border: "1px solid " + C.line }, t); });
  var listWrap = node("div", browserWin, { display: "flex", flexDirection: "row", flexShrink: "0" });
  var listBox = node("div", listWrap, { display: "flex", flexDirection: "column", flexGrow: "1", border: "1px solid " + C.line, borderRadius: "10px", backgroundColor: C.bg, padding: "6px", boxSizing: "border-box", overflow: "hidden" });
  var scrollTrack = node("div", listWrap, { position: "relative", width: "8px", marginLeft: "8px", borderRadius: "4px", backgroundColor: C.line, display: "none", flexShrink: "0" });
  var scrollThumb = node("div", scrollTrack, { position: "absolute", left: "0", width: "8px", borderRadius: "4px", backgroundColor: C.dim });
  var footer = node("div", browserWin, { fontSize: "16px", color: C.dim, marginTop: "8px", whiteSpace: "pre", flexShrink: "0", display: "none" }, "");
  // Visible buttons under the list (no hidden button mappings needed).
  function uiButton(parent, text) { return node("div", parent, { flexGrow: "1", textAlign: "center", fontSize: "18px", padding: "9px 0", margin: "0 5px", borderRadius: "8px", border: "1px solid " + C.line, backgroundColor: C.bg }, text); }
  var btnRow = node("div", browserWin, { display: "flex", flexDirection: "row", marginTop: "12px", flexShrink: "0" });
  var BROWSER_BUTTONS = ["Settings", "Refresh", "Exit"], browserBtns = BROWSER_BUTTONS.map(function (t) { return uiButton(btnRow, t); });
  var focusArea = "list", btnIndex = 0;
  // Settings window (defaults for all games), same style as the list window.
  var settingsWin = node("div", browser, { width: "50%", maxHeight: "90%", display: "none", flexDirection: "column", padding: "18px 20px", boxSizing: "border-box",
    backgroundColor: C.panel, border: "1px solid " + C.line, borderRadius: "14px" });
  var settingsHead = node("div", settingsWin, { display: "flex", flexDirection: "row", alignItems: "center", marginBottom: "12px" });
  node("div", settingsHead, { width: "10px", height: "26px", backgroundColor: C.accent, marginRight: "10px", borderRadius: "2px" });
  node("div", settingsHead, { fontSize: "26px", fontWeight: "bold" }, "Settings");
  node("div", settingsHead, { fontSize: "16px", color: C.dim, marginLeft: "12px" }, "for all games");
  var settingsWrap = node("div", settingsWin, { display: "flex", flexDirection: "row" });
  var settingsList = node("div", settingsWrap, { display: "flex", flexDirection: "column", flexGrow: "1", border: "1px solid " + C.line, borderRadius: "10px", backgroundColor: C.bg, padding: "6px", overflow: "hidden" });
  var setTrack = node("div", settingsWrap, { position: "relative", width: "8px", marginLeft: "8px", borderRadius: "4px", backgroundColor: C.line, display: "none", flexShrink: "0" });
  var setThumb = node("div", setTrack, { position: "absolute", left: "0", width: "8px", borderRadius: "4px", backgroundColor: C.dim });
  var settingsRows = [], settingsIndex = 0, settingsTop = 0, SET_ROW_H = 34;
  function listRow(i) {
    while (rows.length <= i) {
      var row = node("div", listBox, { display: "none", flexDirection: "row", alignItems: "center", height: ROW_H + "px", padding: "0 12px", borderRadius: "6px", fontSize: "20px", flexShrink: "0" });
      var label = node("div", row, { flexGrow: "1", overflow: "hidden", whiteSpace: "nowrap" }, "");
      var tag = node("div", row, { fontSize: "14px", marginLeft: "12px", padding: "2px 8px", borderRadius: "4px", whiteSpace: "nowrap" }, "");
      rows.push({ row: row, label: label, tag: tag });
    }
    return rows[i];
  }
  // Rows that fit in 90% of the screen height, after the window's header and footer.
  function maxRows() {
    var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 720;
    return Math.max(3, Math.floor((vh * 0.9 - 36 - 38 - 44 - 12 - 30 - 14) / ROW_H));  // padding, header, tabs, list padding, buttons, gaps
  }
  var emptyNote = node("div", listBox, { display: "none", whiteSpace: "pre-wrap", fontSize: "17px", lineHeight: "1.45", color: C.text, padding: "10px" }, "");

  // Game screen
  var game = node("div", root, { position: "absolute", left: "0", top: "0", right: "0", bottom: "0", display: "none", backgroundColor: "#000" });
  // Pixel-exact display: integer scale (square pixels), no smoothing.
  var liveImage = node("div", game, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", backgroundSize: "100% 100%", backgroundRepeat: "no-repeat", imageRendering: "pixelated" });
  // CRT filter: a tiled scanline pattern composited over the picture (no CPU cost).
  var crtOverlay = node("div", game, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "none", zIndex: "2", backgroundRepeat: "repeat", imageRendering: "pixelated" });
  var crtOverlay2 = node("div", game, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "none", zIndex: "2", imageRendering: "pixelated" });
  var crtOn = true, crtStyle = 5, crtScale = 0;  // default: Scanlines + grille
  // Picture geometry: pixel aspect, scaling and edge crop (in NES pixels).
  var ASPECTS = ["1:1", "8:7", "4:3", "Stretch"], SCALES = ["Integer", "Fit"], CROPS = ["None", "Sides", "All edges"];
  // Filter density: pattern cells per NES pixel along each axis (1 = one scanline/dot per pixel).
  var DENSITIES = ["1x", "2x", "3x", "4x"], crtDensity = 0;
  var aspectMode = 1, scaleMode = 0, cropMode = 1, picSX = 0, picSY = 0, picW = 0, picH = 0, picOX = 0, picOY = 0;
  // Native video buffers rotated per frame (1 = single buffer, as before 0.9.17).
  var displayMode = "texture", texture2 = null, videoBuffers = 3, motionTest = false, motionSave = 0, MOTION_ROWS = 16;
  var canvas = null, canvasWrap = null, ctx2d = null, imageData = null, shownUrl = "", videoFallback = "";
  // Stats bar (top left): level 1 = FPS, 2 = all numbers, 3 = numbers + frametime graph, on one line.
  var STATS_LEVELS = ["Off", "FPS", "Full", "Full + graph"], statsLevel = 0;
  var statsBar = node("div", game, { position: "absolute", zIndex: "3", left: "16px", top: "12px", display: "none", flexDirection: "row", alignItems: "center", backgroundColor: "rgba(0,0,0,0.6)", padding: "4px 10px", borderRadius: "6px" });
  var stats = node("div", statsBar, { fontSize: "18px", color: "#9dfc9d", whiteSpace: "pre", fontFamily: "Courier New, monospace" }, "");
  // Frametime graph: time between displayed frames, scrolling left (newest at the right), 2 px per frame.
  var GRAPH_STEP = 2, GRAPH_FRAMES = 240, GRAPH_W = GRAPH_STEP * GRAPH_FRAMES, GRAPH_H = 40, GRAPH_MAX_MS = 33.4, graphMs = 0;  // 16.7 ms sits in the middle
  var graph = node("canvas", statsBar, { width: GRAPH_W + "px", height: GRAPH_H + "px", marginLeft: "12px", display: "none" });
  graph.width = GRAPH_W; graph.height = GRAPH_H;
  var graphCtx = null; try { graphCtx = graph.getContext("2d"); } catch (e) { graphCtx = null; }
  // Hidden scratch canvas for scrolling: copying a canvas onto itself can smear
  // on the console (overlapping copy), filling the area under the line.
  var graphBuf = null, graphBufCtx = null;
  try { graphBuf = document.createElement("canvas"); graphBuf.width = GRAPH_W; graphBuf.height = GRAPH_H; graphBufCtx = graphBuf.getContext("2d"); } catch (e) { graphBufCtx = null; }
  var graphAt = 0;
  var testLabel = node("div", game, { position: "absolute", zIndex: "4", left: "50%", top: "40%", transform: "translateX(-50%)", fontSize: "44px", fontWeight: "bold", color: "#ffd84a", backgroundColor: "rgba(0,0,0,0.75)", padding: "10px 24px", borderRadius: "10px", display: "none" }, "");
  var toast = node("div", game, { position: "absolute", zIndex: "3", left: "50%", bottom: "28px", transform: "translateX(-50%)", fontSize: "20px", backgroundColor: "rgba(10,12,18,0.85)", padding: "10px 18px", borderRadius: "8px", display: "none" }, "");
  var hint = node("div", game, { position: "absolute", zIndex: "3", right: "16px", bottom: "12px", fontSize: "16px", color: "#8891a4" }, "L + R: Menu");

  // Pause menu
  var menu = node("div", root, { position: "absolute", zIndex: "10", left: "0", top: "0", right: "0", bottom: "0", display: "none", backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" });
  var menuPanel = node("div", menu, { display: "flex", flexDirection: "column", width: "460px", padding: "26px", backgroundColor: C.panel, border: "1px solid " + C.line, borderRadius: "14px" });
  var menuTitle = node("div", menuPanel, { fontSize: "26px", fontWeight: "bold", marginBottom: "14px", overflow: "hidden", whiteSpace: "nowrap" }, "Paused");
  var menuItems = [];

  // Message screen
  var message = node("div", root, { position: "absolute", zIndex: "11", left: "0", top: "0", right: "0", bottom: "0", display: "none", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.75)" });
  var messagePanel = node("div", message, { maxWidth: "760px", padding: "30px", backgroundColor: C.panel, border: "1px solid " + C.line, borderRadius: "14px", fontSize: "22px", lineHeight: "1.45" });
  var messageText = node("div", messagePanel, { whiteSpace: "pre-wrap" }, "");
  node("div", messagePanel, { color: C.dim, fontSize: "18px", marginTop: "18px" }, "Press A or B to continue");

  function showToast(text, ms) { toast.textContent = text; toast.style.display = "block"; toastUntil = now() + (ms || 1800); }
  var toastUntil = 0;

  /* ---------------- Platform: input, video, audio, files ---------------- */
  var pad = null, keyBits = 0;
  var KEYMAP = { ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT, x: BTN.A, z: BTN.B, s: BTN.X, a: BTN.Y,
    Enter: BTN.PLUS, Shift: BTN.MINUS, q: BTN.L, w: BTN.R, Escape: BTN.B, Backspace: BTN.B };
  var PADMAP = [[0, BTN.B], [1, BTN.A], [2, BTN.Y], [3, BTN.X], [4, BTN.L], [5, BTN.R], [6, BTN.ZL], [7, BTN.ZR], [8, BTN.MINUS], [9, BTN.PLUS], [12, BTN.UP], [13, BTN.DOWN], [14, BTN.LEFT], [15, BTN.RIGHT]];
  var p2Bits = 0;  // player 2 buttons, read with player 1
  function readButtons() {
    var bits = keyBits | autoBits;
    if (pad) { try { bits |= pad.poll(); p2Bits = pad.player2(); } catch (e) { record("Controller: " + e.message); } }
    else if (navigator.getGamepads) {
      var pads; try { pads = navigator.getGamepads(); } catch (_) { pads = []; }
      var seen = 0; p2Bits = 0;
      for (var p = 0; p < pads.length; p++) {
        var gp = pads[p]; if (!gp) continue;
        if (seen++ === 1) { for (var m2 = 0; m2 < PADMAP.length; m2++) if (gp.buttons[PADMAP[m2][0]] && gp.buttons[PADMAP[m2][0]].pressed) p2Bits |= PADMAP[m2][1]; continue; }  // second pad = player 2
        for (var m = 0; m < PADMAP.length; m++) if (gp.buttons[PADMAP[m][0]] && gp.buttons[PADMAP[m][0]].pressed) bits |= PADMAP[m][1];
        if (gp.axes.length > 1) { if (gp.axes[0] < -0.5) bits |= BTN.SL; if (gp.axes[0] > 0.5) bits |= BTN.SR; if (gp.axes[1] < -0.5) bits |= BTN.SU; if (gp.axes[1] > 0.5) bits |= BTN.SD; }
      }
    }
    return bits;
  }
  function listen(target, name, fn) { target.addEventListener(name, fn, true); removers.push(function () { target.removeEventListener(name, fn, true); }); }
  function consume(e) { if (e.preventDefault) e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  // Keep the game's own UI from reacting while SW2NES is open.
  listen(window, "navigate-input", consume);
  listen(window, "engine-input", consume);
  listen(window, "keydown", function (e) { var k = KEYMAP[e.key] || KEYMAP[String(e.key).toLowerCase()]; if (k) keyBits |= k; consume(e); });
  listen(window, "keyup", function (e) { var k = KEYMAP[e.key] || KEYMAP[String(e.key).toLowerCase()]; if (k) keyBits &= ~k; consume(e); });

  var files = N ? N.files : {
    list: async function (dir) { return dir === ROM_DIR && preview ? preview.roms.map(function (r) { return { name: r.name, dir: false, size: r.size || 0 }; }) : null; },
    readInto: async function (path, heap, allocate, limit) {
      var name = path.slice(path.lastIndexOf("/") + 1);
      if (path.indexOf(ROM_DIR + "/") === 0 && preview) {
        var entry = preview.roms.find(function (x) { return x.name === name; }); if (!entry) return -1;
        var bytes = new Uint8Array(await (await fetch(entry.url)).arrayBuffer()); if (bytes.length > limit) throw Error("File too large");
        var target = allocate(bytes.length); heap().set(bytes, target); return bytes.length;
      }
      var saved = memoryStore[path]; if (!saved) return -1;
      var t = allocate(saved.length); heap().set(saved, t); return saved.length;
    },
    writeFrom: function (path, heap, pointer, length) { memoryStore[path] = heap.slice(pointer, pointer + length); },
    mkdir: function () {}, commit: function () {}, remove: function (p) { delete memoryStore[p]; }
  };
  var memoryStore = {};

  /* ---------------- Core ---------------- */
  if (typeof QuickNESCore !== "function") throw Error("The emulator runtime is missing from the package.");
  var core = await QuickNESCore({ print: record, printErr: record });
  function heap() { return core.HEAPU8; }
  var W = core._nes_width(), H = core._nes_height(), FRAME_BYTES = W * H * 4;
  var videoFormat = 28; // DXGI code; 85 (16-bit) only when a test plan asks for it

  /* ---------------- State ---------------- */
  var mode = "browser", roms = [], selected = 0, top = 0;
  var running = null; // {name, path, base, battery, sramHash, sramCheck, start, emitted}
  var texture = null, audio = null, showStats = false, turbo = 0;
  var pollMs = 0, held = 0, lastBits = 0, repeatAt = 0, comboLatch = false, frameHandle = null, timerHandle = null;
  var history = [], tickCount = 0, tickHist = [0, 0, 0], pendingFrame = false, presentEarly = false, lastTick = 0, tickGaps = acc(), presentOffsets = acc(), autoBits = 0, autotest = null, sessionStart = 0;
  // Pacing: "locked" runs exactly one NES frame per display tick while the
  // display is within 1.5 Hz of the NES rate, and stretches audio by the rate
  // difference instead of running an extra frame to catch up (which overran
  // the frame budget and dropped a frame every few seconds). "clock" is the
  // older wall-clock pacing, kept for other display rates and A/B tests.
  var DEFER_MS = 12, padMs = 0, padTotal = 0, deferred = 0, deferConvert = true, deferredConverts = 0, pacingMode = "locked", locked = false, tickMs = 1000 / 60, audioRatio = 1, pendEma = 0, ratioTicks = 0, AUDIO_TARGET = 3;
  // Spike log: timings of the last two ticks, captured when a display gap
  // exceeds 24 ms (a missed refresh).
  var REC = 10, recCur = new Float64Array(REC), recPrev = new Float64Array(REC), spikes = [], spikeCount = 0, lateCount = 0;
  var drawFrac = 1, drawAcc = 0, emaSkip = 0, emaRender = 0, renderSamples = 0;
  var emuCount = 0, videoCount = 0, statsAt = 0, workMs = 0, emuMs = 0, videoMs = 0, audioMs = 0, inputMs = 0;

  function sanitize(name) { return name.replace(/\.nes$/i, "").replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 80) || "game"; }
  function hashSram() {
    var h = 2166136261 | 0, p = core._nes_sram(), u8 = heap(), mul = Math.imul;
    for (var i = 0, n = core._nes_sram_size(); i < n; i++) h = mul(h ^ u8[p + i], 16777619);
    return h;
  }
  var SETTINGS = DATA_DIR + "/settings.json";
  function saveSettings() {
    // While a game uses its own settings, those values go to the game's file and
    // the global file keeps the all-games values.
    var g = running && running.perGame ? running.globalVals : gameValues();
    if (running && running.perGame) {
      try { writeText(running.base + ".settings.json", JSON.stringify(gameValues())); } catch (e) { record("Game settings save: " + e.message); }
    }
    try { writeText(SETTINGS, JSON.stringify({ v: 6, crt: g.crt, stats: statsLevel > 0, statsLevel: statsLevel, buffers: videoBuffers, aspect: g.aspect, scale: g.scale, crop: g.crop, density: crtDensity,
      faces2: g.faces, turbo: g.turbo, palette: g.palette, volume: g.volume, filter: g.filter, recent: recentGames, favourites: favourites, autoLoad: autoLoadState, pauseMenu: pauseInMenu, dimMenu: dimInMenu })); }
    catch (e) { record("Settings save: " + e.message); }
  }
  async function loadSettings() {
    try {
      var t = await readText(SETTINGS); if (!t) return; var v = JSON.parse(t);
      var pick = function (x, n, d) { return typeof x === "number" && x >= 0 && x < n ? x | 0 : d; };
      if (Array.isArray(v.faces2)) setGameValues({ faces: v.faces2 });
      else if (Array.isArray(v.faces) && v.faces.length === 4) setGameValues({ faces: v.faces.map(function (x) { return x === 2 ? 4 : x; }) });  // old "None" was 2
      setGameValues({ turbo: v.turbo, palette: v.palette, volume: v.volume, filter: v.filter });
      if (Array.isArray(v.recent)) recentGames = v.recent.filter(function (x) { return typeof x === "string"; }).slice(0, RECENT_MAX);
      if (Array.isArray(v.favourites)) favourites = v.favourites.filter(function (x) { return typeof x === "string"; });
      if (typeof v.autoLoad === "boolean") autoLoadState = v.autoLoad; if (typeof v.pauseMenu === "boolean") pauseInMenu = v.pauseMenu; if (typeof v.dimMenu === "boolean") dimInMenu = v.dimMenu;
      aspectMode = pick(v.aspect, ASPECTS.length, aspectMode); scaleMode = pick(v.scale, SCALES.length, scaleMode); cropMode = pick(v.crop, CROPS.length, cropMode);
      if (v.v !== 2 && v.v !== 3 && v.v !== 4 && v.v !== 5 && v.v !== 6) { if (typeof v.buffers === "number") videoBuffers = v.buffers === 1 ? 1 : 3; aspectMode = 1; scaleMode = 0; saveSettings(); return; }  // pre-v2 settings: take the new defaults (stats off, LCD matrix, 8:7, Integer)
      if (v.v === 2 || v.v === 3) { aspectMode = 1; scaleMode = 0; }  // -> v4: 8:7 and Integer become the defaults once
      crtStyle = typeof v.crt === "number" ? Math.max(0, Math.min(CRT_STYLES.length - 1, v.crt | 0)) : (v.crt === false ? 0 : 1); crtOn = crtStyle > 0; if (typeof v.statsLevel === "number" && v.statsLevel >= 0 && v.statsLevel < STATS_LEVELS.length) statsLevel = v.statsLevel | 0; else if (typeof v.stats === "boolean") statsLevel = v.stats ? 3 : 0; showStats = statsLevel > 0; if (v.buffers === 1 || v.buffers === 3) videoBuffers = v.buffers;
      if (CRT_CHOICES.indexOf(crtStyle) < 0 || v.v !== 6) { crtStyle = 5; crtOn = true; }  // -> v6: Scanlines + grille default once; removed styles fall back to it
      if (v.v !== 6) saveSettings();
    }
    catch (e) { record("Settings load: " + e.message); }
  }
  function ensureDirs() {
    try { files.mkdir(ROM_DIR); files.mkdir(DATA_PARENT); files.mkdir(DATA_DIR); files.commit(); }
    catch (e) { record("Directory setup: " + e.message); }
  }

  // List order: favourites, then recently played (newest first), then the rest A-Z.
  // The shown list for the current view: All = favourites, recent, then A-Z;
  // Favourites = A-Z; Recent = most recently played first.
  var allRoms = [];
  function orderRoms() {
    var cur = roms[selected] && roms[selected].name, list;
    if (listView === 1) list = allRoms.filter(function (r) { return favourites.indexOf(r.name) >= 0; }).sort(function (a, b) { return naturalCompare(a.name, b.name); });
    else if (listView === 2) list = recentGames.map(function (n) { return allRoms.find(function (r) { return r.name === n; }); }).filter(Boolean);
    else {
      var rank = function (r) { var f = favourites.indexOf(r.name); if (f >= 0) return [0, 0]; var k = recentGames.indexOf(r.name); return k >= 0 ? [1, k] : [2, 0]; };
      list = allRoms.slice().sort(function (a, b) { var x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || naturalCompare(a.name, b.name); });
    }
    roms = list; selected = 0; top = 0;
    if (cur) { var i = roms.findIndex(function (r) { return r.name === cur; }); if (i >= 0) selected = i; }
  }
  function setListView(v) { if (v === listView) return; listView = v; roms = []; orderRoms(); paintBrowser(); }
  async function scan() {
    var entries = null;
    try { entries = await files.list(ROM_DIR); } catch (e) { record("List: " + e.message); }
    allRoms = (entries || []).filter(function (e) { return !e.dir && /\.nes$/i.test(e.name); });
    orderRoms();
    if (selected >= roms.length) selected = Math.max(0, roms.length - 1);
    paintBrowser();
  }
  // Settings screen entries: [label, choices, get, set]. All apply to every game.
  var autoLoadState = false, pauseInMenu = true, dimInMenu = true;
  // Face button remapping: Switch A, B, X, Y -> index into FACE_CHOICES (turbo = auto-fire).
  var FACE_KEYS = ["A", "B", "X", "Y"], FACE_CHOICES = ["NES A", "NES B", "Turbo A", "Turbo B", "None"], FACE_DEFAULT = [0, 0, 1, 1], faceMap = FACE_DEFAULT.slice();
  var TURBO_RATES = ["10 Hz", "15 Hz", "20 Hz", "30 Hz"], TURBO_PERIOD = [6, 4, 3, 2], turboRate = 1;
  // Colour palettes (generated NTSC decodes; "Default" is QuickNES's own) and audio options.
  var PALETTES = ["Default", "Vivid", "Natural", "Warm", "Soft", "Greyscale"], paletteMode = 0;
  // NTSC decode parameters per palette: [hue, saturation, gamma, brightness, contrast].
  // QuickNES's own palette is this decode at hue 4.0, saturation 1.55, gamma 1.0.
  var PALETTE_PARAMS = [null, [4.0, 2.05, 1.0, 0, 1], [4.0, 1.4, 1.15, 0, 1], [4.35, 1.6, 1.0, 0.01, 1], [4.0, 1.2, 0.95, 0.04, 0.9], [4.0, 0, 1.0, 0, 1]];
  // NES composite signal -> YIQ -> RGB, for all 512 colours (incl. emphasis); method from the NESdev wiki.
  function ntscPalette(hue, sat, gamma, bright, contrast) {
    var black = 0.518, white = 1.962, att = 0.746, levels = [0.350, 0.518, 0.962, 1.550, 1.094, 1.506, 1.962, 1.962], out = new Uint8Array(512 * 3);
    for (var px = 0; px < 512; px++) {
      var color = px & 15, level = (px >> 4) & 3, emph = px >> 6;
      if (color > 13) level = 1;
      var lo = levels[level], hi = levels[4 + level];
      if (color === 0) lo = hi; if (color > 12) hi = lo;
      var y = 0, i = 0, q = 0;
      for (var ph = 0; ph < 12; ph++) {
        var inPhase = function (c) { return (c + ph) % 12 < 6; };
        var sig = inPhase(color) ? hi : lo;
        if (((emph & 1) && inPhase(0)) || ((emph & 2) && inPhase(4)) || ((emph & 4) && inPhase(8))) sig *= att;
        var v = (sig - black) / (white - black);
        y += v; i += v * Math.cos(Math.PI * (ph + hue) / 6); q += v * Math.sin(Math.PI * (ph + hue) / 6);
      }
      y = y / 12 * contrast + bright; i = i / 12 * sat; q = q / 12 * sat;
      var rgb = [y + 0.946882 * i + 0.623557 * q, y - 0.274788 * i - 0.635691 * q, y - 1.108545 * i + 1.709007 * q];
      for (var k = 0; k < 3; k++) out[px * 3 + k] = Math.round(255 * Math.pow(Math.max(0, Math.min(1, rgb[k])), gamma));
    }
    return out;
  }
  // Applies palette and audio options to the running core.
  var paletteApplied = -1;
  function applyEmuOptions() {
    if (!running) return;
    if (paletteApplied !== paletteMode) {
      var pp = PALETTE_PARAMS[paletteMode];
      if (pp) { heap().set(ntscPalette(pp[0], pp[1], pp[2], pp[3], pp[4]), core._nes_palette_buffer()); core._nes_use_palette(1); }
      else core._nes_use_palette(0);
      paletteApplied = paletteMode;
    }
    core._nes_set_audio(Math.round(volumeLevel * 25.6), audioFilter);
  }
  var VOLUMES = ["0%", "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"], volumeLevel = 10;
  var FILTERS = ["Off", "Soft", "Strong"], audioFilter = 0;
  // Recent games (newest first) and favourites, by file name.
  var recentGames = [], favourites = [], RECENT_MAX = 5;
  // Settings that can be kept per game ("This game" in the in-game menu).
  var GAME_KEYS = ["aspect", "scale", "crop", "crt", "palette", "faces", "turbo", "volume", "filter"];
  function gameValues() { return { aspect: aspectMode, scale: scaleMode, crop: cropMode, crt: crtStyle, palette: paletteMode, faces: faceMap.slice(), turbo: turboRate, volume: volumeLevel, filter: audioFilter }; }
  function setGameValues(v) {
    var pick = function (x, n, d) { return typeof x === "number" && x >= 0 && x < n ? x | 0 : d; };
    aspectMode = pick(v.aspect, ASPECTS.length, aspectMode); scaleMode = pick(v.scale, SCALES.length, scaleMode); cropMode = pick(v.crop, CROPS.length, cropMode);
    if (typeof v.crt === "number" && CRT_CHOICES.indexOf(v.crt) >= 0) { crtStyle = v.crt; crtOn = crtStyle > 0; }
    paletteMode = pick(v.palette, PALETTES.length, paletteMode); turboRate = pick(v.turbo, TURBO_RATES.length, turboRate);
    volumeLevel = pick(v.volume, VOLUMES.length, volumeLevel); audioFilter = pick(v.filter, FILTERS.length, audioFilter);
    if (Array.isArray(v.faces) && v.faces.length === 4) faceMap = v.faces.map(function (x, i) { return pick(x, FACE_CHOICES.length, FACE_DEFAULT[i]); });
  }
  var OFF_ON = ["Off", "On"];
  var SETTINGS_ITEMS = [
    ["Aspect", ASPECTS, function () { return aspectMode; }, function (v) { aspectMode = v; }],
    ["Scale", SCALES, function () { return scaleMode; }, function (v) { scaleMode = v; }],
    ["Crop", CROPS, function () { return cropMode; }, function (v) { cropMode = v; }],
    ["CRT style", null, crtChoiceIndex, function (v) { crtStyle = CRT_CHOICES[v]; crtOn = crtStyle > 0; }],
    ["Palette", PALETTES, function () { return paletteMode; }, function (v) { paletteMode = v; }],
    ["Stats", STATS_LEVELS, function () { return statsLevel; }, function (v) { statsLevel = v; showStats = v > 0; }],
    ["Auto-load save state", OFF_ON, function () { return autoLoadState ? 1 : 0; }, function (v) { autoLoadState = !!v; }],
    ["Pause in menu", OFF_ON, function () { return pauseInMenu ? 1 : 0; }, function (v) { pauseInMenu = !!v; }],
    ["Dim game in menu", OFF_ON, function () { return dimInMenu ? 1 : 0; }, function (v) { dimInMenu = !!v; }],
    ["Volume", VOLUMES, function () { return volumeLevel; }, function (v) { volumeLevel = v; }],
    ["Audio filter", FILTERS, function () { return audioFilter; }, function (v) { audioFilter = v; }],
    ["Turbo speed", TURBO_RATES, function () { return turboRate; }, function (v) { turboRate = v; }],
    ["Switch A button", FACE_CHOICES, function () { return faceMap[0]; }, function (v) { faceMap[0] = v; }],
    ["Switch B button", FACE_CHOICES, function () { return faceMap[1]; }, function (v) { faceMap[1] = v; }],
    ["Switch X button", FACE_CHOICES, function () { return faceMap[2]; }, function (v) { faceMap[2] = v; }],
    ["Switch Y button", FACE_CHOICES, function () { return faceMap[3]; }, function (v) { faceMap[3] = v; }]
  ];
  // "< value >" selector drawn with CSS triangles (the console font lacks arrow glyphs).
  function valueBox(parent, style) {
    var box = node("div", parent, Object.assign({ display: "none", flexDirection: "row", alignItems: "center", whiteSpace: "nowrap", marginLeft: "16px" }, style || {}));
    var tri = function (left) { return node("div", box, { width: "0", height: "0", borderTop: "8px solid transparent", borderBottom: "8px solid transparent",
      borderLeft: left ? "0" : "11px solid " + C.dim, borderRight: left ? "11px solid " + C.dim : "0" }); };
    var l = tri(true), text = node("div", box, { margin: "0 10px" }, ""), r = tri(false);
    return { box: box, set: function (t, active) {
      box.style.display = t === null ? "none" : "flex"; if (t === null) return;
      text.textContent = t; var c = active ? C.text : C.dim; text.style.color = c; l.style.borderRightColor = c; r.style.borderLeftColor = c;
    } };
  }
  function settingChoices(i) { return SETTINGS_ITEMS[i][1] || crtChoiceNames(); }
  function openSettings() {
    mode = "settings"; settingsIndex = 0; browserWin.style.display = "none"; settingsWin.style.display = "flex"; paintSettings();
  }
  function closeSettings() {
    saveSettings(); mode = "browser"; settingsWin.style.display = "none"; browserWin.style.display = "flex"; paintBrowser();
  }
  function paintSettings() {
    var n = SETTINGS_ITEMS.length, total = n + 1;
    var vh = window.innerHeight || 720, vis = Math.max(5, Math.min(total, Math.floor((vh * 0.9 - 36 - 50 - 14) / SET_ROW_H)));
    if (settingsIndex < settingsTop) settingsTop = settingsIndex; if (settingsIndex >= settingsTop + vis) settingsTop = settingsIndex - vis + 1;
    while (settingsRows.length < vis) {
      var row = node("div", settingsList, { display: "flex", flexDirection: "row", alignItems: "center", height: SET_ROW_H + "px", padding: "0 12px", borderRadius: "6px", fontSize: "18px", flexShrink: "0" });
      settingsRows.push({ row: row, label: node("div", row, { flexGrow: "1" }, ""), value: valueBox(row) });
    }
    for (var k = 0; k < settingsRows.length; k++) {
      var r = settingsRows[k], i = settingsTop + k, active = i === settingsIndex;
      r.row.style.display = k < vis && i < total ? "flex" : "none";
      if (k >= vis || i >= total) continue;
      if (i < n) { r.label.textContent = SETTINGS_ITEMS[i][0]; r.value.set(settingChoices(i)[SETTINGS_ITEMS[i][2]()], active); }
      else { r.label.textContent = "Back"; r.value.set(null); }
      r.row.style.backgroundColor = active ? C.sel : "transparent";
      r.row.style.borderLeft = "4px solid " + (active ? C.accent : "transparent");
    }
    var listH = vis * SET_ROW_H + 12; settingsList.style.height = listH + "px";
    setTrack.style.display = total > vis ? "block" : "none";
    if (total > vis) {
      var th = Math.max(24, Math.round(listH * vis / total));
      setTrack.style.height = listH + "px"; setThumb.style.height = th + "px"; setThumb.style.top = Math.round((listH - th) * settingsTop / (total - vis)) + "px";
    }
  }

  function changeSetting(dir) {
    var it = SETTINGS_ITEMS[settingsIndex], n = settingChoices(settingsIndex).length;
    it[3]((it[2]() + dir + n) % n); paintSettings();
  }
  // Case-insensitive order with numbers compared by value ("Game 2" before "Game 10").
  function naturalCompare(a, b) {
    var x = a.toLowerCase().match(/\d+|\D+/g) || [], y = b.toLowerCase().match(/\d+|\D+/g) || [];
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      var nx = /^\d/.test(x[i]), ny = /^\d/.test(y[i]);
      if (nx && ny && +x[i] !== +y[i]) return +x[i] - +y[i];
      return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  }
  function paintBrowser() {
    count.textContent = roms.length ? roms.length + (roms.length === 1 ? " game" : " games") : "";
    emptyNote.style.display = roms.length ? "none" : "block";
    for (var ti = 0; ti < tabBtns.length; ti++) {
      var tOn = ti === listView, tFocus = focusArea === "tabs" && tOn;
      tabBtns[ti].style.backgroundColor = tFocus ? C.sel : tOn ? C.line : "transparent";
      tabBtns[ti].style.borderColor = tFocus ? C.accent : C.line; tabBtns[ti].style.color = tOn ? C.text : C.dim;
    }
    if (listView === 1) emptyNote.textContent = "No favourites yet.\n\nWhile playing, open the menu (L + R) and set Favourite to On.";
    else if (listView === 2) emptyNote.textContent = "No recently played games yet.";
    else emptyNote.textContent = "No games found.\n\nIn CivHomebrew press Y -> FTP and enable the server, then upload .nes files " +
      "with an FTP client into:\n\n    Root / nes\n\nPress X here to refresh the list.";
    VISIBLE = Math.max(1, Math.min(roms.length, maxRows()));
    if (selected < top) top = selected; if (selected >= top + VISIBLE) top = selected - VISIBLE + 1;
    if (top > Math.max(0, roms.length - VISIBLE)) top = Math.max(0, roms.length - VISIBLE);
    var listH = roms.length ? VISIBLE * ROW_H + 12 : 0;
    listBox.style.height = roms.length ? listH + "px" : "auto";
    for (var i = 0; i < Math.max(rows.length, VISIBLE); i++) {
      var rom = i < VISIBLE ? roms[top + i] : null, row = listRow(i);
      row.row.style.display = rom ? "flex" : "none";
      if (!rom) continue;
      var active = top + i === selected && focusArea === "list";
      row.label.textContent = rom.name.replace(/\.nes$/i, "");
      var fav = favourites.indexOf(rom.name) >= 0, rec = !fav && recentGames.indexOf(rom.name) >= 0;
      row.tag.textContent = fav ? "Favourite" : rec ? "Recent" : "";
      row.tag.style.display = fav || rec ? "block" : "none";
      row.tag.style.color = fav ? "#1a1300" : C.dim; row.tag.style.backgroundColor = fav ? "#f2c94c" : "transparent";
      row.row.style.backgroundColor = active ? C.sel : "transparent";
      row.row.style.borderLeft = "4px solid " + (active ? C.accent : "transparent");
    }
    var scroll = roms.length > VISIBLE;
    scrollTrack.style.display = scroll ? "block" : "none";
    if (scroll) {
      var trackH = listH, thumbH = Math.max(24, Math.round(trackH * VISIBLE / roms.length));
      scrollTrack.style.height = trackH + "px";
      scrollThumb.style.height = thumbH + "px";
      scrollThumb.style.top = Math.round((trackH - thumbH) * top / (roms.length - VISIBLE)) + "px";
    }
    if (!roms.length && focusArea === "list") focusArea = "buttons";
    for (var bi = 0; bi < browserBtns.length; bi++) {
      var on = focusArea === "buttons" && bi === btnIndex, b = browserBtns[bi];
      b.textContent = bi === 2 && exitArmed ? "Confirm exit" : BROWSER_BUTTONS[bi];
      b.style.backgroundColor = on ? C.sel : C.bg; b.style.borderColor = on ? C.accent : C.line;
      b.style.color = bi === 2 && exitArmed ? C.accent : C.text;
    }
    footer.style.display = "none";
  }

  function showMessage(text, then) { messageText.textContent = text; message.style.display = "flex"; messageThen = then || null; mode = "message"; }
  var messageThen = null;

  /* ---------------- Video / audio setup ---------------- */
  function openOutputs() {
    if (N) {
      try { audio = N.audio(6); } catch (e) { audio = null; record("Audio unavailable: " + e.message); showToast("Audio unavailable"); }
    }
    openVideo();
  }
  // Display path: "texture" = native live texture (uploaded by the engine's
  // renderer); "canvas" = 2D canvas putImageData (drawn in the UI's own frame).
  function openVideo() {
    if (N && (displayMode === "texture" || !canvasPixelsOk())) {
      core._nes_set_format16(videoFormat === 85 ? 1 : videoFormat === 86 ? 2 : 0);
      texture = N.texture(W, H, videoFormat, videoBuffers);
      liveImage.style.display = "block"; if (canvasWrap) canvasWrap.style.display = "none";
      return;
    }
    core._nes_set_format16(0);
    if (!canvas) {
      canvasWrap = node("div", game, { position: "absolute", zIndex: "1", overflow: "hidden" });
      canvas = node("canvas", canvasWrap, { position: "absolute", left: "0", top: "0", imageRendering: "pixelated" });
      canvas.width = W; canvas.height = H; ctx2d = canvas.getContext("2d"); imageData = ctx2d.createImageData(W, H);
    }
    canvasWrap.style.display = "block"; liveImage.style.display = "none"; fitPicture();
  }
  function canvasPixelsOk() {
    try { var c = document.createElement("canvas"), x = c.getContext("2d"); return !!x && typeof x.createImageData === "function" && typeof x.putImageData === "function"; } catch (e) { return false; }
  }
  function canvasCaps() {
    var out = {}; try { var c = document.createElement("canvas"), x = c.getContext("2d"); out.ctx = !!x;
      ["createImageData", "putImageData", "getImageData", "drawImage", "fillRect"].forEach(function (k) { out[k] = !!x && typeof x[k] === "function"; });
      out.ImageData = typeof ImageData; } catch (e) { out.error = String(e && e.message || e); } return out;
  }
  function switchDisplay(modeName) {
    displayMode = modeName;
    if (texture) { try { texture.close(); } catch (e) { record("Texture close: " + e.message); } texture = null; liveImage.style.backgroundImage = "none"; shownUrl = ""; }
    if (texture2) { try { texture2.close(); } catch (e) {} texture2 = null; }
    openVideo(); core._nes_reconvert(); present();
  }
  function reopenVideo() {
    if (!N || !texture) return;
    try { texture.close(); } catch (e) { record("Texture close: " + e.message); }
    texture = N.texture(W, H, videoFormat, videoBuffers); shownUrl = "";
    present();
  }
  // Motion test: a bar stepping 4 px per displayed frame across the top 16
  // rows, plus the frame number in binary (8 blocks of 32 px). Smooth delivery
  // shows an evenly gliding bar; a slow-motion video of the screen reveals
  // every repeated or skipped frame. The game pixels underneath are restored
  // after presenting, so emulation output is untouched.
  // Pixel test: alternating one-NES-pixel stripes (vertical in the top half,
  // horizontal in the bottom half). With identical pixel sizes the stripes
  // look perfectly even; any pixel drawn larger shows as repeating bands.
  var pixelTest = false, pixelSave = 0;
  function drawPixelTest(ptr) {
    var U = heap(), A = core.HEAPU32, n = W * H * 4, b = ptr >> 2, half = H >> 1;
    if (!pixelSave) pixelSave = core._malloc(n);
    U.copyWithin(pixelSave, ptr, ptr + n);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++)
      A[b + y * W + x] = (y < half ? x & 1 : y & 1) ? 0xffffffff : 0xff000000;
  }
  function drawMotionTest(ptr) {
    var U = heap(), A = core.HEAPU32, n = MOTION_ROWS * W * 4, f = videoCount;
    if (!motionSave) motionSave = core._malloc(n);
    U.copyWithin(motionSave, ptr, ptr + n);
    var b = ptr >> 2, x0 = (f * 4) % W;
    for (var y = 0; y < 10; y++) { A.fill(0xff000000, b + y * W, b + (y + 1) * W); A.fill(0xffffffff, b + y * W + x0, b + y * W + x0 + 4); }
    for (var k = 0; k < 8; k++) { var on = (f >> (7 - k)) & 1, c = on ? 0xff00ffff : 0xff400000; for (var y2 = 10; y2 < MOTION_ROWS; y2++) A.fill(c, b + y2 * W + k * 32 + 1, b + y2 * W + k * 32 + 31); }
  }
  function closeOutputs() {
    if (texture) { try { texture.close(); } catch (e) { record("Texture close: " + e.message); } texture = null; }
    if (texture2) { try { texture2.close(); } catch (e) { record("Texture close: " + e.message); } texture2 = null; }
    if (audio) { try { audio.close(); } catch (e) { record("Audio close: " + e.message); } audio = null; }
    liveImage.style.backgroundImage = "none"; shownUrl = "";
  }
  function base64(str) {
    if (typeof btoa === "function") return btoa(str);
    var T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = "", i, n;
    for (i = 0; i < str.length; i += 3) {
      n = (str.charCodeAt(i) << 16) | ((i + 1 < str.length ? str.charCodeAt(i + 1) : 0) << 8) | (i + 2 < str.length ? str.charCodeAt(i + 2) : 0);
      out += T[n >> 18 & 63] + T[n >> 12 & 63] + (i + 1 < str.length ? T[n >> 6 & 63] : "=") + (i + 2 < str.length ? T[n & 63] : "=");
    }
    return out;
  }
  // CRT styles: black-only overlays (they only ever darken, so black stays
  // black), drawn by the console's compositor with no per-frame CPU work (no
  // WebGL on the console). Lines are generated at real screen resolution and
  // placed on the exact screen pixels where the picture's NES pixel
  // boundaries fall, so they stay aligned at any aspect, scale or crop.
  var CRT_STYLES = ["Off", "Scanlines", "Soft scanlines", "Bold scanlines", "Aperture grille", "Scanlines + grille",
    "Slot mask", "Shadow mask", "Dot mask", "LCD matrix", "Screen door"];
  // Styles offered in the menus (internal ids; the mask styles are kept in code but not offered).
  var CRT_CHOICES = [0, 1, 2, 3, 4, 5, 9, 10];
  function crtChoiceNames() { return CRT_CHOICES.map(function (id) { return CRT_STYLES[id]; }); }
  function crtChoiceIndex() { var i = CRT_CHOICES.indexOf(crtStyle); return i < 0 ? 0 : i; }
  // For each screen pixel along one axis: the NES pixel it shows (nearest
  // neighbour, sampled at the pixel centre), its position from that NES
  // pixel's first and last screen pixel, and the NES pixel's size on screen.
  function axisMap(n, scale, offset) {
    var src = new Array(n), out = new Array(n), i, start = 0;
    for (i = 0; i < n; i++) src[i] = Math.floor((i + 0.5) / scale + offset);
    for (i = 0; i < n; i++) {
      if (i === n - 1 || src[i + 1] !== src[i]) {
        for (var j = start; j <= i; j++) out[j] = { src: src[j], fromStart: j - start, toEnd: i - j, size: i - start + 1 };
        start = i + 1;
      }
    }
    return out;
  }
  // Darkening (alpha 0-255) for each screen row / column, using every screen
  // pixel inside a NES pixel: v / u is the position across it (0..1, centre
  // 0.5) and d the distance from the centre (0 centre .. ~1 edge). Graded
  // profiles (bright centre fading to the edges) instead of one hard line.
  function pos(o) { return (o.fromStart + 0.5) / o.size; }
  // Distance from the cell centre (0) to its edge (1). Two-pixel cells (fine
  // densities) are one bright + one dark pixel; one-pixel cells get an even shade.
  function edge(o) { return o.size >= 3 ? Math.abs(pos(o) * 2 - 1) : o.size === 2 ? (o.fromStart ? 1 : 0) : 0.6; }
  function prof(d, strength, power) { return Math.round(strength * Math.pow(d, power)); }
  function rowAlpha(style, r) {
    var d = edge(r);
    switch (style) {
      case 1: return prof(d, 175, 2);    // scanlines: beam profile
      case 2: return prof(d, 105, 2.4);  // soft
      case 3: return prof(d, 235, 1.5);  // bold
      case 4: return prof(d, 60, 3);     // aperture grille: faint beam
      case 5: return prof(d, 160, 2);    // scanlines + grille
      case 9: return r.toEnd === 0 ? (r.size >= 3 ? 110 : 80) : 0;  // LCD: crisp gaps
      case 10: return r.toEnd === 0 ? 60 : 0;
    }
    return 0;
  }
  function colAlpha(style, c) {
    var d = edge(c);
    switch (style) {
      case 4: return prof(d, 130, 1.8);  // aperture grille: soft phosphor columns
      case 5: return prof(d, 75, 2.2);
      case 9: return c.toEnd === 0 ? (c.size >= 3 ? 110 : 80) : 0;
      case 10: return c.toEnd === 0 ? 60 : 0;
    }
    return 0;
  }
  function cellAlpha(style, c, r) {  // non-separable (round or staggered) styles
    var dx = edge(c), dy = edge(r);
    if (style === 6) {  // slot mask: soft columns, soft brick-staggered breaks between rows
      var col = prof(dx, 120, 2), brk = (c.src + r.src) & 1 ? prof(dy, 190, 2.5) : prof(dy, 60, 3);
      return Math.min(255, Math.max(col, brk));
    }
    if (style === 7 || style === 8) {  // shadow mask (staggered) / dot mask: round soft dots
      if (style === 7 && (r.src & 1)) dx = edge({ fromStart: (c.fromStart + (c.size >> 1)) % c.size, size: c.size });  // stagger by half a cell
      var rr = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 1.25);
      return prof(rr, style === 7 ? 200 : 185, 1.6);
    }
    return 0;
  }
  var crtKey = "", crtLayers = 1;
  function setLayer(el, url, w, h, repeat) {
    el.style.display = url ? "block" : "none";
    if (!url) return;
    el.style.backgroundImage = 'url("' + url + '")'; el.style.backgroundSize = (w / pixDpr) + "px " + (h / pixDpr) + "px";
    el.style.backgroundRepeat = repeat; el.style.backgroundPosition = "0 0";
  }
  function applyCrt() {
    var on = crtStyle > 0 && running && picW > 0;
    if (!on) { crtOverlay.style.display = "none"; crtOverlay2.style.display = "none"; return; }
    var key = [crtStyle, crtDensity, picW, picH, picSX, picSY, picOX, picOY, pixDpr].join(",");
    if (key === crtKey) { crtOverlay.style.display = "block"; crtOverlay2.style.display = crtLayers === 2 ? "block" : "none"; return; }
    crtKey = key;
    var st = crtStyle, A = function (a) { return [0, 0, 0, a]; };
    var m = crtDensity + 1, cols = axisMap(picW, picSX / m, picOX * m), rows = axisMap(picH, picSY / m, picOY * m);
    if (st === 6 || st === 7 || st === 8) {
      // Staggered patterns: a strip as wide as the picture and two NES rows
      // tall, repeated down (exact whenever the vertical scale is whole).
      // two NES rows of screen pixels, split into the density's pattern rows
      var k = Math.max(1, Math.round(picSY)), rowsK = axisMap(2 * k, k / m, 0);
      crtLayers = 1;
      setLayer(crtOverlay, rgbaPng(picW, 2 * k, function (x, yy) { return A(cellAlpha(st, cols[x], rowsK[yy])); }), picW, 2 * k, "repeat-y");
      setLayer(crtOverlay2, "", 0, 0, ""); return;
    }
    // Separable patterns: a row strip (1 px wide, picture-tall, repeated
    // across) and, for grilles/grids, a column strip (picture-wide, 1 px
    // tall, repeated down).
    var hasCols = st === 4 || st === 5 || st === 9 || st === 10;
    crtLayers = hasCols ? 2 : 1;
    setLayer(crtOverlay, rgbaPng(1, picH, function (x, y) { return A(rowAlpha(st, rows[y])); }), 1, picH, "repeat-x");
    setLayer(crtOverlay2, hasCols ? rgbaPng(picW, 1, function (x) { return A(colAlpha(st, cols[x])); }) : "", picW, 1, "repeat-y");
  }
  // Minimal PNG encoder (stored deflate) for small RGBA tiles: f(x, y) -> [r, g, b, a].
  function rgbaPng(w, h, f) {
    var raw = [];
    for (var y = 0; y < h; y++) { raw.push(0); for (var x = 0; x < w; x++) { var p = f(x, y); raw.push(p[0], p[1], p[2], p[3]); } }
    function crc32(bytes) { var c, crc = -1; for (var n = 0; n < bytes.length; n++) { c = (crc ^ bytes[n]) & 255; for (var b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
    function u32(n) { return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]; }
    function chunk(type, data) { var td = []; for (var i = 0; i < 4; i++) td.push(type.charCodeAt(i)); td = td.concat(data); return u32(data.length).concat(td, u32(crc32(td))); }
    var a = 1, b2 = 0; for (var i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b2 = (b2 + a) % 65521; }
    var z = [0x78, 0x01];
    for (var off = 0; off < raw.length || off === 0; off += 65535) {
      var len = Math.min(65535, raw.length - off), fin = off + len >= raw.length ? 1 : 0;
      z.push(fin, len & 255, len >> 8 & 255, ~len & 255, (~len >> 8) & 255);
      for (var j = off; j < off + len; j++) z.push(raw[j]);
      if (!len) break;
    }
    z = z.concat(u32(((b2 << 16) | a) >>> 0));
    var png = [137, 80, 78, 71, 13, 10, 26, 10].concat(chunk("IHDR", u32(w).concat(u32(h), [8, 6, 0, 0, 0])), chunk("IDAT", z), chunk("IEND", []));
    var str = ""; for (var q = 0; q < png.length; q++) str += String.fromCharCode(png[q]);
    return "data:image/png;base64," + base64(str);
  }
  // Places the picture, working in real screen (device) pixels: visible area
  // after crop, target pixel aspect, and scale. Integer: every NES pixel is
  // exactly sx x sy screen pixels, both whole numbers, picking the whole-number
  // shape closest to the chosen aspect (so pixels are all identical). Fit:
  // largest size at the exact aspect (pixel sizes may differ by one screen
  // pixel). Nearest-neighbour always. Cropping just offsets the image.
  var pixDpr = 1, viewInfo = "";
  function fitPicture() {
    var dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    var vwCss = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1280;
    var vhCss = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 720;
    var vw = Math.round(vwCss * dpr), vh = Math.round(vhCss * dpr);
    var cx = cropMode >= 1 ? 8 : 0, cy = cropMode >= 2 ? 8 : 0, cw = W - 2 * cx, ch = H - 2 * cy;
    // 8:7 = the NES's own pixel shape; 4:3 = the visible (cropped) picture shaped exactly 4:3.
    var par = aspectMode === 1 ? 8 / 7 : aspectMode === 2 ? (4 / 3) * ch / cw : 1, sx, sy;
    if (scaleMode === 0 && vh >= ch && vw >= cw) {
      var maxX = Math.floor(vw / cw), maxY = Math.floor(vh / ch);
      if (aspectMode === 3) { sx = maxX; sy = maxY; }
      else {
        // Largest whole-number height that fits, then the whole-number width
        // closest to the target shape (an exact 8:7 would need fractional pixels).
        sy = maxY; sx = Math.max(1, Math.min(maxX, Math.round(sy * par)));
        if (sx * cw > vw) { sx = maxX; }
      }
    } else if (aspectMode === 3) { sx = vw / cw; sy = vh / ch; }
    else { var fit = Math.min(vw / (cw * par), vh / ch); sy = fit; sx = fit * par; }
    var w = Math.round(cw * sx), h = Math.round(ch * sy), left = Math.floor((vw - w) / 2), top = Math.floor((vh - h) / 2);
    var css = function (v) { return (v / dpr) + "px"; };
    var box = { width: css(w), height: css(h), left: css(left), top: css(top) };
    Object.assign(liveImage.style, box); Object.assign(crtOverlay.style, box); Object.assign(crtOverlay2.style, box);
    liveImage.style.backgroundSize = css(W * sx) + " " + css(H * sy);
    liveImage.style.backgroundPosition = css(-cx * sx) + " " + css(-cy * sy);
    if (canvasWrap) { Object.assign(canvasWrap.style, box); Object.assign(canvas.style, { width: css(W * sx), height: css(H * sy), left: css(-cx * sx), top: css(-cy * sy) }); }
    pixDpr = dpr; picSX = sx; picSY = sy; picW = w; picH = h; picOX = cx; picOY = cy; crtScale = Math.max(1, Math.round(sy));
    var scr = typeof screen !== "undefined" ? screen.width + "x" + screen.height : "?";
    viewInfo = "Viewport " + vwCss + "x" + vhCss + " css, dpr " + dpr + " (" + vw + "x" + vh + " px), screen " + scr +
      "; NES pixel " + (Number.isInteger(sx) && Number.isInteger(sy) ? sx + "x" + sy : sx.toFixed(2) + "x" + sy.toFixed(2)) + " px; picture " + w + "x" + h + " px";
  }
  function scaleLabel() {
    return "Scale: " + SCALES[scaleMode] + (scaleMode === 0 && Number.isInteger(picSX) && Number.isInteger(picSY) && picSX ? " " + picSX + "x" + picSY : "");
  }


  // Displayed-frame times: the start of the refresh (tick) in which each frame
  // was presented. A gap of two refreshes means a refresh got no new frame.
  var presentTick = 0;
  var shownTimes = new Float64Array(601), shownHead = 0, shownCount = 0, worstGaps = new Float64Array(8);
  function noteShown(t) { shownTimes[shownHead] = t; shownHead = (shownHead + 1) % shownTimes.length; if (shownCount < shownTimes.length) shownCount++; }
  function resetShown() { shownHead = 0; shownCount = 0; resetGraph(); }
  // [average fps, 1% low fps] over the recorded window of displayed frames.
  function videoFps() {
    if (shownCount < 3) return [0, 0];
    var n = shownCount, L = shownTimes.length, first = shownTimes[(shownHead - n + L) % L], last = shownTimes[(shownHead - 1 + L) % L];
    // Keep the k largest gaps by insertion (k <= 6): no array or sort per second.
    var k = Math.max(1, Math.floor((n - 1) / 100)), top = worstGaps, m = 0, worst = 0;
    for (var i = 1; i < n; i++) {
      var g = shownTimes[(shownHead - n + i + L) % L] - shownTimes[(shownHead - n + i - 1 + L) % L];
      if (m < k) { var j = m++; while (j > 0 && top[j - 1] < g) { top[j] = top[j - 1]; j--; } top[j] = g; }
      else if (g > top[k - 1]) { var j2 = k - 1; while (j2 > 0 && top[j2 - 1] < g) { top[j2] = top[j2 - 1]; j2--; } top[j2] = g; }
    }
    for (var w = 0; w < k; w++) worst += top[w];
    return [(n - 1) * 1000 / (last - first), 1000 / (worst / k)];
  }
  // Sweep graph (like a heart monitor) of the time between displayed frames:
  // each displayed frame draws only its own segment and erases a few pixels
  // ahead, about 5 canvas calls instead of redrawing all GRAPH_FRAMES points
  // (which cost ~0.8 ms per frame on the console). A dim line marks 16.7 ms.
  var graphPrevY = -1, graphScrollOk = true, GRAPH_Y60 = GRAPH_H - Math.round(16.7 / GRAPH_MAX_MS * GRAPH_H);
  function applyStatsLevel() {
    showStats = statsLevel > 0;
    statsBar.style.display = statsLevel > 0 && running ? "flex" : "none";
    graph.style.display = statsLevel === 3 ? "block" : "none";
    if (statsLevel === 3) resetGraph();
  }
  function resetGraph() {
    graphPrevY = -1;
    if (!graphCtx) return;
    graphCtx.clearRect(0, 0, GRAPH_W, GRAPH_H);
    graphCtx.fillStyle = "rgba(255,255,255,0.3)"; graphCtx.fillRect(0, GRAPH_Y60, GRAPH_W, 1);
    graphCtx.strokeStyle = "#6ee26e"; graphCtx.lineWidth = 1.5;
  }
  // Classic scrolling graph: shift the image left by one step (a single
  // self-copy drawImage) and draw only the newest segment at the right edge.
  function drawGraph() {
    if (!graphCtx || shownCount < 2) return;
    var t0 = now(), g = graphCtx, L = shownTimes.length, S = GRAPH_STEP;
    var ms = shownTimes[(shownHead - 1 + L) % L] - shownTimes[(shownHead - 2 + L) % L];
    var y = GRAPH_H - Math.min(ms, GRAPH_MAX_MS) / GRAPH_MAX_MS * (GRAPH_H - 2) - 1;
    if (graphScrollOk && graphBufCtx) {
      try {
        graphBufCtx.clearRect(0, 0, GRAPH_W, GRAPH_H); graphBufCtx.drawImage(graph, 0, 0);       // snapshot
        g.clearRect(0, 0, GRAPH_W, GRAPH_H); g.drawImage(graphBuf, S, 0, GRAPH_W - S, GRAPH_H, 0, 0, GRAPH_W - S, GRAPH_H);  // shifted back
      } catch (e) { graphScrollOk = false; record("Graph scroll: " + e.message); }
    } else graphScrollOk = false;
    if (!graphScrollOk) { drawGraphFull(); graphMs += now() - t0; return; }
    g.clearRect(GRAPH_W - S, 0, S, GRAPH_H);
    g.fillStyle = "rgba(255,255,255,0.3)"; g.fillRect(GRAPH_W - S, GRAPH_Y60, S, 1);
    if (graphPrevY >= 0) { g.beginPath(); g.moveTo(GRAPH_W - S - 0.5, graphPrevY); g.lineTo(GRAPH_W - 0.5, y); g.stroke(); }
    graphPrevY = y;
    graphMs += now() - t0;
  }
  // Fallback if the canvas cannot copy onto itself: redraw the whole line.
  function drawGraphFull() {
    var g = graphCtx, L = shownTimes.length, n = Math.min(shownCount - 1, GRAPH_FRAMES);
    g.clearRect(0, 0, GRAPH_W, GRAPH_H);
    g.fillStyle = "rgba(255,255,255,0.3)"; g.fillRect(0, GRAPH_Y60, GRAPH_W, 1);
    g.beginPath();
    for (var i = 0; i < n; i++) {
      var ms = shownTimes[(shownHead - n + i + L) % L] - shownTimes[(shownHead - n - 1 + i + L) % L];
      var x = GRAPH_W - (n - 1 - i) * GRAPH_STEP - 0.5, y = GRAPH_H - Math.min(ms, GRAPH_MAX_MS) / GRAPH_MAX_MS * (GRAPH_H - 2) - 1;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  function present() {
    core._nes_convert();  // a conversion deferred after a heavy frame (no-op otherwise)
    var ptr = core._nes_video();
    if (texture) {
      var url;
      var drewPixel = pixelTest && videoFormat === 28, drewTest = motionTest && videoFormat === 28;
      if (drewPixel) drawPixelTest(ptr);
      if (drewTest) drawMotionTest(ptr);
      try { url = texture.present(heap(), ptr); }
      catch (e) {
        if (texture.format === 28) throw e;
        // 16-bit texture rejected: fall back to the console-verified RGBA format.
        record("16-bit video failed, using RGBA: " + e.message); videoFallback = e.message;
        try { texture.close(); } catch (_) {}
        videoFormat = 28; core._nes_set_format16(0); core._nes_reconvert();
        texture = N.texture(W, H, 28); ptr = core._nes_video(); url = texture.present(heap(), ptr);
      }
      finally {
        if (drewTest && motionSave) heap().copyWithin(ptr, motionSave, motionSave + MOTION_ROWS * W * 4);
        if (drewPixel && pixelSave) heap().copyWithin(ptr, pixelSave, pixelSave + W * H * 4);
      }
      if (shownUrl !== url) { liveImage.style.backgroundImage = 'url("' + url + '")'; shownUrl = url; }
    } else if (ctx2d) {
      if (core._nes_bytes_per_pixel() !== 4) core._nes_set_format16(0);
      if (pixelTest) drawPixelTest(ptr);
      if (motionTest) drawMotionTest(ptr);
      imageData.data.set(heap().subarray(ptr, ptr + FRAME_BYTES)); ctx2d.putImageData(imageData, 0, 0);
      if (motionTest) heap().copyWithin(ptr, motionSave, motionSave + MOTION_ROWS * W * 4);
      if (pixelTest) heap().copyWithin(ptr, pixelSave, pixelSave + W * H * 4);
    }
    videoCount++; noteShown(presentTick || now());
  }

  /* ---------------- Game lifecycle ---------------- */
  async function startGame(rom) {
    mode = "loading"; footer.textContent = "Loading " + rom.name + "..."; footer.style.display = "block";
    var path = ROM_DIR + "/" + rom.name;
    try {
      var romPtr = 0;
      var size = await files.readInto(path, heap, function (n) { return (romPtr = core._nes_rom_alloc(n)); }, 4 * 1024 * 1024);
      if (size < 0) throw Error("The file could not be found.");
      var err = core._nes_load();
      if (err) throw Error(romError(heap().subarray(romPtr, romPtr + Math.min(size, 16)), core.UTF8ToString(err)));
      var base = DATA_DIR + "/" + sanitize(rom.name);
      running = { name: rom.name, base: base, battery: !!core._nes_has_battery(), sramHash: 0, sramCheck: 0, sramPos: -1, sramAcc: 0, start: 0, emitted: 0 };
      if (running.battery) {
        try {
          await files.readInto(base + ".srm", heap, function (n) { if (n > core._nes_sram_size()) throw Error("Save file has the wrong size."); return core._nes_sram(); }, 65536);
        } catch (e) { record("SRAM load: " + e.message); }
        running.sramHash = hashSram();
      }
      // Save-state slot times, per-game settings, recent list.
      running.slots = {}; try { var sj = await readText(base + ".slots.json"); if (sj) running.slots = JSON.parse(sj) || {}; } catch (e) { running.slots = {}; }
      stateSlot = autoLoadState ? newestSlot() : 1;
      running.globalVals = gameValues(); running.perGame = false;
      try { var gj = await readText(base + ".settings.json"); if (gj) { setGameValues(JSON.parse(gj)); running.perGame = true; } } catch (e) { record("Game settings: " + e.message); }
      recentGames = [rom.name].concat(recentGames.filter(function (n) { return n !== rom.name; })).slice(0, RECENT_MAX); saveSettings();
      paletteApplied = -1; applyEmuOptions();
      await loadCheats(rom.name); if (applyCheats()) showToast("Cheats active");
      openOutputs();
      browser.style.display = "none"; game.style.display = "block"; fitPicture(); applyCrt(); stats.textContent = ""; applyStatsLevel();
      hint.style.display = "block"; hintUntil = now() + 6000;
      history = []; sessionStart = now(); tickCount = 0;
      if (autoLoadState) await loadState(true, newestSlot());
      resetClock(); mode = "running"; drawFrac = 1; drawAcc = 0; pendingFrame = false; lastTick = 0; accReset(tickGaps); accReset(presentOffsets); spikes = []; spikeCount = 0; lateCount = 0; recCur.fill(0); recPrev.fill(0); setAudioRatio(1); pendEma = AUDIO_TARGET; ratioTicks = 0; emaSkip = emaRender = 0; renderSamples = 0; emuCount = videoCount = 0; workMs = 0; statsAt = now();
    } catch (e) {
      record("Start: " + e.message); core._nes_unload(); closeOutputs();
      if (running && running.perGame) setGameValues(running.globalVals);
      running = null;
      showMessage(e.message, function () { mode = "browser"; paintBrowser(); });
    }
  }
  var hintUntil = 0;
  function resetClock() { if (running) { running.start = now(); running.emitted = 0; } presentTick = 0; resetShown(); }
  function saveSram(force) {
    if (!running || !running.battery || autotest) return; // automated runs never touch game saves
    var h = hashSram(); if (!force && h === running.sramHash) return;
    writeSram(h);
  }
  function writeSram(h) {
    try { files.writeFrom(running.base + ".srm", heap(), core._nes_sram(), core._nes_sram_size()); files.commit(); running.sramHash = h; }
    catch (e) { record("SRAM save: " + e.message); showToast("Could not save game data"); }
  }
  // Battery-save check spread over ticks: every 4 s, hash 1 KB per tick
  // (a whole 8 KB hash in one tick cost several ms on the console).
  function sramStep(t) {
    var r = running;
    if (!r.battery) return 0;
    if (r.sramPos < 0) { if (t - r.sramCheck < 4000) return 0; r.sramCheck = t; r.sramPos = 0; r.sramAcc = 2166136261 | 0; }
    var h = r.sramAcc, p = core._nes_sram(), u8 = heap(), mul = Math.imul, size = core._nes_sram_size(), end = Math.min(size, r.sramPos + 1024);
    for (var i = r.sramPos; i < end; i++) h = mul(h ^ u8[p + i], 16777619);
    r.sramAcc = h; r.sramPos = end;
    if (end >= size) { r.sramPos = -1; if (h !== r.sramHash && !autotest) writeSram(h); }
    return 1;
  }
  function setAudioRatio(r) { if (r !== audioRatio) { audioRatio = r; core._nes_set_audio_ratio(r); } }
  function noteSpike(gap, t) {
    if (gap > 24) spikeCount++; else lateCount++;
    if (spikes.length >= 150) return;
    var a = [], b = [];
    for (var i = 0; i < REC; i++) { a.push(+recCur[i].toFixed(2)); b.push(+recPrev[i].toFixed(2)); }
    spikes.push({ t: +((t - sessionStart) / 1000).toFixed(2), gap: +gap.toFixed(1), last: a, before: b });
  }
  // Save-state slots 1-4 per game (slot 1 keeps the original .state name); the
  // save time of each slot is kept in <game>.slots.json.
  var SLOT_COUNT = 4, stateSlot = 1;
  function statePath(n) { return running.base + (n === 1 ? ".state" : ".state" + n); }
  function slotLabel(n) {
    var t = running && running.slots && running.slots[n];
    if (!t) return n + "  (empty)";
    var d = new Date(t), two = function (x) { return (x < 10 ? "0" : "") + x; }, today = new Date();
    var when = two(d.getHours()) + ":" + two(d.getMinutes());
    if (d.toDateString() !== today.toDateString()) when = two(d.getDate()) + "/" + two(d.getMonth() + 1) + " " + when;
    return n + "  " + when;
  }
  function saveState() {
    try {
      var len = core._nes_state_save(); if (!len) throw Error("Emulator could not create a save state.");
      files.writeFrom(statePath(stateSlot), heap(), core._nes_state_buffer(len), len); files.commit();
      running.slots[stateSlot] = Date.now(); writeText(running.base + ".slots.json", JSON.stringify(running.slots));
      showToast("Saved to slot " + stateSlot);
    } catch (e) { record("State save: " + e.message); showToast("State save failed: " + e.message); }
  }
  async function loadState(quietIfNone, n) {
    n = n || stateSlot;
    try {
      var size = await files.readInto(statePath(n), heap, function (k) { return core._nes_state_buffer(k); }, 1024 * 1024);
      if (size < 0) { if (!quietIfNone) showToast("Slot " + n + " is empty"); return; }
      if (!core._nes_state_load(size)) throw Error("The saved state is not valid.");
      showToast("Loaded slot " + n);
    } catch (e) { record("State load: " + e.message); showToast("State load failed"); }
  }
  function newestSlot() {
    var best = 0, bestT = 0;
    for (var n = 1; n <= SLOT_COUNT; n++) { var t = running.slots[n] || 0; if (t > bestT) { bestT = t; best = n; } }
    return best || 1;
  }
  // ---- Game Genie ----
  // Codes decode to a CPU address ($8000-$FFFF), a value and (8-letter codes)
  // a compare byte. They are applied by patching program ROM in memory, with
  // the original bytes kept so codes can be switched off. 8-letter codes patch
  // every bank where the compare byte matches; 6-letter codes are exact for
  // games up to 32 KB and patch the same spot in every 8 KB bank otherwise.
  var GG_LETTERS = "APZLGITYEOXUKSVN";
  function ggDecode(code) {
    code = String(code || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (code.length !== 6 && code.length !== 8) return null;
    var n = [];
    for (var i = 0; i < code.length; i++) { var v = GG_LETTERS.indexOf(code[i]); if (v < 0) return null; n.push(v); }
    var addr = 0x8000 + (((n[3] & 7) << 12) | ((n[5] & 7) << 8) | ((n[4] & 8) << 8) | ((n[2] & 7) << 4) | ((n[1] & 8) << 4) | (n[4] & 7) | (n[3] & 8));
    if (code.length === 6) return { code: code, addr: addr, value: ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[5] & 8), compare: -1 };
    return { code: code, addr: addr, value: ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[7] & 8),
      compare: ((n[7] & 7) << 4) | ((n[6] & 8) << 4) | (n[6] & 7) | (n[5] & 8) };
  }
  // running.cheats: [{ code, desc, on }]; running.patches: [{ offset, orig }].
  function applyCheats() {
    if (!running) return;
    var U = heap(), prg = core._nes_prg(), size = core._nes_prg_size();
    if (!prg || !size) return;
    (running.patches || []).forEach(function (p) { U[prg + p.offset] = p.orig; });
    running.patches = []; var applied = 0;
    (running.cheats || []).forEach(function (c) {
      if (!c.on) return;
      var g = ggDecode(c.code); if (!g) return;
      var offs = [];
      if (g.compare < 0 && size <= 0x8000) offs.push((g.addr - 0x8000) % size);
      else for (var o = g.addr & 0x1fff; o < size; o += 0x2000) offs.push(o);
      offs.forEach(function (o) {
        if (g.compare >= 0 && U[prg + o] !== g.compare) return;
        running.patches.push({ offset: o, orig: U[prg + o] }); U[prg + o] = g.value; applied++;
      });
    });
    return applied;
  }
  function saveCheats() { try { writeText(running.base + ".cheats.json", JSON.stringify(running.cheats)); } catch (e) { record("Cheats save: " + e.message); } }
  async function loadCheats(romName) {
    running.cheats = []; running.patches = [];
    try { var t = await readText(running.base + ".cheats.json"); if (t) running.cheats = JSON.parse(t).filter(function (c) { return c && ggDecode(c.code); }); } catch (e) { record("Cheats: " + e.message); }
    // Codes uploaded next to the ROM: Root/nes/<game>.gg, one "CODE description" per line.
    try {
      var txt = await readText(ROM_DIR + "/" + romName.replace(/\.nes$/i, "") + ".gg");
      (txt || "").split(/\r?\n/).forEach(function (line) {
        var m = line.trim().match(/^([A-Za-z]{6}(?:[A-Za-z]{2})?)\b\s*(.*)$/); if (!m || !ggDecode(m[1])) return;
        var code = m[1].toUpperCase();
        if (!running.cheats.some(function (c) { return c.code === code; })) running.cheats.push({ code: code, desc: m[2].slice(0, 40), on: false });
      });
    } catch (e) { /* no file */ }
  }
  function openCheatsMenu() {
    var items = (running.cheats || []).map(function (c, i) {
      return menuOption(c.code + (c.desc ? "  " + c.desc : ""), function () { return OFF_ON; }, function () { return running.cheats[i].on ? 1 : 0; },
        function (v) { running.cheats[i].on = !!v; }, function () { applyCheats(); saveCheats(); });
    });
    items.push(["Add code", function () { openCodeEditor(); }]);
    if (running.cheats.length) items.push(["Remove last code", function () { running.cheats.pop(); applyCheats(); saveCheats(); openCheatsMenu(); }]);
    items.push(["Back", function () { openMenu(); }]);
    showMenuItems("Cheats (Game Genie)", items);
  }
  // On-screen code editor: Left/Right move, Up/Down change the letter (blank
  // allowed for letters 7-8), A saves, B cancels.
  var ggEdit = null;
  var ggPanel = node("div", root, { position: "absolute", zIndex: "12", left: "0", top: "0", right: "0", bottom: "0", display: "none", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)" });
  var ggBox = node("div", ggPanel, { padding: "24px 28px", backgroundColor: C.panel, border: "1px solid " + C.line, borderRadius: "14px", display: "flex", flexDirection: "column", alignItems: "center" });
  node("div", ggBox, { fontSize: "24px", fontWeight: "bold", marginBottom: "16px" }, "Enter Game Genie code");
  var ggSlots = node("div", ggBox, { display: "flex", flexDirection: "row" });
  var ggCells = []; for (var gi = 0; gi < 8; gi++) ggCells.push(node("div", ggSlots, { width: "44px", height: "54px", margin: "0 4px", fontSize: "30px", fontFamily: "Courier New, monospace", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "6px", border: "2px solid " + C.line, backgroundColor: C.bg }, ""));
  var ggInfo = node("div", ggBox, { fontSize: "16px", color: C.dim, marginTop: "14px", whiteSpace: "pre", textAlign: "center" }, "");
  function openCodeEditor() { ggEdit = { letters: [0, 0, 0, 0, 0, 0, -1, -1], pos: 0 }; menu.style.display = "none"; ggPanel.style.display = "flex"; mode = "ggedit"; paintCodeEditor(); }
  function ggEditCode() { return ggEdit.letters.filter(function (v) { return v >= 0; }).map(function (v) { return GG_LETTERS[v]; }).join(""); }
  function paintCodeEditor() {
    for (var i = 0; i < 8; i++) {
      var v = ggEdit.letters[i];
      ggCells[i].textContent = v >= 0 ? GG_LETTERS[v] : "-";
      ggCells[i].style.borderColor = i === ggEdit.pos ? C.accent : C.line; ggCells[i].style.color = v >= 0 ? C.text : C.dim;
    }
    var g = ggDecode(ggEditCode()), hex = function (x, n) { var h = x.toString(16).toUpperCase(); while (h.length < n) h = "0" + h; return h; };
    ggInfo.textContent = (g ? "$" + hex(g.addr, 4) + " = " + hex(g.value, 2) + (g.compare >= 0 ? " if " + hex(g.compare, 2) : "") : "Codes have 6 or 8 letters") +
      "\nLeft/Right: move   Up/Down: letter   A: save   B: cancel";
  }
  function handleCodeEditor(ev, pressed) {
    var e = ggEdit, maxV = 15, minV = e.pos >= 6 ? -1 : 0;
    if (pressed & BTN.LEFT) e.pos = Math.max(0, e.pos - 1);
    if (pressed & BTN.RIGHT) e.pos = Math.min(7, e.pos + 1);
    if (ev.up) { var v = e.letters[e.pos] + 1; e.letters[e.pos] = v > maxV ? minV : v; }
    if (ev.down) { var w = e.letters[e.pos] - 1; e.letters[e.pos] = w < minV ? maxV : w; }
    if (e.pos === 6 && e.letters[6] < 0) e.letters[7] = -1;
    paintCodeEditor();
    if (pressed & BTN.A) {
      var code = ggEditCode();
      if (!ggDecode(code)) { showToast("A code needs 6 or 8 letters"); return; }
      running.cheats.push({ code: code, desc: "", on: true }); applyCheats(); saveCheats(); showToast("Code " + code + " added");
      closeCodeEditor();
    } else if (pressed & BTN.B) closeCodeEditor();
  }
  function closeCodeEditor() { ggPanel.style.display = "none"; ggEdit = null; mode = "menu"; menu.style.display = "flex"; openCheatsMenu(); }

  // Clear message for ROMs QuickNES cannot run (reads the iNES header).
  var SUPPORTED_MAPPERS = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 15, 19, 21, 22, 23, 24, 25, 26, 30, 32, 33, 34, 60, 66, 69, 70, 71, 73, 75, 78, 79, 85, 86, 87, 88, 89, 93, 94, 97, 113, 140, 152, 154, 156, 180, 184, 190, 193, 206, 207, 232, 240, 241, 244, 246];
  var MAPPER_NAMES = { 16: "Bandai FCG", 18: "Jaleco SS88006", 64: "Tengen RAMBO-1", 65: "Irem H3001", 67: "Sunsoft-3", 68: "Sunsoft-4", 76: "Namco 3446", 80: "Taito X1-005",
    82: "Taito X1-017", 105: "NES-EVENT", 118: "TxSROM", 119: "TQROM", 159: "Bandai LZ93D50", 185: "CNROM with protection", 228: "Action 52" };
  function romError(h, err) {
    if (h.length < 16 || h[0] !== 0x4e || h[1] !== 0x45 || h[2] !== 0x53 || h[3] !== 0x1a)
      return "This file is not a standard NES ROM (no iNES header).\n\nOnly .nes cartridge images are supported; Famicom Disk System (.fds) and other formats are not.";
    var mapper = (h[6] >> 4) | (h[7] & 0xf0);
    if ((h[7] & 0x0c) === 0x08) mapper |= (h[8] & 0x0f) << 8;  // NES 2.0
    if (SUPPORTED_MAPPERS.indexOf(mapper) < 0 || /mapper/i.test(err))
      return "This game uses mapper " + mapper + (MAPPER_NAMES[mapper] ? " (" + MAPPER_NAMES[mapper] + ")" : "") + ", which SW2NES does not support, so it cannot run.";
    return "This ROM could not be loaded: " + err + "\n\nThe file may be damaged or a bad dump.";
  }
  function quitGame() {
    if (running && history.length >= 5 && !autotest) {
      try { writeText(DATA_DIR + "/last-session.json", JSON.stringify({ app: APP_VERSION, rom: running.name, history: history, spikes: spikes, diagnostics: diagnostics })); }
      catch (e) { record("Session log: " + e.message); }
    }
    saveSram(true); closeOutputs(); core._nes_unload();
    if (running && running.perGame) setGameValues(running.globalVals);  // back to the all-games settings
    running = null; orderRoms();
    game.style.display = "none"; menu.style.display = "none"; browser.style.display = "flex"; statsBar.style.display = "none"; crtOverlay.style.display = "none"; crtOverlay2.style.display = "none";
    mode = "browser"; paintBrowser();
  }

  /* ---------------- Text files and automated test runs ---------------- */
  var APP_VERSION = "1.0.1";
  function ascii(text) { return text.replace(/[\u0080-\uffff]/g, function (c) { return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4); }); }
  // One-time move from the app's former name: copy everything (settings, save
  // states, battery saves, cheats) from the old data folder when this app has
  // no settings yet. The old folder is left in place as a backup.
  async function migrateOldData() {
    var OLD = DATA_PARENT + "/civ" + "nes";  // the app was called CivNES before 0.9.45
    try { if (await readText(SETTINGS) !== null) return; } catch (e) { return; }
    var list = null; try { list = await files.list(OLD); } catch (e) { return; }
    if (!list || !list.length) return;
    var copied = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i]; if (e.dir) continue;
      var ptr = 0;
      try {
        var size = await files.readInto(OLD + "/" + e.name, heap, function (n) { ptr = core._malloc(Math.max(1, n)); return ptr; }, 4 * 1024 * 1024);
        if (size >= 0) { files.writeFrom(DATA_DIR + "/" + e.name, heap(), ptr, size); copied++; }
      } catch (err) { record("Migrate " + e.name + ": " + err.message); }
      finally { if (ptr) core._free(ptr); }
    }
    if (copied) { try { files.commit(); } catch (err) { record("Migrate commit: " + err.message); } record("Copied " + copied + " files from the old CivNES data folder"); }
  }
  async function readText(path) {
    var ptr = 0, size = await files.readInto(path, heap, function (n) { ptr = core._malloc(Math.max(1, n)); return ptr; }, 65536);
    if (size < 0) return null;
    try { var u8 = heap(), out = ""; for (var i = 0; i < size; i++) out += String.fromCharCode(u8[ptr + i]); return out; }
    finally { core._free(ptr); }
  }
  function writeText(path, text) {
    text = ascii(text); var ptr = core._malloc(Math.max(1, text.length)), u8 = heap();
    try { for (var i = 0; i < text.length; i++) u8[ptr + i] = text.charCodeAt(i); files.writeFrom(path, u8, ptr, text.length); files.commit(); }
    finally { core._free(ptr); }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function microBench() {
    var out = {}, t, i, n = 90;
    // Run the loaded game's real frames outside the paced loop.
    t = now(); for (i = 0; i < n; i++) core._nes_frame(0, 0, 0); out.skipFrameMs = +((now() - t) / n).toFixed(3);
    t = now(); for (i = 0; i < n; i++) core._nes_frame(0, 0, 1); out.renderFrameMs = +((now() - t) / n).toFixed(3);
    // Worst case: every pixel changed (scrolling) - full conversion each frame.
    t = now(); for (i = 0; i < n; i++) { core._nes_invalidate_video(); core._nes_frame(0, 0, 1); } out.renderFullMs = +((now() - t) / n).toFixed(3);
    out.videoFormat = videoFormat; out.bytesPerPixel = core._nes_bytes_per_pixel(); if (videoFallback) out.videoFallback = videoFallback;
    core._nes_audio_take();
    if (texture) { t = now(); for (i = 0; i < 30; i++) present(); out.presentMs = +((now() - t) / 30).toFixed(3); }
    if (N && N.benchCalls) out.nativeCallMs = +N.benchCalls(200).toFixed(4);
    t = now(); var h = 0; for (i = 0; i < 1000000; i++) h = (h + i * 31) | 0; out.jsLoop1MMs = +(now() - t).toFixed(1);
    return out;
  }
  // Feasibility probe for GPU palette lookup (WebGL); diagnostics only.
  function probeGpu() {
    var r = {}, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    try { r.canvas2d = !!document.createElement("canvas").getContext("2d"); } catch (e) { r.canvas2d = "error: " + e.message; }
    try { r.webgl2 = !!document.createElement("canvas").getContext("webgl2"); } catch (e) { r.webgl2 = "error: " + e.message; }
    var gl = null;
    try { gl = cv.getContext("webgl") || cv.getContext("experimental-webgl"); } catch (e) { r.webglError = e.message; }
    r.webgl = !!gl;
    if (!gl) return r;
    r.vendor = String(gl.getParameter(gl.VENDOR)); r.renderer = String(gl.getParameter(gl.RENDERER)); r.version = String(gl.getParameter(gl.VERSION));
    function shader(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error("shader: " + gl.getShaderInfoLog(s)); return s; }
    var prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, "attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }"));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, "precision mediump float; varying vec2 uv; uniform sampler2D idx; uniform sampler2D pal; void main(){ float i = texture2D(idx, uv).r; gl_FragColor = texture2D(pal, vec2((i * 255.0 + 0.5) / 256.0, 0.5)); }"));
    gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    function tex(unit) { var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; }
    tex(1); var palData = new Uint8Array(256 * 4); for (var k = 0; k < 256; k++) { palData[k * 4] = k; palData[k * 4 + 1] = 255 - k; palData[k * 4 + 2] = (k * 7) & 255; palData[k * 4 + 3] = 255; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palData);
    gl.uniform1i(gl.getUniformLocation(prog, "pal"), 1);
    tex(0); gl.uniform1i(gl.getUniformLocation(prog, "idx"), 0); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    var indices = new Uint8Array(W * H); for (var q = 0; q < indices.length; q++) indices[q] = (q * 13) & 255;
    gl.viewport(0, 0, W, H);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, W, H, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, indices); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    var px = new Uint8Array(4), cx = 100, cy = 100; gl.readPixels(cx, H - 1 - cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var want = indices[cy * W + cx]; r.readback = [px[0], px[1], px[2]]; r.expected = [want, 255 - want, (want * 7) & 255];
    r.correct = Math.abs(px[0] - want) <= 1 && Math.abs(px[1] - (255 - want)) <= 1 && Math.abs(px[2] - ((want * 7) & 255)) <= 1;
    var t0 = now(); for (var f = 0; f < 60; f++) { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.LUMINANCE, gl.UNSIGNED_BYTE, indices); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
    r.uploadDrawMs = +((now() - t0) / 60).toFixed(3);
    t0 = now(); gl.finish(); r.finishMs = +(now() - t0).toFixed(3);
    r.glError = gl.getError();
    return r;
  }
  // Diagnostics: can emulation move off the UI thread (Web Workers)?
  async function probePlatform() {
    var out = { worker: typeof Worker, sab: typeof SharedArrayBuffer, atomics: typeof Atomics, cores: (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0,
      blob: typeof Blob, objectUrl: typeof URL !== "undefined" && typeof URL.createObjectURL };
    if (typeof Worker !== "function") return out;
    var w = null;
    try {
      var src = "onmessage=function(e){var t=Date.now(),h=0;for(var i=0;i<1e6;i++)h=(h+i*31)|0;postMessage({v:e.data*2,ms:Date.now()-t,wa:typeof WebAssembly})}";
      var url = typeof Blob === "function" ? URL.createObjectURL(new Blob([src], { type: "text/javascript" })) : "data:text/javascript," + encodeURIComponent(src);
      w = new Worker(url); var t0 = now();
      var reply = await new Promise(function (res, rej) { w.onmessage = function (e) { res(e.data); }; w.onerror = function (e) { rej(Error("worker error: " + (e && e.message))); }; w.postMessage(21); setTimeout(function () { rej(Error("worker timeout")); }, 3000); });
      out.roundTrip = reply; out.roundTripMs = +(now() - t0).toFixed(2);
    } catch (e) { out.workerError = String(e && e.message || e); }
    finally { try { if (w) w.terminate(); } catch (_) {} }
    return out;
  }
  // Plan: {"roms":[...names], "seconds":30, "start":[2,4,6,8], "exit":true}
  // "start" lists seconds at which Start is tapped, to get past title screens.
  async function runAutotest(plan) {
    var log = { app: APP_VERSION, startedAt: Date.now(), plan: plan, runs: [], errors: [] };
    log.canvas = canvasCaps();
    try { log.platform = await probePlatform(); } catch (e) { log.platform = { error: String(e && e.message || e) }; }
    if (plan.probeGpu) { try { log.gpu = probeGpu(); } catch (e) { log.gpu = { error: String(e && e.message || e) }; } }
    var savedCrt = crtStyle, savedStats = statsLevel, savedBuffers = videoBuffers;  // per-run overrides are restored afterwards (never saved)
    autotest = plan; var seconds = Math.max(5, Math.min(120, Number(plan.seconds) || 25));
    // Entries: "name.nes" or {"rom": "name.nes", "textureFormat": 28|85|86}.
    var names = Array.isArray(plan.roms) && plan.roms.length ? plan.roms : allRoms.map(function (r) { return r.name; });
    for (var k = 0; k < names.length && !closed; k++) {
      var entry = typeof names[k] === "object" && names[k] ? names[k] : { rom: names[k] };
      var rom = allRoms.find(function (r) { return r.name === entry.rom; });
      if (!rom) { log.errors.push("Missing ROM: " + entry.rom); continue; }
      videoFormat = [28, 85, 86].indexOf(entry.textureFormat || plan.textureFormat) >= 0 ? (entry.textureFormat || plan.textureFormat) : 28;
      presentEarly = entry.present === "early"; pacingMode = entry.pacing === "clock" ? "clock" : "locked";
      deferConvert = entry.deferConvert !== false; displayMode = entry.display === "canvas" ? "canvas" : "texture"; motionTest = !!entry.motion || !!plan.motion; videoBuffers = entry.buffers === 1 ? 1 : 3;
      if (entry.label) { testLabel.textContent = entry.label; testLabel.style.display = "block"; } else testLabel.style.display = "none"; padMs = +entry.pad || 0; crtStyle = typeof entry.crt === "number" ? entry.crt : typeof entry.crt === "boolean" ? (entry.crt ? 1 : 0) : savedCrt; crtOn = crtStyle > 0; statsLevel = typeof entry.stats === "number" ? entry.stats : typeof entry.stats === "boolean" ? (entry.stats ? 3 : 0) : savedStats; showStats = statsLevel > 0;
      var run = { rom: rom.name, textureFormat: videoFormat, present: presentEarly ? "early" : "late", pacing: pacingMode, crt: crtStyle, stats: statsLevel, deferConvert: deferConvert, pad: padMs, motion: motionTest, buffers: videoBuffers, display: displayMode, label: entry.label || "" };
      try {
        await startGame(rom);
        if (!running) throw Error("Start failed: " + (diagnostics.length ? diagnostics[diagnostics.length - 1].message : "unknown"));
        var taps = (Array.isArray(plan.start) ? plan.start : [2, 4, 6, 8]).slice().sort(function (a, b) { return a - b; });
        if (entry.probe) {
          var lv = entry.probe.levels; if (!lv) { lv = []; for (var ms = entry.probe.from || 6; ms <= (entry.probe.to || 15); ms += entry.probe.step || 1) lv.push(ms); }
          await sleep(2000);  // let the game draw a picture first
          probe = { levels: lv, i: 0, secs: entry.probe.secs || 3, gaps: acc(), over: 0, last: 0, start: 0, results: [], done: false };
          while (!probe.done && !closed) await sleep(100);
          run.probe = probe.results; probe = null;
          autoBits = 0; mode = "loading"; quitGame(); log.runs.push(run); continue;
        }
        var began = now(), runSeconds = Math.max(5, Math.min(120, Number(entry.seconds) || seconds));
        while (now() - began < runSeconds * 1000 && !closed) {
          var el = (now() - began) / 1000;
          var script = entry.input || null;  // [[fromSec, toSec, npadBits], ...]
          if (script) { autoBits = 0; for (var q = 0; q < script.length; q++) if (el >= script[q][0] && el < script[q][1]) autoBits |= script[q][2]; }
          else autoBits = taps.some(function (t) { return el >= t && el < t + 0.2; }) ? BTN.PLUS :
            (plan.hold && el > (taps[taps.length - 1] || 0) + 1 ? BTN.RIGHT : 0);
          await sleep(50);
        }
        autoBits = 0; mode = "loading";
        run.history = history.slice(); run.spikes = spikes.slice(); run.bench = microBench(); run.drawFrac = drawFrac; run.emaSkip = emaSkip; run.emaRender = emaRender;
        quitGame();
      } catch (e) { autoBits = 0; run.error = String(e && e.message || e); try { if (running) quitGame(); } catch (_) {} message.style.display = "none"; mode = "browser"; }
      log.runs.push(run);
    }
    log.diagnostics = diagnostics.slice(); log.finishedAt = Date.now(); autotest = null; videoFormat = 28; presentEarly = false; pacingMode = "locked"; crtStyle = savedCrt; crtOn = crtStyle > 0; statsLevel = savedStats; showStats = statsLevel > 0; deferConvert = true; motionTest = false; testLabel.style.display = "none"; videoBuffers = savedBuffers; displayMode = "texture"; padMs = 0;
    try { writeText(DATA_DIR + "/autotest-log.json", JSON.stringify(log)); } catch (e) { record("Autotest log: " + e.message); }
    if (plan.exit !== false) close();
  }

  /* ---------------- Pause menu ---------------- */
  var menuIndex = 0, menuActions = [];
  // In-game menu. Actions run with A; options show "< value >" arrows and
  // cycle with Left/Right (A steps forward). Picture options apply at once.
  function menuOption(label, choices, get, set, after) { return { label: label, choices: choices, get: get, set: set, after: after }; }
  function pictureChanged() { fitPicture(); applyCrt(); saveSettings(); }
  // "This game": the current picture/audio/control settings are kept for this
  // game only. "All games": the game's own file is removed and the shared
  // settings come back.
  function setPerGame(on) {
    if (on === running.perGame) return;
    if (on) { running.perGame = true; saveSettings(); showToast("Settings saved for this game"); }
    else {
      running.perGame = false;
      try { files.remove(running.base + ".settings.json"); files.commit(); } catch (e) { record("Game settings remove: " + e.message); }
      setGameValues(running.globalVals); showToast("Using settings for all games");
    }
  }
  function openMenu() {
    menuActions = [
      ["Resume", function () { closeMenu(); }],
      ["Save state", function () { saveState(); closeMenu(); }],
      ["Load state", async function () { closeMenu(); await loadState(); }],
      menuOption("Slot", function () { var a = []; for (var n = 1; n <= SLOT_COUNT; n++) a.push(slotLabel(n)); return a; },
        function () { return stateSlot - 1; }, function (v) { stateSlot = v + 1; }),
      ["Reset", function () { core._nes_reset(0); closeMenu(); showToast("Reset"); }],
      menuOption("Stats", function () { return STATS_LEVELS; }, function () { return statsLevel; }, function (v) { statsLevel = v; },
        function () { applyStatsLevel(); saveSettings(); }),
      menuOption("Aspect", function () { return ASPECTS; }, function () { return aspectMode; }, function (v) { aspectMode = v; }, pictureChanged),
      menuOption("Scale", function () { return SCALES.map(function (n, i) { return i === 0 && scaleMode === 0 && Number.isInteger(picSX) && picSX ? n + " " + picSX + "x" + picSY : n; }); },
        function () { return scaleMode; }, function (v) { scaleMode = v; }, pictureChanged),
      menuOption("Crop", function () { return CROPS; }, function () { return cropMode; }, function (v) { cropMode = v; }, pictureChanged),
      menuOption("CRT", crtChoiceNames, crtChoiceIndex, function (v) { crtStyle = CRT_CHOICES[v]; crtOn = crtStyle > 0; }, pictureChanged),
      menuOption("Palette", function () { return PALETTES; }, function () { return paletteMode; }, function (v) { paletteMode = v; }, function () { applyEmuOptions(); saveSettings(); }),
      menuOption("Favourite", function () { return OFF_ON; }, function () { return favourites.indexOf(running.name) >= 0 ? 1 : 0; },
        function (v) { favourites = favourites.filter(function (n) { return n !== running.name; }); if (v) favourites.push(running.name); }, saveSettings),
      menuOption("Settings for", function () { return ["All games", "This game"]; }, function () { return running.perGame ? 1 : 0; }, function (v) { setPerGame(!!v); },
        function () { pictureChanged(); applyEmuOptions(); }),
      ["Cheats...", function () { openCheatsMenu(); }],
      ["Quit game", function () { quitGame(); }]
    ];
    showMenuItems(running ? running.name.replace(/\.nes$/i, "") : "Paused", menuActions);
    menu.style.backgroundColor = dimInMenu ? "rgba(0,0,0,0.6)" : "transparent";
    menu.style.display = "flex"; mode = "menu";
    saveSram(false);
  }
  function showMenuItems(title, items) {
    menuActions = items;
    menuItems.forEach(function (m) { menuPanel.removeChild(m.row); }); menuItems = [];
    menuActions.forEach(function (a) {
      var row = node("div", menuPanel, { display: "flex", flexDirection: "row", alignItems: "center", fontSize: "21px", padding: "8px 14px", marginTop: "3px", borderRadius: "8px" });
      var label = node("div", row, { flexGrow: "1" }, Array.isArray(a) ? a[0] : a.label);
      var value = valueBox(row, { fontSize: "18px" });
      menuItems.push({ row: row, label: label, value: value });
    });
    menuTitle.textContent = title;
    menuIndex = 0; paintMenu();
  }
  function cycleMenuOption(dir) {
    var o = menuActions[menuIndex]; if (Array.isArray(o)) return;
    var n = o.choices().length; o.set((o.get() + dir + n) % n); if (o.after) o.after(); paintMenu();
  }

  function paintMenu() {
    menuItems.forEach(function (m, i) {
      var active = i === menuIndex, o = menuActions[i];
      m.row.style.backgroundColor = active ? C.sel : "transparent"; m.row.style.borderLeft = "4px solid " + (active ? C.accent : "transparent");
      m.value.set(Array.isArray(o) ? null : o.choices()[o.get()], active);
    });
  }
  function closeMenu() { menu.style.display = "none"; if (running) { mode = "running"; if (pauseInMenu) { resetClock(); lastTick = 0; } } }

  /* ---------------- Input to NES pad ---------------- */
  function nesPad(b) {
    var p = 0;
    // Face buttons per the user's mapping (Settings): each Switch button -> NES A, NES B or nothing.
    var turboOn = (turbo % TURBO_PERIOD[turboRate]) * 2 < TURBO_PERIOD[turboRate];  // auto-fire on/off cycle
    for (var f = 0; f < FACE_KEYS.length; f++) if (b & BTN[FACE_KEYS[f]]) { var t = faceMap[f]; if (t < 2) p |= FACE_TARGETS[t]; else if (t < 4 && turboOn) p |= FACE_TARGETS[t - 2]; }
    if (b & BTN.PLUS) p |= NES.START; if (b & BTN.MINUS) p |= NES.SELECT;
    if (b & (BTN.UP | BTN.SU)) p |= NES.UP; if (b & (BTN.DOWN | BTN.SD)) p |= NES.DOWN;
    if (b & (BTN.LEFT | BTN.SL)) p |= NES.LEFT; if (b & (BTN.RIGHT | BTN.SR)) p |= NES.RIGHT;
    if ((p & 48) === 48) p &= ~48; if ((p & 192) === 192) p &= ~192;
    return p;
  }
  // Edge/auto-repeat events for menus.
  function navEvents(bits) {
    var pressed = bits & ~lastBits, t = now(), out = 0;
    var dirs = (bits & (BTN.UP | BTN.SU) ? 1 : 0) | (bits & (BTN.DOWN | BTN.SD) ? 2 : 0);
    if (dirs !== held) { held = dirs; repeatAt = t + 380; out |= dirs ? dirs << 8 : 0; }
    else if (dirs && t >= repeatAt) { repeatAt = t + 110; out |= dirs << 8; }
    lastBits = bits;
    return { pressed: pressed, up: !!(out & 256), down: !!(out & 512) };
  }

  /* ---------------- Main loop ---------------- */
  // Diagnostics (autotest "probe"): with the game picture on screen, present
  // every refresh and then busy-wait a fixed time, to find how much of each
  // refresh the console's UI engine leaves us before frame timing wobbles.
  var probe = null;
  function probeTick() {
    var t = now(), P = probe;
    if (P.last) { var g = t - P.last; accAdd(P.gaps, g); if (g > 17.5) P.over++; }
    P.last = t;
    if (!P.start) P.start = t;
    if (t - P.start >= P.secs * 1000) {
      P.results.push({ busy: P.levels[P.i], rafGap: spread(rafTs), rafLag: spread(rafLag), gap: spread(P.gaps), over17_5: P.over, ticks: P.gaps.n });
      P.i++; P.start = t; accReset(P.gaps); P.over = 0; accReset(rafTs); accReset(rafLag);
      if (P.i >= P.levels.length) { P.done = true; return; }
    }
    present(); if (statsLevel === 3) drawGraph();
    var L = P.levels[P.i], ms = typeof L === "number" ? L : L[0] + Math.random() * (L[1] - L[0]);
    var until = t + ms; while (now() < until) {}
  }
  // The console's own frame timestamp (rAF argument), as opposed to when our
  // callback actually starts: logged to tell engine cadence from our jitter.
  var rafTs = acc(), rafLag = acc(), lastRafTs = 0;
  // JS heap sampling (performance.memory where available): allocation per
  // second and GC count (heap size drops), to spot garbage made per frame.
  var heapLast = 0, heapAlloc = 0, heapGcs = 0, heapOk = typeof performance !== "undefined" && !!performance.memory && typeof performance.memory.usedJSHeapSize === "number";
  function sampleHeap() {
    if (!heapOk) return;
    var m = performance.memory.usedJSHeapSize;
    if (heapLast) { if (m < heapLast) heapGcs++; else heapAlloc += m - heapLast; }
    heapLast = m;
  }
  function step(ts) {
    if (closed) return;
    sampleHeap();
    if (typeof ts === "number") { var tn = now(); if (lastRafTs) accAdd(rafTs, ts - lastRafTs); lastRafTs = ts; accAdd(rafLag, tn - ts); }
    if (probe && !probe.done) { probeTick(); schedule(); return; }
    var pollStart = now(), bits = readButtons(); pollMs = now() - pollStart;
    try {
      if (mode === "running") runFrames(bits);
      else {
        if (mode === "menu" && running && !pauseInMenu) runFrames(0, true);  // game keeps running behind the menu
        handleUi(bits);
      }
    } catch (e) {
      record("Loop: " + (e && e.stack || e)); var text = e && e.message || String(e);
      if (running) { try { quitGame(); } catch (_) {} }
      showMessage("Something went wrong:\n" + text, function () { mode = "browser"; paintBrowser(); });
    }
    if (toastUntil && now() > toastUntil) { toast.style.display = "none"; toastUntil = 0; }
    if (hintUntil && now() > hintUntil) { hint.style.display = "none"; hintUntil = 0; }
    schedule();
  }
  function schedule() {
    if (closed) return;
    if (typeof requestAnimationFrame === "function") frameHandle = requestAnimationFrame(step);
    else timerHandle = setTimeout(step, 8);
  }
  function runFrames(bits, behindMenu) {
    var inputStart = now() - pollMs; tickCount++;
    // Publish the frame finished last tick first, at a near-constant point
    // after the display tick, so the renderer picks up exactly one new frame
    // per refresh (publishing after variable emulation work raced its pickup).
    var tickNow = now(), gap = lastTick ? tickNow - lastTick : 0;
    presentTick = tickNow;  // frames presented in this tick count as shown at this refresh
    if (lastTick) {
      accAdd(tickGaps, gap);
      if (gap > 5 && gap < 21) tickMs += (gap - tickMs) * 0.01;  // display refresh period (misses excluded)
      if (gap > 19) noteSpike(gap, tickNow);
    }
    lastTick = tickNow;
    var tmp = recPrev; recPrev = recCur; recCur = tmp; recCur.fill(0); recCur[0] = gap;
    if (presentEarly && pendingFrame) { pendingFrame = false; var pv = now(); present(); if (statsLevel === 3) drawGraph(); var pe = now(); videoMs += pe - pv; recCur[1] = pe - pv; accAdd(presentOffsets, pe - tickNow); }
    if (!behindMenu) {
      var combo = (bits & (BTN.L | BTN.R)) === (BTN.L | BTN.R);
      if (combo && !comboLatch) { comboLatch = true; lastBits = bits; openMenu(); return; }
      if (!combo) comboLatch = false;
    }
    var begin = inputStart, err = (now() - running.start) * NES_RATE / 1000 - running.emitted, due = 1;
    // 57-63.5 Hz: a ~60 Hz display, even through stretches of late refreshes
    // (a 50 Hz or 120 Hz display falls outside and uses wall-clock pacing).
    var hz = 1000 / tickMs;
    locked = pacingMode === "locked" && hz > 57 && hz < 63.5;
    if (locked) {
      // Exactly one frame per refresh. The clock is re-based instead of caught
      // up, so a missed refresh costs one late frame, not a burst of extra work.
      running.start += err * 1000 / NES_RATE;
    } else {
      // Wall-clock pacing: a 0- or 2-frame tick when 1.5 frames ahead/behind.
      if (err > MAX_CATCHUP + 1) { running.emitted += Math.floor(err) - MAX_CATCHUP; due = MAX_CATCHUP; } // far behind: run slower than real time
      else if (err > 2.5) due = Math.floor(err);
      else if (err > 1.5) due = 2;
      else if (err < -1.5) due = 0;
    }
    tickHist[due > 1 ? 2 : due]++; recCur[6] = due;
    if (due <= 0) return;
    var p = nesPad(bits), p2 = behindMenu ? 0 : nesPad(p2Bits), t0 = now(), drew = false, fs = t0;
    for (var i = 0; i < due; i++) {
      turbo++;
      // Fractional frameskip: every emulated frame adds drawFrac; a frame is
      // drawn when the accumulator reaches 1 (evenly spread), at most the last
      // frame of a tick, since earlier ones would be overwritten unseen.
      drawAcc += drawFrac;
      var render = 0;
      if (i === due - 1 && drawAcc >= 1) { render = 1; drawAcc = Math.min(drawAcc - 1, 0.999); }
      if (core._nes_frame(p, p2, render ? 2 : 0) < 0) throw Error("Emulation stopped.");
      // Pixel conversion: now, or - after a heavy frame, when this frame is
      // presented at the start of the next tick anyway - just before that
      // present, so a heavy frame's cost is split across two ticks. Same
      // frame, same refresh, same input: no added latency.
      if (render) { if (deferConvert && presentEarly && locked && now() - tickNow > DEFER_MS) { recCur[7] = 2; deferredConverts++; } else core._nes_convert(); }
      var fe = now(), took = fe - fs; fs = fe;
      if (render) { drew = true; emaRender = emaRender ? emaRender + (took - emaRender) * 0.08 : took; renderSamples++; }
      else emaSkip = emaSkip ? emaSkip + (took - emaSkip) * 0.05 : took;
    }
    var t1 = now();
    // After a heavy frame, leave non-urgent work (audio hand-off, stats, save
    // check) to the next tick so this one still ends before the next refresh.
    // Samples keep accumulating in the core; AudioOut has ~50 ms queued.
    var defer = locked && t1 - tickNow > DEFER_MS && deferred < 2;
    deferred = defer ? deferred + 1 : 0; recCur[8] = defer ? 2 : 0;
    // One AudioOut buffer per tick, not per frame: fewer native calls.
    var samples = defer ? 0 : core._nes_audio_take();
    if (audio && samples) audio.push(heap(), core._nes_audio(), samples);
    if (audio && !defer && ++ratioTicks >= 30) {
      // Audio rate control: stretch by display/NES rate difference, nudged
      // towards AUDIO_TARGET queued buffers (about 50 ms of cushion).
      ratioTicks = 0; pendEma += (audio.pending() - pendEma) * 0.3;
      // The base uses the refresh rate clamped near 60 Hz, so short-term swings
      // in tick timing don't bend the pitch; queue feedback trims the rest.
      var base = NES_RATE / Math.max(59.5, Math.min(60.5, 1000 / tickMs));
      setAudioRatio(locked ? Math.round(base * (1 + 0.002 * (AUDIO_TARGET - pendEma)) * 1e5) / 1e5 : 1);
    }
    var t2 = now();
    running.emitted += due; emuCount += due;
    if (drew) { if (presentEarly) pendingFrame = true; else { present(); if (statsLevel === 3) drawGraph(); accAdd(presentOffsets, now() - tickNow); } }
    var t3 = now();
    emuMs += t1 - t0; audioMs += t2 - t1; videoMs += t3 - t2; inputMs += t0 - begin;
    recCur[2] = t1 - t0; recCur[3] = t2 - t1; if (recCur[7] !== 2) recCur[7] = drew ? 1 : 0;
    if (!defer) recCur[8] = sramStep(t3);
    if (!defer && t3 - statsAt >= 1000) {
      recCur[9] = 1;
      var secs = (t3 - statsAt) / 1000;
      choosePacing((videoMs + audioMs + inputMs) / secs);
      var vf = videoFps();
      if (statsLevel > 0) {
        var span = t3 - statsAt, pct = function (v) { return Math.round(100 * v / span); };
        stats.textContent = statsLevel === 1 ? vf[0].toFixed(1) + " fps" :
          "Emu " + (emuCount / secs).toFixed(1) + " fps   Video avg " + vf[0].toFixed(1) + " fps   1% low " + vf[1].toFixed(1) + " fps   Load " + pct(workMs) + "%";
      }
      var span1 = t3 - statsAt;
      history.push({ heapKBs: heapOk ? Math.round(heapAlloc / 1024 / secs) : -1, gcs: heapGcs, heapMB: heapOk ? +(heapLast / 1048576).toFixed(1) : -1, rafGap: spread(rafTs), rafLag: spread(rafLag), t: Math.round((t3 - sessionStart) / 100) / 10, emu: +(emuCount / secs).toFixed(1), video: +(videoCount / secs).toFixed(1),
        graphMs: +(graphMs / secs).toFixed(2), videoAvg: +vf[0].toFixed(1), low1: +vf[1].toFixed(1), ticks: +(tickCount / secs).toFixed(1), tick012: tickHist.slice(), gap: spread(tickGaps), pub: spread(presentOffsets), early: presentEarly, cpu: Math.round(100 * workMs / span1), core: Math.round(100 * emuMs / span1),
        vid: Math.round(100 * videoMs / span1), aud: Math.round(100 * audioMs / span1), inp: Math.round(100 * inputMs / span1),
        draw: +drawFrac.toFixed(2), skipMs: +emaSkip.toFixed(2), renderMs: +emaRender.toFixed(2), drops: audio ? audio.stats().dropped : -1,
        locked: locked, hz: +(1000 / tickMs).toFixed(3), ratio: audioRatio, pend: +pendEma.toFixed(2), spikes: spikeCount, late: lateCount, defConv: deferredConverts, padMs: +(padTotal / secs).toFixed(1) });
      if (history.length > 600) history.shift();
      emuCount = videoCount = tickCount = 0; tickHist[0] = tickHist[1] = tickHist[2] = 0; graphMs = 0; spikeCount = 0; lateCount = 0; deferredConverts = 0; padTotal = 0; accReset(rafTs); accReset(rafLag); heapAlloc = 0; heapGcs = 0; accReset(tickGaps); accReset(presentOffsets); workMs = emuMs = videoMs = audioMs = inputMs = 0; statsAt = t3;
    }
    var t4 = now();
    recCur[4] = t4 - t3; recCur[5] = t4 - tickNow;  // bookkeeping; whole tick
    workMs += t4 - begin;
    // Constant-length ticks: the console's frame pacing stays flat with
    // constant work per refresh but wobbles when our work varies, so wait out
    // the rest of a fixed budget (only when the frame finished within it).
    if (padMs > 0 && locked) { var padUntil = tickNow + padMs; if (t4 < padUntil) { while (now() < padUntil) {} padTotal += now() - t4; } }
  }
  // Choose the largest fraction of frames to draw whose predicted cost fits the
  // time budget, from measured costs of drawn and undrawn frames on this device.
  // Decreases apply at once; increases need 5% spare budget (no oscillation).
  function fractionFor(budget) {
    var extra = emaRender - emaSkip;
    if (extra <= 0) return 1;
    var f = (budget / NES_RATE - emaSkip) / extra;
    return Math.max(MIN_DRAW, Math.min(1, Math.floor(f * 20) / 20));
  }
  // Allocation-free running statistics (no per-tick garbage).
  function acc() { return { n: 0, sum: 0, sq: 0, lo: Infinity, hi: 0 }; }
  function accAdd(a, v) { a.n++; a.sum += v; a.sq += v * v; if (v < a.lo) a.lo = v; if (v > a.hi) a.hi = v; }
  function accReset(a) { a.n = 0; a.sum = 0; a.sq = 0; a.lo = Infinity; a.hi = 0; }
  // [mean, std, min, max] in ms, for timing diagnostics.
  function spread(a) {
    if (!a.n) return [0, 0, 0, 0];
    var mean = a.sum / a.n, sd = Math.sqrt(Math.max(0, a.sq / a.n - mean * mean));
    return [+mean.toFixed(2), +sd.toFixed(2), +a.lo.toFixed(2), +a.hi.toFixed(2)];
  }
  function fmtSpread(x) { return x[0].toFixed(1) + "+-" + x[1].toFixed(1) + " (" + x[2].toFixed(1) + "-" + x[3].toFixed(1) + ")"; }
  function choosePacing(overheadPerSec) {
    if (!emaSkip || renderSamples < 8) return;
    var budget = 1000 * TARGET_LOAD - overheadPerSec, f = fractionFor(budget);
    var current = NES_RATE * (emaSkip + drawFrac * (emaRender - emaSkip));
    if (f > drawFrac) f = Math.max(drawFrac, fractionFor(budget * 0.95));
    else if (current <= budget) f = drawFrac;  // still fits: keep it steady
    drawFrac = Math.max(drawFrac - 0.1, Math.min(drawFrac + 0.1, f));  // damped steps
  }
  // Exit needs a second B within 3 s; any other button cancels.
  var exitArmed = 0;
  function handleUi(bits) {
    var ev = navEvents(bits), pressed = ev.pressed;
    if (mode === "browser") {
      if (exitArmed && (now() > exitArmed || (pressed & ~(BTN.A | BTN.B)) || ev.up || ev.down || focusArea !== "buttons" || btnIndex !== 2)) { exitArmed = 0; paintBrowser(); }
      if (focusArea === "tabs") {
        if (pressed & BTN.LEFT) setListView(Math.max(0, listView - 1));
        if (pressed & BTN.RIGHT) setListView(Math.min(LIST_VIEWS.length - 1, listView + 1));
        if (ev.down) { focusArea = roms.length ? "list" : "buttons"; selected = 0; paintBrowser(); }
      } else if (focusArea === "list" && roms.length) {
        if (ev.up) { if (selected === 0) focusArea = "tabs"; else selected--; paintBrowser(); }
        if (ev.down) { if (selected === roms.length - 1) { focusArea = "buttons"; } else selected++; paintBrowser(); }
        if (pressed & BTN.LEFT) { selected = Math.max(0, selected - VISIBLE); paintBrowser(); }
        if (pressed & BTN.RIGHT) { selected = Math.min(roms.length - 1, selected + VISIBLE); paintBrowser(); }
        if ((pressed & BTN.A) && roms[selected]) { startGame(roms[selected]); return; }
      } else {
        if (ev.up) { focusArea = roms.length ? "list" : "tabs"; if (roms.length) selected = roms.length - 1; paintBrowser(); }
        if (pressed & BTN.LEFT) { btnIndex = Math.max(0, btnIndex - 1); paintBrowser(); }
        if (pressed & BTN.RIGHT) { btnIndex = Math.min(browserBtns.length - 1, btnIndex + 1); paintBrowser(); }
        if (pressed & BTN.A) {
          if (btnIndex === 0) openSettings();
          else if (btnIndex === 1) { footer.textContent = "Refreshing..."; footer.style.display = "block"; mode = "loading"; scan().then(function () { if (mode === "loading") mode = "browser"; paintBrowser(); }); }
          else if (exitArmed) close(); else { exitArmed = now() + 3000; paintBrowser(); }
          return;
        }
      }
      // B: go to the Exit button and ask for confirmation (a second B or A exits).
      if (pressed & BTN.B) { if (exitArmed) close(); else { focusArea = "buttons"; btnIndex = 2; exitArmed = now() + 3000; paintBrowser(); } }
    } else if (mode === "settings") {
      var nItems = SETTINGS_ITEMS.length;
      if (ev.up) { settingsIndex = (settingsIndex - 1 + nItems + 1) % (nItems + 1); paintSettings(); }
      if (ev.down) { settingsIndex = (settingsIndex + 1) % (nItems + 1); paintSettings(); }
      if (settingsIndex < nItems) {
        if (pressed & BTN.LEFT) changeSetting(-1);
        if (pressed & (BTN.RIGHT | BTN.A)) changeSetting(1);
      } else if (pressed & BTN.A) { closeSettings(); return; }
      if (pressed & BTN.B) closeSettings();
    } else if (mode === "menu") {
      var lr = (bits & (BTN.L | BTN.R)) === (BTN.L | BTN.R);
      if (lr && !comboLatch) { comboLatch = true; closeMenu(); return; }
      if (!lr) comboLatch = false;
      if (ev.up) { menuIndex = (menuIndex - 1 + menuActions.length) % menuActions.length; paintMenu(); }
      if (ev.down) { menuIndex = (menuIndex + 1) % menuActions.length; paintMenu(); }
      var item = menuActions[menuIndex];
      if (!Array.isArray(item)) {
        if (pressed & BTN.LEFT) cycleMenuOption(-1);
        if (pressed & (BTN.RIGHT | BTN.A)) cycleMenuOption(1);
      } else if (pressed & BTN.A) item[1]();
      if (pressed & BTN.B) closeMenu();
    } else if (mode === "ggedit") {
      handleCodeEditor(ev, pressed);
    } else if (mode === "message") {
      if (pressed & (BTN.A | BTN.B)) { message.style.display = "none"; var then = messageThen; messageThen = null; if (then) then(); }
    }
  }

  /* ---------------- Lifetime ---------------- */
  function close() {
    if (closed) return lifetime;
    closed = true;
    if (frameHandle !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameHandle);
    if (timerHandle !== null) clearTimeout(timerHandle);
    try { if (running) { saveSram(true); core._nes_unload(); running = null; } } catch (e) { record("Close save: " + e.message); }
    closeOutputs();
    if (pad) { try { pad.close(); } catch (e) { record("Pad close: " + e.message); } pad = null; }
    removers.forEach(function (fn) { fn(); }); removers = [];
    if (root.parentNode) root.parentNode.removeChild(root);
    if (window.__civswitchApp === instance) delete window.__civswitchApp;
    finish();
    return lifetime;
  }
  var instance = { id: APP_ID, close: close, lifetime: lifetime, diagnostics: diagnostics,
    getState: function () { return { mode: mode, roms: roms.length, running: running && running.name, frames: running ? running.emitted : 0, players: pad && pad.players ? pad.players() : 0, p2: p2Bits, focus: focusArea, view: LIST_VIEWS[listView] }; } };
  window.__civswitchApp = instance;

  try {
    if (nativeError) throw Error("The console bridge could not start: " + nativeError);
    if (N) { try { pad = N.controller(); } catch (e) { record("Controller init: " + e.message); } }
    ensureDirs();
    await migrateOldData();
    await loadSettings();
    browser.style.display = "flex"; root.focus();
    await scan();
    var planText = null;
    try { planText = await readText(ROM_DIR + "/sw2nes-autotest.json"); } catch (e) { record("Autotest read: " + e.message); }
    if (planText) {
      try { files.remove(ROM_DIR + "/sw2nes-autotest.json"); files.commit(); } catch (e) { record("Autotest remove: " + e.message); }
      var plan = null; try { plan = JSON.parse(planText); } catch (e) { record("Autotest parse: " + e.message); }
      if (plan) { footer.textContent = "Running automated test..."; lastBits = readButtons(); schedule(); runAutotest(plan); await lifetime; return; }
    }
  } catch (e) { record("Startup: " + e.message); showMessage("Startup problem:\n" + e.message, function () { mode = "browser"; paintBrowser(); }); }
  lastBits = readButtons(); // ignore the A press that launched the app
  schedule();
  if (typeof log === "function") { try { await log("SW2NES_APP_READY"); } catch (_) {} }
  await lifetime;
})();
