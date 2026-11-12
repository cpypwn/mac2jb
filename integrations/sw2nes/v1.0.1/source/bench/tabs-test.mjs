// Tests the All / Favourites / Recent list tabs (preview.html?many).
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
await send('Page.navigate', { url: `http://127.0.0.1:${port}/bench/preview.html?many` });
for (let i = 0; i < 50 && !(await evaluate('window.__civswitchApp && window.__civswitchApp.getState().mode')); i++) await sleep(100);
const st = () => evaluate('window.__civswitchApp.getState()');
const combo = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(300); };
const menuTo = async idx => { await combo(); for (let i = 0; i < idx; i++) await key('ArrowDown'); };
const current = () => evaluate(`(function(){var rows=[...document.querySelectorAll('#sw2nes div')].filter(d=>d.style.borderLeft&&d.style.borderLeft.indexOf('4px solid')===0&&d.style.borderLeft.indexOf('transparent')<0&&d.offsetParent!==null);return rows.length?rows[0].textContent:null;})()`);
const listed = () => evaluate(`[...document.querySelectorAll('#sw2nes div')].filter(d=>d.style.height==='40px'&&d.offsetParent!==null).map(d=>d.children[0].textContent)`);
const toTop = async () => { for (let i = 0; i < 50 && (await st()).focus !== 'tabs'; i++) await key('ArrowUp'); };   // ends on the tabs
const selectRom = async name => { await toTop(); await key('ArrowDown'); for (let i = 0; i < 45; i++) { const c = await current(); if (c && c.indexOf(name) === 0) return true; await key('ArrowDown'); } return false; };
const r = {};
await selectRom('Test Game 7'); await key('x'); await sleep(1200);
await menuTo(11); await key('x'); await key('z'); await sleep(200);          // Favourite: On
await menuTo(14); await key('x'); await sleep(500);                           // Quit
await selectRom('Test Game 3'); await key('x'); await sleep(1200); await menuTo(14); await key('x'); await sleep(500);
await toTop(); r.focusOnTabs = (await current()) === null;
r.all = (await listed()).slice(0, 4); await shot('tab-all');
await key('ArrowRight'); await sleep(200); r.favourites = await listed(); await shot('tab-favourites');
await key('ArrowRight'); await sleep(200); r.recent = await listed(); await shot('tab-recent');
await key('ArrowDown'); await sleep(200); r.downSelects = await current();
await key('x'); await sleep(1200); r.startedFromRecent = (await st()).running;
console.log(JSON.stringify({ r, logs }, null, 1));
ws.close(); chrome.kill(); server.close();
