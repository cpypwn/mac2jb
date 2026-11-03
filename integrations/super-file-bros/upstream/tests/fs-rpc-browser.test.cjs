const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const net = require('node:net');
const managers = require('../tools/fs-rpc-browser/file-managers.cjs');

test('Windows/macOS/Linux file manager commands preserve one literal URL and never invoke a shell', async () => {
  const url = 'ftp://10.42.0.20:2123/';
  assert.deepEqual(managers.command({manager: 'dolphin', url}, 'linux'), ['dolphin', [url]]);
  assert.deepEqual(managers.command({manager: 'finder', url}, 'darwin'), ['/usr/bin/open', ['-a', 'Finder', url]]);
  assert.deepEqual(managers.command({manager: 'custom', executable: 'C:\\Apps With Spaces\\client.exe', url}, 'win32'), ['C:\\Apps With Spaces\\client.exe', [url]]);
  let options;
  await managers.open({manager: 'custom', executable: '/apps/client;literal', url}, {platform: 'linux', launch: (program, args, settings) => {
    assert.equal(program, '/apps/client;literal'); assert.deepEqual(args, [url]); options = settings;
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  }});
  assert.equal(options.shell, false);
  assert.throws(() => managers.command({manager: 'filezilla', url: 'file:///etc/passwd'}), /FTP URL/);
  assert.throws(() => managers.command({manager: 'filezilla', url: 'ftp://secret:password@10.42.0.20/'}), /anonymous FTP/);
});

test('portable API protects actions and forwards the selected storage mode and live FTP URL', async t => {
  const calls = [], opened = [];
  const app = await require('../tools/fs-rpc-browser/server.cjs').create({backend: {request: async (method, values) => {
    calls.push({method, values}); return {status: 'ready', url: 'ftp://10.42.0.20:2124/'};
  }}, openManager: async value => {opened.push(value); return {ok: true};}});
  t.after(async () => {app.server.closeAllConnections(); await app.close();});
  const url = new URL(app.url);
  const post = (route, data, headers = {}) => fetch(url.origin + route, {method: 'POST', headers, body: JSON.stringify(data)});
  assert.equal((await post('/api/start', {mode: 'storage'})).status, 403);
  const headers = {'x-fs-key': app.token, origin: url.origin};
  assert.equal((await post('/api/start', {mode: 'storage'}, headers)).status, 200);
  assert.equal(calls.at(-1).method, 'start-storage');
  assert.equal((await post('/api/start', {mode: 'storage'}, {...headers, origin: 'https://unrelated.example'})).status, 403);
  // Opening also stores preferences; substitute a read-only mock through command
  // tests above rather than writing a real profile during this API test.
  assert.equal(opened.length, 0);
});

test('the dependency-free FTP probe handles multiline greetings and passive directory data', async t => {
  const sockets = new Set(); let dataServer;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('220-Test server\r\n220 Ready\r\n'); let input = '', dataSocket;
    socket.on('data', bytes => {
      input += bytes;
      while (input.includes('\n')) {
        const at = input.indexOf('\n'), command = input.slice(0, at).trim(); input = input.slice(at + 1);
        if (command.startsWith('USER')) socket.write('331 Password\r\n');
        else if (command.startsWith('PASS')) socket.write('230 Logged in\r\n');
        else if (command === 'PASV') {
          dataServer = net.createServer(peer => {dataSocket = peer; sockets.add(peer); peer.on('close', () => sockets.delete(peer));});
          dataServer.listen(0, '127.0.0.1', () => {
            const port = dataServer.address().port;
            socket.write(`227 Passive (203,0,113,3,${port >> 8},${port & 255})\r\n`);
          });
        } else if (command === 'LIST /') {
          socket.write('150 Data\r\n'); dataSocket.end('dr-xr-xr-x 1 ftp ftp 0 Jan 01 1970 sd\r\n');
          dataSocket.once('close', () => {dataServer.close(); socket.write('226 Done\r\n');});
        } else if (command === 'QUIT') socket.end('221 Bye\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {for (const s of sockets) s.destroy(); dataServer?.close(); await new Promise(resolve => server.close(resolve));});
  const listing = await require('../tools/dolphin-fs-rpc/ftp-client.cjs').listing('127.0.0.1', server.address().port);
  assert.match(listing[0], / sd$/);
});

test('read-only filesystem FTP rejects every mutating command before reaching storage', async () => {
  let accepted = false, input = null; const output = [];
  const server = require('../core/console/host/ftp-server.cjs').create({readOnly: true, greeting: 'Read-only test',
    transport: {address: async () => '127.0.0.1', listen: async port => ({fd: 1, port}),
      accept: async () => {if (accepted) return null; accepted = true; return {fd: 2, peer: '127.0.0.1'};},
      recv: async () => {const bytes = input; input = null; return bytes;},
      send: async (fd, bytes) => {output.push(bytes.toString()); return bytes.length;}, close: async () => {}},
    storage: new Proxy({}, {get: () => () => {throw Error('Storage must not be called');}})});
  await server.start(5000); await server.pump();
  for (const line of ['USER anonymous', 'PASS x', 'STOR /sd/a', 'APPE /sd/a', 'DELE /sd/a', 'RMD /sd/a', 'MKD /sd/a', 'RNFR /sd/a', 'RNTO /sd/b']) {
    input = Buffer.from(line + '\r\n'); await server.pump(); await server.pump();
  }
  await server.stop();
  assert.match(output.join(''), /220 Read-only test/);
  assert.equal((output.join('').match(/550 Read-only filesystem export/g) || []).length, 7);
});
test('automatic folder detection can fill a path before an IPv4 is configured without starting a service',async t=>{
 let serviceCalls=0;
 const app=await require('../tools/fs-rpc-browser/server.cjs').create({backend:{request:async()=>{serviceCalls++;throw Error('Must not start');}},discover:async()=>({run:'/found/ns2jb/runs/switch2-active',host:'',source:'detected'})});
 t.after(async()=>{app.server.closeAllConnections();await app.close();});
 const url=new URL(app.url);
 const response=await fetch(url.origin+'/api/detect',{method:'POST',headers:{origin:url.origin,'x-fs-key':app.token},body:'{}'});
 assert.equal(response.status,200);const result=await response.json();assert.equal(result.needsHost,true);assert.equal(result.connection.run,'/found/ns2jb/runs/switch2-active');assert.equal(serviceCalls,0);
});
