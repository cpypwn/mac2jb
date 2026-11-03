#!/usr/bin/env node
'use strict';
// CLI for the Artemis HTTP transport (no ns2jb RPC session).
//
//   node tools/artemis-http.cjs status   --host <ip>
//   node tools/artemis-http.cjs health   --host <ip>
//   node tools/artemis-http.cjs eval     --host <ip> (--code '...' | --file x.lua)
//   node tools/artemis-http.cjs stat     --host <ip> --path save:/name
//   node tools/artemis-http.cjs get      --host <ip> --path save:/name --out file [--sha256 H] [--size N]
//   node tools/artemis-http.cjs put      --host <ip> --path save:/name --in file [--force] [--atomic]
//   node tools/artemis-http.cjs rm       --host <ip> --path save:/name
//   node tools/artemis-http.cjs backup   --host <ip> --out <dir> [--files a,b,c]
//   node tools/artemis-http.cjs probe    --host <ip>
//   node tools/artemis-http.cjs discover --subnet 192.168.1
//
// Exit codes: 0 ok, 2 usage, 3 connection, 4 timeout, 5 Lua error, 6 HTTP error,
// 7 integrity/size, 8 protocol, 9 protected/refused.
const fs = require('node:fs/promises');
const {
  ArtemisHttp, ArtemisHttpError, discover, anyName,
  SERVER_BODY_CAP, DEFAULT_CHUNK,
} = require('./transports/artemis-http.cjs');

const EXIT = {ok: 0, other: 1, usage: 2, connect: 3, timeout: 4, lua: 5,
  http: 6, integrity: 7, protocol: 8, refused: 9};

function usage(message) {
  if (message) console.error(message);
  process.exit(EXIT.usage);
}

function parse(argv) {
  const options = {_: []};
  const valued = new Set(['host', 'port', 'path', 'out', 'in', 'code', 'file', 'sha256',
    'size', 'chunk', 'files', 'subnet', 'timeout']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const name = token.slice(2);
    if (['json', 'force', 'atomic', 'no-resume', 'no-verify'].includes(name)) {
      options[name] = true; continue;
    }
    if (!valued.has(name)) usage('unknown option --' + name);
    const value = argv[++i];
    if (value === undefined) usage('--' + name + ' needs a value');
    options[name] = value;
  }
  return options;
}

function clientFor(options) {
  if (!options.host) usage('--host is required (or use discover)');
  return new ArtemisHttp({host: options.host, port: options.port ? Number(options.port) : undefined,
    timeout: options.timeout ? Number(options.timeout) : undefined});
}

