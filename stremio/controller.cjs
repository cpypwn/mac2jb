'use strict';
const {AddonCollection, clean, redactText} = require('./addons.cjs');
const {renderMenu} = require('./menu.cjs');
const library = require('./library.cjs');
const {SourcePreferences} = require('./source-preferences.cjs');
const {AUTO_HIDE_MS, SEEK_GESTURE_TIMEOUT_MS, playbackOverlayModel, hitTestPlaybackOverlay, nextPlaybackFocus, validPoint, seekPositionAtX} = require('./playback-controls.cjs');
const {CATALOG_PAGE_SIZE, LIST_PAGE_SIZE, TAB_PAGE_SIZE, pageStart, clamp, buildNavigation, hitTestNavigation} = require('./navigation.cjs');
const BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'zl', 'zr', 'plus', 'seekLeft', 'seekRight']);
const PLAYBACK_BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'l', 'r', 'zl', 'zr', 'plus', 'seekLeft', 'seekRight']);
const time = seconds => `${Math.floor(Math.max(0, seconds || 0) / 60)}:${String(Math.floor(Math.max(0, seconds || 0) % 60)).padStart(2, '0')}`;
const episodeLabel = video => [video.season === null ? '' : `S${String(video.season).padStart(2, '0')}` +
  (video.episode === null ? '' : `E${String(video.episode).padStart(2, '0')}`), video.title].filter(Boolean).join(' · ');
const hasEpisodes = meta => meta?.type === 'series' || meta?.type !== 'tv' && (meta?.videos.length || 0) > 1;
const seasonValue = video => Number.isSafeInteger(video?.season) && video.season >= 0 ? video.season : null;
const videoID = (meta, video) => meta.type === 'tv' ? meta.id : video?.id || meta.behaviorHints?.defaultVideoId || meta.videos[0]?.id || meta.id;
const presentationURL = value => {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : undefined; } catch { return undefined; }
};
// Presentation IDs are optional; selection and playback use the original objects.
const presentationID = value => typeof value === 'string' && value.length <= 128 ? value : undefined;
const progressInfo = (position, duration) => {
  position = library.seconds(position) ?? 0; duration = library.seconds(duration) ?? 0;
  return {position, duration, ratio: duration ? Math.min(1, position / duration) : 0,
    label: `${time(position)}${duration ? ` / ${time(duration)}` : ''}`};
};

class Controller {
  constructor({addonUrls = [], libraryItems = [], sourcePreferences = new SourcePreferences(), callbacks = {}, onChange = () => {}, onLog = () => {}, now = () => Date.now(), ...networkOptions} = {}) {
    this.callbacks = callbacks; this.onChange = onChange; this.onLog = onLog;
    this.sourcePreferences = sourcePreferences;
    this.abort = new AbortController(); this.closed = false;
    this.addons = new AddonCollection({addonUrls, ...networkOptions, signal: this.abort.signal, onLog: value => this._log(value)});
    this.catalogs = []; this.catalogIndex = 0; this.catalogItems = [];
    this.libraryItems = library.normalizeLibrary(libraryItems); this.libraryItem = null;
    this.meta = null; this.video = null; this.streams = [];
    this.view = 'catalog'; this.selected = 0; this.catalogSelected = 0;
    this.episodeSelected = 0; this.sourceSelected = 0;
    this.selectedSeason = undefined; this.seasonSelected = 0;
    this.lastSeasons = new Map();
    this.focusArea = 'content'; this.sidebarSelected = 0; this.tabSelected = 0;
    this.mainFocus = 'content'; this.section = 'home'; this.libraryEmpty = false;
    this.busy = false; this.notice = ''; this.loading = '';
    this.playback = {paused: false, position: 0, duration: 0};
    this.playTitle = '';
    this.playGeneration = 0; this.playStarting = false;
    this.now = now;
    this.overlay = {visible: false, focused: 'playPause', mode: 'controls', optionSelected: 0, lastInteraction: 0};
    this.audioTracks = []; this.subtitleTracks = [];
    this.seekGesture = null;
    this.seekPreview = null;
  }

  _log(message) { if (this.closed) return; try { this.onLog(redactText(message)); } catch {} }
  _emit() {
    if (this.closed) return;
    try {
      const promise = this.onChange(this.getMenuModel());
      if (promise?.catch) promise.catch(() => this._log('The menu update callback failed.'));
    } catch { this._log('The menu update callback failed.'); }
  }
  async _operation(label, action) {
    if (this.busy || this.closed) return false;
    this._cancelSeek();
    this.busy = true; this.loading = label; this.notice = ''; this._emit();
    try { await action(); return true; }
    catch (error) { this.notice = redactText(error.message || 'The action could not finish.'); this._log(this.notice); return false; }
    finally {
      this.busy = false; this.loading = '';
      if (this.view === 'playing' && this.overlay.visible) this.overlay.lastInteraction = this.now();
      this._emit();
    }
  }

  async init() {
    return this._operation('Loading addons…', async () => {
      let addonError;
      try { await this.addons.init(); } catch (error) { if (!this.libraryItems.length) throw error; addonError = error; }
      this.catalogs = this._libraryCatalogs().concat(this.addons.catalogs());
      if (!this.catalogs.length) throw Error('The configured addons do not provide any catalogs.');
      await this._loadCatalog(0);
      if (addonError || this.addons.errors.length) this.notice = 'Some addons are unavailable. Library entries remain available; their sources require a working addon.';
    });
  }

  _libraryCatalogs() {
    if (!this.libraryItems.length) return [];
    const catalogs = [{kind: 'library', name: 'My Library', addonName: 'Stremio account'}];
    if (this.libraryItems.some(library.inContinue)) catalogs.unshift({kind: 'continue', name: 'Continue watching', addonName: 'Stremio account'});
    return catalogs;
  }

  _libraryRows(kind) {
    return this.libraryItems.filter(item => kind === 'continue' ? library.inContinue(item) : !item.removed && !item.temp)
      .sort((a, b) => (Date.parse(b.state.lastWatched || b._mtime) || 0) - (Date.parse(a.state.lastWatched || a._mtime) || 0))
      .map(library.libraryMeta).filter(Boolean);
  }

  async _loadCatalog(index) {
    if (!this.catalogs.length) { this.notice = 'No catalogs are available. Add an addon or sign in to Stremio.'; return; }
    const normalized = (index + this.catalogs.length) % this.catalogs.length;
    const catalog = this.catalogs[normalized];
    const items = catalog.kind ? this._libraryRows(catalog.kind) : await catalog.client.catalog(catalog);
    this.catalogIndex = normalized; this.catalogItems = items;
    this.view = 'catalog'; this.selected = 0; this.catalogSelected = 0;
    this.focusArea = 'content'; this.mainFocus = 'content'; this.tabSelected = normalized;
    this.section = catalog.kind ? 'library' : 'home'; this.libraryEmpty = false;
    this.meta = null; this.video = null; this.streams = []; this.libraryItem = null;
    this.selectedSeason = undefined; this.seasonSelected = 0; this.episodeSelected = 0;
    if (!items.length) this.notice = 'This catalog is empty.';
  }

