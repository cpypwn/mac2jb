'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {create} = require('./pipeline.cjs');
const {qualityProfile} = require('./quality.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'Pipeline fixture did not become ready') {
  for (let count = 0; count < 400; count++) { if (check()) return; await delay(5); }
  throw Error(message);
}
const solid = (width, height, pixel) => {
  const output = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < output.length; offset += 4) output.set(pixel, offset);
  return output;
};
const overlayColor = model => [30 + ['prevEpisode', 'playPause', 'nextEpisode', 'stop'].indexOf(model.focused) * 30,
  model.paused ? 200 : 40, 100, 128];
const blended = color => color.slice(0, 3).map((value, index) => Math.round((value * color[3] + [20, 40, 60][index] * (255 - color[3])) / 255)).concat(255);

async function fixture(t, {quality = '180p', addonUrls = [], audioTracks = []} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stremio-overlay-pipeline-'));
  const state = {events: [], currentButtons: 0, rightStickX: undefined, polls: 0, publications: [], renders: [],
    encodes: [], decoders: [], errors: [], audio: [], activePtsMs: 0, gates: [], touch: undefined};
  let pipeline;
  t.after(async () => {
    state.gates.forEach(resolve => resolve());
    await pipeline?.close();
    await fs.rm(directory, {recursive: true, force: true});
  });
  const profile = qualityProfile(quality);
  pipeline = await create({directory, root: path.resolve(__dirname, '..'), quality, addonUrls, pollIntervalMs: 5,
    onFatal: error => state.errors.push(error),
    graphics: {
      async publish(bytes, ptsMs, format) {
        if(state.publishGate){state.publishWaiting=true;await state.publishGate;}
        if(state.rejectPTS===ptsMs){state.rejectPTS=undefined;return false;}
        state.publications.push({pixels: [...bytes], ptsMs, format: {...format}});
        state.activePtsMs = ptsMs; return true;
      },
      async poll() {
        state.polls++;
        return {events: state.events.splice(0), currentButtons: state.currentButtons, rightStickX: state.rightStickX,
          touch: state.touch, activeFrameSeq: state.publications.length, activePtsMs: state.activePtsMs};
      }
    },
    audio: {async reset() { state.audio.push('reset'); }, async playedSamples() { return 0; },
      async write() {}, async pause() { state.audio.push('pause'); }, async resume() { state.audio.push('resume'); }},
    render: async (model, options) => {
      const overlay = Boolean(options.overlay), playback = model.playbackOverlay;
      state.renders.push({overlay, width: options.width, height: options.height, view: model.view,
        focused: playback?.focused, paused: playback?.paused, subtitleLines: model.subtitleLines,
        mode: playback?.mode, seeking: playback?.seeking, message:playback?.message});
      if (!overlay) return solid(options.width, options.height, [77, 77, 77, 255]);
      const layer = Buffer.alloc(options.width * options.height * 4);
      layer.set(overlayColor(playback), 0);
      layer.set([9, 8, 7, 255], 8);
      if(model.subtitleLines?.length)layer.set([255, 250, 240, 255], 4);
      return layer;
    },
    encode: (rgba, width, height) => {
      assert.equal(rgba.length, width * height * 4);
      state.encodes.push({width, height, pixels: [...rgba.subarray(0, 12)]});
      return Buffer.from(rgba.subarray(0, 12));
    },
    createDecoder: async (source, options) => {
      const request = {source, options, stopped: false, pauses: 0, resumes: 0};
      state.decoders.push(request);
      if(state.openGate)await state.openGate;
      return {info: {duration: 600, hasAudio: false, codecs: ['fixture'], sourceWidth: 3840, sourceHeight: 2160,
          audioTracks, audioTrackId: options.audioTrackId ?? audioTracks[0]?.id},
        async stop() { request.stopped = true;if(state.drainVideoOnStop)await request.videoPromise; }, pause() { request.pauses++; }, resume() { request.resumes++; }};
    }});
  await until(() => !pipeline.controller.busy && pipeline.controller.catalogItems.length === 1);
  return {pipeline, controller: pipeline.controller, state, profile,
    async start() {
      for (let count = 0; count < 3; count++) await pipeline.controller.handleButton('a');
      await until(() => state.decoders.length === 1 && state.renders.some(render => render.overlay));
    },
    async frame(ptsMs = 1000, index = 0) {
      const rgba = solid(profile.width, profile.height, [20, 40, 60, 255]);
      const request=state.decoders.at(-1);request.videoPromise=request.options.onVideo(rgba, {ptsMs, index});
      await request.videoPromise;
      return rgba;
    }};
}

