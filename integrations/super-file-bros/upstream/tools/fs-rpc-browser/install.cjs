#!/usr/bin/env node
// User-level shortcuts reference this portable folder. No admin rights or downloads.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
function escapeDesktop(value) {return '"' + value.replace(/[\\"`$]/g, ch => '\\' + ch) + '"';}
function plan({platform = process.platform, home = os.homedir(), root = path.resolve(__dirname, '../..'), node = process.execPath, env = process.env} = {}) {
  if ([root, node, home].some(value => /[\0\r\n]/.test(value))) throw Error('Unsupported shortcut path');
  if (platform === 'win32') {
    const target = path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Super File Bros.cmd');
    const quoted = value => '"' + value.replaceAll('%', '%%') + '"';
    if ([root,node].some(value=>value.includes('"'))) throw Error('Unsupported shortcut path');
    return [{path: target, text: '@echo off\r\nchcp 65001 >nul\r\ncd /d ' + quoted(root) + '\r\n' + quoted(node) + ' ' + quoted(path.join(root, 'start.cjs')) + '\r\nif errorlevel 1 pause\r\n', mode: 0o644}];
  }
  if (platform === 'darwin') {
    const bundle = path.join(home, 'Applications/Super File Bros.app/Contents');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    return [{path: path.join(bundle, 'Info.plist'), text: '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Super File Bros.</string><key>CFBundleIdentifier</key><string>local.super-file-bros</string><key>CFBundleExecutable</key><string>launch</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>', mode: 0o644},
      {path: path.join(bundle, 'MacOS/launch'), text: '#!/bin/sh\ncd ' + quote(root) + '\nexec ' + quote(node) + ' ' + quote(path.join(root, 'start.cjs')) + ' >> ' + quote(path.join(root, 'super-file-bros.log')) + ' 2>&1\n', mode: 0o755}];
  }
  if (platform !== 'linux') throw Error('Use node start.cjs on this platform');
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local/share');
  // Desktop Exec has its own escaping rules; literal percent signs must be doubled.
  const command = [node, path.join(root, 'start.cjs')].map(value => escapeDesktop(value.replaceAll('%', '%%'))).join(' ');
  return [{path: path.join(data, 'applications/super-file-bros.desktop'), text: '[Desktop Entry]\nType=Application\nName=Super File Bros.\nComment=Switch 2 file manager\nExec=' + command + '\nTerminal=true\nCategories=Utility;FileManager;\n', mode: 0o755}];
}
async function main() {
  require('./requirements.cjs').check();
  const files = plan();
  for (const file of files) {await fs.mkdir(path.dirname(file.path), {recursive: true}); await fs.writeFile(file.path, file.text, {mode: file.mode}); await fs.chmod(file.path, file.mode);}
  console.log('Super File Bros. shortcut installed:\n' + files.map(file=>file.path).join('\n') + '\nKeep this portable folder in its current location.');
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {plan, main};
