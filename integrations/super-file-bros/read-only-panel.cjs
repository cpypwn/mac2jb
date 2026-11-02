'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function waitForDrain(response) {
  if (response.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained);
      response.off('close', closed);
      response.off('error', failed);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    response.once('drain', drained);
    response.once('close', closed);
    response.once('error', failed);
    if (response.destroyed) closed();
  });
}

function checkedPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/sd') ||
      value !== '/sd' && !value.startsWith('/sd/') ||
      /[\x00-\x1f\x7f\\:]/.test(value) ||
      value.split('/').some(part => part === '.' || part === '..') ||
      Buffer.byteLength(value) > 740) throw Error('Choose a path under /sd');
  return value;
}

async function createPanel(storage, {ftpURL = '', token = crypto.randomBytes(32).toString('hex')} = {}) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid local panel key');
  const tickets = new Map();
  let origin, closed = false, active = 0, idle;
  const sendJSON = (res, status, value) => {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(value));
  };
  const asset = {
    '/': ['panel.html', 'text/html; charset=utf-8'],
    '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
    '/panel.css': ['panel.css', 'text/css; charset=utf-8']
  };
  const server = http.createServer(async (req, res) => {
    active++;
    try {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      try {
        if (closed || req.headers.host !== new URL(origin).host) return sendJSON(res, 403, {error: 'Use the local panel address'});
        const url = new URL(req.url, origin);
        if (req.method === 'GET' && asset[url.pathname]) {
          const [name, type] = asset[url.pathname];
          res.writeHead(200, {'content-type': type});
          return res.end(await fs.readFile(path.join(__dirname, name)));
        }
        const download = /^\/download\/([a-f0-9]{48})$/.exec(url.pathname);
        if (req.method === 'GET' && download) {
          const ticket = tickets.get(download[1]);
          tickets.delete(download[1]);
          if (!ticket || Date.now() - ticket.at > 30000) return sendJSON(res, 404, {error: 'Download link expired'});
          const filePath = checkedPath(ticket.path);
          const stat = await storage.stat(filePath);
          if (stat.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size < 0)
            throw Error('The selected path is not a regular file');
          const file = await storage.openRead(filePath);
          try {
            const filename = path.posix.basename(filePath).replace(/[\x00-\x1f\x7f"\\]/g, '_');
            res.writeHead(200, {'content-type': 'application/octet-stream',
              'content-length': String(file.size),
              'content-disposition': 'attachment; filename="' + filename + '"'});
            for (let offset = 0; offset < file.size && !res.destroyed;) {
              const bytes = await storage.read(file, offset, Math.min(32768, file.size - offset));
              if (!bytes.length || bytes.length > 32768) throw Error('The SD download ended early');
              offset += bytes.length;
              if (!res.write(bytes)) await waitForDrain(res);
            }
            if (!res.destroyed) res.end();
          } finally { await storage.close(file); }
          return;
        }
        if (req.method !== 'POST' || !['/api/list', '/api/ticket'].includes(url.pathname))
          return sendJSON(res, 404, {error: 'Unknown read-only action'});
        if (req.headers.origin !== origin || req.headers['x-mac2jb-key'] !== token)
          return sendJSON(res, 403, {error: 'Open the private panel link from mac2jb'});
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) throw Error('Request is too large');
        }
        const input = JSON.parse(body || '{}');
        const filePath = checkedPath(input.path || '/sd');
        if (url.pathname === '/api/list') {
          const stat = await storage.stat(filePath);
          if (stat.type !== 'dir') throw Error('Choose an SD folder');
          const entries = await storage.list(filePath);
          return sendJSON(res, 200, {path: filePath,
            entries: entries.slice(0, 2048), truncated: entries.length > 2048, ftpURL});
        }
        const stat = await storage.stat(filePath);
        if (stat.type !== 'file') throw Error('Choose an SD file');
        if (tickets.size >= 128) throw Error('Too many pending SD downloads');
        const ticket = crypto.randomBytes(24).toString('hex');
        tickets.set(ticket, {path: filePath, at: Date.now()});
        for (const [key, value] of tickets) if (Date.now() - value.at > 30000) tickets.delete(key);
        return sendJSON(res, 200, {url: '/download/' + ticket});
      } catch (error) {
        if (res.destroyed) return;
        if (!res.headersSent) sendJSON(res, 400, {error: String(error.message).slice(0, 400)});
        else res.destroy(error);
      }
    } finally {
      active--;
      if (!active && idle) { idle(); idle = null; }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {url: origin + '/#' + token, origin, token,
    close: async () => {
      closed = true;
      tickets.clear();
      const done = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await done;
      if (active) await new Promise(resolve => { idle = resolve; if (!active) { idle = null; resolve(); } });
    }};
}

module.exports = {checkedPath, createPanel};