test('paused playback retains the decoded frame under changing transparent controls at the same PTS', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start();
  const originalFrame = await f.frame();
  const playingPixels = f.state.publications.at(-1).pixels;
  const menuRenders = f.state.renders.filter(render => !render.overlay).length;
  await f.controller.handleButton('a');
  await until(() => f.pipeline.report.overlayFrames > 0);
  let publication = f.state.publications.at(-1);
  assert.equal(publication.ptsMs, 1000);
  assert.notDeepEqual(publication.pixels, playingPixels);
  assert.deepEqual(publication.pixels.slice(0, 4), blended(overlayColor(f.controller.getMenuModel().playbackOverlay)));
  assert.deepEqual(publication.pixels.slice(4, 8), [20, 40, 60, 255]);
  assert.deepEqual(publication.pixels.slice(8, 12), [9, 8, 7, 255]);
  const pausedPixels = publication.pixels, beforeFocus = f.state.publications.length;
  await f.controller.handleButton('left');
  await until(() => f.state.publications.length > beforeFocus);
  publication = f.state.publications.at(-1);
  assert.equal(publication.ptsMs, 1000); assert.notDeepEqual(publication.pixels, pausedPixels);
  assert.deepEqual(publication.pixels.slice(4, 8), [20, 40, 60, 255]);
  const beforeHide = f.state.publications.length;
  await f.controller.handleButton('x');
  await until(() => f.state.publications.length > beforeHide);
  assert.deepEqual(f.state.publications.at(-1).pixels, [...originalFrame.subarray(0, 12)]);
  assert.equal(f.state.publications.at(-1).ptsMs, 1000);
  assert.equal(f.state.renders.filter(render => !render.overlay).length, menuRenders);
  assert.deepEqual([...originalFrame.subarray(0, 12)], [20, 40, 60, 255, 20, 40, 60, 255, 20, 40, 60, 255]);
  assert.equal(f.state.decoders.length, 1); assert.equal(f.state.decoders[0].pauses, 1);
  assert.deepEqual(f.state.errors, []);
});

test('X toggles the transparent layer on decoded frames while playback continues', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start(); await f.frame();
  assert.notDeepEqual(f.state.publications.at(-1).pixels.slice(0, 4), [20, 40, 60, 255]);
  const polls = f.state.polls;
  await f.controller.handleButton('x');
  await until(() => f.state.polls >= polls + 3);
  await f.frame(1100, 1);
  assert.deepEqual(f.state.publications.at(-1).pixels.slice(0, 4), [20, 40, 60, 255]);
  const overlays = f.state.renders.filter(render => render.overlay).length;
  await f.controller.handleButton('x');
  await until(() => f.state.renders.filter(render => render.overlay).length > overlays);
  await f.frame(1200, 2);
  assert.notDeepEqual(f.state.publications.at(-1).pixels.slice(0, 4), [20, 40, 60, 255]);
  assert.equal(f.state.decoders.length, 1); assert.equal(f.state.decoders[0].pauses, 0);
  assert.deepEqual(f.state.errors, []);
});

test('native button bits route episode shoulders, seek triggers, Plus and left-stick directions once', {timeout: 10000}, async t => {
  const f = await fixture(t), buttons = [];
  f.controller.handleButton = async button => { buttons.push(button); };
  for (const [index, bit] of [6, 7, 8, 9, 10, 16, 17, 18, 19].entries()) {
    f.state.events.push({buttons: 1 << bit});
    await until(() => buttons.length === index + 1);
  }
  assert.deepEqual(buttons, ['l', 'r', 'zl', 'zr', 'plus', 'left', 'up', 'right', 'down']);
  f.state.events.push({buttons: (1 << 12) | (1 << 16)});
  await until(() => buttons.length === 10);
  assert.equal(buttons.at(-1), 'left');
  const touches = [], touch = {x: 640, y: 580, phase: 'start'};
  f.controller.handleTouch = async event => { touches.push(event); };
  f.state.events.push({buttons: 1, touch});
  await until(() => touches.length === 1);
  assert.deepEqual(touches, [touch]); assert.equal(buttons.length, 10);
  assert.deepEqual(f.state.errors, []);
});

