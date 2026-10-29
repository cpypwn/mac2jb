'use strict';
const {createHash} = require('node:crypto');
const DEFAULT_ADDON_URL = 'https://stremio.github.io/stremio-static-addon-example/manifest.json';
const RESOURCES = new Set(['catalog', 'meta', 'stream', 'subtitles']);
const clean = (value, maximum = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maximum) : '';

function httpURL(value, maximum = 8192) {
  if (typeof value !== 'string' || value.length > maximum) throw Error('Expected a bounded HTTP(S) URL.');
  let url;
  try { url = new URL(value); } catch { throw Error('The URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw Error('Only HTTP(S) URLs without embedded usernames or passwords are supported.');
  url.hash = '';
  return url;
}

function manifestURL(value) {
  const url = httpURL(String(value).trim().replace(/^stremio:\/\//i, 'https://'));
  if (!url.pathname.endsWith('/manifest.json')) throw Error('An addon URL must end in /manifest.json.');
  return url;
}

function redactURL(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/[redacted]`;
  } catch { return '[redacted URL]'; }
}

function redactText(value) {
  return clean(String(value).replace(/https?:\/\/[^\s"'<>]+/gi, redactURL)
    .replace(/((?:authorization|cookie|x-api-key)\s*[:=])[^\r\n]*/gi, '$1 [redacted]'), 300);
}

async function requestJSON(initial, {timeoutMs = 12000, maxBytes = 2 * 1024 * 1024,
  fetchImpl = globalThis.fetch, onLog = () => {}, signal} = {}) {
  const abort = new AbortController();
  const cancelled = () => abort.abort();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener('abort', cancelled, {once: true});
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  try {
    let url = httpURL(String(initial));
    for (let redirects = 0; redirects <= 3; redirects++) {
      onLog(`Addon request: ${redactURL(url.href)}`);
      const response = await fetchImpl(url, {redirect: 'manual', signal: abort.signal,
        headers: {accept: 'application/json', 'user-agent': 'mac2jb-stremio-alpha'}});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw Error('The addon redirected too many times.');
        const next = httpURL(new URL(location, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw Error('The addon redirected to an insecure connection.');
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(`The addon request failed (HTTP ${response.status}).`);
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw Error('The addon response exceeds the size limit.');
      }
      const pieces = []; let length = 0;
      for await (const bytes of response.body || []) {
        length += bytes.length;
        if (length > maxBytes) { abort.abort(); throw Error('The addon response exceeds the size limit.'); }
        pieces.push(Buffer.from(bytes));
      }
      let result;
      try { result = JSON.parse(Buffer.concat(pieces).toString('utf8')); }
      catch { throw Error('The addon returned invalid JSON.'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('The addon response must be a JSON object.');
      return result;
    }
  } catch (error) {
    if (signal?.aborted) throw Error('The addon request was cancelled.');
    if (abort.signal.aborted && !/size limit/.test(error.message)) throw Error('The addon request timed out.');
    if (/^(The addon|Only HTTP|The URL|Expected a bounded)/.test(error.message)) throw error;
    throw Error('The addon could not be reached.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); }
}

function normalizeManifest(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.types) ||
      !Array.isArray(raw.resources) || !Array.isArray(raw.catalogs || []))
    throw Error('The addon manifest is incomplete.');
  const types = raw.types.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 64).slice(0, 32);
  const prefixes = value => Array.isArray(value) ? value
    .filter(prefix => typeof prefix === 'string' && prefix.length <= 128).slice(0, 64) : null;
  const resources = raw.resources.slice(0, 64).flatMap(resource => {
    if (typeof resource === 'string') return RESOURCES.has(resource) ? [{name: resource, types, idPrefixes: prefixes(raw.idPrefixes)}] : [];
    if (!resource || !RESOURCES.has(resource.name)) return [];
    const allowed = Array.isArray(resource.types) ? resource.types.filter(type => types.includes(type)) : types;
    const idPrefixes = prefixes(resource.idPrefixes);
    return [{name: resource.name, types: allowed, idPrefixes}];
  });
  const catalogs = (raw.catalogs || []).slice(0, 64).flatMap(catalog => {
    if (!catalog || !types.includes(catalog.type) || typeof catalog.id !== 'string' || !catalog.id || catalog.id.length > 256) return [];
    const extra = Array.isArray(catalog.extra) ? catalog.extra.slice(0, 32).filter(item => item && typeof item.name === 'string') : [];
    return [{id: catalog.id, type: catalog.type, name: clean(catalog.name) || clean(catalog.id), extra}];
  });
  return {id: clean(raw.id), name: clean(raw.name) || clean(raw.id), types, resources, catalogs};
}

function normalizeMeta(raw, fallbackType) {
  if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 2048) return null;
  const type = typeof raw.type === 'string' && raw.type ? raw.type : fallbackType;
  if (typeof type !== 'string' || !type || type.length > 64) return null;
  const videos = (Array.isArray(raw.videos) ? raw.videos : []).slice(0, 2000).flatMap(video => {
    if (!video || typeof video.id !== 'string' || !video.id || video.id.length > 2048) return [];
    return [{id: video.id, title: clean(video.title || video.name) || video.id.slice(0, 80),
      season: Number.isSafeInteger(video.season) ? video.season : null,
      episode: Number.isSafeInteger(video.episode) ? video.episode : null, released: clean(video.released, 48)}];
  }).sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || (a.episode ?? -1) - (b.episode ?? -1) ||
    (Date.parse(a.released) || -8640000000000000) - (Date.parse(b.released) || -8640000000000000));
  let poster, background, logo;
  try { if (typeof raw.poster === 'string') poster = httpURL(raw.poster).href; } catch {}
  try { if (typeof raw.background === 'string') { const url = httpURL(raw.background, 2048); if (url.href.length <= 2048) background = url.href; } } catch {}
  try { if (typeof raw.logo === 'string') { const url = httpURL(raw.logo, 2048); if (url.href.length <= 2048) logo = url.href; } } catch {}
  const rating = raw.imdbRating ?? raw.rating;
  const defaultVideoId = raw.behaviorHints?.defaultVideoId;
  return {id: raw.id, type, name: clean(raw.name) || raw.id.slice(0, 80), poster, background, logo,
    posterShape: ['poster', 'square', 'landscape'].includes(raw.posterShape) ? raw.posterShape : 'poster',
    genres: (Array.isArray(raw.genres) ? raw.genres : []).slice(0, 8).map(genre => clean(genre, 48)).filter(Boolean),
    runtime: clean(raw.runtime, 48),
    rating: typeof rating === 'string' || typeof rating === 'number' && Number.isFinite(rating) ? clean(String(rating), 16) : '',
    behaviorHints: {defaultVideoId: typeof defaultVideoId === 'string' && defaultVideoId.length <= 2048 ? defaultVideoId : undefined},
    description: clean(raw.description, 600), releaseInfo: clean(String(raw.releaseInfo || raw.year || ''), 48), videos};
}

function requestHeaders(raw) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 32)
    throw Error('The stream headers are invalid.');
  const headers = {};
  const forbidden = /^(host|connection|content-length|transfer-encoding|proxy-authorization)$/i;
  let total = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbidden.test(name) ||
        typeof value !== 'string' || /[\r\n\x00]/.test(value) || value.length > 4096)
      throw Error('The stream headers are invalid.');
    total += name.length + value.length;
    if (total > 16384) throw Error('The stream headers exceed the size limit.');
    headers[name] = value;
  }
  return headers;
}

function normalizeStream(raw, addonName, providerKey) {
  const label = clean(raw?.name || raw?.title || raw?.description, 100) || 'Unnamed source';
  const result = {label, addonName, providerKey, playable: false, reason: '', url: null, headers: {}};
  if (typeof raw?.url === 'string') {
    try {
      result.url = httpURL(raw.url, 16384).href;
      result.headers = requestHeaders(raw.behaviorHints?.proxyHeaders?.request);
      result.playable = true;
    } catch (error) { result.reason = error.message; }
  } else if (raw?.infoHash) result.reason = 'Torrent sources need a streaming service; this alpha supports direct HTTP(S)/HLS sources.';
  else if (raw?.ytId) result.reason = 'YouTube-ID sources are not supported by this alpha.';
  else if (raw?.externalUrl) result.reason = 'Browser-only sources are not supported by this alpha.';
  else result.reason = 'This source does not provide a supported direct HTTP(S)/HLS URL.';
  return result;
}

function normalizeSubtitle(raw, addonName, providerKey = 'subtitle') {
  if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 2048 ||
      /[\x00-\x1f\x7f]/.test(raw.id) || typeof raw.lang !== 'string' || !clean(raw.lang, 64) || raw.lang.length > 64) return null;
  try {
    const lang = clean(raw.lang, 64);
    const url = httpURL(raw.url).href;
    if (url.length > 8192) return null;
    let label = clean(raw.label, 160);
    if (!label) { try { label = lang === 'und' ? 'Unknown language' : new Intl.DisplayNames(['en'], {type: 'language'}).of(lang); } catch {} }
    return {id: `${providerKey}:${raw.id}`, remoteId: raw.id, url, lang,
      label: clean(label, 160) || lang, addonName: clean(addonName)};
  } catch { return null; }
}

function subtitleExtras(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('The subtitle request metadata is invalid.');
  const extras = {};
  if (raw.videoHash !== undefined) {
    if (typeof raw.videoHash !== 'string' || !/^[a-f0-9]{16}$/i.test(raw.videoHash)) throw Error('The subtitle video hash is invalid.');
    extras.videoHash = raw.videoHash;
  }
  if (raw.videoSize !== undefined) {
    if (!Number.isSafeInteger(raw.videoSize) || raw.videoSize < 0) throw Error('The subtitle video size is invalid.');
    extras.videoSize = raw.videoSize;
  }
  if (raw.filename !== undefined) {
    if (typeof raw.filename !== 'string' || !raw.filename || raw.filename.length > 1024 || /[\x00-\x1f\x7f]/.test(raw.filename))
      throw Error('The subtitle filename is invalid.');
    extras.filename = raw.filename;
  }
  return extras;
}

class AddonClient {
  constructor(url, options = {}) { this.url = manifestURL(url); this.options = options; this.manifest = null; }
  async init() { this.manifest = normalizeManifest(await requestJSON(this.url, this.options)); return this; }
  supports(resource, type, id = '') {
    if (typeof type !== 'string' || !type || type.length > 64 || typeof id !== 'string' || id.length > 2048) return false;
    return this.manifest?.resources.some(rule => rule.name === resource && rule.types.includes(type) &&
      (resource === 'catalog' || !rule.idPrefixes || rule.idPrefixes.some(prefix => id.startsWith(prefix)))) || false;
  }
  resourceURL(resource, type, id, extras = {}) {
    if (!RESOURCES.has(resource) || typeof type !== 'string' || typeof id !== 'string') throw Error('Invalid addon resource.');
    const url = new URL(this.url);
    const suffix = Object.entries(extras).filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join('&');
    url.pathname = url.pathname.slice(0, -'manifest.json'.length) +
      [resource, type, id].map(encodeURIComponent).join('/') + (suffix ? '/' + suffix : '') + '.json';
    return url;
  }
  async catalog(catalog, extras = {}) {
    if (!this.supports('catalog', catalog.type, catalog.id)) throw Error('This addon does not expose this catalog.');
    for (const extra of catalog.extra || [])
      if (extra.isRequired && extras[extra.name] === undefined) throw Error('This catalog requires filters that are not available in this alpha.');
    const permitted = new Set((catalog.extra || []).map(extra => extra.name));
    const filtered = Object.fromEntries(Object.entries(extras).filter(([name]) => permitted.has(name)));
    const data = await requestJSON(this.resourceURL('catalog', catalog.type, catalog.id, filtered), this.options);
    if (!Array.isArray(data.metas)) throw Error('The addon did not return a catalog list.');
    return data.metas.slice(0, 500).map(meta => normalizeMeta(meta, catalog.type)).filter(Boolean);
  }
  async meta(type, id) {
    if (!this.supports('meta', type, id)) return null;
    const data = await requestJSON(this.resourceURL('meta', type, id), this.options);
    const meta = normalizeMeta(data.meta, type);
    return meta?.id === id && meta.type === type ? meta : null;
  }
  async streams(type, id) {
    if (!this.supports('stream', type, id)) return [];
    const data = await requestJSON(this.resourceURL('stream', type, id), this.options);
    if (!Array.isArray(data.streams)) throw Error('The addon did not return a stream list.');
    const providerKey = createHash('sha256').update(this.url.href).digest('hex');
    return data.streams.slice(0, 200).map(stream => normalizeStream(stream, this.manifest.name, providerKey));
  }
  async subtitles(type, id, extra = {}) {
    if (!id || !this.supports('subtitles', type, id)) return [];
    const data = await requestJSON(this.resourceURL('subtitles', type, id, subtitleExtras(extra)), this.options);
    if (!Array.isArray(data.subtitles)) throw Error('The addon did not return a subtitle list.');
    const providerKey = 'sub_' + createHash('sha256').update(this.url.href).digest('hex').slice(0, 16);
    const seen = new Set();
    return data.subtitles.slice(0, 200).map(subtitle => normalizeSubtitle(subtitle, this.manifest.name, providerKey)).filter(subtitle => {
      if (!subtitle || seen.has(subtitle.id)) return false;
      seen.add(subtitle.id); return true;
    });
  }
}

class AddonCollection {
  constructor({addonUrls = [], ...options} = {}) {
    if (!Array.isArray(addonUrls) || addonUrls.length > 33) throw Error('Configure at most 32 account addon manifest URLs and the built-in sample.');
    this.urls = [...new Set(addonUrls.length ? addonUrls : [DEFAULT_ADDON_URL])];
    this.options = options; this.clients = []; this.errors = [];
  }
  async init() {
    const results=[];
    for(let offset=0;offset<this.urls.length;offset+=4)results.push(...await Promise.allSettled(
      this.urls.slice(offset,offset+4).map(url=>Promise.resolve().then(()=>new AddonClient(url,this.options).init()))));
    this.clients = []; this.errors = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') this.clients.push(result.value);
      else this.errors.push({url: redactURL(this.urls[index]), message: redactText(result.reason.message)});
    });
    if (!this.clients.length) throw Error(this.errors[0]?.message || 'No addons are available.');
    return this;
  }
  catalogs() { return this.clients.flatMap(client => client.manifest.catalogs
    .filter(catalog => client.supports('catalog', catalog.type, catalog.id))
    .map(catalog => ({...catalog, client, addonName: client.manifest.name}))); }
  async meta(type, id, preferred) {
    const clients = [...new Set([preferred, ...this.clients].filter(Boolean))].filter(client => client.supports('meta', type, id));
    const results = await Promise.allSettled(clients.map(client => client.meta(type, id)));
    return results.find(result => result.status === 'fulfilled' && result.value)?.value || null;
  }
  async streams(type, id) {
    const clients = this.clients.filter(client => client.supports('stream', type, id));
    const results = await Promise.allSettled(clients.map(client => client.streams(type, id)));
    const streams = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (!streams.length && results.some(result => result.status === 'rejected')) throw Error('The stream providers could not return sources. Refresh to try again.');
    return streams;
  }
  async subtitles(type, id, extra = {}) {
    const extras = subtitleExtras(extra);
    const clients = this.clients.filter(client => client.supports('subtitles', type, id));
    const results = await Promise.allSettled(clients.map(client => client.subtitles(type, id, extras)));
    const subtitles = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).slice(0, 200);
    if (!subtitles.length && results.some(result => result.status === 'rejected'))
      throw Error('The subtitle providers could not return subtitles. Try again.');
    return subtitles;
  }
}

module.exports = {DEFAULT_ADDON_URL, AddonClient, AddonCollection, requestJSON, manifestURL, normalizeMeta,
  normalizeStream, normalizeSubtitle, subtitleExtras, requestHeaders, redactURL, redactText, clean};
