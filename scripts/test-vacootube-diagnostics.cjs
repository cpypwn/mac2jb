'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {create, parseHeader, gateReason, FILE} = require('../integrations/vacootube/overlay/server/streaming/lib/mac-vacootube-diagnostics.cjs');

function readyHeader() {
  const bytes = Buffer.alloc(344);
  const set = (index, value) => bytes.writeUInt32LE(value, index * 4);
  set(0, 4);
  set(3, 4);
  set(24, 0x1f000300);
  set(41, 1);
  set(62, 31250000);
  set(69, 1);
  set(70, 3);
  set(72, 3);
  set(73, 3);
  set(78, 0);
  set(79, 0);
  set(80, 1);
  set(81, 4);
  set(82, 1);
  const mode = Buffer.alloc(4);
  mode.writeUInt32LE(2);
  return {bytes, mode};
}

test('console sample names the exact VacooTube display gates', () => {
  const {bytes, mode} = readyHeader();
  const display = parseHeader(bytes, mode);
  const sample = {player: {ready: true, frames: 2}, stream: {frames: 8},
    route: {ready: true}, receiver: {running: true}, console: display};
  assert.equal(gateReason(sample, 7), 'visible');
  assert.equal(gateReason({...sample, console: {...display, startOverlay: 1}}, 7),
    'console-start-overlay-open');
  assert.equal(gateReason({...sample, console: {...display, routePending: 1}}, 7),
    'console-route-pending');
  assert.equal(gateReason({...sample, console: {...display, telemetry: {...display.telemetry,
    sensorReady: false}}}, 7), 'console-network-sensor-not-ready');
  assert.equal(gateReason({...sample, console: {...display, hostEchoGeneration: 2}}, 7),
    'host-generation-not-echoed');
  assert.equal(gateReason({...sample, stream: {frames: 7}}, 7), 'gpu-frame-not-acknowledged');
  assert.equal(gateReason({...sample, stream: {frames: 1, started: 'new'}},
    7, 'old'), 'visible');
  assert.equal(display.sensor.sampleValid, true);
  assert.equal(display.telemetry.generation, 3);
});

test('VacooTube evidence survives switching to another IZlauncher app', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vacootube-diagnostics-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const {bytes, mode} = readyHeader();
  let tick = 0;
  const diagnostics = create({directory, mapped: 0, header: 0x700c80,
    rpc: {readMany: async spans => {
      assert.deepEqual(spans.map(span => span.length), [344, 4]);
      return [bytes, mode];
    }},
    now: () => new Date(Date.UTC(2026, 9, 31, 10, 0, tick++)).toISOString()});
  await fs.writeFile(path.join(directory, 'pc-screen-receiver.json'), JSON.stringify({
    created: '2026-10-31T10:00:00.000Z', running: true, ready: true,
    lastState: {stageName: 'sending acknowledgement'}
  }));
  diagnostics.begin({frames: 7});
  diagnostics.observe({source: 'player', routeGate: {ready: true, reason: 'physical-route-ready'},
    frames: 8, acknowledged: 4, youtube: {ready: true, frames: 2}});
  await diagnostics.flush();
  const file = path.join(directory, FILE);
  let report = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].last.gate, 'visible');
  assert.equal(report.attempts[0].last.console.publication, 4);
  assert.equal(report.attempts[0].last.receiver.stage, 'sending acknowledgement');
  assert.ok(report.attempts[0].firstPlayerFrame);
  assert.ok(report.attempts[0].firstGpuAck);
  assert.ok(report.attempts[0].firstVisible);
  diagnostics.end('source-changed');
  diagnostics.observe({source: 'doom', frames: 100});
  await diagnostics.flush();
  report = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(report.attempts[0].endReason, 'source-changed');
  assert.equal(report.attempts[0].last.stream.frames, 8);
});

test('diagnostic read failure is recorded without interrupting the player', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vacootube-diagnostics-error-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const diagnostics = create({directory, mapped: 0, header: 0x700c80,
    rpc: {readMany: async () => {throw Error('RPC unavailable');}}});
  diagnostics.begin({frames: 0});
  diagnostics.observe({source: 'player', frames: 1, youtube: {ready: true, frames: 1}});
  await diagnostics.flush();
  const report = JSON.parse(await fs.readFile(path.join(directory, FILE), 'utf8'));
  assert.equal(report.attempts[0].last.gate, 'console-header-unavailable');
  assert.equal(report.attempts[0].last.consoleReadError, 'RPC unavailable');
});
