'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');

const QUALITY = Object.freeze({
  '180p': {width: 320, height: 180, bitrate: '450k'},
  '360p': {width: 640, height: 360, bitrate: '900k'},
  '540p': {width: 960, height: 540, bitrate: '1800k'},
  '720p': {width: 1280, height: 720, bitrate: '3000k'}
});

const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_ARTWORK_BYTES = Math.floor(1.4 * 1024 * 1024);
const execFileAsync = promisify(execFile);

function safeDiagnostic(value) {
  return String(value || '').slice(0, 2048)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[0-9a-f]{48}\b/gi, '[session]')
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/\b((?:token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function safePlaybackStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value).filter(([key, count]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) &&
    (typeof count === 'boolean' || Number.isFinite(count) && count >= 0 && count <= 1e12))
    .slice(0, 12).map(([key, count]) => `${key}=${count}`).join(' ');
}

function artworkURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = '';
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

function artworkType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function fitNativeArtwork(bytes, type) {
  if (bytes.length <= MAX_NATIVE_ARTWORK_BYTES) return {bytes, type};
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artwork-'));
  try {
    const input = path.join(directory, `source.${type.split('/')[1]}`);
    const output = path.join(directory, 'scaled.jpg');
    await fs.writeFile(input, bytes);
    for (const [edge, quality] of [[1280, 78], [960, 65]]) {
      await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality),
        '--resampleHeightWidthMax', String(edge), input, '--out', output], {timeout: 12000});
      const scaled = await fs.readFile(output);
      if (artworkType(scaled) === 'image/jpeg' && scaled.length <= MAX_NATIVE_ARTWORK_BYTES)
        return {bytes: scaled, type: 'image/jpeg'};
    }
    throw Error('Artwork remains too large after resizing');
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
}

function visibleArtwork(model) {
  const urls = new Set();
  for (const item of [model?.hero, ...(Array.isArray(model?.cards) ? model.cards : [])]) {
    for (const key of ['poster', 'background', 'logo']) {
      const url = artworkURL(item?.[key]);
      if (url) urls.add(url);
    }
  }
  return urls;
}

async function downloadArtwork(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  timeout.unref?.();
  try {
    let current = url;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const reply = await fetchImpl(current, {redirect: 'manual', signal: controller.signal,
        headers: {accept: 'image/jpeg,image/png,image/webp;q=0.8,image/gif;q=0.7'}, credentials: 'omit'});
      if ([301, 302, 303, 307, 308].includes(reply.status)) {
        const location = reply.headers.get('location');
        const next = location ? artworkURL(new URL(location, current).href) : null;
        await reply.body?.cancel();
        if (!next || redirects === 4 || current.startsWith('https:') && !next.startsWith('https:'))
          throw Error('Artwork redirect rejected');
        current = next;
        continue;
      }
      if (!reply.ok || !reply.body || Number(reply.headers.get('content-length')) > MAX_ARTWORK_BYTES)
        throw Error('Artwork response rejected');
      const chunks = []; let size = 0;
      for await (const chunk of reply.body) {
        size += chunk.length;
        if (size > MAX_ARTWORK_BYTES) throw Error('Artwork exceeds the size limit');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const type = artworkType(bytes);
      if (!type) throw Error('Unsupported artwork format');
      return fitNativeArtwork(bytes, type);
    }
    throw Error('Artwork redirect rejected');
  } finally { clearTimeout(timeout); }
}

