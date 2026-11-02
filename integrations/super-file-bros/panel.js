'use strict';

const key = location.hash.slice(1);
const files = document.getElementById('files');
const message = document.getElementById('message');
const pathLabel = document.getElementById('path');
const ftp = document.getElementById('ftp');
let current = '/sd';

async function request(route, value) {
  const response = await fetch(route, {method: 'POST',
    headers: {'content-type': 'application/json', 'x-mac2jb-key': key},
    body: JSON.stringify(value)});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'The SD request failed');
  return result;
}

async function browse(target) {
  message.textContent = 'Reading ' + target;
  try {
    const result = await request('/api/list', {path: target});
    current = result.path;
    pathLabel.textContent = current;
    files.replaceChildren();
    if (result.ftpURL) { ftp.href = result.ftpURL; ftp.hidden = false; }
    else ftp.hidden = true;
    for (const entry of result.entries) {
      const row = document.createElement('div'); row.className = 'file';
      const text = document.createElement('div'); text.className = 'name';
      const name = document.createElement('strong'); name.textContent = entry.name;
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = entry.type === 'dir' ? 'folder' : entry.size.toLocaleString() + ' bytes';
      text.append(name, meta);
      const action = document.createElement('button');
      const targetPath = current + (current.endsWith('/') ? '' : '/') + entry.name;
      action.textContent = entry.type === 'dir' ? 'open' : 'download';
      action.onclick = async () => {
        if (entry.type === 'dir') return browse(targetPath);
        try {
          const ticket = await request('/api/ticket', {path: targetPath});
          const link = document.createElement('a'); link.href = ticket.url;
          document.body.append(link); link.click(); link.remove();
          message.textContent = 'Downloading ' + entry.name;
        } catch (error) { message.textContent = error.message; }
      };
      row.append(text, action); files.append(row);
    }
    message.textContent = result.truncated ? 'Showing the first 2,048 entries' :
      result.entries.length ? result.entries.length + ' entries' : 'This folder is empty';
  } catch (error) {message.textContent = error.message;}
}

document.getElementById('up').onclick = () => browse(current === '/sd' ? '/sd' :
  current.slice(0, current.lastIndexOf('/')) || '/sd');
document.getElementById('refresh').onclick = () => browse(current);
browse('/sd');
