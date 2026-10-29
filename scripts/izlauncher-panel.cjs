'use strict';
const fs = require('node:fs');
const path = require('node:path');

function readPanel(root, candidate) {
  const runs = fs.realpathSync(path.join(root, 'runs'));
  const directory = path.resolve(candidate);
  const run = fs.lstatSync(directory);
  if (path.dirname(directory) !== runs || !/^izlauncher-[A-Za-z0-9_-]+$/.test(path.basename(directory)) ||
      !run.isDirectory() || run.isSymbolicLink() || run.uid !== process.getuid() ||
      (run.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory)
    throw Error('Invalid IZlauncher run directory.');
  const file = path.join(directory, 'pc-screen-local.json');
  let info;
  try {info = fs.lstatSync(file);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 || info.size > 4096 || fs.realpathSync(file) !== file)
    throw Error('Invalid local panel report.');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const match = typeof report?.url === 'string' &&
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/#([a-f0-9]{48})$/.exec(report.url);
  if (!match || Number(match[1]) > 65535 || report.port !== Number(match[1]))
    throw Error('Invalid local panel address.');
  return {path: directory, url: report.url};
}

function verifyPanelEvent(root, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.path !== 'string' || typeof event.url !== 'string')
    throw Error('Invalid IZlauncher panel event.');
  const panel = readPanel(root, event.path);
  if (!panel || panel.url !== event.url || panel.path !== event.path)
    throw Error('The IZlauncher panel address does not match the active run.');
  return panel;
}

module.exports = {readPanel, verifyPanelEvent};