  async _openMeta(item) {
    const catalog = this.catalogs[this.catalogIndex];
    this.libraryItem = this.libraryItems.find(entry => entry._id === item.id) || null;
    const fetched = await this.addons.meta(item.type, item.id, catalog?.client);
    this.meta = fetched ? {...item, ...fetched, poster: fetched.poster || item.poster} : item;
    this.video = null; this.view = 'details'; this.selected = 0; this.focusArea = 'content';
    this.selectedSeason = undefined; this.seasonSelected = 0; this.episodeSelected = 0;
  }

  _seasonGroups() {
    const groups = new Map();
    for (const [index, video] of (this.meta?.videos || []).entries()) {
      const season = seasonValue(video);
      if (!groups.has(season)) groups.set(season, []);
      groups.get(season).push({video, index});
    }
    const numbered = [...groups.keys()].some(season => season !== null);
    return [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a - b)
      .map(([season, entries]) => ({season, entries, label: season === 0 ? 'Specials' : season === null ?
        numbered ? 'Other episodes' : 'Episodes' : `Season ${season}`}));
  }

  _episodeEntries() {
    const entries = (this.meta?.videos || []).map((video, index) => ({video, index}));
    return this.meta?.type === 'series' && this.selectedSeason !== undefined ?
      entries.filter(({video}) => seasonValue(video) === this.selectedSeason) : entries;
  }

  _rememberEpisode(video) {
    const index = (this.meta?.videos || []).findIndex(entry => entry.id === video?.id);
    if (index >= 0) {
      this.episodeSelected = index;
      if (this.meta.type === 'series') this.selectedSeason = seasonValue(this.meta.videos[index]);
    }
    if (this.meta?.type === 'series') {
      this.lastSeasons.set(this.meta.id, this.selectedSeason);
      this.seasonSelected = Math.max(0, this._seasonGroups().findIndex(group => group.season === this.selectedSeason));
    }
  }

  _currentSeason() {
    const groups = this._seasonGroups();
    const saved = this.meta?.videos.find(video => video.id === this.libraryItem?.state.video_id);
    const preferred = this.selectedSeason !== undefined ? this.selectedSeason : this.lastSeasons.has(this.meta?.id) ?
      this.lastSeasons.get(this.meta.id) : saved ? seasonValue(saved) : undefined;
    return groups.find(group => group.season === preferred) || groups.find(group => group.season > 0) || groups[0];
  }

  _detailsActions() {
    const actions = [];
    if (this.libraryItem && library.inContinue(this.libraryItem)) {
      const id = this.libraryItem.state.video_id || (this.meta.type !== 'series' ? videoID(this.meta) : null);
      if (id) actions.push({action: 'resume', id, label: `Resume at ${time(library.resumePosition(this.libraryItem, id))}`,
        detail: this.meta.type === 'series' ? this.meta.videos.find(video => video.id === id)?.title || id : ''});
    }
    const episodes = hasEpisodes(this.meta);
    if (this.meta.type === 'series') {
      const group = this._currentSeason();
      if (group) actions.push({action: 'currentSeason', season: group.season,
        label: group.season > 0 ? `${group.label} episodes` : group.season === 0 ? 'Specials episodes' : 'Episodes',
        detail: `${group.entries.length} episode${group.entries.length === 1 ? '' : 's'}`});
      actions.push({action: 'watch', label: `Browse seasons (${this._seasonGroups().length})`,
        detail: !this.meta.videos.length ? 'No episode list provided' : ''});
    } else actions.push({action: 'watch', label: episodes ? `Episodes (${this.meta.videos.length})` : 'Choose a stream',
      detail: episodes && !this.meta.videos.length ? 'No episode list provided' : ''});
    actions.push({action: 'back', label: 'Back to catalog'});
    return actions;
  }

  async _openStreams(video = null, autoResume = false) {
    const id = videoID(this.meta, video);
    const streams = await this.addons.streams(this.meta.type, id);
    if (video) this._rememberEpisode(video);
    this.video = video; this.streams = streams;
    this.view = 'sources'; this.selected = 0; this.sourceSelected = 0;
    if (!streams.length) this.notice = 'No sources were returned for this video.';
    if (autoResume) {
      const preferred = this.sourcePreferences.find(this.meta.type, this.meta.id, id, streams);
      if (preferred >= 0) await this._startStream(streams[preferred], preferred);
    }
  }

  _rows() {
    if (this.view === 'catalogs') return this.catalogs.map(catalog => ({label: catalog.name, detail: catalog.addonName}));
    if (this.view === 'catalog') return this.catalogItems.map(meta => ({label: meta.name,
      detail: [meta.releaseInfo, meta.type].filter(Boolean).join(' · ')}));
    if (this.view === 'details') return this._detailsActions();
    if (this.view === 'seasons') return this._seasonGroups().map(group => ({label: group.label, season: group.season,
      episodeCount: group.entries.length, detail: `${group.entries.length} episode${group.entries.length === 1 ? '' : 's'}`}));
    if (this.view === 'episodes') return this._episodeEntries().map(({video, index}) => ({label: episodeLabel(video),
      detail: (video.released || '').slice(0, 10), videoIndex: index}));
    if (this.view === 'sources') return this.streams.map(stream => ({label: stream.label,
      detail: stream.playable ? stream.addonName : 'Unsupported source', disabled: !stream.playable}));
    return [];
  }

  _itemProgress(item, id) {
    if (!item || !library.inContinue(item)) return null;
    const videoId = item.state.video_id || (item.type !== 'series' ? item.behaviorHints?.defaultVideoId || item._id : null);
    if (id && id !== videoId) return null;
    return progressInfo(item.state.timeOffset / 1000, item.state.duration / 1000);
  }

