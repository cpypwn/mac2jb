'use strict';

// Drawing and hit testing share the Switch's canonical touch coordinates.
const OVERLAY_WIDTH = 1280, OVERLAY_HEIGHT = 720;
const AUTO_HIDE_MS = 4000, SEEK_GESTURE_TIMEOUT_MS = 1500, OPTION_PAGE_SIZE = 6;
const CONTROL_IDS = Object.freeze(['prevEpisode', 'playPause', 'nextEpisode', 'audio', 'subtitles', 'stop']);
const controls = Object.freeze(CONTROL_IDS.map((id, index) => Object.freeze({
  id, x: 110 + index * 178, y: 526, width: 166, height: 78
})));
const seekbar = Object.freeze({x: 110, y: 456, width: 1060, height: 32});
const close = Object.freeze({x: 1134, y: 58, width: 64, height: 64});
const validSeconds = value => Number.isFinite(value) && value >= 0 ? value : 0;
const formatTime = value => {
  value = Math.floor(validSeconds(value));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const contains = (box, {x, y}) => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
const validPoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y) &&
  point.x >= 0 && point.y >= 0 && point.x < OVERLAY_WIDTH && point.y < OVERLAY_HEIGHT;
const seekPositionAtX = (x, duration) => Number.isFinite(x) && Number.isFinite(duration) && duration > 0 ?
  Math.max(0, Math.min(duration, (x - seekbar.x) / seekbar.width * duration)) : null;

function playbackOverlayModel({visible = false, focused = 'playPause', title = '', paused = false,
  position = 0, duration = 0, busy = false, message = '', canPreviousEpisode = false, canNextEpisode = false,
  mode = 'controls', seeking = false, previewKind = null, optionSelected = 0, audioTracks = [], subtitleTracks = []} = {}) {
  busy = Boolean(busy || seeking);
  position = validSeconds(position); duration = validSeconds(duration);
  if (duration) position = Math.min(position, duration);
  focused = CONTROL_IDS.includes(focused) ? focused : 'playPause';
  mode = ['audio', 'subtitles'].includes(mode) ? mode : 'controls';
  const options = mode === 'audio' ? audioTracks : mode === 'subtitles' ?
    [{id: null, label: 'Off', selected: !subtitleTracks.some(track => track.selected)}, ...subtitleTracks] : [];
  optionSelected = Math.max(0, Math.min(Number.isSafeInteger(optionSelected) ? optionSelected : 0, Math.max(0, options.length - 1)));
  const optionOffset = Math.floor(optionSelected / OPTION_PAGE_SIZE) * OPTION_PAGE_SIZE;
  const optionRows = options.slice(optionOffset, optionOffset + OPTION_PAGE_SIZE).map((track, index) => ({...track,
    index: optionOffset + index, focused: optionOffset + index === optionSelected, disabled: Boolean(busy),
    x: 290, y: 184 + index * 54, width: 700, height: 46}));
  const ratio = duration ? position / duration : 0;
  return {width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT, visible: Boolean(visible),
    focused, title, paused: Boolean(paused), mode, seeking: Boolean(seeking), previewKind,
    optionTitle: mode === 'audio' ? 'Audio' : mode === 'subtitles' ? 'Subtitles' : '',
    optionSelected, optionOffset, optionCount: options.length, optionRows,
    optionPaging: mode === 'controls' || options.length <= OPTION_PAGE_SIZE ? [] : [
      {action: 'previousOptions', label: 'Previous', index: Math.max(0, optionOffset - OPTION_PAGE_SIZE),
        disabled: Boolean(busy || optionOffset === 0), x: 290, y: 520, width: 220, height: 46},
      {action: 'nextOptions', label: 'Next', index: Math.min(options.length - 1, optionOffset + OPTION_PAGE_SIZE),
        disabled: Boolean(busy || optionOffset + optionRows.length >= options.length), x: 770, y: 520, width: 220, height: 46}],
    position, duration, ratio, timeLabel: `${formatTime(position)} / ${formatTime(duration)}`,
    canPreviousEpisode: Boolean(canPreviousEpisode), canNextEpisode: Boolean(canNextEpisode),
    busy: Boolean(busy), message,
    controls: controls.map(control => ({...control,
      label: {prevEpisode: 'Previous', playPause: paused ? 'Play' : 'Pause', nextEpisode: 'Next episode', audio: 'Audio', subtitles: 'Subtitles', stop: 'Stop'}[control.id],
      focused: control.id === focused,
      disabled: Boolean(busy || control.id === 'prevEpisode' && !canPreviousEpisode || control.id === 'nextEpisode' && !canNextEpisode ||
        control.id === 'audio' && !audioTracks.length || control.id === 'subtitles' && !subtitleTracks.length)})),
    seekbar: {...seekbar, enabled: !busy && duration > 0 && mode === 'controls', ratio}, close: {...close}};
}

function hitTestPlaybackOverlay(point, durationOrModel = 0) {
  if (!validPoint(point)) return null;
  const model = typeof durationOrModel === 'object' ? durationOrModel : null;
  const duration = model?.duration ?? durationOrModel;
  if (contains(close, point)) return {action: 'close'};
  if (model && model.mode !== 'controls') {
    for (const row of model.optionRows) if (contains(row, point)) return {action: 'selectTrack', id: row.id, index: row.index, disabled: row.disabled};
    for (const paging of model.optionPaging) if (contains(paging, point)) return {...paging};
    return null;
  }
  for (const control of controls) if (contains(control, point)) return {action: control.id};
  if (contains(seekbar, point) && Number.isFinite(duration) && duration > 0)
    return {action: 'seekTo', seconds: seekPositionAtX(point.x, duration)};
  return null;
}

function nextPlaybackFocus(focused, direction, disabled = []) {
  const step = direction < 0 ? -1 : 1;
  let index = CONTROL_IDS.indexOf(focused);
  if (index < 0) index = 1;
  for (let count = 0; count < CONTROL_IDS.length; count++) {
    index = (index + step + CONTROL_IDS.length) % CONTROL_IDS.length;
    if (!disabled.includes(CONTROL_IDS[index])) return CONTROL_IDS[index];
  }
  return focused;
}

module.exports = {OVERLAY_WIDTH, OVERLAY_HEIGHT, AUTO_HIDE_MS, SEEK_GESTURE_TIMEOUT_MS, OPTION_PAGE_SIZE, CONTROL_IDS,
  playbackOverlayModel, hitTestPlaybackOverlay, nextPlaybackFocus, validPoint, seekPositionAtX};
