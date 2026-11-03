'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const FILE = 'vacootube-display-diagnostics.json';
const HEADER_BYTES = 344;

function parseHeader(bytes, mode) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== HEADER_BYTES ||
      !Buffer.isBuffer(mode) || mode.length !== 4) throw Error('Incomplete console display sample');
  const word = index => bytes.readUInt32LE(index * 4);
  const flags = word(24);
  return {
    activeApp: mode.readUInt32LE(),
    publication: word(0),
    gpuAck: word(3),
    startOverlay: word(38),
    hostReady: word(41),
    routePending: word(63),
    visibleLatch: word(69),
    generation: word(70),
    frameGeneration: word(72),
    hostEchoGeneration: word(73),
    telemetry: {
      flags,
      valid: !!(flags & 0x10000000),
      visible: !!(flags & 0x01000000),
      sensorReady: !!(flags & 0x02000000),
      routeReady: !!(flags & 0x04000000),
      hostReady: !!(flags & 0x08000000),
      generation: (flags >>> 8) & 255
    },
    sensor: {
      clockReady: word(62) === 31250000,
      sampleValid: word(82) === 1,
      mode: word(78),
      result: word(79),
      type: word(80),
      status: word(81),
      policy: word(84)
    }
  };
}

function hasNewAck(stream, baselineFrames = 0, baselineStarted = null) {
  return stream.started && baselineStarted && stream.started !== baselineStarted
    ? stream.frames > 0 : stream.frames > baselineFrames;
}

function gateReason(sample, baselineFrames = 0, baselineStarted = null) {
  const {player, stream, route, receiver, console: display} = sample;
  if (stream.sourceError || stream.error) return 'player-or-stream-error';
  if (!player.ready) return 'player-not-ready';
  if (!player.frames) return 'player-no-compositor-frame';
  if (route?.ready === false) return 'console-network-not-ready';
  if (receiver?.error) return 'receiver-error';
  if (receiver && receiver.running === false && !receiver.preexisting) return 'receiver-not-running';
  if (!hasNewAck(stream, baselineFrames, baselineStarted)) return 'gpu-frame-not-acknowledged';
  if (!display) return sample.consoleReadError ? 'console-header-unavailable' : 'console-header-pending';
  if (display.activeApp !== 2) return 'console-player-not-active';
  if (display.startOverlay !== 0) return 'console-start-overlay-open';
  if (display.routePending !== 0) return 'console-route-pending';
  if (display.hostReady !== 1) return 'host-display-gate-closed';
  if (!display.telemetry.valid) return 'console-telemetry-unavailable';
  if (!display.telemetry.sensorReady) return 'console-network-sensor-not-ready';
  if (!display.telemetry.routeReady) return 'console-network-route-not-ready';
  if (display.frameGeneration !== display.generation) return 'fresh-frame-not-confirmed';
  if (display.hostEchoGeneration !== display.generation) return 'host-generation-not-echoed';
  if (display.visibleLatch !== 1 || !display.telemetry.visible) return 'display-confirmation-pending';
  return 'visible';
}

function view(state) {
  return {
    route: state.routeGate && {
      ready: state.routeGate.ready,
      reason: state.routeGate.reason,
      code: state.routeGate.code,
      mode: state.routeGate.mode,
      required: state.routeGate.required,
      network: state.routeGate.network
    },
    stream: {
      started: state.started ?? null,
      frames: Number(state.frames) || 0,
      acknowledged: state.acknowledged ?? null,
      awaitingFreshFrame: !!state.awaitingFreshFrame,
      freshnessReason: state.freshnessReason ?? null,
      sourceError: state.sourceError ?? null,
      error: state.error ?? null,
      consoleDisplay: state.consoleDisplay ?? null
    },
    player: {
      ready: state.youtube?.ready === true,
      frames: Number(state.youtube?.frames) || 0,
      inputError: state.youtube?.inputError || null,
      audioError: state.youtube?.audioError || null
    }
  };
}

function create({directory, rpc, mapped, header, now = () => new Date().toISOString()}) {
  const filename = path.join(directory, FILE);
  const report = {version: 1, module: 'vacootube', attempts: []};
  let current = null;
  let pending = Promise.resolve();
  const persist = () => fs.writeFile(filename, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  function enqueue(task) {
    pending = pending.then(task).catch(error => {
      console.error('VacooTube diagnostics: ' + error.message);
    });
  }
  async function sample() {
    const spans = [{address: mapped + header, length: HEADER_BYTES},
      {address: mapped + 0x700004, length: 4}];
    const buffers = rpc.readMany ? await rpc.readMany(spans) :
      [await rpc.read(spans[0].address, spans[0].length),
        await rpc.read(spans[1].address, spans[1].length)];
    return parseHeader(buffers[0], buffers[1]);
  }
  function begin(stats = {}) {
    if (current) end('replaced');
    current = {
      started: now(),
      baselineFrames: Number(stats.frames) || 0,
      baselineStreamStarted: stats.started ?? null,
      firstPlayerFrame: null,
      firstGpuAck: null,
      firstVisible: null,
      last: null,
      transitions: []
    };
    report.attempts.push(current);
    enqueue(persist);
  }
  function observe(state) {
    if (!current || state.source !== 'player') return;
    const attempt = current;
    const selected = view(state);
    enqueue(async () => {
      const at = now();
      let display = null, consoleReadError = null, receiver = null;
      try { display = await sample(); }
      catch (error) { consoleReadError = error.message; }
      try {
        const row = JSON.parse(await fs.readFile(path.join(directory, 'pc-screen-receiver.json'), 'utf8'));
        const timestamp = Date.parse(row.created || row.started || '');
        receiver = {
          running: row.running === true,
          ready: row.ready === true,
          error: row.error || row.stopError || null,
          stage: row.lastState?.stageName || null,
          lastState: row.lastState || null,
          preexisting: Number.isFinite(timestamp) && timestamp < Date.parse(attempt.started) - 2500
        };
      } catch {}
      const entry = {at, ...selected, receiver, console: display, consoleReadError};
      entry.gate = gateReason(entry, attempt.baselineFrames, attempt.baselineStreamStarted);
      if (!attempt.firstPlayerFrame && entry.player.frames > 0) attempt.firstPlayerFrame = at;
      if (!attempt.firstGpuAck && hasNewAck(entry.stream, attempt.baselineFrames,
          attempt.baselineStreamStarted)) attempt.firstGpuAck = at;
      if (!attempt.firstVisible && entry.gate === 'visible') attempt.firstVisible = at;
      if (!attempt.last || attempt.last.gate !== entry.gate ||
          Date.parse(at) - Date.parse(attempt.last.at) >= 5000) {
        attempt.transitions.push(entry);
        if (attempt.transitions.length > 24) attempt.transitions.shift();
      }
      attempt.last = entry;
      await persist();
    });
  }
  function end(reason) {
    if (!current) return;
    const attempt = current;
    current = null;
    enqueue(async () => { attempt.ended = now(); attempt.endReason = reason; await persist(); });
  }
  return {begin, observe, end, flush: () => pending};
}

module.exports = {create, parseHeader, gateReason, FILE};