test('raw right-stick float previews then releases exactly one absolute seek through the actual pipeline', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600);
  f.state.rightStickX = 0.5;
  await until(() => f.controller.seekPreview !== null && f.controller.seekPreview > 10.2);
  assert.equal(f.state.decoders.length, 1);
  assert.equal(f.controller.playback.position, 10);
  const target = f.controller.seekPreview;
  f.state.rightStickX = 0;
  await until(() => f.state.decoders.length === 2 && !f.controller.busy);
  const afterRelease = f.state.polls;
  await until(() => f.state.polls >= afterRelease + 5);
  assert.equal(f.state.decoders.length, 2);
  assert.ok(f.state.decoders[1].options.position >= target);
  assert.ok(f.state.decoders[1].options.position < 12);
  assert.equal(f.state.decoders[0].stopped, true);
  assert.equal(f.controller.seekPreview, null);
  assert.deepEqual(f.state.errors, []);
});

test('held left-stick navigation repeats after a delay and does not backlog during a pending action', {timeout: 10000}, async t => {
  let wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
  const f = await fixture(t), buttons = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; }); f.state.gates.push(release);
  f.controller.handleButton = async button => { buttons.push(button); if (buttons.length === 2) await pending; };
  f.state.currentButtons = 1 << 17; f.state.events.push({buttons: 1 << 17});
  await until(() => buttons.length === 1);
  let polls = f.state.polls; wall += 400;
  await until(() => f.state.polls >= polls + 3); assert.equal(buttons.length, 1);
  wall += 600; await until(() => buttons.length === 2);
  polls = f.state.polls; wall += 10000;
  await until(() => f.state.polls >= polls + 5); assert.equal(buttons.length, 2);
  f.state.currentButtons = 0; release();
  polls = f.state.polls; await until(() => f.state.polls >= polls + 5);
  assert.deepEqual(buttons, ['up', 'up']); assert.deepEqual(f.state.errors, []);
});

test('720p quality reaches decoder selection, overlay rendering, encoding and native frame format', {timeout: 10000}, async t => {
  const f = await fixture(t, {quality: '720p'}); await f.start(); await f.frame();
  assert.equal(f.state.decoders[0].options.quality, '720p');
  assert.ok(f.state.renders.some(render => render.overlay && render.width === 1280 && render.height === 720));
  assert.deepEqual(f.state.encodes.at(-1).width, 1280); assert.deepEqual(f.state.encodes.at(-1).height, 720);
  assert.deepEqual(f.state.publications.at(-1).format, {width: 1280, height: 720});
  assert.equal(f.pipeline.report.quality, '720p'); assert.equal(f.pipeline.report.targetWidth, 1280);
  assert.equal(f.pipeline.report.sourceWidth, 3840); assert.equal(f.pipeline.report.sourceHeight, 2160);
  assert.deepEqual(f.state.errors, []);
});

test('seeking retains video under the overlay while opening and clears busy on the first new frame', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600);
  const menus = f.state.renders.filter(row => !row.overlay).length;
  let release;
  f.state.openGate = new Promise(resolve => { release = resolve; }); f.state.gates.push(release);
  const seeking = f.controller.handleButton('zr');
  await until(() => f.state.decoders.length === 2 && f.controller.playback.seeking);
  await until(() => f.pipeline.report.overlayFrames > 0);
  assert.equal(f.controller.view, 'playing');
  assert.equal(f.state.renders.filter(row => !row.overlay).length, menus);
  assert.deepEqual(f.state.publications.at(-1).pixels.slice(4, 8), [20, 40, 60, 255]);
  release(); await seeking;
  assert.equal(f.controller.playback.seeking, true);
  await f.frame(20000); await until(() => !f.controller.playback.seeking);
  assert.equal(f.state.renders.filter(row => !row.overlay).length, menus);
  assert.deepEqual(f.state.errors, []);
});

