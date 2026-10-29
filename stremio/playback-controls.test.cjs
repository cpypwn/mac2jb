'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {OVERLAY_WIDTH, OVERLAY_HEIGHT, AUTO_HIDE_MS, SEEK_GESTURE_TIMEOUT_MS, OPTION_PAGE_SIZE, CONTROL_IDS, playbackOverlayModel,
  hitTestPlaybackOverlay, nextPlaybackFocus, validPoint, seekPositionAtX} = require('./playback-controls.cjs');

test('overlay drawing rectangles and touch hitboxes use the same canonical coordinates', () => {
  const model = playbackOverlayModel({visible: true, focused: 'playPause', position: 125, duration: 500});
  assert.equal(model.width, OVERLAY_WIDTH); assert.equal(model.height, OVERLAY_HEIGHT);
  assert.equal(model.width, 1280); assert.equal(model.height, 720); assert.equal(AUTO_HIDE_MS, 4000);
  assert.deepEqual(model.controls.map(control => control.id), CONTROL_IDS);
  for (const control of model.controls) {
    assert.deepEqual(hitTestPlaybackOverlay({x: control.x + control.width / 2, y: control.y + control.height / 2}, 500), {action: control.id});
    assert.deepEqual(hitTestPlaybackOverlay({x: control.x, y: control.y}, 500), {action: control.id});
    assert.equal(hitTestPlaybackOverlay({x: control.x + control.width, y: control.y}, 500), null);
  }
  assert.deepEqual(hitTestPlaybackOverlay({x: model.close.x + 1, y: model.close.y + 1}), {action: 'close'});
  assert.equal(model.timeLabel, '2:05 / 8:20'); assert.equal(model.ratio, 0.25);
});

test('seekbar maps taps to absolute positions and rejects unknown durations and invalid points', () => {
  const {seekbar} = playbackOverlayModel();
  assert.deepEqual(hitTestPlaybackOverlay({x: seekbar.x, y: seekbar.y}, 600), {action: 'seekTo', seconds: 0});
  assert.deepEqual(hitTestPlaybackOverlay({x: seekbar.x + seekbar.width / 2, y: seekbar.y + 5}, 600), {action: 'seekTo', seconds: 300});
  assert.equal(hitTestPlaybackOverlay({x: seekbar.x + seekbar.width / 2, y: seekbar.y}, 0), null);
  assert.equal(hitTestPlaybackOverlay({x: seekbar.x, y: seekbar.y}, Infinity), null);
  for (const point of [undefined, {}, {x: NaN, y: 2}, {x: 1, y: Infinity}, {x: -1, y: 0}, {x: 1280, y: 0}, {x: 0, y: 720}]) {
    assert.equal(validPoint(point), false); assert.equal(hitTestPlaybackOverlay(point, 600), null);
  }
});

test('overlay models bound progress and provide accessible focus and disabled states', () => {
  let model = playbackOverlayModel({paused: true, position: -10, duration: 300, focused: 'unknown', canNextEpisode: true});
  assert.equal(model.focused, 'playPause'); assert.equal(model.controls.find(control => control.focused).id, 'playPause');
  assert.equal(model.position, 0); assert.equal(Object.hasOwn(model, 'volume'), false);
  assert.equal(model.controls[0].disabled, true); assert.equal(model.controls[1].label, 'Play');
  assert.equal(model.controls[2].disabled, false); assert.equal(model.canNextEpisode, true);
  assert.equal(model.seekbar.enabled, true);
  model = playbackOverlayModel({busy: true, duration: 300, position: 400});
  assert.equal(model.position, 300); assert.equal(model.ratio, 1); assert.equal(model.seekbar.enabled, false);
  assert.ok(model.controls.every(control => control.disabled));
  assert.equal(playbackOverlayModel({duration: NaN}).seekbar.enabled, false);
  assert.equal(nextPlaybackFocus('playPause', 1), 'nextEpisode');
  assert.equal(nextPlaybackFocus('prevEpisode', -1), 'stop');
  assert.equal(nextPlaybackFocus('playPause', -1, ['prevEpisode']), 'stop');
  assert.equal(nextPlaybackFocus('playPause', 1, CONTROL_IDS), 'playPause');
});

test('audio and subtitle options share six-row geometry with exact IDs, Off and bounded touch paging', () => {
  const tracks = Array.from({length: 8}, (_, id) => ({id: `track:${id}`, label: `Track ${id}`, selected: id === 7}));
  let model = playbackOverlayModel({visible: true, mode: 'audio', audioTracks: tracks, optionSelected: 7, duration: 600});
  assert.equal(OPTION_PAGE_SIZE, 6); assert.equal(SEEK_GESTURE_TIMEOUT_MS, 1500);
  assert.equal(model.optionOffset, 6); assert.equal(model.optionCount, 8);
  assert.deepEqual(model.optionRows.map(row => row.id), ['track:6', 'track:7']);
  assert.equal(model.optionRows[1].focused, true); assert.equal(model.optionRows[1].selected, true);
  for (const row of model.optionRows) assert.deepEqual(hitTestPlaybackOverlay({x: row.x + 1, y: row.y + 1}, model),
    {action: 'selectTrack', id: row.id, index: row.index, disabled: false});
  const previous = model.optionPaging.find(paging => paging.action === 'previousOptions');
  assert.equal(hitTestPlaybackOverlay({x: previous.x + 1, y: previous.y + 1}, model).index, 0);
  assert.equal(model.optionPaging.find(paging => paging.action === 'nextOptions').disabled, true);
  assert.equal(model.seekbar.enabled, false);
  assert.equal(hitTestPlaybackOverlay({x: model.seekbar.x, y: model.seekbar.y}, model), null);
  model = playbackOverlayModel({mode: 'subtitles', subtitleTracks: tracks, busy: true});
  assert.equal(model.optionRows.length, 6); assert.equal(model.optionRows[0].id, null);
  assert.equal(model.optionRows[0].label, 'Off'); assert.equal(model.optionRows[0].selected, false);
  assert.ok(model.optionRows.every(row => row.disabled));
  assert.ok(model.optionPaging.every(paging => paging.disabled));
  model = playbackOverlayModel({mode: 'subtitles', subtitleTracks: tracks.map(track => ({...track, selected: false}))});
  assert.equal(model.optionRows[0].selected, true);
  const boxes = [...model.optionRows, ...model.optionPaging];
  for (const [index, box] of boxes.entries()) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 720);
    for (const other of boxes.slice(index + 1)) assert.equal(box.x < other.x + other.width && box.x + box.width > other.x &&
      box.y < other.y + other.height && box.y + box.height > other.y, false);
  }
});

test('timeline drag positions clamp independently of Y and decoder seeking disables playback actions', () => {
  const {seekbar} = playbackOverlayModel();
  assert.equal(seekPositionAtX(seekbar.x + seekbar.width / 2, 600), 300);
  assert.equal(seekPositionAtX(-500, 600), 0);
  assert.equal(seekPositionAtX(5000, 600), 600);
  for (const [x, duration] of [[NaN, 600], [1, 0], [1, Infinity]]) assert.equal(seekPositionAtX(x, duration), null);
  const model = playbackOverlayModel({seeking: true, duration: 600,
    audioTracks: [{id: 1}], subtitleTracks: [{id: 2}], canPreviousEpisode: true, canNextEpisode: true});
  assert.equal(model.seeking, true); assert.equal(model.busy, true);
  assert.equal(model.seekbar.enabled, false); assert.ok(model.controls.every(control => control.disabled));
});