  _mediaPresentation(meta, index, selected, hero = false) {
    if (!meta) return null;
    const item = this.libraryItems.find(item => item._id === meta.id);
    const progress = this._itemProgress(item);
    return {index, id: presentationID(meta.id), title: clean(meta.name), type: clean(meta.type, 64),
      subtitle: [clean(meta.releaseInfo, 48), clean(meta.type, 64)].filter(Boolean).join(' · '),
      releaseInfo: clean(meta.releaseInfo, 48), poster: presentationURL(meta.poster),
      posterShape: ['poster', 'square', 'landscape'].includes(meta.posterShape) ? meta.posterShape : 'poster',
      description: clean(meta.description, hero ? 600 : 180),
      ...(hero ? {background: presentationURL(meta.background), logo: presentationURL(meta.logo),
        genres: (Array.isArray(meta.genres) ? meta.genres : []).slice(0, 8).map(genre => clean(genre, 48)).filter(Boolean),
        runtime: clean(meta.runtime, 48), rating: clean(meta.rating, 16)} : {}),
      selected, inLibrary: Boolean(item && !item.removed && !item.temp), canResume: Boolean(progress), progress};
  }

  _presentation(rows, selected, start) {
    const catalog = this.libraryEmpty ? {name: 'My Library', addonName: 'Stremio account', kind: 'library'} : this.catalogs[this.catalogIndex];
    const tabIndex = this.view === 'catalogs' ? selected : this.focusArea === 'tabs' ? clamp(this.tabSelected, this.catalogs.length) : this.catalogIndex;
    const tabStart = Math.max(0, Math.min(tabIndex - 3, this.catalogs.length - TAB_PAGE_SIZE));
    const section = catalog?.kind ? 'Library' : 'Discover';
    const breadcrumb = this.view === 'catalogs' ? ['Catalogs'] : [section, catalog?.name].filter(Boolean);
    if (this.meta && this.view !== 'catalog' && this.view !== 'catalogs') breadcrumb.push(this.meta.name);
    if (this.view === 'seasons') breadcrumb.push('Seasons');
    if (['episodes', 'sources', 'playing'].includes(this.view) && this.meta?.type === 'series' && this.selectedSeason !== undefined) {
      const season = this._seasonGroups().find(group => group.season === this.selectedSeason);
      if (season) breadcrumb.push(season.label);
    }
    if (this.view === 'episodes') breadcrumb.push('Episodes');
    if (this.view === 'sources') breadcrumb.push(this.video ? episodeLabel(this.video) : 'Sources');
    if (this.view === 'playing') breadcrumb.push('Now playing');
    const visibleRows = rows.slice(start, start + (this.view === 'catalog' ? CATALOG_PAGE_SIZE : LIST_PAGE_SIZE)).map((row, localIndex) => {
      const index = start + localIndex;
      const enriched = {...row, index, selected: index === selected};
      if (this.view === 'episodes') {
        const {video, index: videoIndex} = this._episodeEntries()[index];
        Object.assign(enriched, {id: presentationID(video.id), title: video.title, season: video.season, episode: video.episode,
          released: video.released, videoIndex, progress: this._itemProgress(this.libraryItem, video.id)});
      }
      if (this.view === 'sources') Object.assign(enriched, {provider: this.streams[index].addonName,
        playable: this.streams[index].playable});
      return enriched;
    });
    const heroMeta = this.view === 'catalog' ? this.catalogItems[selected] : this.view === 'catalogs' ? null : this.meta;
    return {brand: 'Stremio', breadcrumb,
      catalog: catalog ? {index: this.libraryEmpty ? -1 : this.catalogIndex, name: clean(catalog.name, 120), addonName: clean(catalog.addonName, 120),
        kind: catalog.kind || 'addon', type: catalog.type || ''} : null,
      tabs: this.catalogs.slice(tabStart, tabStart + TAB_PAGE_SIZE).map((entry, localIndex) => ({index: tabStart + localIndex,
        id: presentationID(entry.kind || entry.id || String(tabStart + localIndex)), label: clean(entry.name, 120), detail: clean(entry.addonName, 120),
        kind: entry.kind || 'addon', active: !this.libraryEmpty && tabStart + localIndex === this.catalogIndex,
        selected: tabStart + localIndex === tabIndex})),
      tabOffset: tabStart, tabCount: this.catalogs.length,
      cards: this.view === 'catalog' ? this.catalogItems.slice(start, start + CATALOG_PAGE_SIZE)
        .map((meta, localIndex) => this._mediaPresentation(meta, start + localIndex, start + localIndex === selected)) : [],
      hero: this._mediaPresentation(heroMeta, this.view === 'catalog' ? selected : this.catalogSelected, true, true),
      actions: this.view === 'details' ? visibleRows.map(row => ({...row})) : [],
      playback: this.view === 'playing' ? {...this.playback, ...progressInfo(this.playback.position, this.playback.duration)} : null,
      rows: visibleRows};
  }

  getMenuModel() {
    const rows = this._rows();
    const selected = Math.max(0, Math.min(this.selected, Math.max(0, rows.length - 1)));
    const start = pageStart(selected, this.view === 'catalog' ? CATALOG_PAGE_SIZE : LIST_PAGE_SIZE);
    let title = 'Stremio compatible · alpha', subtitle = '';
    if (this.view === 'catalogs') subtitle = 'Choose a catalog';
    if (this.view === 'catalog') {
      const catalog = this.libraryEmpty ? {name: 'My Library', addonName: 'Stremio account'} : this.catalogs[this.catalogIndex];
      subtitle = catalog ? `${catalog.addonName} · ${catalog.name}` : 'Catalogs';
    }
    if (this.view === 'details' || this.view === 'episodes' || this.view === 'seasons') {
      title = this.meta?.name || title;
      subtitle = this.view === 'seasons' ? 'Choose a season' : this.view === 'episodes' ?
        [this._seasonGroups().find(group => group.season === this.selectedSeason)?.label, 'Choose an episode'].filter(Boolean).join(' · ') :
        [this.meta?.releaseInfo, this.meta?.type].filter(Boolean).join(' · ');
    }
    if (this.view === 'sources') { title = this.video ? episodeLabel(this.video) : this.meta?.name || title; subtitle = 'Choose a source'; }
    if (this.view === 'playing') {
      title = this.playTitle;
      subtitle = `${this.playback.paused ? 'Paused' : 'Playing'} · ${time(this.playback.position)} / ${time(this.playback.duration)}`;
    }
    const model = {width: 640, height: 360, view: this.view, title, subtitle,
      ...this._presentation(rows, selected, start), selected: selected - start, offset: start, count: rows.length,
      selectedIndex: selected,
      selectedSeason: this.selectedSeason ?? null,
      description: this.view === 'details' ? this.meta?.description || '' : '',
      message: this.busy ? this.loading : this.notice, busy: this.busy, isPlaying: this.view === 'playing',
      playbackOverlay: this.view === 'playing' ? this._overlayModel() : null,
      footer: this.view === 'playing' ? 'A Select / Pause  X / + Controls  L / R Episodes  Hold ZL / ZR or left stick Seek  B Hide / Stop' :
        this.focusArea === 'sidebar' ? '↑/↓ Menu  A Open  → Return  B Return' : this.focusArea === 'tabs' ? '←/→ Catalogs  A Open  ↓ Titles  B Menu' :
        this.view === 'catalog' ? '←/→ Titles  ↑ Catalogs  L/R Tabs  A Open  B Menu  X Refresh  Y Next catalog' : '↑/↓ Browse  L/R Tabs  A Open  B Back  ← Menu  X Refresh'};
    model.navigation = buildNavigation(model, {focusArea: this.focusArea, sidebarIndex: this.sidebarSelected,
      tabIndex: this.tabSelected, section: this.section});
    return model;
  }