test('a frame completing during queued seek shutdown cannot strand the resumed playback controls', {timeout:10000},async t=>{
  const f=await fixture(t);await f.start();await f.frame(10000);
  await until(()=>f.controller.playback.duration===600);
  f.state.drainVideoOnStop=true;
  let release;f.state.publishGate=new Promise(resolve=>{release=resolve;});f.state.gates.push(release);
  const oldFrame=f.frame(10066,0);await until(()=>f.state.publishWaiting);
  const framesBefore=f.pipeline.report.frames;
  // exercise the real input queue while the old decoder drains its callback.
  f.state.events.push({buttons:1<<9});
  await until(()=>f.state.decoders[0].stopped&&f.controller.busy);
  assert.equal(f.state.decoders.length,1,'replacement waits for the old decoder callback');
  f.state.publishGate=undefined;release();await oldFrame;
  await until(()=>f.state.decoders.length===2&&!f.controller.busy);
  assert.equal(f.controller.playback.seeking,true,'wait for a frame from the replacement decoder');
  const resumedPTS=f.state.decoders[1].options.position*1000;
  f.state.rejectPTS=resumedPTS;await f.frame(resumedPTS);
  assert.equal(f.controller.playback.seeking,true,'a dropped replacement frame cannot finish seeking');
  await f.frame(resumedPTS+1000/15,1);await until(()=>!f.controller.playback.seeking);
  assert.equal(f.pipeline.report.frames,framesBefore+1,'retired upload cannot count as replacement playback');
  await f.frame(resumedPTS+2000/15,2);
  assert.ok(!f.controller.getMenuModel().playbackOverlay.message.includes('Seeking'));
  f.state.events.push({buttons:1<<2});await until(()=>!f.controller.overlay.visible);
  f.state.events.push({buttons:0,touch:{x:640,y:360,phase:'start'}});await until(()=>f.controller.overlay.visible);
  const realNow=f.controller.now;f.controller.now=()=>realNow()+10000;
  assert.equal(f.controller.tickOverlay(),true);assert.equal(f.controller.overlay.visible,false);
  assert.deepEqual(f.state.errors,[]);
});

test('held ZR and left stick continuously preview and each reopen once after release', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600);
  for (const bit of [9, 16]) {
    const count = f.state.decoders.length;
    f.state.currentButtons = 1 << bit; f.state.events.push({buttons: 1 << bit});
    await until(() => f.controller.seekGesture?.owner === 'held');
    const initial = f.controller.seekPreview;
    await delay(400);
    assert.equal(f.state.decoders.length, count);
    assert.ok(bit === 9 ? f.controller.seekPreview > initial : f.controller.seekPreview < initial);
    f.state.currentButtons = 0;
    await until(() => f.state.decoders.length === count + 1 && !f.controller.busy);
    await f.frame(f.state.decoders.at(-1).options.position * 1000);
    await until(() => !f.controller.playback.seeking);
    const polls = f.state.polls; await until(() => f.state.polls >= polls + 3);
    assert.equal(f.state.decoders.length, count + 1);
  }
  assert.deepEqual(f.state.errors, []);
});

test('physical D-pad navigates playback controls and track pages while the left stick seeks', {timeout: 10000}, async t => {
  const audioTracks = Array.from({length: 8}, (_, id) => ({id, label: `Track ${id}`}));
  const f = await fixture(t, {audioTracks}); await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600);
  f.state.events.push({buttons: 1 << 14});
  await until(() => f.controller.overlay.focused === 'audio');
  f.state.events.push({buttons: 1});
  await until(() => f.controller.overlay.mode === 'audio');
  f.state.events.push({buttons: 1 << 15});
  await until(() => f.controller.overlay.optionSelected === 1);
  f.state.events.push({buttons: 1 << 14});
  await until(() => f.controller.overlay.optionSelected === 6);
  f.state.events.push({buttons: 1 << 12});
  await until(() => f.controller.overlay.optionSelected === 0);
  f.state.events.push({buttons: 1 << 1});
  await until(() => f.controller.overlay.mode === 'controls');
  f.state.currentButtons = 1 << 18;
  f.state.events.push({buttons: 1 << 18});
  await until(() => f.controller.seekGesture?.owner === 'held');
  const preview = f.controller.seekPreview, focused = f.controller.overlay.focused;
  f.state.events.push({buttons: (1 << 12) | (1 << 18)});
  await until(() => f.controller.overlay.focused !== focused);
  await until(() => f.controller.seekPreview > preview);
  f.state.currentButtons = 0;
  await until(() => f.state.decoders.length === 2 && !f.controller.busy);
  assert.deepEqual(f.state.errors, []);
});

test('stable touch snapshot recovers drag moves and release without another ring edge', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600);
  f.state.touch = {active: true, x: 640, y: 470, id: 7};
  f.state.events.push({buttons: 0, touch: {x: 640, y: 470, phase: 'start'}});
  await until(() => f.controller.seekGesture?.owner === 'touch');
  assert.equal(f.controller.seekPreview, 300);
  f.state.touch = {active: true, x: 905, y: 650, id: 7};
  await until(() => f.controller.seekPreview === 450);
  assert.equal(f.state.decoders.length, 1);
  f.state.touch = {active: false, x: 905, y: 650, id: 7};
  await until(() => f.state.decoders.length === 2 && !f.controller.busy);
  assert.equal(f.state.decoders[1].options.position, 450);
  const polls = f.state.polls; await until(() => f.state.polls >= polls + 5);
  assert.equal(f.state.decoders.length, 2); assert.equal(f.controller.view, 'playing');
  assert.deepEqual(f.state.errors, []);
});

