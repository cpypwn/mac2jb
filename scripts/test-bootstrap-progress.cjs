#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');

test('native bootstrap line progress follows actual sender operations without USB hardware', async t => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-bootstrap-progress-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const harness = `
    #include <libusbd.h>
    #include <time.h>
    #include <stdio.h>
    #include <stdlib.h>
    static int mock_usb_write(libusbd_ctx_t*, uint8_t, uint64_t, const void*, uint32_t, uint64_t);
    static int mock_sleep(const struct timespec*, struct timespec*);
    #define libusbd_init(ctx) (*(ctx)=(libusbd_ctx_t*)1,0)
    #define libusbd_free(...) (0)
    #define libusbd_set_pid(...) (0)
    #define libusbd_set_version(...) (0)
    #define libusbd_set_class(...) (0)
    #define libusbd_set_subclass(...) (0)
    #define libusbd_set_protocol(...) (0)
    #define libusbd_set_manufacturer_str(...) (0)
    #define libusbd_set_product_str(...) (0)
    #define libusbd_set_serial_str(...) (0)
    #define libusbd_iface_alloc(ctx,iface) (*(iface)=0,0)
    #define libusbd_config_finalize(...) (0)
    #define libusbd_iface_set_class(...) (0)
    #define libusbd_iface_set_subclass(...) (0)
    #define libusbd_iface_set_protocol(...) (0)
    #define libusbd_iface_standard_desc(...) (0)
    #define libusbd_iface_nonstandard_desc(...) (0)
    #define libusbd_iface_add_endpoint(ctx,iface,type,direction,size,interval,unknown,ep) (*(ep)=0,0)
    #define libusbd_iface_finalize(...) (0)
    #define libusbd_ep_write mock_usb_write
    #define nanosleep mock_sleep
    #define main mac2jb_sender_entry
    #include ${JSON.stringify(path.join(root, 'sender.c'))}
    #undef main
    static int setting(const char *name) { const char *value=getenv(name); return value ? atoi(value) : 0; }
    static int mock_usb_write(libusbd_ctx_t *ctx, uint8_t iface, uint64_t ep,
                              const void *data, uint32_t len, uint64_t timeout) {
      static int calls=0; calls++;
      if(calls==setting("TEST_BLOCK_AT")) {
        fputs("TEST_BLOCKED\\n",stderr); fflush(stderr);
        if(getchar()==EOF) return LIBUSBD_NOT_ENUMERATED;
      }
      const uint8_t *bytes=data;
      int result=calls==setting("TEST_FAIL_AT") ? LIBUSBD_NOT_ENUMERATED : (int)len;
      printf("TEST_USB {\\"call\\":%d,\\"key\\":%u,\\"mods\\":%u,\\"result\\":%d}\\n",
             calls,bytes[2],bytes[0],result); fflush(stdout);
      return result;
    }
    static int mock_sleep(const struct timespec *duration, struct timespec *remaining) {
      static int calls=0; calls++;
      printf("TEST_WAIT {\\"call\\":%d,\\"seconds\\":%ld,\\"nanoseconds\\":%ld}\\n",
             calls,duration->tv_sec,duration->tv_nsec); fflush(stdout);
      if(calls==setting("TEST_CANCEL_AT_WAIT")) raise(SIGTERM);
      return 0;
    }
    int main(int argc,char **argv) { return mac2jb_sender_entry(argc,argv); }
  `;
  const input = path.join(temporary, 'sender-test.c');
  fs.writeFileSync(input, harness);
  const executables = {};
  for (const mode of ['gui', 'cli']) {
    const executable = path.join(temporary, 'sender-' + mode);
    const compiled = spawnSync('xcrun', ['clang', '-std=c11', '-D_POSIX_C_SOURCE=200809L',
      ...(mode === 'gui' ? ['-DMAC2JB_GUI=1'] : []),
      '-I' + path.join(root, 'vendor/libusbd/include'), input, '-o', executable], {encoding: 'utf8'});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    executables[mode] = executable;
  }
  let number = 0;
  function file(text) {
    const name = path.join(temporary, 'input-' + (++number) + '.bas');
    fs.writeFileSync(name, text);
    return name;
  }
  const environment = extra => ({...process.env, MAC2JB_AUTO_WORKER: '1', ...extra});
  // remainingMs depends on the wall clock, only the eta test looks at it
  function trace(output, eta = false) {
    return output.split('\n').flatMap(line => {
      for (const [prefix, type] of [['MAC2JB_GUI ', 'progress'], ['TEST_USB ', 'usb'], ['TEST_WAIT ', 'wait']])
        if (line.startsWith(prefix)) {
          const {remainingMs, ...row} = {type, ...JSON.parse(line.slice(prefix.length))};
          return [eta && remainingMs !== undefined ? {...row, remainingMs} : row];
        }
      return [];
    });
  }
  const progress = records => records.filter(row => ['line-start', 'line-complete'].includes(row.type));
  function run(text, settings = {}, mode = 'gui') {
    const result = spawnSync(executables[mode], [file(text), '--delay-ms', '50'], {
      env: environment(settings), encoding: 'utf8', timeout: 3000
    });
    return {...result, records: trace(result.stdout)};
  }
  function expected(total) {
    return Array.from({length: total}, (_, index) => [
      {type: 'line-start', line: index + 1, completed: index, total},
      {type: 'line-complete', line: index + 1, completed: index + 1, total}
    ]).flat();
  }

  await t.test('line-start is flushed before the first indentation write can finish', async t => {
    const child = spawn(executables.gui, [file(' A\n'), '--delay-ms', '50'], {
      env: environment({TEST_BLOCK_AT: '2'}), stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '', error = '';
    child.stdout.on('data', bytes => {output += bytes;});
    child.stderr.on('data', bytes => {error += bytes;});
    const done = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', code => resolve(code));
    });
    t.after(async () => {child.kill('SIGKILL'); await done;});
    const deadline = Date.now() + 2000;
    while (!error.includes('TEST_BLOCKED') || !output.includes('"type":"line-start"')) {
      assert.ok(Date.now() < deadline, 'The first source-line event was not flushed before USB blocked');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(trace(output).some(row => row.type === 'usb' && row.call === 2), false);
    assert.deepEqual(progress(trace(output)), [{type: 'line-start', line: 1, completed: 0, total: 1}]);
    child.stdin.end('\n');
    assert.equal(await done, 0, error);
    const records = trace(output);
    const firstIndent = records.findIndex(row => row.type === 'usb' && row.call === 2);
    assert.equal(records[firstIndent].key, 44);
    assert.ok(firstIndent > records.findIndex(row => row.type === 'line-start'));
  });

  await t.test('completion follows successful Enter down, release and existing pacing', () => {
    const result = run('A\nB\n');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(progress(result.records), expected(2));
    const firstComplete = result.records.findIndex(row => row.type === 'line-complete');
    const enterDown = result.records.findIndex(row => row.type === 'usb' && row.call === 4);
    const enterUp = result.records.findIndex(row => row.type === 'usb' && row.call === 5);
    const enterWait = result.records.findIndex(row => row.type === 'wait' && row.call === 2);
    assert.equal(result.records[enterDown].key, 40);
    assert.equal(result.records[enterUp].key, 0);
    assert.ok(enterDown < enterUp && enterUp < enterWait && enterWait < firstComplete);
    assert.ok(result.records.filter(row => row.type === 'wait').every(row => row.seconds === 0 && row.nanoseconds === 50000000));
  });

  await t.test('a failed midline write does not complete or start another line', () => {
    const result = run('AB\nC\n', {TEST_FAIL_AT: '4'});
    assert.equal(result.status, 1);
    assert.deepEqual(progress(result.records), [{type: 'line-start', line: 1, completed: 0, total: 2}]);
  });

  await t.test('a failed Enter release does not complete the line', () => {
    const result = run('A\n', {TEST_FAIL_AT: '5'});
    assert.equal(result.status, 1);
    assert.deepEqual(progress(result.records), [{type: 'line-start', line: 1, completed: 0, total: 1}]);
  });

  await t.test('cancelling during a line prevents completion and the next line', () => {
    const result = run('AB\nC\n', {TEST_CANCEL_AT_WAIT: '1'});
    assert.equal(result.status, 1);
    assert.deepEqual(progress(result.records), [{type: 'line-start', line: 1, completed: 0, total: 2}]);
    assert.equal(result.records.some(row => row.type === 'usb' && row.key === 40), false);
  });

  await t.test('cancellation during the final Enter pause does not publish completion', () => {
    const result = run('A\nB\n', {TEST_CANCEL_AT_WAIT: '2'});
    assert.equal(result.status, 1);
    assert.deepEqual(progress(result.records), [{type: 'line-start', line: 1, completed: 0, total: 2}]);
  });

  await t.test('the final unterminated line completes after its last successful stroke', () => {
    const result = run('A\nB');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(progress(result.records), expected(2));
    const finalComplete = result.records.findIndex(row => row.type === 'line-complete' && row.line === 2);
    const finalRelease = result.records.findIndex(row => row.type === 'usb' && row.call === 7);
    assert.ok(finalRelease < finalComplete);
    assert.equal(result.records[finalRelease].key, 0);
  });

  await t.test('CRLF remains one Enter per line and preserves the LF report sequence', () => {
    const crlf = run('\r\nA\r\n');
    const lf = run('\nA\n');
    assert.equal(crlf.status, 0, crlf.stderr);
    assert.deepEqual(progress(crlf.records), expected(2));
    assert.deepEqual(crlf.records, lf.records);
    assert.equal(crlf.records.filter(row => row.type === 'usb' && row.key === 40).length, 2);
  });

  await t.test('the stroke plan matches what was sent, including indent changes', () => {
    const result = spawnSync(executables.gui, [file('A\n  B\n    C\r\nD\n '), '--delay-ms', '50'], {
      env: environment({}), encoding: 'utf8', timeout: 3000
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = trace(result.stdout, true).filter(row => ['line-start', 'line-complete'].includes(row.type));
    assert.equal('remainingMs' in lines[0], false);
    assert.ok(lines.slice(1).every(row => Number.isFinite(row.remainingMs) && row.remainingMs >= 0));
    assert.equal(lines.at(-1).remainingMs, 0); // off by any stroke -> not 0
  });

  await t.test('an empty file has zero line events', () => {
    const result = run('');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(progress(result.records), []);
  });

  await t.test('a final whitespace-only line completes after indentation has been supplied', () => {
    const result = run('A\n ');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(progress(result.records), expected(2));
  });

  await t.test('CLI start and completion lines are readable, terminated lines', () => {
    const result = run('A\nB', {}, 'cli');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('\r'), false);
    assert.deepEqual(result.stdout.split('\n').filter(line => /^(Typing|Sent) line /.test(line)),
      ['Typing line 1 of 2', 'Sent line 1 of 2', 'Typing line 2 of 2', 'Sent line 2 of 2']);
    assert.equal(result.stdout.includes('MAC2JB_GUI'), false);
  });
});