function transcodeArgs(source, position = 0, quality = '720p', audioTrackId) {
  if (!source || typeof source.url !== 'string') throw Error('No selected stream');
  const url = new URL(source.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Only HTTP(S) streams without URL passwords are supported');
  if (!Number.isFinite(position) || position < 0 || position > 864000) throw Error('Invalid playback position');
  if (audioTrackId !== undefined && (!Number.isSafeInteger(audioTrackId) || audioTrackId < 0 || audioTrackId > 65535))
    throw Error('Invalid audio track');
  const profile = QUALITY[quality];
  if (!profile) throw Error('Invalid Stremio video output');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '15000000',
    '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2', '-reconnect_max_retries', '2'];
  const headers = [];
  for (const [name, value] of Object.entries(source.headers || {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 8192)
      throw Error('Invalid stream header');
    headers.push(`${name}: ${value}\r\n`);
  }
  if (headers.length) args.push('-headers', headers.join(''));
  if (position) args.push('-ss', String(position));
  args.push('-i', url.href,
    '-map', '0:v:0', '-map', audioTrackId === undefined ? '0:a:0?' : `0:${audioTrackId}`,
    '-vf', `fps=30,scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`,
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-g', '30', '-b:v', profile.bitrate,
    '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-f', 'matroska', '-live', '1', 'pipe:1');
  return args;
}

async function create(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const {createController} = require(path.join(projectRoot, 'stremio/controller.cjs'));
  const {createReporter} = require(path.join(projectRoot, 'stremio/progress.cjs'));
  const {create: createBuiltin} = require(path.join(projectRoot, 'stremio/builtin.cjs'));
  const {probe, tools} = require(path.join(projectRoot, 'stremio/decoder.cjs'));
  const {routeAddress} = require(path.join(projectRoot, 'stremio/receiver.cjs'));
  const consoleIP = options.consoleIP;
  if (!consoleIP) throw Error('Enter the Switch IPv4 address');
  const host = options.host || await routeAddress(consoleIP);
  const binaries = await tools({ffmpeg: options.ffmpeg, ffprobe: options.ffprobe});
  const quality = options.quality || '720p';
  if (!QUALITY[quality]) throw Error('Invalid Stremio video output');
  const sample = options.includeSample === false ? null : await createBuiltin({root: projectRoot});
  const token = options.token || crypto.randomBytes(24).toString('hex');
  if (!/^[0-9a-f]{48}$/.test(token)) throw Error('Invalid session token');
  const prefix = '/' + token;
  let selected = null, revision = 0, closed = false, streaming = null, controller, server;
  const stoppingTranscoders = new WeakMap();
  const stopTranscoder = child => {
    if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
    if (stoppingTranscoders.has(child)) return stoppingTranscoders.get(child);
    const pending = new Promise(resolve => {
      let finished = false;
      let force, limit;
      const finish = () => {
        if (finished) return;
        finished = true; clearTimeout(force); clearTimeout(limit); resolve();
      };
      child.once('close', finish);
      force = setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 2000);
      limit = setTimeout(finish, 5000);
      force.unref?.(); limit.unref?.();
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
    stoppingTranscoders.set(child, pending);
    return pending;
  };
  const reporter = createReporter({emit: update => {
    if (!update.itemId.startsWith('mac2jb:')) options.onAccountProgress?.(update);
  }});
  const playbackState = (paused = controller?.playback?.paused || false) => ({
    position: controller?.playback?.position || selected?.position || 0,
    duration: selected?.duration || 0, paused
  });
  const logs = [];
  const artworkCache = new Map();
  const artworkPending = new Map();
  const recentArtwork = new Map();
  const rememberArtwork = model => {
    const now = Date.now();
    for (const url of visibleArtwork(model)) recentArtwork.set(url, now);
    for (const [url, seen] of recentArtwork) {
      if (now - seen > 30000 || recentArtwork.size > 256) recentArtwork.delete(url);
    }
  };
  const log = value => {
    const detail = safeDiagnostic(value);
    logs.push(detail); if (logs.length > 100) logs.shift(); options.onLog?.(detail);
  };
  const controllerOptions = {
    addonUrls: [...(options.addonUrls || []), ...(sample ? [sample.manifestURL] : [])],
    libraryItems: options.libraryItems || [],
    sourcePreferences: options.sourcePreferences,
    callbacks: {
      async play(source) {
        const info = await (options.probe || probe)(source, binaries);
        if (selected) reporter.update(playbackState(), {reason: 'stop'});
        selected = {source, position: source.resumePosition || 0, duration: info.duration || 0,
          audioTrackId: info.audioTrackId, audioTracks: info.audioTracks || []};
        revision++;
        reporter.begin(source, {position: selected.position, duration: selected.duration});
        controller.updatePlayback({position: selected.position, duration: selected.duration, paused: false});
        controller.setMediaTracks({audioTracks: (info.audioTracks || []).map(track => ({
          id: track.id, label: track.label, language: track.language,
          selected: track.id === info.audioTrackId
        }))});
      },
      async pause() { reporter.update(playbackState(!controller.playback.paused), {reason: 'pause'}); },
      async seek(delta) { if (selected) { selected.position = Math.max(0, controller.playback.position + delta); revision++; reporter.update({...playbackState(), position: selected.position}, {reason: 'seek'}); } },
      async seekTo(position) { if (selected) { selected.position = Math.max(0, position); revision++; reporter.update({...playbackState(), position: selected.position}, {reason: 'seek'}); } },
      async selectAudio(id) {
        if (!selected || !selected.audioTracks.some(track => track.id === id)) throw Error('Audio track is unavailable');
        selected.position = controller.playback.position;
        selected.audioTrackId = id;
        revision++;
      },
      async stop() { reporter.update(playbackState(), {reason: 'stop'}); selected = null; revision++; await stopTranscoder(streaming); }
    },
    onLog: log
  };
  controller = (options.createController || createController)(controllerOptions);
  const sendJSON = (response, status, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {'content-type': 'application/json', 'content-length': bytes.length,
      'cache-control': 'no-store'}); response.end(bytes);
  };
  const readBody = async request => {
    let size = 0, chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) throw Error('Request too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  server = http.createServer(async (request, response) => {
    if (closed) return sendJSON(response, 503, {error: 'Session closed'});
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (peer !== consoleIP && !(options.allowLoopback && ['127.0.0.1', '::1'].includes(peer)))
      return sendJSON(response, 403, {error: 'This session belongs to another console'});
    let url;
    try { url = new URL(request.url, 'http://local'); }
    catch { return sendJSON(response, 400, {error: 'Invalid route'}); }
    if (!url.pathname.startsWith(prefix + '/')) return sendJSON(response, 404, {error: 'Not found'});
    const route = url.pathname.slice(prefix.length);
    try {
      if (request.method === 'POST' && route === '/client-close') {
        response.once('finish', () => { try { options.onClientClose?.(); } catch (error) { log(error.message); } });
        return sendJSON(response, 200, {ok: true});
      }
      if (request.method === 'GET' && (route === '/artwork' || route === '/artwork-data')) {
        const imageURL = artworkURL(url.searchParams.get('url'));
        if (!imageURL || !visibleArtwork(controller.getMenuModel()).has(imageURL) &&
            Date.now() - (recentArtwork.get(imageURL) || 0) > 30000)
          return sendJSON(response, 404, {error: 'Artwork is unavailable'});
        let image = artworkCache.get(imageURL);
        if (!image) {
          let pending = artworkPending.get(imageURL);
          if (!pending) {
            pending = downloadArtwork(imageURL, options.fetchArtwork || fetch);
            artworkPending.set(imageURL, pending);
            pending.finally(() => artworkPending.delete(imageURL)).catch(() => {});
          }
          image = await pending;
          artworkCache.set(imageURL, image);
          if (artworkCache.size > 32) artworkCache.delete(artworkCache.keys().next().value);
        }
        if (route === '/artwork-data') {
          if (image.bytes.length > MAX_NATIVE_ARTWORK_BYTES)
            return sendJSON(response, 413, {error: 'Artwork is too large for the native client'});
          return sendJSON(response, 200, {data: `data:${image.type};base64,${image.bytes.toString('base64')}`});
        }
        response.writeHead(200, {'content-type': image.type, 'content-length': image.bytes.length,
          'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff'});
        response.end(image.bytes);
        return;
      }
      if (request.method === 'GET' && route === '/state') {
        const model = controller.getMenuModel();
        rememberArtwork(model);
        return sendJSON(response, 200, {model, playback: selected && model.isPlaying ? {
          revision, url: `http://${host}:${server.address().port}${prefix}/stream?revision=${revision}&position=${selected.position}`,
          position: selected.position, duration: selected.duration, paused: model.playback?.paused || false
        } : null});
      }
      if (request.method === 'POST' && route === '/button') {
        const body = await readBody(request);
        if (!/^(up|down|left|right|a|b|x|y|l|r|zl|zr|plus|seekLeft|seekRight|stopPlayback)$/.test(body.button))
          return sendJSON(response, 400, {error: 'Invalid button'});
        if (body.button === 'stopPlayback') {
          for (let attempt = 0; attempt < 3 && controller.getMenuModel().isPlaying; attempt++)
            if (!await controller.handleButton('b')) break;
        } else await controller.handleButton(body.button);
        return sendJSON(response, 200, {ok: true});
      }
      if (request.method === 'POST' && route === '/catalog-filter') {
        const body = await readBody(request);
        if (typeof body.name !== 'string' || body.name.length > 64 ||
            body.value !== null && (typeof body.value !== 'string' || body.value.length > 256) ||
            !controller.setCatalogFilter(body.name, body.value))
          return sendJSON(response, 400, {error: 'Invalid catalog filter'});
        return sendJSON(response, 200, {ok: true, model: controller.getMenuModel()});
      }
      if (request.method === 'POST' && route === '/touch') {
        const body = await readBody(request);
        if (!Number.isFinite(body.x) || !Number.isFinite(body.y) ||
            !['start', 'move', 'up', 'cancel', 'tap'].includes(body.phase))
          return sendJSON(response, 400, {error: 'Invalid touch'});
        await controller.handleTouch({x: body.x, y: body.y, phase: body.phase, id: 0});
        return sendJSON(response, 200, {ok: true});
      }
      if (request.method === 'POST' && route === '/progress') {
        const body = await readBody(request);
        if (selected && body.revision === revision && Number.isFinite(body.position) && body.position >= 0) {
          controller.updatePlayback({position: Math.min(body.position, selected.duration || body.position)});
          reporter.update(playbackState());
          controller.tickOverlay();
        }
        return sendJSON(response, 200, {ok: true});
      }
      if (request.method === 'POST' && route === '/ended') {
        const body = await readBody(request);
        if (selected && body.revision === revision) {
          reporter.update({...playbackState(), position: selected.duration}, {reason: 'ended'});
          selected = null; revision++; await stopTranscoder(streaming); controller.playbackEnded();
        }
        return sendJSON(response, 200, {ok: true});
      }
      if (request.method === 'POST' && route === '/failure') {
        const body = await readBody(request);
        if (selected && body.revision === revision) {
          const detail = safeDiagnostic(body.error);
          const stats = safePlaybackStats(body.stats);
          log(`Native playback failed${detail ? `: ${detail}` : ''}${stats ? ` (${stats})` : ''}`);
          reporter.update(playbackState(), {reason: 'stop'}); selected = null; revision++; await stopTranscoder(streaming);
          controller.playbackFailed(detail || 'Playback could not continue');
        }
        return sendJSON(response, 200, {ok: true});
      }
      if (request.method === 'GET' && route === '/stream') {
        const wanted = Number(url.searchParams.get('revision'));
        if (!selected || wanted !== revision) return sendJSON(response, 409, {error: 'Stream changed'});
        if (streaming) await stopTranscoder(streaming);
        const position = Number(url.searchParams.get('position'));
        const ffmpeg = (options.spawn || spawn)(binaries.ffmpeg,
          transcodeArgs(selected.source, position, quality, selected.audioTrackId ?? undefined),
          {stdio: ['ignore', 'pipe', 'pipe']});
        streaming = ffmpeg;
        let error = '';
        let lastOutputAt = Date.now(), stalled = false;
        ffmpeg.stdout.on('data', () => { lastOutputAt = Date.now(); stalled = false; });
        const stallMonitor = setInterval(() => {
          if (!stalled && Date.now() - lastOutputAt >= 20000) {
            stalled = true;
            log('Video transcoder has produced no data for 20 seconds');
          }
        }, 5000);
        stallMonitor.unref?.();
        ffmpeg.stderr.on('data', chunk => { error = (error + chunk).slice(-2048); });
        ffmpeg.once('error', failure => { log(`Video transcoder error: ${safeDiagnostic(failure.message)}`); if (!response.headersSent) sendJSON(response, 502, {error: 'Video transcoder failed'}); else response.destroy(); });
        ffmpeg.once('close', code => {
          clearInterval(stallMonitor);
          if (streaming === ffmpeg) streaming = null;
          if (code && !response.destroyed)
            log(`Video transcoder exited with code ${code}${error ? `: ${safeDiagnostic(error)}` : ''}`);
          if (!response.writableEnded) response.end();
        });
        response.once('close', () => { clearInterval(stallMonitor); if (streaming === ffmpeg) stopTranscoder(ffmpeg); });
        response.writeHead(200, {'content-type': 'video/x-matroska', 'cache-control': 'no-store'});
        ffmpeg.stdout.pipe(response);
        return;
      }
      sendJSON(response, 404, {error: 'Not found'});
    } catch (error) { log(error.message); if (!response.headersSent) sendJSON(response, 400, {error: error.message}); else response.destroy(); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, host, resolve); });
    if (!await controller.init()) throw Error('Stremio catalogs could not be loaded');
  } catch (error) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await sample?.close(); controller.close(); throw error;
  }
  return {host, port: server.address().port, token, origin: `http://${host}:${server.address().port}${prefix}`,
    get state() { return {model: controller.getMenuModel(), selected, revision, logs: [...logs]}; },
    async close() {
      if (closed) return; closed = true; await stopTranscoder(streaming); reporter.close(playbackState()); controller.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await sample?.close();
    }};
}

module.exports = {create, transcodeArgs, safeDiagnostic};
