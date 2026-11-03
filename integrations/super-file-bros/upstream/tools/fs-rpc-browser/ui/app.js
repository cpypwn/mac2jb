'use strict';
const $ = id => document.getElementById(id), key = location.hash.slice(1);
let games = [], connected = false, state = {}, busy = false, cwd = '/', lastStorageLease = '', connectionHost = '', pollError = false;
async function api(route, data) {
  const response = await fetch(route, {method: data === undefined ? 'GET' : 'POST', headers: {'x-fs-key': key,
    ...(data === undefined ? {} : {'content-type': 'application/json'})}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Request failed'); return result;
}
function notice(text) {$('notice').textContent = text;}
async function action(fn) {if (busy) return; busy = true; try {await fn();} catch (error) {notice(error.message);} finally {busy = false;}}
function row(name, detail, label, callback) {
  const item = document.createElement('div'); item.className = 'game';
  const text = document.createElement('div'), title = document.createElement('strong'), sub = document.createElement('small');
  title.textContent = name; sub.textContent = detail; text.append(title, sub); item.append(text);
  if (label) {const button = document.createElement('button'); button.textContent = label; button.onclick = () => action(callback); item.append(button);}
  return item;
}
function storageLabel(storages = []) {
  return [...new Set(storages)].map(id => ({2: 'Game card', 4: 'Console storage', 5: 'SD card'})[id] || 'Unknown storage').join(' + ') || 'Storage unknown';
}
function renderGames() {
  $('games').replaceChildren(); const search = $('search').value.toLowerCase();
  for (const game of games.filter(game => (game.name + game.title).toLowerCase().includes(search))) {
    $('games').append(row(game.name, game.title.toUpperCase() + ' · ' + storageLabel(game.storages), 'Connect', async () => {state = await api('/api/start', {title: game.title}); renderStatus();}));
  }
  if (!$('games').children.length) $('games').append(row(connected ? 'No matching games' : 'Connect to load installed games', '', '', null));
}
function renderStatus() {
  $('export-name').textContent = state.name || 'Nothing connected'; $('export-status').textContent = state.status || 'Idle';
  $('progress').textContent = state.error || state.progress || 'Choose a game or open SD & console storage.';
  $('open').disabled = state.status !== 'ready'; $('stop').disabled = !['ready', 'preparing', 'stopping'].includes(state.status);
  $('ftp-url').hidden = state.status !== 'ready'; $('ftp-url').textContent = state.url || ''; $('ftp-url').href = state.url || '#';
  $('mounts').textContent = (state.mounts || []).map(name => '/' + name).join(' · ');
  $('storage-start').disabled = !connected || state.status === 'stopping';
}
async function download(target) {
  const result = await api('/api/download', {path: target});
  const link = document.createElement('a'); link.href = result.url; link.download = result.name;
  document.body.append(link); link.click(); link.remove();
  notice('Downloading ' + result.name + '. Your browser saves the file to its download folder.');
  await renderDownloads();
}
async function renderDownloads() {
  const records = await api('/api/downloads');
  $('downloads').hidden = !records.length; $('download-items').replaceChildren();
  for (const record of records.slice().reverse()) {
    const size = (record.bytes / 1048576).toFixed(2) + ' MB';
    const total = record.totalBytes === null ? '' : ' / ' + (record.totalBytes / 1048576).toFixed(2) + ' MB';
    const active = ['queued', 'starting', 'downloading'].includes(record.status);
    const item = row(record.name, record.status + ' · ' + size + total + ' · ' + record.files + ' files' + (record.error ? ' · ' + record.error : ''),
      active ? 'Cancel' : '', () => api('/api/download/cancel', {id: record.id}));
    if (record.currentFile && active) {const current = document.createElement('small'); current.textContent = record.currentFile; item.firstChild.append(current);}
    $('download-items').append(item);
  }
}
let folderWritable = false, uploading = false, cancelUpload = false, uploadToken = null;
function fileDialog(title, text, name, label = 'Save') {
  $('dialog-title').textContent = title; $('dialog-text').textContent = text;
  $('dialog-label').hidden = name === null; $('dialog-name').required = name !== null; $('dialog-name').value = name || ''; $('dialog-name').setCustomValidity('');
  $('dialog-confirm').textContent = label; $('file-dialog').showModal();
  return new Promise(resolve => {
    $('file-dialog').onclose = () => resolve(null);
    $('dialog-cancel').onclick = () => $('file-dialog').close();
    $('file-dialog-form').onsubmit = event => {event.preventDefault();
      const value = name === null ? true : $('dialog-name').value.trim();
      if (name !== null && (!value || /[\x00-\x1f\x7f/\\:]/.test(value) || ['.', '..'].includes(value))) {$('dialog-name').setCustomValidity('Enter one file or folder name'); $('dialog-name').reportValidity(); return;}
      $('file-dialog').onclose = null; $('file-dialog').close(); resolve(value);
    };
    $('dialog-name').oninput = () => $('dialog-name').setCustomValidity('');
  });
}
async function mutateEntry(entry, target, operation) {
  if (operation === 'rename') {
    const name = await fileDialog('Rename', entry.name, entry.name); if (!name) return;
    await api('/api/sd/rename', {path: target, to: (cwd === '/' ? '' : cwd) + '/' + name, lease: state.lease});
    notice('Renamed to ' + name);
  } else {
    if (!await fileDialog('Delete ' + (entry.type === 'dir' ? 'folder' : 'file') + '?', 'Permanently delete ' + target + (entry.type === 'dir' ? ' and everything inside it?' : '?') + ' This cannot be undone.', null, 'Delete permanently')) return;
    await api('/api/sd/delete', {path: target, confirmed: true, lease: state.lease}); notice('Deleted ' + entry.name);
  }
  await browse(cwd);
}
async function uploadFiles(files) {
  if (!files.length || !folderWritable) return;
  uploading = true; cancelUpload = false; $('upload-progress').hidden = false;
  const base = cwd, lease = state.lease, total = files.reduce((sum, file) => sum + file.size, 0); let transferred = 0;
  const directories = new Set();
  try {
    for (const file of files) {
      if (cancelUpload) throw Error('Upload cancelled');
      const relative = file.webkitRelativePath || file.name;
      if (relative.split('/').some(part => !part || ['.', '..'].includes(part) || /[\x00-\x1f\x7f\\:]/.test(part))) throw Error('Invalid upload path');
      const target = base + '/' + relative, parent = target.slice(0, target.lastIndexOf('/'));
      if (parent !== base && !directories.has(parent)) {await api('/api/sd/mkdir', {path: parent, parents: true, lease}); directories.add(parent);}
      $('upload-name').textContent = relative;
      const opened = await api('/api/sd/upload-begin', {path: target, size: file.size, lease}); uploadToken = opened.token;
      for (let offset = 0; offset < file.size;) {
        if (cancelUpload) throw Error('Upload cancelled');
        const bytes = new Uint8Array(await file.slice(offset, offset + 32768).arrayBuffer());
        const data = btoa(String.fromCharCode(...bytes));
        await api('/api/sd/upload-chunk', {token: uploadToken, offset, data}); offset += bytes.length; transferred += bytes.length;
        $('upload-meter').value = total ? transferred / total : 1;
        $('upload-detail').textContent = (transferred / 1048576).toFixed(2) + ' / ' + (total / 1048576).toFixed(2) + ' MB';
      }
      if (cancelUpload) throw Error('Upload cancelled');
      await api('/api/sd/upload-finish', {token: uploadToken}); uploadToken = null;
    }
    $('upload-meter').value = 1; $('upload-detail').textContent = 'Upload complete · ' + files.length + ' files'; notice('Upload complete');
  } catch (error) {
    if (uploadToken) {await api('/api/sd/upload-cancel', {token: uploadToken}).catch(cleanup => {error.message += '. Cleanup: ' + cleanup.message;}); uploadToken = null;}
    $('upload-detail').textContent = error.message; throw error;
  } finally {uploading = false; $('upload-cancel').disabled = true; await browse(base);}
}
async function browse(target = '/') {
  const result = await api('/api/browse', {path: target}); cwd = result.cwd;
  sessionStorage.setItem('storagePath', cwd); $('path').textContent = cwd; $('files').replaceChildren();
  $('download-folder').disabled = false; folderWritable = result.writable === true;
  for (const id of ['upload-files', 'upload-folder', 'new-folder']) $(id).disabled = !folderWritable || uploading;
  $('write-status').textContent = folderWritable ? 'SD card · Upload, rename and delete available. Existing files are never overwritten.' : 'Read-only · Open an SD folder to upload or manage files.';
  for (const entry of result.entries) {
    const target = (cwd === '/' ? '' : cwd) + '/' + entry.name;
    const item = row(entry.name, entry.type === 'dir' ? 'Folder' : entry.size.toLocaleString() + ' bytes',
      entry.type === 'dir' ? 'Open' : '', () => browse(target));
    const button = document.createElement('button'); button.className = 'download-button';
    button.textContent = entry.type === 'dir' ? 'Download ZIP' : 'Download';
    button.onclick = () => action(() => download(target)); item.append(button);
    if (folderWritable) for (const operation of ['rename', 'delete']) {
      const control = document.createElement('button'); control.textContent = operation === 'rename' ? 'Rename' : 'Delete';
      control.onclick = () => action(() => mutateEntry(entry, target, operation)); item.append(control);
    }
    $('files').append(item);
  }
  if (!result.entries.length) $('files').append(row('This folder is empty', '', '', null));
}
function acceptList(result) {
  connected = true; games = result.games; connectionHost = result.session.host;
  if (result.connection) {$('run').value = result.connection.run; $('host').value = result.connection.host;}
  notice('Connected to ' + connectionHost + ' · ' + games.length + ' installed games'); renderGames(); renderStatus();
}
async function detect() {
  notice('Detecting an active FS RPC session…');
  try {
    const result = await api('/api/detect', {});
    if (result.needsHost) {
      $('run').value = result.connection.run; $('host').value = result.connection.host || '';
      connected = false; games = []; renderGames(); $('connection-settings').open = true;
      notice('Active run folder found. Enter the console IPv4 and click Connect.'); return;
    }
    acceptList(result); $('connection-settings').open = false;
  }
  catch (error) {$('connection-settings').open = true; throw error;}
}
$('detect').onclick = () => action(detect);
$('connect-form').onsubmit = event => {event.preventDefault(); action(async () => {
  notice('Checking the held endpoint and reading installed games…');
  acceptList(await api('/api/connect', {run: $('run').value.trim(), host: $('host').value.trim()}));
});};
$('refresh').onclick = () => action(async () => acceptList(await api('/api/list', {})));
$('search').oninput = renderGames;
$('games-tab').onclick = () => {$('games-view').hidden = false; $('storage-view').hidden = true; $('games-tab').classList.add('selected'); $('storage-tab').classList.remove('selected');};
$('storage-tab').onclick = () => {$('games-view').hidden = true; $('storage-view').hidden = false; $('storage-tab').classList.add('selected'); $('games-tab').classList.remove('selected');};
$('storage-start').onclick = () => action(async () => {state = await api('/api/start', {mode: 'storage'}); renderStatus();});
$('download-folder').onclick = () => action(() => download(cwd));
$('upload-files').onclick = () => $('file-picker').click();
$('upload-folder').onclick = () => $('folder-picker').click();
for (const id of ['file-picker', 'folder-picker']) $(id).onchange = () => {const files = [...$(id).files]; $(id).value = ''; $('upload-cancel').disabled = false; action(() => uploadFiles(files));};
$('upload-cancel').onclick = () => {cancelUpload = true; $('upload-detail').textContent = 'Cancelling upload…';};
$('new-folder').onclick = () => action(async () => {const name = await fileDialog('New folder', 'Create a folder in ' + cwd, ''); if (!name) return; await api('/api/sd/mkdir', {path: cwd + '/' + name, lease: state.lease}); await browse(cwd);});
$('up').onclick = () => action(() => browse(cwd.split('/').slice(0, -1).join('/') || '/'));
$('stop').onclick = () => action(async () => {state = await api('/api/stop', {lease: state.lease}); renderStatus();});
$('open').onclick = () => action(async () => {await api('/api/open', {manager: $('manager').value, executable: $('executable').value}); notice('Opened in your selected file manager.');});
async function init() {
  const result = await api('/api/settings');
  $('run').value = result.settings.run || ''; $('host').value = result.settings.host || '';
  for (const manager of result.fileManagers) {const option = document.createElement('option'); option.value = manager.id; option.textContent = manager.name; $('manager').append(option);}
  $('manager').value = result.settings.manager || (result.platform === 'linux' ? 'dolphin' : 'filezilla');
  $('executable').value = result.settings.executable || '';
  await action(detect);
  renderStatus();
}
let polling = false;
setInterval(async () => {
  if (polling) return; polling = true;
  try {
    state = await api('/api/status'); renderStatus(); await renderDownloads();
    if (pollError) {pollError = false; notice(connected ? 'Connected to ' + connectionHost : 'Filesystem service is available.');}
    if (state.mode === 'storage' && state.status === 'ready' && lastStorageLease !== state.lease) {lastStorageLease = state.lease; await browse(sessionStorage.getItem('storagePath') || '/').catch(() => browse('/')); }
  } catch (error) {pollError = true; notice(error.message);} finally {polling = false;}
}, 1000);
init().catch(error => notice(error.message));
