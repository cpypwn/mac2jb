#!/usr/bin/env node
// rebuild ftp native code. linux only
// bit weird to have it as a node script but this lets me call it from other code :)
// ^ i now no longer do this to make the base tool a bit more compatible but i can't be bothered to rework this for windows
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function findTool(names) {
  for (const name of names) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const file = path.join(directory, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
  }
  throw new Error('Missing build tool: ' + names.join(' or '));
}

function main() {
  const directory = path.join(__dirname, 'oz-code');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2-ftp-build-'));
  try {
    const gcc = (() => { try { return findTool(['aarch64-linux-gnu-gcc']); } catch { return null; } })();
    const compiler = gcc || findTool(['clang']);
    const linker = gcc ? findTool(['aarch64-linux-gnu-ld']) : findTool(['ld.lld']);
    const objcopy = gcc ? findTool(['aarch64-linux-gnu-objcopy']) : findTool(['llvm-objcopy']);
    const common = [
        '-c',
        '-Os',
        '-ffreestanding',
        '-fno-builtin',
        '-fPIC',
        '-fno-stack-protector',
        '-fno-asynchronous-unwind-tables',
        '-fno-unwind-tables',
        '-fno-jump-tables',
        '-ffunction-sections',
        '-mgeneral-regs-only',
        '-mno-outline-atomics',
        '-Wall',
        '-Wextra',
        '-Werror',
    ];

    const object = path.join(temporary, 'native-civ7.o');
    const elf = path.join(temporary, 'native-civ7.elf');
    const binary = path.join(temporary, 'native-civ7.bin');
    execFileSync(compiler, [
      ...(!gcc ? ['--target=aarch64-linux-gnu'] : []),
      ...common,
      path.join(directory, 'native.c'),
      '-o', object,
    ], { stdio: 'inherit' });
    execFileSync(linker, ['-T', path.join(directory, 'layout-civ7.ld'), object, '-o', elf], {
      stdio: 'inherit',
    });

    execFileSync(objcopy, ['-O', 'binary', elf, binary], { stdio: 'inherit' });
    fs.copyFileSync(binary, path.join(directory, 'native-civ7.bin'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
