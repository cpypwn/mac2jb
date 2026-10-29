'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require('../../stremio/protocol.cjs');
const {create, createGraphics, HOLD_MS, B_BUTTON, MINUS_BUTTON} = require('./adapter.cjs');

const directory = path.join(__dirname, 'offline-session');
const root = path.resolve(__dirname, '../..');
const mapped = 0x200000;
const mediaHeader = P.initialMemory().subarray(0, 16);

test('media bridge reuses MintBrew-owned storage and delegates to its frame worker', async () => {
  const writes = [];
  let receiverArgs, transportArgs, uploads = 0, stopped = 0;
  const rpc = {read: async (address, length) => {
    assert.equal(address, mapped);
    assert.equal(length, 16);
    return mediaHeader;
  }, write: async (address, bytes) => writes.push({address, bytes: Buffer.from(bytes)})};
  const graphics = await createGraphics({rpc, gpu: {privateStorage: {mapped, bytes: P.MEMORY_BYTES}}, directory,
    dependencies: {
      createReceiver: async args => {
        receiverArgs = args;
        return {report: {ready: true}, upload: async () => {uploads++;}, close: async () => {stopped++;}};
      },
      createTransport: args => {
        transportArgs = args;
        return {publishedFrameSeq: 4, publish: async () => true,
          poll: async () => ({currentButtons: 0, events: []}), close: async () => {stopped++;}};
      }
    }});
  assert.equal(writes.length, 0);
  assert.equal(receiverArgs.mapped, mapped);
  assert.equal(transportArgs.mapped, mapped);
  assert.equal(graphics.publishedFrameSeq, 4);
  assert.equal(await graphics.publish(Buffer.alloc(0), 0), true);
  assert.equal((await graphics.poll()).currentButtons, 0);
  await transportArgs.upload({address: mapped + P.HEADER_BYTES, packet: Buffer.alloc(P.WRITE_BYTES)});
  await transportArgs.upload({address: mapped + P.HEADER_BYTES, packet: Buffer.alloc(P.WRITE_BYTES + 1)});
  assert.equal(uploads, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, mapped + P.HEADER_BYTES);
  assert.equal(writes[0].bytes.length, P.WRITE_BYTES);
  await graphics.close();
  await graphics.close();
  assert.equal(stopped, 2);
});

test('B and Minus require a continuous hold; the exit callback runs once outside polling', async () => {
  let clock = 0, buttons = 0, returns = 0;
  const graphics = await createGraphics({rpc: {read: async () => mediaHeader, write: async () => {}},
    gpu: {privateStorage: {mapped, bytes: P.MEMORY_BYTES}}, directory,
    onReturn: () => {returns++;}, dependencies: {
      now: () => clock,
      createReceiver: async () => ({report: {}, close: async () => {}, upload: async () => {}}),
      createTransport: () => ({poll: async () => ({currentButtons: buttons, events: []}), close: async () => {}})
    }});
  buttons = B_BUTTON;
  await graphics.poll();
  clock = HOLD_MS - 1;
  await graphics.poll();
  assert.equal(returns, 0);
  buttons = 0;
  await graphics.poll();
  buttons = MINUS_BUTTON;
  await graphics.poll();
  clock += HOLD_MS;
  await graphics.poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returns, 1);
  await graphics.poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returns, 1);
  await graphics.close();
});

test('service starts on the already-running MintBrew worker and exits after cleanup', async () => {
  const events = [];
  let returnToMenu, pipelineArgs;
  const rpc = {a: {session: 'offline'}, write: async (address, bytes) =>
    events.push([address === 0x100000 + 976 ? 'sound' : 'exit', address,
      bytes.readUInt32LE(), bytes.length === 8 ? bytes.readUInt32LE(4) : undefined])};
  const menu = {controls: {mapped: 0x100000}};
  const service = create({rpc, menu, gpu: {privateStorage: {mapped, bytes: P.MEMORY_BYTES}},
    directory, root, config: {addonUrls: ['https://example.test/manifest.json'],
      libraryItems: [{id: 'movie'}], quality: '540p'},
    dependencies: {
      checkDecoder: () => {events.push('decoder');},
      loadPreferences: () => ({last: true}),
      createGraphics: async options => {
        events.push('graphics');
        returnToMenu = options.onReturn;
        return {abortPending: async () => {events.push('abort');}, close: async () => {events.push('graphics-close');}};
      },
      createAudio: async () => {events.push('audio'); return {close: async () => {events.push('audio-close');}};},
      createPipeline: async options => {
        pipelineArgs = options;
        events.push('pipeline');
        return {close: async () => {events.push('pipeline-close');}};
      }
    }});
  await service.start();
  assert.equal(service.report.status, 'running');
  assert.deepEqual(events.slice(0, 4), ['decoder', 'graphics', 'audio', 'pipeline']);
  assert.deepEqual(pipelineArgs.addonUrls, ['https://example.test/manifest.json']);
  assert.deepEqual(pipelineArgs.libraryItems, [{id: 'movie'}]);
  assert.equal(pipelineArgs.quality, '540p');
  assert.deepEqual(pipelineArgs.sourcePreferences, {last: true});
  await pipelineArgs.onNavigation();
  await pipelineArgs.onNavigation();
  assert.deepEqual(events.filter(row => Array.isArray(row) && row[0] === 'sound'), [
    ['sound', menu.controls.mapped + 976, 1, 8],
    ['sound', menu.controls.mapped + 976, 2, 8]
  ]);
  await returnToMenu();
  assert.equal(service.report.status, 'stopped');
  assert.ok(events.indexOf('pipeline-close') < events.findIndex(value => Array.isArray(value) && value[0] === 'exit'));
  assert.ok(events.indexOf('audio-close') < events.findIndex(value => Array.isArray(value) && value[0] === 'exit'));
  assert.ok(events.indexOf('graphics-close') < events.findIndex(value => Array.isArray(value) && value[0] === 'exit'));
  assert.deepEqual(events.at(-1), ['exit', menu.controls.mapped + 1016, 1, undefined]);
  await service.close();
  assert.equal(events.filter(value => value === 'pipeline-close').length, 1);
});

