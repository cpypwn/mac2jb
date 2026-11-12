// Runs the app's GPU probe in headless Chrome via a 16-bit autotest plan against the mock console.
import { spawn } from 'node:child_process'; import { createServer } from 'node:http'; import { readFile } from 'node:fs/promises'; import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = createServer(async (req, res) => { try { res.end(await readFile(path.join(root, decodeURIComponent(req.url.split('?')[0])))); } catch { res.statusCode = 404; res.end(); } }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${process.argv[2]}`, '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise(res => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = b.match(/ws:\/\/[^\s]+/); if (m) res(m[0]); }); });
const list = await (await fetch(wsUrl.replace('ws://', 'http://').replace(/\/devtools.*/, '/json'))).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/bench/preview-autotest.html?f16=1${process.argv[3] ? '&' + process.argv[3] + '=1' : ''}` });
let title = ''; for (let i = 0; i < 300 && !/CLOSED|FAILED/.test(title); i++) { await new Promise(r => setTimeout(r, 200)); title = await ev('document.title'); }
const log = JSON.parse(await ev('new TextDecoder().decode(__mock.files.get("save:/civhomebrew/data/sw2nes/autotest-log.json")||new Uint8Array())') || 'null');
console.log(JSON.stringify({ title, live: await ev('__mock.live'), errors: await ev('__mock.errors'), gpu: log && log.gpu, bench: log && log.runs.map(r => r.bench), runErrors: log && log.runs.map(r => r.error || null) }, null, 1));
ws.close(); chrome.kill(); server.close();