  async _select() {
    if (this.view === 'catalogs') { await this._loadCatalog(this.selected); return; }
    if (this.view === 'catalog') {
      const item = this.catalogItems[this.selected];
      if (item) { this.catalogSelected = this.selected; await this._openMeta(item); }
      return;
    }
    if (this.view === 'details') {
      const action = this._detailsActions()[this.selected];
      if (action?.action === 'back') { this.view = 'catalog'; this.selected = this.catalogSelected; return; }
      if (action?.action === 'resume') {
        const video = this.meta.videos.find(video => video.id === action.id) ||
          {id: action.id, title: this.meta.name, season: null, episode: null, released: ''};
        await this._openStreams(video, true); return;
      }
      if (action?.action === 'currentSeason') {
        const group = this._seasonGroups().find(group => group.season === action.season);
        if (group) { this.selectedSeason = group.season; this.seasonSelected = this._seasonGroups().findIndex(entry => entry.season === group.season);
          this.lastSeasons.set(this.meta.id, group.season);
          this.view = 'episodes'; this.selected = Math.max(0, group.entries.findIndex(entry => entry.video.id === this.libraryItem?.state.video_id)); }
        return;
      }
      if (hasEpisodes(this.meta)) {
        if (!this.meta.videos.length) throw Error('This addon does not provide an episode list.');
        this.view = this.meta.type === 'series' ? 'seasons' : 'episodes';
        this.selected = this.view === 'seasons' ? clamp(this.seasonSelected, this._seasonGroups().length) : 0;
      } else await this._openStreams();
      return;
    }
    if (this.view === 'seasons') {
      const group = this._seasonGroups()[this.selected];
      if (group) { this.seasonSelected = this.selected; this.selectedSeason = group.season; this.lastSeasons.set(this.meta.id, group.season);
        this.view = 'episodes'; this.selected = 0; }
      return;
    }
    if (this.view === 'episodes') {
      const entry = this._episodeEntries()[this.selected];
      if (entry) await this._openStreams(entry.video);
      return;
    }
    if (this.view === 'sources') {
      const source = this.streams[this.selected];
      if (!source) return;
      if (!source.playable) throw Error(source.reason);
      await this._startStream(source, this.selected);
    }
  }

  _openSidebar() {
    if (this.focusArea !== 'sidebar') this.mainFocus = this.focusArea;
    this.focusArea = 'sidebar';
    this.sidebarSelected = Math.max(0, ['home', 'library', 'catalogs'].indexOf(this.section));
  }

  _leaveSidebar() {
    this.focusArea = this.mainFocus === 'tabs' && this.view === 'catalog' && this.catalogs.length ? 'tabs' : 'content';
  }

  async _sidebarAction(id) {
    if (id === 'catalogs') {
      this.view = 'catalogs'; this.selected = this.catalogIndex;
      this.focusArea = 'content'; this.mainFocus = 'content'; this.section = 'catalogs';
    } else if (id === 'library') {
      const index = this.catalogs.findIndex(catalog => catalog.kind === 'library');
      if (index >= 0) await this._loadCatalog(index);
      else {
        this.view = 'catalog'; this.catalogItems = []; this.selected = 0; this.catalogSelected = 0;
        this.meta = null; this.video = null; this.streams = []; this.libraryItem = null;
        this.libraryEmpty = true; this.section = 'library'; this.focusArea = 'content'; this.mainFocus = 'content';
        this.notice = 'Your library is empty. Sign in to Stremio on the Mac and add titles to your library.';
      }
    } else if (id === 'home') {
      await this._loadCatalog(0); this.section = 'home';
      if (!this.catalogs.length) { this.view = 'catalog'; this.focusArea = 'content'; this.mainFocus = 'content'; this.libraryEmpty = false; }
    }
  }

  _moveBrowseFocus(button) {
    if (!['left', 'right', 'up', 'down'].includes(button)) return false;
    if (this.focusArea === 'sidebar') {
      if (button === 'up' || button === 'down') this.sidebarSelected = clamp(this.sidebarSelected + (button === 'down' ? 1 : -1), 3);
      else if (button === 'right') this._leaveSidebar();
    } else if (this.focusArea === 'tabs' && this.view === 'catalog') {
      if (button === 'left' && this.tabSelected <= 0) this._openSidebar();
      else if (button === 'left' || button === 'right') this.tabSelected = clamp(this.tabSelected + (button === 'right' ? 1 : -1), this.catalogs.length);
      else if (button === 'down') this.focusArea = 'content';
    } else if (this.view === 'catalog') {
      if (button === 'left' && this.selected <= 0) this._openSidebar();
      else if (button === 'left' || button === 'right') this.selected = clamp(this.selected + (button === 'right' ? 1 : -1), this.catalogItems.length);
      else if (button === 'up') {
        if (this.catalogs.length) { this.focusArea = 'tabs'; this.tabSelected = this.catalogIndex; }
        else this._openSidebar();
      }
    } else if (button === 'left') this._openSidebar();
    else if (button === 'up' || button === 'down') this.selected = clamp(this.selected + (button === 'down' ? 1 : -1), this._rows().length);
    this.notice = ''; this._emit(); return true;
  }