test('invalid storage and configuration fail before touching the console', async () => {
  await assert.rejects(createGraphics({rpc: {write: async () => {}},
    gpu: {privateStorage: {mapped, bytes: P.MEMORY_BYTES - 1}}, directory}), /owned media buffer/);
  await assert.rejects(createGraphics({rpc: {read: async () => Buffer.alloc(16), write: async () => {}},
    gpu: {privateStorage: {mapped, bytes: P.MEMORY_BYTES}}, directory}), /did not load/);
  assert.throws(() => create({rpc: {}, menu: {controls: {mapped: 1}}, gpu: {}, directory, root,
    config: {quality: '8k'}}), /configuration/);
});

test('startup failure releases already-created owners', async () => {
  const events = [];
  const service = create({rpc: {a: {session: 'offline'}}, menu: {controls: {mapped: 0x100000}},
    gpu: {}, directory, root, dependencies: {
      checkDecoder: () => {},
      createGraphics: async () => ({abortPending: async () => events.push('abort'),
        close: async () => events.push('graphics-close')}),
      createAudio: async () => ({close: async () => events.push('audio-close')}),
      loadPreferences: () => ({}),
      createPipeline: async () => {throw Error('render failed');}
    }});
  await assert.rejects(service.start(), /render failed/);
  assert.equal(service.report.status, 'failed');
  assert.ok(events.includes('audio-close'));
  assert.ok(events.includes('graphics-close'));
  await service.close();
});

test('closing during startup waits for a pending graphics setup and then releases it', async () => {
  let finishGraphics;
  const created = new Promise(resolve => {finishGraphics = resolve;});
  let closedGraphics = 0, audioCreated = 0;
  const service = create({rpc: {a: {session: 'offline'}}, menu: {controls: {mapped: 0x100000}},
    gpu: {}, directory, root, dependencies: {
      checkDecoder: () => {},
      createGraphics: () => created,
      createAudio: async () => {audioCreated++;},
      loadPreferences: () => ({}),
      createPipeline: async () => {}
    }});
  const started = service.start();
  await new Promise(resolve => setImmediate(resolve));
  const closing = service.close();
  finishGraphics({abortPending: async () => {}, close: async () => {closedGraphics++;}});
  await assert.rejects(started, /closed during startup/);
  await closing;
  assert.equal(audioCreated, 0);
  assert.equal(closedGraphics, 1);
});

test('a pipeline failure reports once and returns to MintBrew after cleanup', async () => {
  const events = [];
  let pipelineArgs;
  const rpc = {a: {session: 'offline'}, write: async (address, bytes) => {
    events.push(['exit', address, bytes.readUInt32LE()]);
  }};
  const service = create({rpc, menu: {controls: {mapped: 0x100000}}, gpu: {},
    directory, root, onFatal: error => events.push(['fatal', error.message]), dependencies: {
      checkDecoder: () => {}, loadPreferences: () => ({}),
      createGraphics: async () => ({abortPending: async () => {},
        close: async () => events.push('graphics-close')}),
      createAudio: async () => ({close: async () => events.push('audio-close')}),
      createPipeline: async args => {
        pipelineArgs = args;
        return {close: async () => events.push('pipeline-close')};
      }
    }});
  await service.start();
  pipelineArgs.onFatal(Error('frame failed'));
  pipelineArgs.onFatal(Error('duplicate'));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(value => Array.isArray(value) && value[0] === 'fatal'),
    [['fatal', 'frame failed']]);
  assert.deepEqual(events.at(-1), ['exit', 0x100000 + 1016, 1]);
  assert.equal(service.report.status, 'failed');
});
