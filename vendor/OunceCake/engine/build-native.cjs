#!/usr/bin/env node
/**
 * Rebuild the injected HTTP/WebDAV server (engine/oz-code/native.bin) with clang + lld.
 *
 * The payload is freestanding (no libc, no sysroot), so any host with an LLVM toolchain works:
 * macOS (Homebrew `llvm` + `lld`), Linux, or Windows. Tools are found via CC / LD / OBJCOPY /
 * READELF, then PATH, then the usual Homebrew prefixes.
 *
 * Usage: node engine/build-native.cjs [--out <path>]   (default: engine/oz-code/native.bin)
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SOURCE_DIRECTORY = path.join(__dirname, 'oz-code');
// Kept inside the repo (and gitignored) rather than in the OS temp dir so failed builds can be inspected.
const BUILD_DIRECTORY = path.join(SOURCE_DIRECTORY, '.build');
const SOURCES = ['native.c', 'vendor/picohttpparser/picohttpparser.c'];
const ENTRY_SYMBOL = 'server_main';

const HOMEBREW_PREFIXES = [
  '/opt/homebrew/opt/llvm/bin',
  '/opt/homebrew/opt/lld/bin',
  '/usr/local/opt/llvm/bin',
  '/usr/local/opt/lld/bin',
];

const TOOLS = {
  cc: { variable: 'CC', names: ['clang'] },
  ld: { variable: 'LD', names: ['ld.lld'] },
  objcopy: { variable: 'OBJCOPY', names: ['llvm-objcopy'] },
  readelf: { variable: 'READELF', names: ['llvm-readelf'] },
};

const COMPILE_FLAGS = [
  '--target=aarch64-none-elf',
  '-std=c11',
  '-c',
  '-Os',
  '-ffreestanding',
  // Also stops loop-idiom recognition from turning native.c's memcpy/memset loops into self-calls.
  '-fno-builtin',
  '-nostdlib',
  '-fPIC',
  '-fno-stack-protector',
  '-fno-asynchronous-unwind-tables',
  '-fno-unwind-tables',
  '-fno-jump-tables',
  '-ffunction-sections',
  '-fdata-sections',
  '-mgeneral-regs-only',
  '-mno-outline-atomics',
  '-Wall',
  '-Wextra',
  '-I',
  path.join(SOURCE_DIRECTORY, 'shim'),
];

// The image is copied to an arbitrary address and nobody applies relocations, so anything that
// needs one at load time (absolute pointers in data, GOT slots) would silently point at garbage.
const FORBIDDEN_RELOCATION = /R_AARCH64_(ABS64|ABS32|GLOB_DAT|RELATIVE|\w*GOT\w*)/;

/** Parse argv into options; only `--out <path>` is supported. */
function getArgs(argv) {
  let out = path.join(SOURCE_DIRECTORY, 'native.bin');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out = path.resolve(argv[++i]);
      continue;
    }
    throw new Error('Usage: node engine/build-native.cjs [--out <path>]');
  }
  return { out };
}

/** Find an executable by env override, PATH, then Homebrew prefixes. */
function findTool({ variable, names }) {
  if (process.env[variable]) return process.env[variable];
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directories = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...HOMEBREW_PREFIXES];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name + suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Could not find ${names.join(' / ')}. Install LLVM + lld (e.g. \`brew install llvm lld\`) or set ${variable}.`);
}

/** Run a tool, returning stdout as text. */
function run(tool, args) {
  return execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Reject objects containing relocations that would need fixing up at load time. */
function checkRelocations(readelf, objects) {
  for (const object of objects) {
    const bad = run(readelf, ['-r', '--wide', object])
      .split('\n')
      .filter((line) => FORBIDDEN_RELOCATION.test(line));
    if (bad.length) {
      throw new Error(`${path.basename(object)} needs load-time relocations:\n${bad.join('\n')}`);
    }
  }
}

/** The host jumps to the first byte of the image, so the entry point must be at address 0. */
function checkEntry(readelf, elf) {
  const symbol = run(readelf, ['-s', '--wide', elf])
    .split('\n')
    .find((line) => line.trim().endsWith(' ' + ENTRY_SYMBOL));
  const value = symbol && parseInt(symbol.trim().split(/\s+/)[1], 16);
  if (value !== 0) throw new Error(`${ENTRY_SYMBOL} is not at offset 0 (${symbol ? symbol.trim() : 'missing'})`);
}

function main(argv = process.argv.slice(2)) {
  const { out } = getArgs(argv);
  const tools = Object.fromEntries(Object.entries(TOOLS).map(([key, tool]) => [key, findTool(tool)]));
  fs.mkdirSync(BUILD_DIRECTORY, { recursive: true });

  const objects = SOURCES.map((source) => {
    const object = path.join(BUILD_DIRECTORY, path.basename(source, '.c') + '.o');
    run(tools.cc, [...COMPILE_FLAGS, path.join(SOURCE_DIRECTORY, source), '-o', object]);
    return object;
  });
  checkRelocations(tools.readelf, objects);

  const elf = path.join(BUILD_DIRECTORY, 'native.elf');
  run(tools.ld, ['-T', path.join(SOURCE_DIRECTORY, 'layout.ld'), '--gc-sections', '-static', ...objects, '-o', elf]);
  checkEntry(tools.readelf, elf);

  const binary = path.join(BUILD_DIRECTORY, 'native.bin');
  run(tools.objcopy, ['-O', 'binary', elf, binary]);
  fs.copyFileSync(binary, out);
  console.log(`Built ${out} (${fs.statSync(out).size} bytes)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
