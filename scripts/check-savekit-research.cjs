'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const prefix = 'vendor/ns2-savekit/research';
const sourceExtensions = new Set(['.cjs', '.py', '.sh', '.command', '.swift', '.ino']);

function check(condition, message) {
  if (!condition) throw Error(message);
}

function regularFile(root, relative) {
  const parts = relative.split('/');
  check(parts.length > 0 && parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\')),
    'Invalid research path: ' + relative);
  const file = path.join(root, ...parts);
  const info = fs.lstatSync(file);
  check(info.isFile() && !info.isSymbolicLink(), 'Research file is missing or is not regular: ' + relative);
  const resolved = fs.realpathSync(file);
  check(resolved.startsWith(fs.realpathSync(root) + path.sep), 'Research file escapes the runtime: ' + relative);
  return file;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourcePaths(base) {
  const found = new Set();
  function scan(folder, relative) {
    for (const item of fs.readdirSync(folder, {withFileTypes: true})) {
      if (item.name === 'lib' && (relative === 'tools' || relative === 'current/tools')) continue;
      const next = relative + '/' + item.name;
      const file = path.join(folder, item.name);
      check(!item.isSymbolicLink(), 'Research source is a symbolic link: ' + next);
      if (item.isDirectory()) scan(file, next);
      else if (item.isFile() && (sourceExtensions.has(path.extname(item.name)) || next === 'tools/vision/ocr')) {
        found.add(next);
      }
    }
  }
  for (const prefix of ['', 'current/']) {
    scan(path.join(base, prefix, 'tools'), prefix + 'tools');
    for (const item of fs.readdirSync(path.join(base, prefix, 'payloads'), {withFileTypes: true})) {
      if (item.name.endsWith('.lua')) {
        check(item.isFile() && !item.isSymbolicLink(), 'Invalid research payload: ' + item.name);
        found.add(prefix + 'payloads/' + item.name);
      }
    }
    found.add(prefix + 'patches/apply.sh');
  }
  return found;
}

function audit(root) {
  const base = path.join(root, prefix);
  const catalogFile = regularFile(root, prefix + '/catalog.json');
  const contents = fs.readFileSync(catalogFile);
  check(contents.length <= 256 * 1024, 'Research catalog is too large.');
  const catalog = JSON.parse(contents);
  check(catalog && Array.isArray(catalog.tools) && catalog.tools.length > 0 && catalog.tools.length <= 128,
    'Invalid research catalog.');
  const listed = new Set();
  for (const item of catalog.tools) {
    check(item && typeof item.path === 'string' && item.path.length < 256 &&
      typeof item.category === 'string' && item.category.length > 0 &&
      typeof item.name === 'string' && item.name.length > 0,
    'Invalid research catalog entry.');
    check(!listed.has(item.path), 'Duplicate research catalog path: ' + item.path);
    listed.add(item.path);
    regularFile(root, prefix + '/' + item.path);
  }
  const discovered = sourcePaths(base);
  for (const relative of discovered) {
    check(listed.has(relative), 'Research source is missing from catalog: ' + relative);
    regularFile(root, prefix + '/' + relative);
  }
  for (const relative of listed) {
    check(discovered.has(relative), 'Research catalog path is outside source scope: ' + relative);
  }
  return {catalogFile, listed};
}

function main(args) {
  check(args.length === 0 || args.length === 2 || args.length === 4,
    'usage: check-savekit-research.cjs [--root RUNTIME_ROOT] [--compare SOURCE_ROOT]');
  let root = process.cwd();
  let compare = null;
  for (let index = 0; index < args.length; index += 2) {
    check(args[index] === '--root' || args[index] === '--compare', 'Unknown research check option.');
    check(typeof args[index + 1] === 'string' && path.isAbsolute(args[index + 1]),
      'Research check roots must be absolute paths.');
    if (args[index] === '--root') root = args[index + 1];
    else compare = args[index + 1];
  }
  const packaged = audit(root);
  if (compare) {
    const source = audit(compare);
    check(digest(packaged.catalogFile) === digest(source.catalogFile), 'Packaged research catalog differs from source.');
    for (const relative of source.listed) {
      const name = prefix + '/' + relative;
      check(digest(regularFile(root, name)) === digest(regularFile(compare, name)),
        'Packaged research file differs from source: ' + relative);
    }
  }
  console.log('SaveKit research catalog: ' + packaged.listed.size + ' source tools verified.');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error('SaveKit research catalog check failed: ' + error.message);
  process.exitCode = 1;
}