  async _startStream(source, sourceIndex) {
    if (typeof this.callbacks.play !== 'function') throw Error('The media pipeline is not connected.');
    this.playTitle = this.video ? `${this.meta.name} · ${episodeLabel(this.video)}` : this.meta.name;
    this._log(`Starting direct HTTP(S) playback from ${source.addonName}.`);
    const generation = ++this.playGeneration;
    this.sourceSelected = sourceIndex; this.playStarting = true;
    this._cancelSeek(); this.overlay.mode = 'controls';
    this.audioTracks = []; this.subtitleTracks = [];
    try {
      const id = videoID(this.meta, this.video);
      const info = {itemId: this.meta.id, videoId: id, type: this.meta.type, name: this.meta.name,
        ...(this.meta.poster ? {poster: this.meta.poster} : {}),
        ...(Number.isSafeInteger(this.video?.season) ? {season: this.video.season} : {}),
        ...(Number.isSafeInteger(this.video?.episode) ? {episode: this.video.episode} : {}),
        ...(this.meta.type === 'series' ? {videoIds: this.meta.videos.map(video => video.id)} : {})};
      const resume = library.resumePosition(this.libraryItem, id);
      this.playback = {paused: false, position: resume,
        duration: this.libraryItem && (this.libraryItem.state.video_id || this.libraryItem._id) === id ? this.libraryItem.state.duration / 1000 : 0};
      await this.callbacks.play({url: source.url, headers: {...source.headers}, title: this.playTitle,
        meta: {id: this.meta.id, type: this.meta.type, videoId: id}, resumePosition: resume, libraryInfo: info});
      if (generation === this.playGeneration) {
        try { await this.sourcePreferences.remember(this.meta.type, this.meta.id, id, this.streams, sourceIndex); }
        catch { this._log('The last playback source could not be saved.'); }
      }
    } finally { this.playStarting = false; }
    if (generation !== this.playGeneration) return;
    this.view = 'playing'; this.selected = 0;
    this.overlay.focused = 'playPause'; this._showOverlay();
  }

  async _back() {
    if (this.focusArea === 'sidebar') { this._leaveSidebar(); return; }
    if (this.view === 'catalog' || this.view === 'catalogs') { this._openSidebar(); return; }
    this.focusArea = 'content';
    if (this.view === 'sources') {
      const episodes = hasEpisodes(this.meta);
      if (episodes) {
        this._rememberEpisode(this.video || this.meta.videos[this.episodeSelected]);
        if (this.meta.type === 'series' && !this._seasonGroups().some(group => group.season === this.selectedSeason)) {
          this.selectedSeason = this._seasonGroups()[0]?.season;
          this.seasonSelected = 0;
        }
      }
      this.view = episodes ? 'episodes' : 'details';
      this.selected = episodes ? Math.max(0, this._episodeEntries().findIndex(entry => entry.index === this.episodeSelected)) : 0;
    } else if (this.view === 'episodes') {
      this.view = this.meta.type === 'series' ? 'seasons' : 'details';
      this.selected = this.view === 'seasons' ? clamp(this.seasonSelected, this._seasonGroups().length) : 0;
    } else if (this.view === 'seasons') { this.view = 'details'; this.selected = 0; }
    else if (this.view === 'details') { this.view = 'catalog'; this.selected = this.catalogSelected; }
  }

  async _refresh() {
    if (this.libraryEmpty && this.view === 'catalog') await this._sidebarAction('library');
    else if (this.view === 'catalog' || this.view === 'catalogs') await this._loadCatalog(this.catalogIndex);
    else if (this.view === 'sources') await this._openStreams(this.video);
    else if (this.view === 'details' || this.view === 'seasons' || this.view === 'episodes') await this._openMeta(this.meta);
  }

  _overlayModel() {
    const {videos, index} = this._episodeNavigation();
    return playbackOverlayModel({...this.playback, ...this.overlay, audioTracks: this.audioTracks, subtitleTracks: this.subtitleTracks, previewKind: this.seekGesture?.owner || null, title: this.playTitle,
      canPreviousEpisode: index > 0, canNextEpisode: index >= 0 && index < videos.length - 1,
      position: this.seekPreview ?? this.playback.position,
      busy: this.busy, message: this.busy ? this.loading : this.playback.seeking ? 'Seeking…' : this.seekPreview !== null ? this.seekGesture?.owner === 'touch' ? 'Release to seek' : 'Release the stick or trigger to seek' : this.notice});
  }

