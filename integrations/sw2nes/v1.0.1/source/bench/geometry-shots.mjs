// Screenshots SMB in each aspect/scale/crop setting (needs bench/smb-local.nes). WINDOW=WxH sets the viewport.
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
await send('Page.navigate', { url: `http://127.0.0.1:${port}/bench/preview.html?smb` });
for (let i = 0; i < 50 && !(await evaluate('window.__civswitchApp && window.__civswitchApp.getState().mode')); i++) await sleep(100);
await key('ArrowDown'); await key('x'); await sleep(1500); await key('Enter'); await sleep(3500);
const combo = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(250); };
// menu: 6 Aspect, 7 Scale, 8 Crop. Start: 1:1, Integer, Sides.
const press = async (idx, n) => { await combo(); for (let i = 0; i < idx; i++) await key('ArrowDown'); for (let i = 0; i < n; i++) await key('x'); await key('z'); await sleep(400); };
const optVal = name => evaluate(`(function(){var d=[...document.querySelectorAll('#sw2nes div')].find(e=>e.textContent===${JSON.stringify(name)}&&e.nextSibling);return d?d.nextSibling.textContent.replace(/[\\u25c0\\u25b6]/g,'').trim():null;})()`);
const labels = async () => (await Promise.all(['Aspect','Scale','Crop','CRT'].map(async k => k + ': ' + await optVal(k)))).join(' | ');
const steps = [['1-default', []], ['2-crop-all', [[8, 1]]], ['3-crop-none', [[8, 1]]], ['4-crop-sides', [[8, 1]]], ['5-4x3', [[6, 1]]], ['6-stretch', [[6, 1]]], ['7-1x1', [[6, 1]]]];
const res = [];
for (const [name, acts] of steps) { for (const [idx, n] of acts) await press(idx, n); await combo(); res.push(name + ': ' + await labels() + ' || ' + await evaluate(`innerWidth+'x'+innerHeight+' wrap '+[...document.querySelectorAll('#sw2nes canvas')].map(c=>c.parentNode.style.cssText).join(' / ')`)); await key('z'); await sleep(400); await shot(name); }
console.log(JSON.stringify({ res, logs }));
ws.close(); chrome.kill(); server.close();
