(async function () {
  'use strict';
  if (window.__civswitchApp?.close) await window.__civswitchApp.close();
  const config = window.CivStremioConfig;
  if (!config || !/^[0-9a-f]{48}$/.test(config.token)) throw Error('Stremio install token is invalid');
  if (!window.JellyfinNativeHttp?.available || !window.JellyfinNativePlayer)
    throw Error('CivHomebrew native media components are unavailable');
  const exchange = window.JellyfinNativeHttp.create(window.JellyfinNativeHttp.bridge());
  const font = 'BodyFont, BodyFont-JP, Arial, sans-serif';
  const owner = {owner: 'civ-stremio'};
  const cleanups = [];
  const calls = new Set();
  let closed = false, closing = false, busy = false, state = null, player = null, playerRevision = 0;
  let playingOffset = 0, lifetimeResolve, nativeInput = false, lastAnalogAt = 0;
  let frameSeen = false, pointerActive = false, pointerClosing = false;
  let touchTail = Promise.resolve(), nativeFormat = null;
  let rawPad = null, rawPrevious = 0n, lastDirectTouchAt = 0, lastXAt = 0;
  let exitHold = null;
  let playerDiagnostics = null;
  let bridgeAddress = '', origin = '', storage = null, storageTask = null, keyboard = null, editing = false;
  const artworkCache = new Map();
  const artworkPending = new Map();
  const settingsPath = 'save:/civhomebrew/stremio-settings.json';
  const lifetime = new Promise(resolve => { lifetimeResolve = resolve; });
  const viewportValue = (value, key) => value.replace(/(-?\d+(?:\.\d+)?)(vw|vh)\b/g, (_, number, unit) => {
    const pixels = Number(number) * (unit === 'vw' ? window.innerWidth || 1280 : window.innerHeight || 720) / 100;
    return `${Math.round(key === 'fontSize' ? Math.max(14, pixels) : pixels)}px`;
  });
  const node = (tag, parent, style = {}, content = '') => {
    const item = document.createElement(tag);
    const viewportStyles = {};
    const resolved = {};
    for (const [key, value] of Object.entries(style)) {
      if (typeof value === 'string' && /\d(?:vw|vh)\b/.test(value)) {
        viewportStyles[key] = value;
        resolved[key] = viewportValue(value, key);
      } else resolved[key] = value;
    }
    item.__viewportStyles = viewportStyles;
    Object.assign(item.style, {fontFamily: font, boxSizing: 'border-box'}, resolved);
    item.textContent = content;
    parent.appendChild(item);
    return item;
  };
  const root = node('div', document.body, {position: 'fixed', left: '0', top: '0',
    width: `${window.innerWidth}px`, height: `${window.innerHeight}px`,
    background: 'radial-gradient(circle at 20% 10%,#1d4739,#081e19 55%,#031310)',
    color: '#e8fff4', padding: '0', zIndex: '10', overflow: 'hidden'});
  root.tabIndex = -1;
  const shell = node('div', root, {display: 'flex', width: '100%', height: '100%'});
  const sidebar = node('div', shell, {width: '11%', flexShrink: '0', padding: '2.5vh 0.8vw',
    background: 'rgba(2,17,14,.72)', borderRight: '1px solid rgba(143,240,193,.16)'});
  const brandArea = node('div', sidebar, {width: '100%', height: '16vh', display: 'flex',
    alignItems: 'center', justifyContent: 'center'});
  const sidebarBrand = node('img', brandArea, {display: 'block', width: '100%', height: '100%',
    maxWidth: '120px', maxHeight: '120px', objectFit: 'contain', margin: '0 auto'});
  sidebarBrand.src = config.icon;
  sidebarBrand.alt = 'Stremio';
  sidebarBrand.setAttribute('aria-label', 'Stremio');
  const sidebarItems = node('div', sidebar, {display: 'flex', flexDirection: 'column', gap: '1.6vh',
    marginTop: '1.2vh'});
  const main = node('div', shell, {flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column',
    padding: '2.5vh 2.5vw 2vh'});
  const topbar = node('div', main, {height: '6.2vh', display: 'flex', alignItems: 'center',
    borderBottom: '1px solid rgba(143,240,193,.17)'});
  const header = node('div', topbar, {fontSize: '2.3vw', fontWeight: '700', whiteSpace: 'nowrap'}, 'Stremio');
  const breadcrumb = node('div', topbar, {fontSize: '1.05vw', color: '#a7cdbb', overflow: 'hidden',
    whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: '1', textAlign: 'right', marginLeft: '3vw',
    marginRight: '1.4vw'});
  const tabs = node('div', main, {height: '6vh', flexShrink: '0', display: 'flex', alignItems: 'center',
    gap: '1.1vw', overflow: 'hidden'});
  const hero = node('div', main, {height: '24vh', flexShrink: '0', borderRadius: '1.2vw',
    border: '1px solid rgba(143,240,193,.19)', background: 'rgba(16,48,39,.68)',
    position: 'relative', overflow: 'hidden'});
  const heading = node('div', main, {fontSize: '1.65vw', fontWeight: '700', margin: '1.7vh 0 0.4vh'});
  const subtitle = node('div', main, {fontSize: '1vw', color: '#9abbb0', minHeight: '2.5vh'});
  const list = node('div', main, {flex: '1', minHeight: '0', overflow: 'hidden'});
  const notice = node('div', main, {fontSize: '1vw', color: '#96f0c4', minHeight: '2.5vh'});
  const footer = node('div', main, {display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', gap: '1.2vw', minHeight: '5.5vh', flexShrink: '0',
    marginTop: '0.6vh', borderTop: '1px solid rgba(143,240,193,.3)'});
  const footerPrimary = node('div', footer, {display: 'flex', flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', gap: '1vw',
    width: '50vw', minWidth: '0', flexShrink: '0'});
  const footerExit = node('div', footer, {display: 'flex', alignItems: 'center',
    gap: '0.5vw', flexShrink: '0', paddingLeft: '1.2vw',
    borderLeft: '1px solid rgba(143,240,193,.25)'});
  node('span', footerExit, {fontSize: '1.15vw', fontWeight: '700', color: '#8ff0c1'}, 'Hold B / −');
  node('span', footerExit, {fontSize: '1.1vw', color: '#d7eee2'}, 'Return to CivHomebrew');
  const video = node('div', root, {position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
    backgroundColor: '#000', display: 'none', zIndex: '20'});
  const image = node('img', video, {position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
    display: 'none', objectFit: 'fill'});
  image.alt = 'Stremio playback';
  function fitNativeImage() {
    const width = Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1280;
    const height = Number(window.innerHeight) || Number(document.documentElement?.clientHeight) || 720;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    video.style.width = `${width}px`;
    video.style.height = `${height}px`;
    let displayWidth = Number(nativeFormat?.displayWidth || nativeFormat?.width) || 16;
    let displayHeight = Number(nativeFormat?.displayHeight || nativeFormat?.height) || 9;
    if (displayWidth <= 0 || displayWidth > 32768 || displayHeight <= 0 || displayHeight > 32768) {
      displayWidth = 16; displayHeight = 9;
    }
    const scale = Math.min(width / displayWidth, height / displayHeight);
    const fittedWidth = Math.max(1, Math.min(width, Math.floor(displayWidth * scale)));
    const fittedHeight = Math.max(1, Math.min(height, Math.floor(displayHeight * scale)));
    Object.assign(image.style, {left: `${Math.floor((width - fittedWidth) / 2)}px`,
      top: `${Math.floor((height - fittedHeight) / 2)}px`, width: `${fittedWidth}px`, height: `${fittedHeight}px`});
  }
  fitNativeImage();
  const videoStatus = node('div', video, {position: 'absolute', left: '32px', bottom: '30px', right: '32px',
    padding: '13px 18px', borderRadius: '12px', backgroundColor: 'rgba(3,19,16,.84)', fontSize: '18px'}, 'Loading video');
  const videoOverlay = node('div', video, {position: 'absolute', left: '0', top: '0',
    width: '100%', height: '100%', display: 'none',
    background: 'linear-gradient(transparent 43%,rgba(2,13,11,.94) 100%)', color: '#e8fff4'});
  const overlayTitle = node('div', videoOverlay, {position: 'absolute', left: '8.6%', right: '14%', top: '47%',
    fontSize: '24px', fontWeight: '700'});
  const overlayExit = node('div', videoOverlay, {position: 'absolute', left: '8.6%', top: '7%',
    border: '1px solid rgba(143,240,193,.42)', color: '#e8fff4', fontSize: '18px',
    padding: '6px 14px', borderRadius: '12px',
    background: 'rgba(3,19,16,.8)'}, 'Hold B or − to return');
  node('div', videoOverlay, {position: 'absolute', right: '6.5%', top: '7%', fontSize: '25px',
    padding: '4px 14px', borderRadius: '12px', background: 'rgba(143,240,193,.16)'}, '×');
  const overlayTrack = node('div', videoOverlay, {position: 'absolute', left: '8.6%', top: '63.3%', width: '82.8%',
    height: '13px', borderRadius: '8px', background: 'rgba(232,255,244,.3)', overflow: 'hidden'});
  const overlayFill = node('div', overlayTrack, {height: '100%', width: '0%', background: '#8ff0c1'});
  const overlayTime = node('div', videoOverlay, {position: 'absolute', right: '8.6%', top: '67.5%',
    fontSize: '17px', color: '#bed4ca'});
  const overlayControls = node('div', videoOverlay, {position: 'absolute', left: '8.6%', width: '82.8%',
    bottom: '10%', height: '54px', display: 'flex', justifyContent: 'space-between'});
  const overlayOptions = node('div', videoOverlay, {position: 'absolute', top: '24%', left: '22.5%', width: '55%',
    display: 'none', background: 'rgba(3,19,16,.94)', padding: '16px', borderRadius: '16px'});
  const overlayHint = node('div', videoOverlay, {position: 'absolute', left: '8.6%', bottom: '5%',
    fontSize: '17px', color: '#d7eee2', whiteSpace: 'pre-wrap'},
  'D-pad Choose    A Select    X Close    B Back    Hold B or − to return    Left stick Seek');
  const connection = node('div', root, {position: 'absolute', inset: '0', zIndex: '40', display: 'flex',
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(2,13,11,.96)'});
  const connectionCard = node('div', connection, {width: '80%', maxWidth: '760px', padding: '36px', borderRadius: '20px',
    background: 'linear-gradient(125deg,#193e34,#071e19)', border: '1px solid rgba(143,240,193,.25)'});
  node('div', connectionCard, {fontSize: '32px', fontWeight: '700', marginBottom: '12px'}, 'Connect Stremio');
  const connectionStatus = node('div', connectionCard, {fontSize: '20px', color: '#bad9c8',
    marginBottom: '24px'}, 'Enter this Mac’s IPv4 address and bridge port shown in mac2jb');
  const addressButton = node('button', connectionCard, {display: 'block', padding: '14px 22px',
    border: '0', borderRadius: '12px', backgroundColor: '#8ff0c1', color: '#062018',
    fontSize: '20px', fontWeight: '700'}, 'Set Mac address');
  const retryButton = node('button', connectionCard, {display: 'none', padding: '12px 20px',
    marginTop: '12px', border: '1px solid #8ff0c1', borderRadius: '12px',
    backgroundColor: 'transparent', color: '#8ff0c1', fontSize: '19px'}, 'Retry connection');
  node('div', connectionCard, {display: 'block', padding: '12px 0',
    marginTop: '12px', color: '#bad9c8', fontSize: '17px'}, 'Hold B or − to return to CivHomebrew');

  function resizeStage() {
    fitNativeImage();
    for (const child of root.querySelectorAll('*'))
      for (const [key, value] of Object.entries(child.__viewportStyles || {}))
        child.style[key] = viewportValue(value, key);
    if (state) { lastMenuSignature = ''; heroSignature = ''; paint(); }
  }
  listen(window, 'resize', resizeStage);
  resizeStage();

  function validAddress(value) {
    if (typeof value !== 'string' || value.length > 64) return false;
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value.trim());
    return !!match && match[1].split('.').every(part => Number(part) >= 0 && Number(part) <= 255) &&
      Number(match[2]) > 0 && Number(match[2]) <= 65535;
  }
  function showConnection(message) {
    connection.style.display = 'flex';
    connectionStatus.textContent = message || (bridgeAddress ? `Mac bridge: ${bridgeAddress}` :
      'Enter this Mac’s IPv4 address and bridge port shown in mac2jb');
    addressButton.textContent = bridgeAddress ? 'Change Mac address' : 'Set Mac address';
    retryButton.style.display = bridgeAddress ? 'block' : 'none';
  }
  async function persistAddress() {
    if (!storage) return false;
    const previous = storageTask;
    storageTask = (async () => {
      if (previous) await previous.catch(() => {});
      await storage.write(settingsPath, unescape(encodeURIComponent(JSON.stringify({
        bridgeAddress, packageAddress: config.initialAddress
      }))));
      await storage.commit();
    })();
    await storageTask;
    return true;
  }
  async function editAddress() {
    if (editing || closed) return;
    editing = true;
    try {
      let value;
      if (window.engine) {
        if (!keyboard) throw Error('CivHomebrew keyboard is unavailable');
        value = await keyboard.edit(bridgeAddress || '192.168.1.100:39384', 64, false, 'Mac IPv4:port');
      } else {
        value = await new Promise(resolve => {
          const shade = node('div', connection, {position: 'absolute', inset: '0', display: 'flex',
            alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(2,13,11,.98)'});
          const input = node('input', shade, {width: '65%', padding: '14px', fontSize: '24px',
            background: '#071e19', color: '#e8fff4', border: '2px solid #8ff0c1'});
          input.value = bridgeAddress || '192.168.1.100:39384'; input.maxLength = 64;
          const key = event => {
            if (event.key !== 'Enter' && event.key !== 'Escape') return;
            window.removeEventListener('keydown', key, true);
            shade.remove(); resolve(event.key === 'Enter' ? input.value : null);
            event.preventDefault(); event.stopImmediatePropagation();
          };
          window.addEventListener('keydown', key, true); input.focus();
        });
      }
      if (value === null || value === undefined) return;
      if (!validAddress(value)) throw Error('Enter an IPv4 address and port, such as 192.168.1.100:39384');
      bridgeAddress = value.trim();
      origin = `http://${bridgeAddress}/${config.token}`;
      try { await persistAddress(); } catch { connectionStatus.textContent = 'Address could not be saved; it will work for this session only'; }
      connection.style.display = 'none';
      await refresh();
    } catch (error) { showConnection(error.message); }
    finally { editing = false; root.focus(); }
  }
  listen(addressButton, 'click', editAddress);
  listen(retryButton, 'click', async () => { connection.style.display = 'none'; await refresh(); });
  for (const event of ['pointerdown', 'pointerup', 'touchstart', 'touchend'])
    listen(overlayExit, event, input => input.stopPropagation());

  function artwork(value) {
    if (!origin || typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return url.href;
    } catch { return ''; }
  }
  function loadArtwork(value, picture, fallback) {
    const alternatives = Array.isArray(fallback) ? fallback : fallback ? [fallback] : [];
    const source = artwork(value);
    if (!source) { if (alternatives.length) loadArtwork(alternatives[0], picture, alternatives.slice(1)); return; }
    const cached = artworkCache.get(source);
    if (cached) { picture.src = cached; return; }
    let pending = artworkPending.get(source);
    if (!pending) {
      pending = request('/artwork-data?url=' + encodeURIComponent(source)).then(reply => {
        if (typeof reply.data !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(reply.data))
          throw Error('Invalid artwork response');
        artworkCache.set(source, reply.data);
        if (artworkCache.size > 32) artworkCache.delete(artworkCache.keys().next().value);
        return reply.data;
      }).finally(() => artworkPending.delete(source));
      artworkPending.set(source, pending);
    }
    pending.then(data => { if (picture.parentNode) picture.src = data; }, () => {
      if (alternatives.length) loadArtwork(alternatives[0], picture, alternatives.slice(1));
      else if (picture.parentNode) picture.src = source;
    });
  }
  function empty(target) { while (target.firstChild) target.removeChild(target.firstChild); }
  function makePoster(parent, item, style = {}) {
    const frame = node('div', parent, {position: 'relative', overflow: 'hidden', borderRadius: '0.8vw',
      flexShrink: '0', background: 'linear-gradient(145deg,#27684f,#13372e 56%,#09231c)', ...style});
    const title = String(item.title || item.label || 'Stremio');
    node('div', frame, {position: 'absolute', inset: '0', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '2.6vw', fontWeight: '700', color: 'rgba(232,255,244,.7)'},
    title.split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toUpperCase());
    const sources = [...new Set([item.poster, item.background, item.logo].map(artwork).filter(Boolean))];
    const source = sources[0];
    if (source) {
      const picture = node('img', frame, {position: 'absolute', left: '0', top: '0',
        width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'center center'});
      picture.alt = title;
      let next = 0;
      const tryNext = () => {
        if (!picture.parentNode) return;
        if (next >= sources.length) { picture.style.display = 'none'; return; }
        loadArtwork(sources[next++], picture);
      };
      picture.onerror = tryNext;
      tryNext();
    }
    const ratio = Math.max(0, Math.min(1, Number(item.progress?.ratio || 0)));
    if (ratio) {
      const track = node('div', frame, {position: 'absolute', left: '4%', right: '4%', bottom: '3%',
        height: '0.5vh', borderRadius: '1vh', background: 'rgba(2,17,14,.7)'});
      node('div', track, {height: '100%', width: `${ratio * 100}%`, borderRadius: '1vh', background: '#8ff0c1'});
    }
    return frame;
  }
  async function touchMenu(target) {
    if (closed || busy || !target || target.disabled) return;
    busy = true;
    let filterPrompt = null;
    try {
      await request('/touch', {x: target.x + target.width / 2, y: target.y + target.height / 2, phase: 'tap'});
      const next = await request('/state');
      if (closed) return;
      state = next;
      await syncPlayback(next);
      paint();
      filterPrompt = next.model?.filterInput;
    } catch (error) { showError(error); }
    finally { busy = false; }
    if (filterPrompt) editCatalogFilter({filterName: filterPrompt.name, ...filterPrompt});
  }
  async function editCatalogFilter(entry) {
    if (closed || closing || busy || editing || !entry?.filterName) return;
    editing = true;
    try {
      let value;
      if (window.engine) {
        if (!keyboard) throw Error('CivHomebrew keyboard is unavailable');
        value = await keyboard.edit(entry.value || '', 120, false, entry.label || 'Search');
      } else value = window.prompt?.(entry.label || 'Search', entry.value || '');
      busy = true;
      await request('/catalog-filter', {name: entry.filterName,
        value: value === null || value === undefined ? null : String(value).trim()});
      const next = await request('/state');
      if (!closed) { state = next; await syncPlayback(next); paint(); }
    } catch (error) { showError(error); }
    finally { busy = false; editing = false; if (!closed) root.focus(); }
  }
  function paintSidebar(model) {
    empty(sidebarItems);
    for (const target of model.navigation?.sidebar || []) {
      const active = target.focused || target.active;
      const item = node('div', sidebarItems, {minHeight: '6vh', padding: '1.5vh 0.4vw', borderRadius: '0.6vw',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', border: target.focused ? '2px solid #8ff0c1' : '1px solid transparent',
        background: active ? 'rgba(143,240,193,.15)' : 'transparent',
        color: active ? '#e8fff4' : '#a7cdbb', fontSize: '1vw', cursor: 'pointer'}, target.label);
      item.onclick = () => touchMenu(target);
    }
  }
  let tabMarquees = [];
  const tabMarqueeTimer = setInterval(() => {
    for (const entry of tabMarquees) {
      if (!entry.item.parentNode || !(entry.focused || entry.hovered)) {
        entry.elapsed = 0;
        entry.label.style.transform = 'translateX(0px)';
        continue;
      }
      const width = entry.item.clientWidth - 2 * parseFloat(viewportValue('1vw')) - 4;
      const distance = Math.max(0, entry.label.scrollWidth - width);
      if (!distance) continue;
      entry.elapsed += 40;
      const travel = distance * 1000 / 28;
      const cycle = 900 + travel + 900;
      const phase = entry.elapsed % cycle;
      const offset = Math.max(0, Math.min(distance, (phase - 900) * 28 / 1000));
      entry.label.style.transform = `translateX(-${Math.round(offset)}px)`;
    }
  }, 40);
  cleanups.push(() => clearInterval(tabMarqueeTimer));
  function paintTabs(model) {
    const previous = new Map(tabMarquees.map(entry => [entry.key, entry]));
    empty(tabs);
    tabMarquees = [];
    tabs.style.display = model.view === 'catalog' ? 'flex' : 'none';
    for (const tab of model.tabs || []) {
      const target = model.navigation?.tabs?.find(item => item.index === tab.index);
      const active = tab.selected || tab.active;
      const item = node('div', tabs, {maxWidth: '17vw', minWidth: '0', padding: '0.9vh 1vw',
        borderRadius: '0.6vw', border: tab.selected && target?.focused ? '2px solid #8ff0c1' :
          '1px solid rgba(143,240,193,.15)',
        background: active ? 'rgba(143,240,193,.19)' : 'rgba(16,48,39,.5)',
        color: active ? '#e8fff4' : '#9abbb0', overflow: 'hidden', whiteSpace: 'nowrap',
        fontSize: '0.95vw', cursor: 'pointer'});
      const label = node('span', item, {display: 'inline-block', whiteSpace: 'nowrap'}, tab.label);
      const key = `${tab.index}:${tab.label}`;
      const prior = previous.get(key);
      const marquee = {key, item, label, focused: !!target?.focused,
        hovered: !!prior?.hovered, elapsed: prior?.elapsed || 0};
      tabMarquees.push(marquee);
      item.onpointerenter = () => { marquee.hovered = true; marquee.elapsed = 0; };
      item.onpointerleave = () => { marquee.hovered = false; marquee.elapsed = 0; };
      item.onclick = () => touchMenu(target);
      if (target?.focused) setTimeout(() => {
        if (!item.parentNode) return;
        const box = item.getBoundingClientRect(), track = tabs.getBoundingClientRect();
        if (box.right > track.right - 12) tabs.scrollLeft += box.right - track.right + 12;
        if (box.left < track.left + 12) tabs.scrollLeft -= track.left - box.left + 12;
      }, 0);
    }
  }
  let heroSignature = '';
  function paintHero(model) {
    const media = model.hero;
    const signature = JSON.stringify([model.view, media?.id, media?.title, media?.poster,
      media?.background, media?.releaseInfo, media?.type, media?.runtime, media?.description]);
    if (signature === heroSignature) return;
    heroSignature = signature;
    empty(hero);
    hero.style.display = media ? 'block' : 'none';
    if (!media) return;
    if (model.view === 'catalog') {
      const backdrop = artwork(media.background);
      if (backdrop) {
        const picture = node('img', hero, {position: 'absolute', right: '0', top: '0',
          height: 'auto', width: '100%', opacity: '.82'});
        picture.alt = '';
        picture.onload = () => {
          const naturalWidth = picture.naturalWidth, naturalHeight = picture.naturalHeight;
          if (!naturalWidth || !naturalHeight || !picture.parentNode) return;
          const width = hero.clientWidth || window.innerWidth * .84;
          const height = hero.clientHeight || window.innerHeight * .24;
          const scale = Math.max(width / naturalWidth, height / naturalHeight);
          const fittedWidth = Math.ceil(naturalWidth * scale);
          const fittedHeight = Math.ceil(naturalHeight * scale);
          picture.style.width = `${fittedWidth}px`;
          picture.style.height = `${fittedHeight}px`;
          picture.style.top = `${Math.floor((height - fittedHeight) / 2)}px`;
        };
        picture.onerror = () => { picture.style.display = 'none'; };
        loadArtwork(backdrop, picture);
      }
      for (let index = 0; index < 32; index++) {
        const position = index / 31;
        const alpha = Math.pow(1 - position, 1.35);
        node('div', hero, {position: 'absolute', left: `${index * 2.5}%`, top: '0',
          width: '2.55%', height: '100%', backgroundColor: `rgba(9,35,28,${alpha.toFixed(3)})`});
      }
      const copy = node('div', hero, {position: 'relative', padding: '2.5vh 2vw', width: '75%'});
      node('div', copy, {fontSize: '2.1vw', fontWeight: '700', lineHeight: '1.12',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}, media.title || 'Discover');
      node('div', copy, {fontSize: '0.95vw', marginTop: '1.5vh', color: '#a7cdbb'},
        [media.releaseInfo, media.type, media.runtime].filter(Boolean).join('  ·  '));
      node('div', copy, {fontSize: '1vw', lineHeight: '1.4', color: '#c4dace', marginTop: '2vh',
        overflow: 'hidden', maxHeight: '8.2vh'}, media.description || 'Browse your catalogs and choose something to watch');
    } else {
      const layout = node('div', hero, {display: 'flex', padding: '1.5vh 1.5vw', height: '100%'});
      const coverHeight = Math.max(1, hero.clientHeight - 2 * parseFloat(viewportValue('1.5vh')));
      makePoster(layout, media, {height: '100%', width: `${Math.round(coverHeight * 2 / 3)}px`,
        flexShrink: '0', marginRight: '2.2vw'});
      const copy = node('div', layout, {minWidth: '0'});
      node('div', copy, {fontSize: '2vw', fontWeight: '700', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap'}, media.title || model.title || 'Stremio');
      node('div', copy, {fontSize: '0.95vw', color: '#96f0c4', marginTop: '1.2vh'},
        [media.releaseInfo, media.type, media.runtime].filter(Boolean).join('  ·  '));
      node('div', copy, {fontSize: '1vw', lineHeight: '1.4', color: '#b7d1c3', marginTop: '1.6vh',
        maxHeight: '10vh', overflow: 'hidden'}, media.description || '');
    }
  }
  function paintCatalog(model) {
    empty(list);
    list.style.display = 'flex';
    list.style.gap = viewportValue('1.4vw');
    const cards = Array.isArray(model.cards) ? model.cards : [];
    if (!cards.length) {
      list.style.display = 'block';
      node('div', list, {padding: '8vh 2vw', color: '#a7cdbb', fontSize: '1.3vw'},
        model.message || 'Nothing here yet');
      return;
    }
    const spacing = parseFloat(viewportValue('1.4vw'));
    const cardWidth = Math.max(1, Math.floor(((list.clientWidth || window.innerWidth * .8) - spacing * 3) / 4));
    const posterLimit = Math.max(1, Math.floor((list.clientHeight || window.innerHeight * .36) -
      parseFloat(viewportValue('8vh'))));
    const posterWidth = Math.max(1, Math.floor(Math.min(cardWidth - 2 * spacing, posterLimit * 2 / 3)));
    const posterHeight = Math.max(1, Math.floor(posterWidth * 1.5));
    for (const card of cards) {
      const target = model.navigation?.cards?.find(item => item.index === card.index);
      const selected = !!target?.focused;
      const item = node('div', list, {minWidth: '0', flex: `0 0 ${cardWidth}px`, width: `${cardWidth}px`,
        height: '100%', maxHeight: '100%',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
        padding: '0.8vh 0.6vw', borderRadius: '1vw', cursor: 'pointer',
        border: selected ? '2px solid #8ff0c1' : '1px solid rgba(143,240,193,.18)',
        background: selected ? 'rgba(143,240,193,.16)' : 'rgba(10,38,30,.6)',
        boxShadow: selected ? '0 0 1.7vw rgba(143,240,193,.3)' : 'none'});
      makePoster(item, card, {height: `${posterHeight}px`, width: `${posterWidth}px`});
      node('div', item, {width: '100%', fontSize: '1.05vw', textAlign: 'center', fontWeight: selected ? '700' : '500',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '1.1vh 0.2vw 0'}, card.title || 'Untitled');
      node('div', item, {width: '100%', fontSize: '0.8vw', color: '#a7cdbb', textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}, card.subtitle || '');
      item.onclick = () => touchMenu(target);
    }
  }
  function paintRows(model) {
    empty(list);
    list.style.display = 'block';
    const rows = Array.isArray(model.rows) ? model.rows : [];
    if (!rows.length) {
      node('div', list, {padding: '7vh 2vw', color: '#a7cdbb', fontSize: '1.25vw'},
        model.message || 'No results yet');
      return;
    }
    for (const entry of rows) {
      const target = model.navigation?.rows?.find(item => item.index === entry.index);
      const selected = !!target?.focused;
      const row = node('div', list, {display: 'flex', alignItems: 'center', gap: '1vw',
        padding: '1vh 1vw', marginBottom: '0.6vh', borderRadius: '0.7vw', minHeight: '5.3vh',
        border: selected ? '2px solid #8ff0c1' : '1px solid rgba(143,240,193,.17)',
        background: selected ? 'rgba(143,240,193,.18)' : 'rgba(10,38,30,.55)',
        color: entry.disabled ? '#60776c' : '#e8fff4', cursor: 'pointer'});
      const title = node('div', row, {fontSize: '1.1vw', fontWeight: selected ? '700' : '500',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: '1'},
      entry.label || entry.title || 'Untitled');
      title.title = entry.label || entry.title || 'Untitled';
      if (entry.detail) node('div', row, {fontSize: '0.85vw', color: '#a7cdbb', maxWidth: '34%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}, entry.detail);
      row.onclick = () => touchMenu(target);
    }
  }
  let lastMenuSignature = '', lastTextureUrl = '';
  function paint() {
    if (closed || !state) return;
    const model = state.model || {};
    const isPlaying = !!model.isPlaying && !!state.playback;
    video.style.display = isPlaying ? 'block' : 'none';
    if (isPlaying) {
      lastMenuSignature = '';
      const overlay = model.playbackOverlay;
      videoStatus.style.display = frameSeen ? 'none' : 'block';
      videoOverlay.style.display = overlay?.visible ? 'block' : 'none';
      if (!frameSeen) videoStatus.textContent = 'Loading video';
      if (overlay?.visible) {
        overlayTitle.textContent = overlay.title || model.title || 'Stremio';
        overlayFill.style.width = `${Math.max(0, Math.min(100, Number(overlay.ratio || 0) * 100))}%`;
        overlayTime.textContent = overlay.timeLabel || '';
        overlayHint.textContent = (overlay.message || 'D-pad Choose    A Select    X Close    B Back    Left stick Seek') +
          '    Hold B or − to return';
        while (overlayControls.firstChild) overlayControls.removeChild(overlayControls.firstChild);
        const controls = overlay.controls || [];
        for (const control of controls) {
          node('div', overlayControls, {width: `${Math.max(1, 100 / controls.length - 1)}%`,
            height: '100%', padding: '13px 4px', borderRadius: '12px', textAlign: 'center',
            border: control.focused && overlay.mode === 'controls' ? '2px solid #8ff0c1' : '1px solid rgba(143,240,193,.25)',
            background: control.focused && overlay.mode === 'controls' ? 'rgba(143,240,193,.2)' : 'rgba(3,19,16,.72)',
            color: control.disabled ? '#708d7f' : '#e8fff4', fontSize: '17px'}, control.label);
        }
        overlayOptions.style.display = overlay.mode === 'controls' ? 'none' : 'block';
        while (overlayOptions.firstChild) overlayOptions.removeChild(overlayOptions.firstChild);
        if (overlay.mode !== 'controls') {
          node('div', overlayOptions, {fontWeight: '700', marginBottom: '8px', fontSize: '19px'}, overlay.optionTitle || 'Options');
          for (const row of overlay.optionRows || []) node('div', overlayOptions, {
            padding: '7px 10px', borderRadius: '8px', fontSize: '17px',
            background: row.focused ? 'rgba(143,240,193,.25)' : 'transparent',
            border: row.focused ? '1px solid #8ff0c1' : '1px solid transparent'
          }, `${row.selected ? '✓  ' : ''}${row.label || 'Unknown'}`);
        }
      }
      return;
    }
    const signature = JSON.stringify(model);
    if (signature === lastMenuSignature) return;
    lastMenuSignature = signature;
    paintSidebar(model);
    paintTabs(model);
    paintHero(model);
    breadcrumb.textContent = (model.breadcrumb || []).join('  /  ');
    heading.textContent = model.view === 'catalog' ? model.catalog?.name || 'Discover' : model.title || 'Discover';
    subtitle.textContent = model.view === 'catalog' && model.count ? `${model.selectedIndex + 1} / ${model.count}` : model.subtitle || '';
    notice.textContent = model.message || '';
    const hints = (model.footer || '↑/↓ Browse  A Open  B Back').split(/\s{2,}/);
    const navigation = model.view === 'catalog' ?
      hints.find(hint => hint.startsWith('L/R ')) || hints.find(hint => /^[←↑↓→]/.test(hint)) :
      hints.find(hint => /^[←↑↓→]/.test(hint)) || hints.find(hint => hint.startsWith('L/R '));
    let primaryHints = [hints.find(value => value.startsWith('A ')),
      hints.find(value => value.startsWith('B ')), navigation].filter(Boolean);
    if (model.view === 'catalog' && model.cards?.length && hints.includes('L/R Tabs') &&
        hints.includes('A Open') && hints.includes('B Menu'))
      primaryHints = ['L/R Switch tabs', 'A Open title', 'B Open menu'];
    if (model.view === 'details') {
      const row = model.rows?.find(item => item.selected) ||
        model.rows?.find(item => item.index === model.selectedIndex) || model.rows?.[model.selected || 0];
      const label = row?.label || '';
      const action = row?.action;
      const open = /^play$/i.test(label) ? 'A Play' : action === 'resume' ? 'A Resume' :
        action === 'back' ? 'A Back to catalog' : action === 'currentSeason' ? 'A Open episodes' :
        action === 'watch' && /seasons/i.test(label) ? 'A Browse seasons' :
        action === 'watch' && /episodes/i.test(label) ? 'A Browse episodes' :
        action === 'watch' && /stream/i.test(label) ? 'A Choose stream' : 'A Open';
      primaryHints = [open, 'B Back to titles'];
    }
    empty(footerPrimary);
    for (const hint of primaryHints) {
      const split = hint.indexOf(' ');
      const group = node('div', footerPrimary, {display: 'flex', alignItems: 'baseline',
        gap: '0.4vw', flexShrink: '0', whiteSpace: 'nowrap'});
      node('span', group, {fontSize: '1.2vw', fontWeight: '700', color: '#8ff0c1'}, hint.slice(0, split));
      node('span', group, {fontSize: '1.15vw', color: '#d7eee2'}, hint.slice(split + 1));
    }
    if (model.view === 'catalog') paintCatalog(model); else paintRows(model);
  }

  async function request(route, data) {
    if (!origin) throw Error('Set the Mac bridge address first');
    const cancel = {cancelled: false};
    calls.add(cancel);
    try {
      const reply = await exchange(origin + route, data === undefined ? 'GET' : 'POST',
        data === undefined ? {} : {'Content-Type': 'application/json'},
        data === undefined ? null : JSON.stringify(data), {cancel, deadline: Date.now() + 12000});
      if (reply.status !== 200) throw Error('Mac bridge returned HTTP ' + reply.status);
      return JSON.parse(reply.body);
    } finally { calls.delete(cancel); }
  }

  async function stopPlayer() {
    const old = player;
    player = null;
    playerRevision = 0;
    frameSeen = false;
    playerDiagnostics = null;
    nativeFormat = null;
    lastTextureUrl = '';
    image.src = '';
    image.style.display = 'none';
    if (old) await old.stop();
  }

  async function syncPlayback(next) {
    if (closed) return;
    const playback = next.playback;
    if (!playback) { if (player) await stopPlayer(); return; }
    if (player && playerRevision === playback.revision) {
      if (player.stats().paused !== playback.paused) player.togglePause();
      return;
    }
    await stopPlayer();
    if (closed) return;
    const revision = playback.revision;
    playingOffset = playback.position;
    const current = window.JellyfinNativePlayer.create({url: playback.url, headers: {},
      onFormat(format) { if (!closed && player === current) {
        nativeFormat = format;
        fitNativeImage();
      } },
      onImage(url) { if (!closed && player === current) {
        frameSeen = true;
        if (lastTextureUrl !== url) {
          lastTextureUrl = url;
          image.src = url;
        }
        image.style.display = 'block';
        videoStatus.style.display = 'none';
      } },
      onStatus(message) { if (!closed && player === current && !frameSeen) videoStatus.textContent = message; },
      onStats(stats) { if (!closed && player === current) {
        const keys = ['submitted', 'decoded', 'presented', 'gpuTransfers', 'gpuPendingPolls',
          'queuedPackets', 'queuedBytes', 'audioDecoded', 'audioBufferedMsUpperBound', 'videoPacerPending'];
        const snapshot = {};
        for (const key of keys) if (Number.isFinite(stats[key])) snapshot[key] = stats[key];
        playerDiagnostics = snapshot;
      } },
      onError(error) { if (!closed && player === current) {
        const reason = String(error || 'Native playback failed').slice(0, 500);
        videoStatus.textContent = reason;
        request('/failure', {revision, error: reason, stats: playerDiagnostics}).then(refresh).catch(showError);
      } },
      onEnded() { if (!closed && player === current) request('/ended', {revision}).then(refresh).catch(showError); }
    });
    player = current;
    playerRevision = revision;
    if (playback.paused) current.togglePause();
  }

  function showError(error) { if (!closed) {
    notice.textContent = error.message || String(error);
    videoStatus.textContent = notice.textContent;
    showConnection(`Cannot reach ${bridgeAddress || 'the Mac bridge'}. Check mac2jb and the network, then retry`);
  } }
  async function refresh() {
    if (closed || busy) return;
    busy = true;
    try {
      const next = await request('/state');
      if (closed) return;
      state = next;
      await syncPlayback(next);
      paint();
      connection.style.display = 'none';
    } catch (error) { showError(error); }
    finally { busy = false; }
  }
  async function button(name) {
    if (closed || busy) return;
    busy = true;
    let filterPrompt = null;
    try {
      await request('/button', {button: name});
      const next = await request('/state');
      if (closed) return;
      state = next;
      await syncPlayback(next);
      paint();
      filterPrompt = next.model?.filterInput;
    } catch (error) { showError(error); }
    finally { busy = false; }
    if (filterPrompt) editCatalogFilter({filterName: filterPrompt.name, ...filterPrompt});
  }
  function action(name, phase, x, y) {
    phase = Number(phase);
    if (closed || closing || editing) return;
    const exitKey = name === 'minus' || name === 'select' || name === 'terminal' ? 'minus' :
      name === 'cancel' || name === 'b' || name === 'keyboard-escape' ? 'b' : null;
    if (exitKey) {
      if (phase === 0) {
        if (!exitHold || exitHold.key !== exitKey) exitHold = {key: exitKey, started: Date.now()};
        return;
      }
      if (!exitHold || exitHold.key !== exitKey) return;
      if (phase === 3 && Date.now() - exitHold.started < 650) return;
      if (phase === 3 || Date.now() - exitHold.started >= 650) {
        exitHold = null;
        close();
        return;
      }
      exitHold = null;
      if (exitKey === 'b' && connection.style.display === 'none') button('b');
      return;
    }
    if (phase !== 0 && phase !== 3) return;
    if (connection.style.display !== 'none') {
      if (name === 'accept' || name === 'a') editAddress();
      return;
    }
    if (name === 'plus') { showConnection(); return; }
    if (name === 'nav-move') {
      if (Date.now() - lastAnalogAt < 250) return;
      lastAnalogAt = Date.now();
      if (Math.abs(x) > Math.abs(y) && Math.abs(x) > .7)
        name = state?.model?.isPlaying ? (x > 0 ? 'seekRight' : 'seekLeft') : (x > 0 ? 'right' : 'left');
      else if (Math.abs(y) > .7) name = y > 0 ? 'down' : 'up';
      else return;
    }
    const mapping = {'nav-up': 'up', 'nav-down': 'down', 'nav-left': 'left', 'nav-right': 'right',
      accept: 'a', cancel: 'b', 'keyboard-escape': 'b', menu: 'x',
      'shoulder-left': 'l', 'shoulder-right': 'r'};
    let selected = mapping[name] || name;
    if (selected === 'x') {
      if (Date.now() - lastXAt < 350) return;
      lastXAt = Date.now();
      if (state?.model?.isPlaying) selected = 'stopPlayback';
    }
    if (/^(up|down|left|right|a|b|x|y|l|r|plus|seekLeft|seekRight|stopPlayback)$/.test(selected)) button(selected);
  }
  function listen(target, event, callback) {
    target.addEventListener(event, callback);
    cleanups.push(() => target.removeEventListener(event, callback));
  }
  function touch(event, phase) {
    if (closed || !state?.model?.isPlaying) return;
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = event.changedTouches?.[0] || event.touches?.[0] || event;
    const x = (point.clientX - rect.left) * 1280 / rect.width;
    const y = (point.clientY - rect.top) * 720 / rect.height;
    if ((phase === 'start' || phase === 'tap') && state?.model?.playbackOverlay?.visible &&
        x >= 1134 && x <= 1198 && y >= 58 && y <= 122) {
      button('stopPlayback');
      event.preventDefault?.();
      return true;
    }
    touchTail = touchTail.then(async () => {
      await request('/touch', {x, y, phase});
      const next = await request('/state');
      if (!closed) { state = next; await syncPlayback(next); paint(); }
    }).catch(showError);
    event.preventDefault?.();
  }
  listen(video, 'pointerdown', event => { lastDirectTouchAt = Date.now(); pointerActive = true;
    video.setPointerCapture?.(event.pointerId); pointerClosing = !!touch(event, 'start'); });
  listen(video, 'pointermove', event => { if (pointerActive && !pointerClosing) touch(event, 'move'); });
  listen(video, 'pointerup', event => { if (pointerActive && !pointerClosing) touch(event, 'up');
    pointerActive = false; pointerClosing = false; });
  listen(video, 'pointercancel', event => { if (pointerActive && !pointerClosing) touch(event, 'cancel');
    pointerActive = false; pointerClosing = false; });
  listen(video, 'touchstart', event => { if (pointerActive || Date.now() - lastDirectTouchAt < 350) return;
    lastDirectTouchAt = Date.now(); touch(event, 'start'); });
  listen(video, 'touchmove', event => { if (pointerActive) return; lastDirectTouchAt = Date.now(); touch(event, 'move'); });
  listen(video, 'touchend', event => { if (pointerActive) return; lastDirectTouchAt = Date.now(); touch(event, 'up'); });
  listen(video, 'touchcancel', event => { if (pointerActive) return; lastDirectTouchAt = Date.now(); touch(event, 'cancel'); });
  listen(video, 'click', event => { if (Date.now() - lastDirectTouchAt >= 350) touch(event, 'tap'); });
  listen(window, 'keydown', event => {
    if (event.key === 'F8') { close(); event.preventDefault(); return; }
    const mapped = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Enter: 'a', Escape: 'b', KeyX: 'x', KeyQ: 'l', KeyE: 'r', KeyC: 'plus', Minus: 'minus'}[event.code || event.key] ||
      {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'a', Escape: 'b'}[event.key];
    if (mapped) { action(mapped, event.repeat ? 3 : 0); event.preventDefault(); }
  });
  listen(window, 'keyup', event => {
    const mapped = {Escape: 'b', Minus: 'minus'}[event.code || event.key];
    if (mapped) { action(mapped, 1); event.preventDefault(); }
  });
  for (const event of ['navigate-input', 'engine-input']) listen(window, event, e => {
    const detail = e.detail || {}; action(detail.name, detail.status, detail.x, detail.y);
    e.preventDefault?.();
  });
  if (window.engine?.on) {
    const subscription = window.engine.on('InputAction', action, owner);
    nativeInput = true;
    cleanups.push(() => { if (subscription?.clear) subscription.clear(); else window.engine.off?.('InputAction', action, owner); });
  }
  const padState = {};
  const poll = setInterval(() => {
    if (closed) return;
    if (rawPad) try {
      const bits = rawPad.poll();
      if (bits !== null) {
        if ((bits & 0x4n) && !(rawPrevious & 0x4n)) action('x', 0);
        if (bits & 0x800n) action('minus', rawPrevious & 0x800n ? 3 : 0);
        else if (rawPrevious & 0x800n) action('minus', 1);
        rawPrevious = bits;
      }
    } catch (_) { rawPad.close(); rawPad = null; }
    if (nativeInput || !navigator.getGamepads) return;
    const map = [[12, 'up'], [13, 'down'], [14, 'left'], [15, 'right'], [0, 'a'], [1, 'b'],
      [2, 'x'], [4, 'l'], [5, 'r'], [6, 'seekLeft'], [7, 'seekRight'], [8, 'minus']];
    const pads = navigator.getGamepads() || [];
    for (let i = 0; i < pads.length; i++) if (pads[i]) for (const [index, name] of map) {
      const key = i + ':' + index, down = !!pads[i].buttons[index]?.pressed;
      if (name === 'b' || name === 'minus') {
        if (down) action(name, padState[key] ? 3 : 0);
        else if (padState[key]) action(name, 1);
      } else if (down && !padState[key]) action(name, 0);
      padState[key] = down;
    }
  }, 50);
  const stateTimer = setInterval(() => { if (origin && !editing) refresh(); }, 1500);
  const progressTimer = setInterval(() => {
    if (!closed && player && playerRevision && state?.playback)
      request('/progress', {revision: playerRevision, position: playingOffset + player.stats().seconds}).catch(showError);
  }, 1500);
  async function close() {
    if (closed || closing) return lifetime;
    closing = true;
    if (origin) try {
      await exchange(origin + '/client-close', 'POST', {'Content-Type': 'application/json'}, '{}',
        {cancel: {cancelled: false}, deadline: Date.now() + 1000});
    } catch (_) {}
    closed = true;
    clearInterval(poll); clearInterval(stateTimer); clearInterval(progressTimer);
    rawPad?.close?.(); rawPad = null;
    for (const cancel of calls) cancel.cancelled = true;
    for (const cleanup of cleanups) cleanup();
    keyboard?.cancel?.();
    if (storageTask) await storageTask.catch(() => {});
    await stopPlayer();
    root.remove();
    if (window.__civswitchApp === instance) delete window.__civswitchApp;
    lifetimeResolve();
    return lifetime;
  }
  const instance = {id: 'civ-stremio', close, lifetime};
  window.__civswitchApp = instance;
  root.focus();
  try {
    if (window.PayloadNative) {
      const native = window.PayloadNative.create();
      storage = native.files;
      if (native.controllerButtons) try { rawPad = native.controllerButtons(); } catch (_) {}
    }
    if (window.CivKeyboard?.create) keyboard = window.CivKeyboard.create({root,
      native: () => !!window.engine, focus: () => { if (!closed) root.focus(); },
      error: message => showConnection(message)});
    const stored = storage ? await storage.read(settingsPath, 2048, false) : null;
    const saved = stored && JSON.parse(stored);
    const address = saved?.packageAddress === config.initialAddress && validAddress(saved.bridgeAddress) ?
      saved.bridgeAddress : validAddress(config.initialAddress) ? config.initialAddress : '';
    if (address) {
      bridgeAddress = address;
      origin = `http://${bridgeAddress}/${config.token}`;
      if (saved?.bridgeAddress !== address && storage) await persistAddress().catch(() => {});
      connection.style.display = 'none';
      await refresh();
    } else showConnection();
  } catch (error) { showConnection(error.message); }
  return lifetime;
})();