  _episodeNavigation() {
    if (this.meta?.type !== 'series') return {videos: [], index: -1};
    const seen = new Set();
    const videos = (this.meta.videos || []).filter(video => video?.id && !seen.has(video.id) && seen.add(video.id))
      .sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || (a.episode ?? -1) - (b.episode ?? -1) ||
        (Date.parse(a.released) || -8640000000000000) - (Date.parse(b.released) || -8640000000000000));
    return {videos, index: videos.findIndex(video => video.id === videoID(this.meta, this.video))};
  }

  async _playAdjacentEpisode(direction) {
    const {videos, index} = this._episodeNavigation();
    if (index < 0) throw Error('Episode controls are available when a series episode is playing.');
    const video = videos[index + direction];
    if (!video) throw Error(`There is no ${direction < 0 ? 'previous' : 'next'} episode.`);
    const generation = this.playGeneration;
    const preferredAddon = this.streams[this.sourceSelected]?.addonName;
    const streams = await this.addons.streams(this.meta.type, video.id);
    if (this.closed || generation !== this.playGeneration || this.view !== 'playing') return;
    let sourceIndex = streams.findIndex(stream => stream.playable && stream.addonName === preferredAddon);
    if (sourceIndex < 0) sourceIndex = streams.findIndex(stream => stream.playable);
    if (sourceIndex < 0) throw Error(`No playable source is available for the ${direction < 0 ? 'previous' : 'next'} episode.`);
    if (typeof this.callbacks.play !== 'function') throw Error('The media pipeline is not connected.');
    // Resolve the replacement fully before the play callback replaces the decoder.
    this._updateLibrarySnapshot(false);
    this.video = video; this.streams = streams;
    this._rememberEpisode(video);
    await this._startStream(streams[sourceIndex], sourceIndex);
  }

  _showOverlay() {
    if (!this.overlay.visible) this.overlay.focused = 'playPause';
    this.overlay.visible = true; this.overlay.lastInteraction = this.now();
  }

  tickOverlay() {
    this._expireSeek();
    if (this.closed || this.view !== 'playing' || !this.overlay.visible || this.playback.paused || this.playback.seeking || this.busy || this.seekPreview !== null || this.overlay.mode !== 'controls' ||
      this.now() - this.overlay.lastInteraction < AUTO_HIDE_MS) return false;
    this.overlay.visible = false; this._emit(); return true;
  }

  async _playbackCallback(name, ...args) {
    if (typeof this.callbacks[name] !== 'function') throw Error(`Playback ${name} is not connected.`);
    return this.callbacks[name](...args);
  }

  async _playbackAction(action, seconds) {
    const generation = this.playGeneration;
    this._showOverlay();
    if (action === 'audio' || action === 'subtitles') { this._openTrackOptions(action); return; }
    if (action === 'playPause') {
      const paused = !this.playback.paused;
      await this._playbackCallback('pause');
      if (generation !== this.playGeneration || this.view !== 'playing') return;
      this.playback.paused = paused;
      this.overlay.lastInteraction = this.now();
    } else if (action === 'prevEpisode' || action === 'nextEpisode') {
      await this._playAdjacentEpisode(action === 'prevEpisode' ? -1 : 1);
    } else if (action === 'seek') {
      const delta = seconds;
      const target = Math.max(0, Math.min(this.playback.duration || library.MAX_SECONDS, this.playback.position + delta));
      if (target === this.playback.position) return;
      await this._playbackCallback('seek', target - this.playback.position);
      if (generation === this.playGeneration && this.view === 'playing') this.playback.position = target;
    } else if (action === 'seekTo') {
      if (!this.playback.duration || !Number.isFinite(seconds)) return;
      const target = Math.max(0, Math.min(this.playback.duration, seconds));
      if (target === this.playback.position) return;
      await this._playbackCallback('seekTo', target);
      if (generation === this.playGeneration && this.view === 'playing') this.playback.position = target;
    } else if (action === 'stop') {
      await this._playbackCallback('stop'); this._updateLibrarySnapshot(false);
      if (generation !== this.playGeneration || this.view !== 'playing') return;
      this.overlay.visible = false; this.view = 'sources'; this.selected = this.sourceSelected;
    }
  }

  async _playingButton(button) {
    if (button === 'a') return this._playbackAction('playPause');
    if (['zl', 'zr', 'seekLeft', 'seekRight'].includes(button))
      return this._playbackAction('seek', ['right', 'zr', 'seekRight'].includes(button) ? 10 : -10);
    if (button === 'l' || button === 'r') return this._playbackAction(button === 'r' ? 'nextEpisode' : 'prevEpisode');
    if (button === 'b') return this._playbackAction('stop');
  }

  async handleButton(button) {
    if (!BUTTONS.has(button) || this.busy || this.closed || this.view === 'playing' && this.playback.seeking) return false;
    if (this.view !== 'playing' && ['zl', 'zr', 'plus', 'seekLeft', 'seekRight'].includes(button)) return false;
    if (this.view === 'playing') {
      if (!PLAYBACK_BUTTONS.has(button)) return false;
      if (this.overlay.visible && this.overlay.mode !== 'controls' && !['l', 'r'].includes(button)) {
        if (button === 'b' || button === 'x' || button === 'plus') {
          this.overlay.mode = 'controls'; this._showOverlay(); this._emit(); return true;
        }
        if (button === 'up' || button === 'down') {
          this.overlay.optionSelected = clamp(this.overlay.optionSelected + (button === 'down' ? 1 : -1), this._overlayModel().optionCount);
          this._showOverlay(); this._emit(); return true;
        }
        if (button === 'left' || button === 'right') {
          const action = button === 'left' ? 'previousOptions' : 'nextOptions';
          const page = this._overlayModel().optionPaging.find(row => row.action === action && !row.disabled);
          if (!page) return false;
          this.overlay.optionSelected = page.index; this._showOverlay(); this._emit(); return true;
        }
        if (button === 'a') {
          const row = this._overlayModel().optionRows.find(row => row.focused);
          return row ? this.selectMediaTrack(this.overlay.mode, row.id) : false;
        }
        return false;
      }
      if (button === 'x' || button === 'plus') {
        if (this.overlay.visible) { this.overlay.visible = false; this._cancelSeek(); } else this._showOverlay();
        this.notice = ''; this._emit(); return true;
      }
      if (button === 'b' && this.overlay.visible) { this._cancelSeek(); this.overlay.visible = false; this._emit(); return true; }
      if (button === 'left' || button === 'right') {
        this._showOverlay();
        this.overlay.focused = nextPlaybackFocus(this.overlay.focused, button === 'left' ? -1 : 1,
          this._overlayModel().controls.filter(control => control.disabled).map(control => control.id));
        this._showOverlay(); this.notice = ''; this._emit(); return true;
      }
      if (button === 'a' && this.overlay.visible) {
        const control = this._overlayModel().controls.find(control => control.id === this.overlay.focused);
        if (control?.disabled) { this._showOverlay(); this._emit(); return true; }
        if (control.id === 'audio' || control.id === 'subtitles') { this._openTrackOptions(control.id); this._emit(); return true; }
        return this._operation('Updating playback…', () => this._playbackAction(control.id));
      }
      if (button === 'up' || button === 'down') return false;
    }
    if (this.view !== 'playing' && (button === 'l' || button === 'r'))
      return this._operation('Loading…', () => this._loadCatalog(this.catalogIndex + (button === 'r' ? 1 : -1)));
    if (this.view !== 'playing' && this._moveBrowseFocus(button)) return true;
    return this._operation(this.view === 'playing' ? 'Updating playback…' : 'Loading…', async () => {
      if (this.view === 'playing') { await this._playingButton(button); return; }
      if (button === 'a' && this.focusArea === 'sidebar') await this._sidebarAction(['home', 'library', 'catalogs'][this.sidebarSelected]);
      else if (button === 'a' && this.focusArea === 'tabs' && this.view === 'catalog') await this._loadCatalog(this.tabSelected);
      else if (button === 'a') await this._select();
      else if (button === 'b') await this._back();
      else if (button === 'x') await this._refresh();
      else if (button === 'y' && this.catalogs.length) await this._loadCatalog(this.catalogIndex + 1);
    });
  }

  async handleTouch(touch) {
    this._expireSeek();
    if (this.closed || this.busy || this.view === 'playing' && this.playback.seeking) return false;
    const phase = touch?.phase || 'tap', id = touch?.id ?? touch?.identifier ?? 0;
    if (this.seekGesture?.owner === 'touch') {
      if (id !== this.seekGesture.id) return false;
      if (phase === 'cancel') { this._cancelSeek(); this._emit(); return true; }
      if (!['move', 'end', 'up'].includes(phase) || !Number.isFinite(touch?.x)) return false;
      this.seekGesture.updatedAt = this.now();
      this.seekPreview = seekPositionAtX(touch.x, this.playback.duration);
      this._showOverlay();
      if (phase === 'end' || phase === 'up') return this._commitSeek('touch');
      this._emit(); return true;
    }
    if (!validPoint(touch) || !['start', 'down', 'tap'].includes(phase)) return false;
    if (this.view !== 'playing') {
      const hit = hitTestNavigation(this.getMenuModel().navigation, touch);
      if (!hit || hit.disabled) return false;
      if (hit.area === 'paging' || hit.area === 'tabPaging') {
        if (hit.area === 'paging') { this.selected = clamp(hit.index, this._rows().length); this.focusArea = 'content'; }
        else { this.tabSelected = clamp(hit.index, this.catalogs.length); this.focusArea = 'tabs'; }
        this.notice = ''; this._emit(); return true;
      }
      return this._operation('Loading…', async () => {
        if (hit.area === 'sidebar') {
          this.sidebarSelected = ['home', 'library', 'catalogs'].indexOf(hit.id);
          await this._sidebarAction(hit.id);
        } else if (hit.area === 'tabs') await this._loadCatalog(hit.index);
        else if (hit.area === 'command') {
          if (hit.id === 'back') await this._back();
          else if (hit.id === 'refresh') await this._refresh();
        } else if (hit.area === 'content') {
          this.selected = clamp(hit.index, this._rows().length); this.focusArea = 'content';
          await this._select();
        }
      });
    }
    if (this.seekGesture) return false;
    if (!this.overlay.visible) { this._showOverlay(); this.notice = ''; this._emit(); return true; }
    const model = this._overlayModel();
    const hit = hitTestPlaybackOverlay(touch, model);
    if (hit?.action === 'seekTo' && !model.seekbar.enabled) return false;
    if (hit?.action === 'seekTo' && phase !== 'tap') {
      this._beginSeek('touch', {id}); this.seekPreview = hit.seconds;
      this._showOverlay(); this._emit(); return true;
    }
    this._showOverlay();
    if (hit?.action === 'close') {
      if (this.overlay.mode !== 'controls') this.overlay.mode = 'controls'; else this.overlay.visible = false;
      this._emit(); return true;
    }
    if (!hit || hit.disabled) return false;
    if (hit.action === 'selectTrack') { this.overlay.optionSelected = hit.index; return this.selectMediaTrack(this.overlay.mode, hit.id); }
    if (hit.action === 'previousOptions' || hit.action === 'nextOptions') {
      this.overlay.optionSelected = hit.index; this._emit(); return true;
    }
    const control = model.controls.find(control => control.id === hit.action);
    if (control?.disabled) return false;
    if (control) this.overlay.focused = control.id;
    if (hit.action === 'audio' || hit.action === 'subtitles') { this._openTrackOptions(hit.action); this._emit(); return true; }
    return this._operation('Updating playback…', () => this._playbackAction(hit.action, hit.seconds));
  }

  _cancelSeek() { this.seekGesture = null; this.seekPreview = null; }

  cancelSeekGesture() {
    const active = this.seekPreview !== null; this._cancelSeek();
    if (active && !this.closed) this._emit();
    return active;
  }

  _expireSeek() {
    if (!this.seekGesture) return false;
    if (this.closed || this.view !== 'playing' || !this.playback.duration || this.playback.seeking || this.seekGesture.generation !== this.playGeneration ||
      this.now() - this.seekGesture.updatedAt >= SEEK_GESTURE_TIMEOUT_MS) {
      this._cancelSeek(); if (!this.closed) this._emit(); return true;
    }
    return false;
  }

  _beginSeek(owner, fields = {}) {
    this.seekGesture = {owner, generation: this.playGeneration, updatedAt: this.now(), ...fields};
    this.seekPreview = this.playback.position;
  }

  _seekReady(owner) {
    this._expireSeek();
    if (this.closed || this.busy || this.playback.seeking || this.view !== 'playing' || !this.playback.duration || this.overlay.mode !== 'controls') {
      if (this.seekGesture?.owner === owner) this._cancelSeek();
      return false;
    }
    return !this.seekGesture || this.seekGesture.owner === owner;
  }

  async _commitSeek(owner) {
    if (!this.seekGesture || this.seekGesture.owner !== owner) return false;
    const target = Math.max(0, Math.min(this.playback.duration, this.seekPreview));
    this._cancelSeek();
    if (Math.abs(target - this.playback.position) < 0.1) { this._emit(); return false; }
    return this._operation('Seeking…', () => this._playbackAction('seekTo', target));
  }

  async handleHeldSeek({backward = false, forward = false, left = false, right = false} = {}, elapsedSeconds = 0.07) {
    if (!this._seekReady('held')) return false;
    if (!backward && !forward && !left && !right) return this._commitSeek('held');
    if (!this.seekGesture) this._beginSeek('held', {triggerDirection: 0, heldSeconds: 0});
    const gesture = this.seekGesture;
    const dt = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.min(0.25, elapsedSeconds)) : 0;
    const triggerDirection = Number(Boolean(forward)) - Number(Boolean(backward));
    const stickDirection = Number(Boolean(right)) - Number(Boolean(left));
    let delta = 0;
    if (triggerDirection !== gesture.triggerDirection) {
      gesture.triggerDirection = triggerDirection; gesture.heldSeconds = 0;
      delta = triggerDirection * 10;
    } else if (triggerDirection) {
      const previous = gesture.heldSeconds;
      gesture.heldSeconds += dt;
      delta = triggerDirection * 40 * (Math.max(0, gesture.heldSeconds - 0.25) - Math.max(0, previous - 0.25));
    }
    if (stickDirection) {
      // Combining a trigger and the stick keeps one scrub speed and one release.
      if (!triggerDirection) delta = stickDirection * 40 * dt;
      else if (stickDirection !== triggerDirection) delta = 0;
    }
    gesture.updatedAt = this.now();
    this.seekPreview = Math.max(0, Math.min(this.playback.duration - 0.1, this.seekPreview + delta));
    this._showOverlay(); this._emit(); return true;
  }

  async handleSeekAxis(value, elapsedSeconds = 0.2) {
    if (!this._seekReady('axis')) return false;
    if (!Number.isFinite(value)) {
      if (this.seekGesture?.owner === 'axis') { this._cancelSeek(); this._emit(); }
      return false;
    }
    value = Math.max(-1, Math.min(1, value));
    if (Math.abs(value) <= 0.15) return this._commitSeek('axis');
    if (!this.seekGesture) this._beginSeek('axis');
    this.seekGesture.updatedAt = this.now();
    const dt = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.min(0.25, elapsedSeconds)) : 0;
    const speed = Math.sign(value) * ((Math.abs(value) - 0.15) / 0.85) ** 2 * 90;
    this.seekPreview = Math.max(0, Math.min(this.playback.duration - 0.1, this.seekPreview + speed * dt));
    this._showOverlay(); this._emit(); return true;
  }

  setMediaTracks(update = {}) {
    if (this.closed) return;
    for (const key of ['audioTracks', 'subtitleTracks']) {
      if (!Array.isArray(update[key])) continue;
      const seen = new Set(); let selected = false;
      this[key] = update[key].slice(0, 200).filter(track => track &&
        (typeof track.id === 'string' && track.id.length > 0 && track.id.length <= 4096 && !/[\x00-\x1f\x7f]/.test(track.id) || Number.isSafeInteger(track.id) && track.id >= 0) &&
        !seen.has(track.id) && seen.add(track.id)).map((track, index) => {
          const chosen = Boolean(track.selected && !selected); selected ||= chosen;
          return {id: track.id, label: clean(track.label || track.title || track.language || `Track ${index + 1}`, 100),
            language: clean(track.language || track.lang, 32), selected: chosen};
        });
    }
    for (const [key, names] of [['audioTracks', ['selectedAudioId', 'audioTrackId']], ['subtitleTracks', ['selectedSubtitleId', 'subtitleTrackId']]]) {
      const name = names.find(name => Object.prototype.hasOwnProperty.call(update, name));
      if (name) this[key] = this[key].map(track => ({...track, selected: track.id === update[name]}));
    }
    this.overlay.optionSelected = clamp(this.overlay.optionSelected, this._overlayModel().optionCount);
    if (this.view === 'playing' && this.overlay.visible) this._emit();
  }

  _openTrackOptions(mode) {
    this._cancelSeek(); this.overlay.mode = mode;
    const tracks = mode === 'audio' ? this.audioTracks : this.subtitleTracks;
    const selected = tracks.findIndex(track => track.selected);
    this.overlay.optionSelected = mode === 'subtitles' ? selected + 1 : Math.max(0, selected);
    this._showOverlay();
  }

  async selectMediaTrack(mode, id) {
    if (this.closed || this.busy || this.playback.seeking || this.view !== 'playing' || !['audio', 'subtitles'].includes(mode)) return false;
    const key = mode === 'audio' ? 'audioTracks' : 'subtitleTracks';
    if (!(mode === 'subtitles' && id === null) && !this[key].some(track => track.id === id)) return false;
    const generation = this.playGeneration;
    return this._operation('Updating playback…', async () => {
      await this._playbackCallback(mode === 'audio' ? 'selectAudio' : 'selectSubtitle', id);
      if (this.closed || generation !== this.playGeneration || this.view !== 'playing') return;
      this[key] = this[key].map(track => ({...track, selected: track.id === id}));
      this.overlay.mode = 'controls'; this.overlay.focused = mode; this._showOverlay();
    });
  }

  updatePlayback(update = {}) {
    if (this.closed) return;
    const wasPaused = this.playback.paused;
    const wasSeeking = this.playback.seeking;
    const previousPosition = this.playback.position;
    const previous = [Math.floor(this.playback.position), Math.floor(this.playback.duration), this.playback.paused, this.playback.seeking].join(':');
    for (const key of ['position', 'duration']) if (Number.isFinite(update[key]) &&
      update[key] >= 0 && update[key] <= library.MAX_SECONDS)
      this.playback[key] = update[key];
    if (typeof update.paused === 'boolean') this.playback.paused = update.paused;
    if (typeof update.seeking === 'boolean') this.playback.seeking = update.seeking;
    if (wasSeeking && update.seeking === false) this._cancelSeek();
    if ((wasPaused && update.paused === false) || (wasSeeking && update.seeking === false))
      this.overlay.lastInteraction = this.now();
    if (this.seekPreview !== null) this.seekPreview = this.playback.duration ? Math.max(0, Math.min(
      this.playback.duration - (this.seekGesture?.owner === 'touch' ? 0 : 0.1),
      this.seekPreview + (this.seekGesture?.owner === 'touch' ? 0 : this.playback.position - previousPosition))) : null;
    if (['audioTracks', 'subtitleTracks', 'selectedAudioId', 'audioTrackId', 'selectedSubtitleId', 'subtitleTrackId'].some(key =>
      Object.prototype.hasOwnProperty.call(update, key))) this.setMediaTracks(update);
    this._updateLibrarySnapshot(false);
    const changed = previous !== [Math.floor(this.playback.position), Math.floor(this.playback.duration), this.playback.paused, this.playback.seeking].join(':');
    if (changed && (this.view !== 'playing' || this.overlay.visible)) this._emit();
  }

  _updateLibrarySnapshot(ended) {
    if (!this.meta || this.view !== 'playing' && !this.playStarting) return;
    let item = this.libraryItems.find(entry => entry._id === this.meta.id);
    if (!item) item = library.normalizeLibraryItem({_id: this.meta.id, type: this.meta.type, name: this.meta.name,
      poster: this.meta.poster, removed: true, temp: true, state: {}});
    if (!item) return;
    const updated = library.updateLibraryItem(item, {videoId: videoID(this.meta, this.video),
      position: this.playback.position, duration: this.playback.duration, ended});
    this.libraryItem = updated;
    const index = this.libraryItems.findIndex(entry => entry._id === item._id);
    if (index < 0) this.libraryItems.unshift(updated); else this.libraryItems[index] = updated;
    const currentCatalog = this.catalogs[this.catalogIndex];
    this.catalogs = this._libraryCatalogs().concat(this.catalogs.filter(catalog => !catalog.kind));
    const currentIndex = this.catalogs.findIndex(catalog => currentCatalog?.kind ? catalog.kind === currentCatalog.kind : catalog === currentCatalog);
    this.catalogIndex = currentIndex >= 0 ? currentIndex : 0;
    if (this.catalogs[this.catalogIndex]?.kind) {
      this.catalogItems = this._libraryRows(this.catalogs[this.catalogIndex].kind);
      this.catalogSelected = Math.min(this.catalogSelected, Math.max(0, this.catalogItems.length - 1));
    }
  }

  playbackEnded(message = 'Playback ended.') {
    if (this.closed || this.view !== 'playing' && !this.playStarting) return;
    this._updateLibrarySnapshot(true);
    this.playGeneration++;
    this._cancelSeek();
    this.overlay.mode = 'controls'; this.overlay.visible = false;
    this.view = 'sources'; this.selected = this.sourceSelected;
    this.notice = redactText(message); this._emit();
  }

  playbackFailed(message = 'Playback failed. Check the Mac activity log.') {
    if (this.closed || this.view !== 'playing' && !this.playStarting) return;
    if (this.meta && this.streams[this.sourceSelected])
      this.sourcePreferences.forget(this.meta.type, this.meta.id, videoID(this.meta, this.video),
        this.streams, this.sourceSelected).catch(() => this._log('The failed playback source could not be cleared.'));
    this._updateLibrarySnapshot(false); this.playGeneration++;
    this._cancelSeek();
    this.overlay.mode = 'controls'; this.overlay.visible = false;
    this.view = 'sources'; this.selected = this.sourceSelected;
    this.notice = redactText(message); this._emit();
  }

  setPlaybackInfo(update) { this.updatePlayback(update); }

  close() { this.closed = true; this._cancelSeek(); this.playGeneration++; this.abort.abort(); }

  renderMenu(options) { return renderMenu(this.getMenuModel(), options); }
}

const createController = options => new Controller(options);
module.exports = {Controller, createController, renderMenu, episodeLabel};
