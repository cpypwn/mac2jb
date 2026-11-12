// Drives bench/preview.html in headless Chrome over CDP and saves screenshots.
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
  `--user-data-dir=${out}/profile`, '--window-size=1280,720', '--autoplay-policy=no-user-gesture-required', ...(process.env.JITLESS ? ['--js-flags=--jitless'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
await send('Page.navigate', { url: `http://127.0.0.1:${port}/bench/${page}` });
const results = {};
for (let i = 0; i < 50 && !(await evaluate('window.__civswitchApp && window.__civswitchApp.getState().mode')); i++) await sleep(100);
results.initial = await evaluate('window.__civswitchApp.getState()');
await shot('1-browser');
await key('x'); await sleep(1200);                 // A: start the game
results.afterStart = await evaluate('window.__civswitchApp.getState()');
for (let i = 0; i < 6; i++) { await key('Enter'); await sleep(500); } // Start through title screens
await sleep(1500); await shot('2-game');
if (process.env.CRT) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200);
  for (let i = 0; i < 9; i++) await key('ArrowDown'); await key('x'); await key('z'); await sleep(600); await shot('2b-crt'); results.crtMenuOk = true; }
if (process.env.MOTION) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200);
  for (let i = 0; i < 10; i++) await key('ArrowDown'); await key('x'); await key('z'); await sleep(700); await shot('2c-motion'); }
if (process.env.PERF) {
  { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200);
    for (let i = 0; i < 5; i++) await key('ArrowDown'); for (let i = 0; i < 3; i++) await key('x'); await key('z'); await sleep(400); } // stats are off by default: Full + graph
  const openMenu = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200); };
  results.speed = [];
  for (let i = 0; i < 6; i++) { await sleep(1500); results.speed.push(await evaluate(`[...document.querySelectorAll('#sw2nes div')].find(d=>d.style.fontFamily.indexOf('Courier')>=0).textContent`)); }
}
if (process.env.GRAPHCHECK) results.graphPixels = await evaluate(`(function(){var m=window.__mock;if(!m||!m.lastPixels)return null;var d=m.lastPixels,n=d.length/4,line=0,ref=0,bg=0,other=0;for(var i=0;i<d.length;i+=4){var r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];if(r===0x6e&&g===0xe2&&b===0x6e&&a===255)line++;else if(r===0x55&&g===0x55&&b===0x55&&a===0x99)ref++;else if(r===0&&g===0&&b===0&&a===0x99)bg++;else other++;}var art=[];for(var y=0;y<60;y+=3){var row="";for(var x=0;x<360;x+=4){var c=" ";for(var dy=0;dy<3;dy++)for(var dx=0;dx<4;dx++){var j=((y+dy)*360+x+dx)*4;if(d[j+1]===0xe2)c="#";else if(c===" "&&d[j]===0x55)c="-";}row+=c;}art.push(row);}return {pixels:n,line:line,ref:ref,bg:bg,other:other,art:art};})()`);
results.pixels = await evaluate(`(function(){var c=document.querySelector('#sw2nes canvas');var d=c?c.getContext('2d').getImageData(0,0,c.width,c.height).data:window.__mock.lastPixels;if(!c)c={width:256,height:d.length/1024};var s=new Set();for(var i=0;i<d.length;i+=4)s.add((d[i]<<16)|(d[i+1]<<8)|d[i+2]);return {w:c.width,h:c.height,colors:s.size};})()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' });
await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200);
results.menu = await evaluate('window.__civswitchApp.getState()'); await shot('3-menu');
await key('x'); await sleep(400);                   // Resume
await key('q', 1); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200);
await key('ArrowDown'); await key('x'); await sleep(400); // Save state
results.toastAfterSave = await evaluate(`[...document.querySelectorAll('#sw2nes div')].filter(d=>d.style.bottom==='28px')[0].textContent`);
for (let k = 0; k < 2; k++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' }); await sleep(200); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); await sleep(200);
  if (k === 0) { await key('ArrowDown'); await key('ArrowDown'); await key('x'); await sleep(500); results.toastAfterLoad = await evaluate(`[...document.querySelectorAll('#sw2nes div')].filter(d=>d.style.bottom==='28px')[0].textContent`); } }
for (let i = 0; i < 14; i++) await key('ArrowDown');
await key('x'); await sleep(400);                   // Quit game
results.afterQuit = await evaluate('window.__civswitchApp.getState()');
await key('z'); await sleep(400);                   // B: asks for confirmation
results.afterFirstB = await evaluate('document.title !== "CLOSED" && window.__civswitchApp ? [...document.querySelectorAll("#sw2nes div")].map(d=>d.textContent).find(t=>t==="Confirm exit") || "no prompt" : "exited"'); await shot('4-exit-prompt');
await key('z'); await sleep(500);                   // B again: exit app
results.title = await evaluate('document.title');
results.appRemoved = await evaluate('!document.getElementById("sw2nes") && !window.__civswitchApp');
results.logs = logs;
results.mock = await evaluate(`window.__mock ? (function(m){return {live:m.live,mallocs:m.mallocs,frees:m.frees,errors:m.errors,presents:m.presents,audioAppended:m.audioAppended,audioStarted:m.audioStarted,commits:m.commits,files:[...m.files.keys()].map(k=>k+' '+m.files.get(k).length),dirs:[...m.dirs],calls:m.calls};})(window.__mock) : null`);
console.log(JSON.stringify(results, null, 1));
ws.close(); chrome.kill(); server.close();