test('paused language switch preserves position and frame, then leaves controls able to resume', {timeout: 10000}, async t => {
  const f = await fixture(t, {audioTracks: [{id: 2, label: 'English'}, {id: 5, label: 'Japanese'}]});
  await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600 && f.pipeline.report.displayAcknowledgedPosition === 10);
  await f.controller.handleButton('a');
  assert.equal(f.controller.playback.paused, true);
  const menus = f.state.renders.filter(row => !row.overlay).length;
  await f.controller.selectMediaTrack('audio', 5);
  assert.equal(f.state.decoders.length, 2);
  assert.equal(f.state.decoders[1].options.audioTrackId, 5);
  assert.equal(f.state.decoders[1].options.position, 10);
  assert.equal(f.state.decoders[1].pauses, 1);
  assert.equal(f.controller.playback.seeking, false);
  assert.equal(f.controller.playback.paused, true);
  assert.equal(f.state.renders.filter(row => !row.overlay).length, menus);
  assert.equal(f.controller.audioTracks.find(track => track.selected).id, 5);
  await f.controller.handleTouch({x: 300, y: 560, phase: 'start'});
  assert.equal(f.controller.playback.paused, false);
  assert.equal(f.state.decoders[1].resumes, 1);
  assert.deepEqual(f.state.errors, []);
});

test('a held first touch reveals hidden controls without the stable snapshot recapturing its finger', {timeout: 10000}, async t => {
  const f = await fixture(t); await f.start(); await f.frame(10000);
  await until(() => f.controller.playback.duration === 600);
  await f.controller.handleButton('x'); assert.equal(f.controller.overlay.visible, false);
  f.state.touch = {active: true, x: 640, y: 470, id: 2};
  f.state.events.push({buttons: 0, touch: {x: 640, y: 470, phase: 'start'}});
  await until(() => f.controller.overlay.visible);
  const polls = f.state.polls; await until(() => f.state.polls >= polls + 5);
  assert.equal(f.controller.seekGesture, null); assert.equal(f.controller.seekPreview, null);
  f.state.touch = {active: false, x: 640, y: 470, id: 2};
  await until(() => f.state.polls >= polls + 10);
  assert.equal(f.state.decoders.length, 1);
  assert.deepEqual(f.state.errors, []);
});

test('installed subtitle addon loads only selected cues, composites with hidden controls, and turns off', {timeout: 10000}, async t => {
  const http = require('node:http'); let base, downloads = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/manifest.json') return response.end(JSON.stringify({id: 'fixture.subtitles', version: '1.0.0', name: 'Subtitles', resources: ['subtitles'], types: ['movie'], catalogs: []}));
    if (request.url.startsWith('/subtitles/movie/')) return response.end(JSON.stringify({subtitles: [{id: 'en', lang: 'eng', url: base + '/english.srt'}]}));
    if (request.url === '/english.srt') { downloads++; return response.end('1\n00:00:09,000 --> 00:00:12,000\nHello from the add-on\n\n2\n00:00:20,000 --> 00:00:21,000\nLater cue\n'); }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t, {addonUrls: [base + '/manifest.json']}); await f.start(); await f.frame(10000);
  await until(() => f.controller.subtitleTracks.length === 1);
  assert.equal(downloads, 0);
  await f.controller.selectMediaTrack('subtitles', f.controller.subtitleTracks[0].id);
  assert.equal(downloads, 1);
  await f.controller.handleButton('x'); await f.frame(10100, 1);
  assert.deepEqual(f.state.renders.at(-1).subtitleLines, ['Hello from the add-on']);
  assert.deepEqual(f.state.publications.at(-1).pixels.slice(4, 8), [255, 250, 240, 255]);
  await f.controller.selectMediaTrack('subtitles', null);
  await f.controller.handleButton('x'); await f.frame(10200, 2);
  assert.deepEqual(f.state.publications.at(-1).pixels.slice(4, 8), [20, 40, 60, 255]);
  assert.equal(downloads, 1); assert.equal(f.state.decoders.length, 1);
  assert.deepEqual(f.state.errors, []);
});
