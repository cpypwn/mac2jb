const http = require('node:http'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { redact } = require('../core/session/ledger.cjs');
async function createWindowServer({
  root,
  manager,
  port,
  token = crypto.randomBytes(24).toString('hex'),
}) {
  let actualPort,
    mutation = Promise.resolve(),
    mutationEpoch = 0;
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/icon.svg': ['icon.svg', 'image/svg+xml'],
  };
  const reply = (res, status, value) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(value));
  };
  async function readBody(req) {
    let size = 0,
      chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw Error('Request is too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const origin = 'http://127.0.0.1:' + actualPort;
    try {
      if (req.headers.host !== '127.0.0.1:' + actualPort)
        return reply(res, 403, { error: 'Use the local application address' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/health')
        return reply(res, 200, {
          version: 16,
          pid: process.pid,
          preview: manager.preview === true,
        });
      if (req.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        res.writeHead(200, { 'content-type': type });
        return res.end(await fs.readFile(path.join(root, 'panel/ui', name)));
      }
      if (req.headers['x-iz-key'] !== token)
        return reply(res, 403, {
          error: 'Reopen the application using its launch link',
        });
      if (req.method === 'GET' && url.pathname === '/api/extensions')
        return reply(res, 200, {
          ...require('../core/extensions.cjs').catalog(root),
          modules: (
            await require('../core/modules.cjs').list(root)
          ).modules.map((m) => m.descriptor),
          moduleErrors: (await require('../core/modules.cjs').list(root))
            .errors,
        });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        manager.refresh().catch(() => {});
        return reply(res, 200, await manager.snapshot());
      }
      if (req.method === 'GET' && url.pathname === '/api/loader-source') {
        const source = await manager.source(url.searchParams.get('id'));
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename=' + source.name + '.bas',
        });
        return res.end(await fs.readFile(source.file));
      }
      if (req.method === 'GET' && url.pathname === '/api/input-package') {
        const file=await require('../hardware/agents.cjs').archive(root);
        res.writeHead(200,{'content-type':'application/gzip','content-disposition':'attachment; filename="iz2s-arm-input.tar.gz"'});
        return res.end(await fs.readFile(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/setup-report')
        return reply(res, 200, {
          text: await manager.setupReport(url.searchParams.get('id')),
        });
      if (req.method === 'GET' && url.pathname === '/api/log')
        return reply(res, 200, {
          events: await manager.historyLog(url.searchParams.get('id')),
        });
      if (req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
      if (req.headers.origin !== origin)
        return reply(res, 403, {
          error: 'The request must come from this application',
        });
      const body = await readBody(req);
      // Emergency stop must bypass a blocked ordinary mutation queue.
      if (url.pathname === '/api/hard-stop') {
        require('../core/host-modules.cjs').hardStop();
        const result = await manager.hardStop();
        mutationEpoch++;
        mutation = Promise.resolve();
        return reply(res, 200, result);
      }
      if (url.pathname === '/api/stop') {
        await require('../core/host-modules.cjs').close();
        await manager.stop();
        return reply(res, 200, { ok: true });
      }
      const ownEpoch = mutationEpoch;
      const task = async () => {
        if (ownEpoch !== mutationEpoch)
          throw Error('Request cancelled by STOP');
        if (url.pathname === '/api/folder/open') {
          if (manager.preview) throw Error('Preview cannot open local folders');
          return require('../core/desktop-folders.cjs').open(root, body);
        }
        if (url.pathname === '/api/module/start') {
          if (manager.preview) throw Error('Preview cannot execute modules');
          const current = (await manager.snapshot()).active;
          const session = current?.runDirectory
            ? { directory: current.runDirectory }
            : null;
          return require('../core/host-modules.cjs').start(root, body.id, {
            session,
          });
        }
        if (url.pathname === '/api/module/stop')
          return require('../core/host-modules.cjs').stop(body.id);
        if (url.pathname === '/api/install-host')
          return require('../core/modules.cjs').install(root, body.id, {source:body.source});
        if (url.pathname === '/api/engine/install')
          return manager.installEngine(body.id);
        if (url.pathname === '/api/engine/rescan')
          return manager.rescanEngine();
        if (url.pathname === '/api/launch-settings')
          return manager.configureLaunch(body);
        if (url.pathname === '/api/input/install') return manager.installInput(body);
        if (url.pathname === '/api/hardware/open') return manager.openHardwareApp();
        if (url.pathname === '/api/check') return manager.refresh(true);
        if (url.pathname === '/api/connection')
          return manager.configureConnection(body);
        if (url.pathname === '/api/start') return manager.begin(body);
        if (url.pathname === '/api/setup') return manager.setupAction(body);
        if (url.pathname === '/api/retry') return manager.retry();
        if (url.pathname === '/api/load') {
          await manager.loadPackages(body.ids);
          return { ok: true };
        }
        if(url.pathname==='/api/unload'){
          if(manager.preview)throw Error('Preview cannot remove console modules');
          await manager.unloadPackages(body.ids);
          return {ok:true};
        }
        if (url.pathname === '/api/delete') {
          await manager.remove(body.id);
          return { ok: true };
        }
        if (url.pathname === '/api/dismiss') {
          manager.dismiss();
          return { ok: true };
        }
        throw Error('Unknown action');
      };
      const result = mutation.then(task);
      mutation = result.catch(() => {});
      reply(res, 200, await result);
    } catch (e) {
      reply(res, 400, { error: redact(e.message).slice(0, 1200) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve();
    });
  });
  return {
    server,
    token,
    url: 'http://127.0.0.1:' + actualPort + '/#' + token,
    close: () => new Promise((r) => server.close(r)),
  };
}
module.exports = { createWindowServer };
