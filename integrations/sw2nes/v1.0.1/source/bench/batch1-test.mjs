// Tests the batch-1 features (errors, recent/favourites, palette, slots, per-game settings, player 2) with the native mock.
// Usage: node bench/ui-test.mjs OUT_DIR
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(process.argv[2] || 'shots'); const page = process.argv[3] || 'preview.html'; await mkdir(out, { recursive: true });
const server = createServer(async (req, res) => {
  try { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root)) throw 0;
    res.end(await readFile(p)); } catch { res.statusCode = 404; res.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const port = server.address().port;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${out}/profile`, `--window-size=${process.env.WINDOW || '1280,720'}`, '--autoplay-policy=no-user-gesture-required', ...(process.env.JITLESS ? ['--js-flags=--jitless'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = b.match(/ws:\/\/[^\s]+/); if (m) res(m[0]); }); setTimeout(() => rej(Error('no devtools')), 15000); });
const list = await (await fetch(wsUrl.replace('ws://', 'http://').replace(/\/devtools.*/, '/json'))).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(), logs = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails).slice(0, 600)); });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = async (k, hold = 120) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k }); await sleep(hold); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k }); await sleep(150); };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
if (process.env.THROTTLE) await send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
await send('Page.navigate', { url: `http://127.0.0.1:${port}/bench/preview-native.html` });
for (let i = 0; i < 80 && (await evaluate('window.__civswitchApp && window.__civswitchApp.getState().mode')) !== 'browser'; i++) await sleep(100);
const st = () => evaluate('window.__civswitchApp ? window.__civswitchApp.getState() : {mode: "app closed"}');
const visible = () => evaluate(`[...document.querySelectorAll('#sw2nes div')].filter(d=>d.offsetParent!==null && d.children.length===0).map(d=>d.textContent)`);
const optVal = name => evaluate(`(function(){var d=[...document.querySelectorAll('#sw2nes div')].find(e=>e.textContent===${JSON.stringify(name)}&&e.nextSibling);return d?d.nextSibling.textContent:null;})()`);
const combo = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(300); };
const menuTo = async idx => { await combo(); for (let i = 0; i < idx; i++) await key('ArrowDown'); };
const files = () => evaluate('[...__mock.files.keys()]');
const r = {};
// Move the list highlight to the named game (rows marked by their accent border).
const current = () => evaluate(`(function(){var rows=[...document.querySelectorAll('#sw2nes div')].filter(d=>d.style.borderLeft&&d.style.borderLeft.indexOf('4px solid')===0&&d.style.borderLeft.indexOf('transparent')<0&&d.offsetParent!==null);return rows.length?rows[0].textContent:null;})()`);
// Go up to the view tabs (from the list or the buttons), step into the list, then down to the game.
const selectRom = async name => { for (let i = 0; i < 50 && (await st()).focus !== 'tabs'; i++) await key('ArrowUp'); await key('ArrowDown'); for (let i = 0; i < 50; i++) { const c = await current(); if (c && c.indexOf(name) === 0) return true; await key('ArrowDown'); } return false; };
const message = () => evaluate(`(function(){var m=[...document.querySelectorAll('#sw2nes div')].find(d=>d.style.zIndex==='11');return m&&m.style.display!=='none'?m.textContent:'none';})()`);
// bad ROMs: mapper 16 header, and a non-ROM file
await evaluate(`(function(){var h=new Uint8Array(16+16384+8192);h.set([0x4e,0x45,0x53,0x1a,1,1,0x00,0x10]);__mock.files.set('save:/nes/Bad Mapper.nes',h);__mock.files.set('save:/nes/junk.nes',new TextEncoder().encode('hello'));})()`);
await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown'); await key('ArrowRight'); await key('x'); await sleep(800);   // Refresh button
r.listAfterRefresh = (await visible()).filter(t => /Chase|Mapper|junk/.test(t));
await selectRom('Bad Mapper'); await key('x'); await sleep(900); r.badMapperMsg = await message(); await key('x'); await sleep(300);
await selectRom('junk'); await key('x'); await sleep(900); r.junkMsg = await message(); await key('x'); await sleep(300);
await selectRom('Diamond Chase'); await key('x'); await sleep(1500); r.started = (await st()).running;
// palette -> Greyscale (5 steps) and check the presented frame is grey
const greyCheck = () => evaluate(`(function(){var d=__mock.lastPixels;if(!d)return null;var n=0,g=0;for(var i=0;i<d.length;i+=4){if(d[i]||d[i+1]||d[i+2]){n++;if(d[i]===d[i+1]&&d[i+1]===d[i+2])g++;}}return n?+(g/n).toFixed(3):null;})()`);
r.greyBefore = await greyCheck();
await menuTo(10); for (let i = 0; i < 5; i++) await key('x'); r.palette = await optVal('Palette'); await key('z'); await sleep(800); r.greyAfter = await greyCheck();
await menuTo(10); await key('x'); await key('z'); await sleep(300);   // back to Default
// slot 2 save
await menuTo(3); await key('x'); r.slotLabel = await optVal('Slot'); await key('z'); await sleep(200);
await menuTo(1); await key('x'); await sleep(500); r.saveToast = (await visible()).find(t => /slot/i.test(t)) || 'none';
r.slotFiles = (await files()).filter(f => /Diamond Chase\.(state|slots)/.test(f));
// favourite on
await menuTo(11); await key('x'); r.favourite = await optVal('Favourite'); await key('z'); await sleep(200);
// per-game settings: This game, then change CRT
await menuTo(12); await key('x'); r.settingsFor = await optVal('Settings for'); await key('z'); await sleep(300);
const crtBefore = await (async () => { await menuTo(9); const v = await optVal('CRT'); await key('x'); const v2 = await optVal('CRT'); await key('z'); await sleep(200); return [v, v2]; })();
r.crtChange = crtBefore;
// player 2
await evaluate('__mock.player2 = true; __mock.buttons2 = 1;'); await sleep(3500); r.p2 = await st();
// quit and look at the list + files
await menuTo(14); await key('x'); await sleep(600);
r.listTags = (await visible()).filter(t => /Chase|Favourite|Recent|Mapper|junk/.test(t));
r.gameSettingsFile = (await files()).filter(f => /settings/.test(f));
r.globalCrt = await evaluate(`JSON.parse(new TextDecoder().decode(__mock.files.get('save:/civhomebrew/data/sw2nes/settings.json'))).crt`);
r.perGameCrt = await evaluate(`(function(){var f=__mock.files.get('save:/civhomebrew/data/sw2nes/Diamond Chase.settings.json');return f?JSON.parse(new TextDecoder().decode(f)).crt:null;})()`);
// Game Genie: an uploaded .gg file appears in the Cheats list; a code typed in the editor is added and on
await evaluate(`__mock.files.set('save:/nes/Diamond Chase.gg', new TextEncoder().encode('SXIOPO Infinite lives\\nbadcode\\n'))`);
r.dbgBeforeSel = [await current(), (await st()).mode]; r.dbgSel = await selectRom('Diamond Chase'); await key('x'); await sleep(1500); r.dbgAfterStart = await st();
await menuTo(13); await key('x'); await sleep(300);
r.cheatsMenu = await evaluate(`[...document.querySelectorAll('#sw2nes div')].filter(d=>d.offsetParent!==null&&d.children.length===2).map(d=>d.children[0].textContent+(d.children[1].textContent?'='+d.children[1].textContent:''))`);
await key('x'); r.importedToggle = await optVal('SXIOPO  Infinite lives');
r.dbgCheatsMenu = r.cheatsMenu; await key('ArrowDown'); await key('x'); await sleep(300); r.editorOpen = (await evaluate('window.__civswitchApp ? window.__civswitchApp.getState().mode : "app closed"'));
const target = 'GOSSIP', L = 'APZLGITYEOXUKSVN';
for (let i = 0; i < 6; i++) { for (let k = 0; k < L.indexOf(target[i]); k++) await key('ArrowUp', 40); await key('ArrowRight'); }
r.editorInfo = await evaluate(`[...document.querySelectorAll('#sw2nes div')].find(d=>/^\\$/.test(d.textContent)&&d.offsetParent!==null).textContent`);
await key('x'); await sleep(400);
r.afterAdd = await evaluate(`[...document.querySelectorAll('#sw2nes div')].filter(d=>d.offsetParent!==null&&d.children.length===2).map(d=>d.children[0].textContent+(d.children[1].textContent?'='+d.children[1].textContent:''))`);
r.cheatsFile = await evaluate(`(function(){var f=__mock.files.get('save:/civhomebrew/data/sw2nes/Diamond Chase.cheats.json');return f?new TextDecoder().decode(f):null;})()`);
console.log(JSON.stringify({ r, logs }, null, 1));
ws.close(); chrome.kill(); server.close();