function fail(error) {
  if (error instanceof ArtemisHttpError) {
    console.error('FAILED[' + error.code + ']: ' + error.message);
    const map = {ECONN: EXIT.connect, ETIMEDOUT: EXIT.timeout, ELUA: EXIT.lua,
      EHTTP: EXIT.http, ESIZE: EXIT.integrity, EHASH: EXIT.integrity,
      EPROTO: EXIT.protocol, EPROTECTED: EXIT.refused, EEXIST: EXIT.refused,
      ENOENT: EXIT.refused, ESTILL: EXIT.integrity, EPATH: EXIT.refused,
      EUSAGE: EXIT.usage, ERANGE: EXIT.usage, EATOMIC: EXIT.refused};
    process.exit(map[error.code] || EXIT.other);
  }
  console.error('FAILED: ' + (error && error.stack || error));
  process.exit(EXIT.other);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parse(rest);
  switch (command) {
    case 'status': {
      const client = clientFor(options);
      const status = await client.status();
      if (options.json) console.log(JSON.stringify(status, null, 2));
      else console.log(status.banner);
      return EXIT.ok;
    }
    case 'health': {
      const client = clientFor(options);
      const health = await client.health();
      if (options.json) console.log(JSON.stringify(health, null, 2));
      else {
        console.log('status   ' + health.status + '  ' + health.banner.split('\n')[0]);
        console.log('lua      ' + health.lua);
        console.log('platform ' + health.platform);
        console.log('engine   ' + health.engine);
      }
      return EXIT.ok;
    }
    case 'eval': {
      const client = clientFor(options);
      const code = options.code !== undefined ? options.code
        : options.file ? await fs.readFile(options.file, 'utf8') : null;
      if (code === null) usage('eval needs --code or --file');
      const parsed = await client.eval(code);
      if (options.json) console.log(JSON.stringify(parsed, null, 2));
      else {
        if (parsed.result !== null) console.log('result: ' + parsed.result);
        for (const line of parsed.output) console.log(line);
      }
      return EXIT.ok;
    }
    case 'stat': {
      const client = clientFor(options);
      if (!options.path) usage('stat needs --path');
      const stat = await client.stat(anyName(options.path).bare);
      if (options.json) console.log(JSON.stringify(stat, null, 2));
      else console.log(stat.exists ? 'present ' + stat.size + ' bytes' : 'absent');
      return EXIT.ok;
    }
    case 'get': {
      const client = clientFor(options);
      if (!options.path || !options.out) usage('get needs --path and --out');
      const got = await client.download(anyName(options.path).bare, {
        out: options.out,
        chunkSize: options.chunk ? Number(options.chunk) : DEFAULT_CHUNK,
        expectedSha256: options.sha256 || null,
        expectedSize: options.size ? Number(options.size) : null,
        resume: !options['no-resume'],
        onProgress: options.json ? null : (done, total) => {
          if (process.stderr.isTTY) process.stderr.write('\r' + done + '/' + total);
        },
      });
      if (process.stderr.isTTY) process.stderr.write('\n');
      if (options.json) console.log(JSON.stringify(got, null, 2));
      else console.log('downloaded ' + got.size + ' bytes -> ' + got.path + '  sha256 ' + got.sha256);
      return EXIT.ok;
    }
    case 'put': {
      const client = clientFor(options);
      if (!options.path || !options.in) usage('put needs --path and --in');
      const bytes = await fs.readFile(options.in);
      const got = await client.upload(anyName(options.path).bare, bytes, {
        overwrite: !!options.force,
        chunkSize: options.chunk ? Number(options.chunk) : undefined,
        atomic: !!options.atomic,
        verify: !options['no-verify'],
      });
      if (options.json) console.log(JSON.stringify(got, null, 2));
      else console.log('uploaded ' + got.size + ' bytes -> ' + got.path + '  sha256 ' + got.sha256 +
        (got.verified ? '  (remote read-back verified)' : '  (unverified)') +
        (got.atomic ? '  (atomic)' : ''));
      return EXIT.ok;
    }
    case 'rm': {
      const client = clientFor(options);
      if (!options.path) usage('rm needs --path');
      const gone = await client.remove(anyName(options.path).bare);
      if (options.json) console.log(JSON.stringify(gone, null, 2));
      else console.log('deleted ' + gone.path + '; read-back confirms absent');
      return EXIT.ok;
    }
    case 'backup': {
      const client = clientFor(options);
      if (!options.out) usage('backup needs --out');
      const files = options.files ? options.files.split(',') : null;
      const made = await client.backup(files, options.out);
      if (options.json) console.log(JSON.stringify(made.manifest, null, 2));
      else {
        console.log('explicit-file backup: ' + made.manifest.files + ' files, ' +
          made.manifest.bytes + ' bytes -> ' + made.dir);
        console.log('scope is ' + made.manifest.scope + '; complete=' + made.manifest.complete);
      }
      return EXIT.ok;
    }
    case 'probe': {
      const client = clientFor(options);
      const rename = await client.probeRename();
      // Direct /save caps at the server request body; larger transfers use
      // /eval appends (see docs/ARTEMIS-HTTP.md).
      console.log(JSON.stringify({rename, serverBodyCap: SERVER_BODY_CAP}, null, 2));
      return EXIT.ok;
    }
    case 'discover': {
      const found = await discover({subnet: options.subnet, port: options.port});
      if (options.json) console.log(JSON.stringify(found, null, 2));
      else if (!found.length) console.log('no Artemis server answered');
      else for (const hit of found) console.log(hit.host + '  ' + hit.banner.split('\n')[0]);
      return EXIT.ok;
    }
    default:
      usage('usage: artemis-http.cjs <status|health|eval|stat|get|put|rm|backup|probe|discover> ...');
  }
}

main().then(code => process.exit(code)).catch(fail);
