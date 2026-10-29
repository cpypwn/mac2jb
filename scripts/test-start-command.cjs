#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

test('the native command sender accepts only the live five-argument START record', {skip: process.platform !== 'darwin' ? 'Requires the real macOS libusbd build' : false}, t => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-start-test-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const source = fs.readFileSync(path.join(root, 'commands.c'), 'utf8');
  const entry = 'int main(int argc, char **argv) {';
  assert.equal(source.split(entry).length, 2);
  // Compile the production translation unit with its program entry renamed.
  // The harness calls its actual record parser and never initializes USB.
  const harness = source.replace(entry, 'int mac2jb_commands_test_entry(int argc, char **argv) {') + `
    int main(void) {
      char command[512];
      return load_active_start(command, sizeof(command)) == 0 ? 0 : 1;
    }
  `;
  const input = path.join(temporary, 'start-test.c');
  const executable = path.join(temporary, 'start-test');
  fs.writeFileSync(input, harness);
  const compiled = spawnSync('xcrun', ['clang', '-std=c11', '-D_POSIX_C_SOURCE=200809L',
    '-I' + root, '-I' + path.join(root, 'vendor/libusbd/include'),
    input, '-L' + path.join(root, 'vendor/libusbd'), '-lusbd',
    '-Wl,-rpath,' + path.join(root, 'vendor/libusbd'),
    '-framework', 'CoreFoundation', '-framework', 'IOKit', '-o', executable], {encoding: 'utf8'});
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const folder = path.join(temporary, 'vendor/ns2jb/runs');
  fs.mkdirSync(folder, {recursive: true});
  const active = path.join(folder, 'mac2jb-active-connect.txt');
  function check(command, expected, pid = process.pid) {
    fs.writeFileSync(active, `${pid}\n${command}\n`);
    const result = spawnSync(executable, [], {cwd: temporary, encoding: 'utf8'});
    assert.equal(result.status, expected, command + '\n' + result.stderr);
  }
  for (const command of ['V=START(39380,192,0,2,1)', 'V=START(39380,0,0,0,0)',
    'V=START(39380,255,255,255,255)']) check(command, 0);
  for (const command of ['V=START(39380,192,0,2,1,0,0,0,0)', 'V=START(39380,192,0,2)',
    'V=START(39381,192,0,2,1)', 'V=START(39380,256,0,2,1)', 'V=START(39380,-1,0,2,1)',
    'V=START(39380,192,0,2,1.5)', 'V=START(39380,192,0,2,1);PRINT 1',
    'V=START(39380,192,0,2,18446744073709551616)', 'V=START(39380,192,0,2,)',
    'V=START(39380,192,0,2,1,)', 'V=START(39380,192,0,2,1)garbage']) check(command, 1);
  check('V=START(39380,192,0,2,1)', 1, 1);
});

test('native full-game and demo command modes preserve actual HID ordering and waits without hardware', async t => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-command-modes-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const production = fs.readFileSync(path.join(root, 'commands.c'), 'utf8')
    .replace('int main(int argc, char **argv) {', 'int mac2jb_commands_test_entry(int argc, char **argv) {');
  // Compile the production main and sender encoding. Only USB operations and the
  // monotonic clock/sleep boundary are replaced, so every submitted key is observed.
  const harness = `
    #include <libusbd.h>
    #include <time.h>
    #include <unistd.h>
    #include <stdio.h>
    static unsigned long long mock_ns=0;
    static int mock_usb_write(libusbd_ctx_t*,uint8_t,uint64_t,const void*,uint32_t,uint64_t);
    static int mock_clock(clockid_t,struct timespec*);
    static int mock_pause(const struct timespec*,struct timespec*);
    static unsigned int mock_seconds(unsigned int);
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
    #define clock_gettime mock_clock
    #define nanosleep mock_pause
    #define sleep mock_seconds
    ${production}
    static int mock_usb_write(libusbd_ctx_t *ctx,uint8_t iface,uint64_t ep,
                              const void *data,uint32_t len,uint64_t timeout) {
      if(len!=8)return LIBUSBD_NOT_ENUMERATED;
      static int calls=0;calls++;
      const char *failure=getenv("TEST_FAIL_AT");
      const uint8_t *b=data;
      printf("TEST_USB {\\"atNs\\":%llu,\\"report\\":[%u,%u,%u,%u,%u,%u,%u,%u]}\\n",
        mock_ns,b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7]);return failure && calls==atoi(failure) ? LIBUSBD_NOT_ENUMERATED : (int)len;
    }
    static int mock_clock(clockid_t id,struct timespec *value) {
      value->tv_sec=(time_t)(mock_ns/1000000000ULL);value->tv_nsec=(long)(mock_ns%1000000000ULL);return 0;
    }
    static int mock_pause(const struct timespec *value,struct timespec *remaining) {
      unsigned long long duration=(unsigned long long)value->tv_sec*1000000000ULL+value->tv_nsec;
      printf("TEST_PAUSE {\\"durationNs\\":%llu}\\n",duration);mock_ns+=duration;const char *cancel=getenv("TEST_CANCEL_AT_WAIT");static int pauses=0;pauses++;if(cancel && pauses==atoi(cancel))raise(SIGTERM);return 0;
    }
    static unsigned int mock_seconds(unsigned int seconds) {
      printf("TEST_SLEEP {\\"seconds\\":%u}\\n",seconds);mock_ns+=(unsigned long long)seconds*1000000000ULL;
      const char *cancel=getenv("TEST_CANCEL_AT_SLEEP");static int sleeps=0;sleeps++;if(cancel && sleeps==atoi(cancel))raise(SIGTERM);return 0;
    }
    int main(int argc,char **argv) { return mac2jb_commands_test_entry(argc,argv); }
  `;
  const input = path.join(temporary, 'commands-test.c');fs.writeFileSync(input, harness);
  const executables = {};
  for (const build of ['cli', 'gui']) {
    const executable = path.join(temporary, 'commands-' + build);
    const compiled = spawnSync(process.platform === 'darwin' ? 'xcrun' : 'cc', [...(process.platform === 'darwin' ? ['clang'] : []), '-std=c11', '-D_POSIX_C_SOURCE=200809L',
      ...(build === 'gui' ? ['-DMAC2JB_GUI=1'] : []), '-I' + root,
      '-I' + path.join(root, 'vendor/libusbd/include'), input, '-o', executable], {encoding: 'utf8'});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);executables[build] = executable;
  }
  const active = path.join(temporary, 'vendor/ns2jb/runs/mac2jb-active-connect.txt');
  fs.mkdirSync(path.dirname(active), {recursive: true});
  const start = 'V=START(39380,192,0,2,1)';fs.writeFileSync(active, `${process.pid}\n${start}\n`);
  const following = ['RUN', 'REMOVE NSR,&H60000000,&H3FFFFFFF', start];
  const guiOptions = ['--gui-events', '--load-confirm-wait-ms', '111', '--load-wait-ms', '222',
    '--run-wait-ms', '333', '--remove-wait-ms', '444'];
  function run(build, demo, extra = ['--auto'], input = '', extraEnv = {}, useDefaultDelay = false, useDefaultWaits = false) {
    const result = spawnSync(executables[build], [...(demo ? ['--demo'] : []), ...(useDefaultDelay ? [] : ['--delay-ms', '50']),
      ...(build === 'gui' ? (useDefaultWaits ? ['--gui-events'] : guiOptions) : []), ...extra], {cwd: temporary, encoding: 'utf8', input,
      env: {...process.env, MAC2JB_AUTO_WORKER: '1', ...extraEnv}, timeout: 3000});
    const records = result.stdout.split('\n').flatMap(line => {
      for (const [prefix, kind] of [['TEST_USB ', 'usb'], ['TEST_SLEEP ', 'sleep'],
        ['TEST_PAUSE ', 'pause'], ['MAC2JB_GUI ', 'event']])
        if (line.startsWith(prefix)) return [{kind, ...JSON.parse(line.slice(prefix.length))}];
      return [];
    });
    return {...result, records};
  }
  function character(mods, key) {
    assert.ok(mods === 0 || mods === 2, 'Only the existing SmileBASIC shift convention is used');
    if (key >= 4 && key <= 29) return String.fromCharCode((mods ? 97 : 65) + key - 4);
    if (key >= 30 && key <= 38) return mods ? '!@#$%^&*('[key - 30] : String(key - 29);
    if (key === 39) return mods ? ')' : '0';
    const symbols = {44: [' ', ' '], 45: ['-', '_'], 46: ['=', '+'], 47: ['[', '{'], 48: [']', '}'],
      49: ['\\', '|'], 51: [';', ':'], 52: ["'", '"'], 53: ['`', '~'], 54: [',', '<'], 55: ['.', '>'], 56: ['/', '?']};
    assert.ok(symbols[key], 'Unexpected HID key: ' + key);return symbols[key][mods ? 1 : 0];
  }
  function submitted(records, pending = '') {
    const usb = records.filter(row => row.kind === 'usb'), groups = [];let command = '', firstAt;
    for (let index = 0; index < usb.length; index++) {
      const row = usb[index], [mods, reserved, key, ...remaining] = row.report;
      assert.equal(reserved, 0);assert.deepEqual(remaining, [0, 0, 0, 0, 0]);
      if (!key) continue;
      assert.deepEqual(usb[index + 1].report, Array(8).fill(0), 'Every pressed key must immediately release');
      if (key === 40) {groups.push({command, firstAt, enterAt: row.atNs});command = '';firstAt = undefined;}
      else {firstAt ??= row.atNs;command += character(mods, key);}
    }
    assert.equal(command, pending);return groups;
  }
  function events(result, demo, automatic) {
    const native = result.records.filter(row => row.kind === 'event');
    assert.deepEqual(native.filter(row => row.type.startsWith('command-')).map(row => [row.type, row.step]),
      Array.from({length: 4}, (_, index) => [['command-start', index + 1], ['command-complete', index + 1]]).flat());
    const waits = new Map(native.filter(row => row.type === 'wait').map(row => [row.label, row.durationMs]));
    assert.deepEqual([...waits], [['LOAD confirmation', 111],
      ['LOAD', 222], ...(automatic ? [['RUN', 333], ['REMOVE', 444]] : [])]);
  }
  for (const build of ['cli', 'gui']) for (const demo of [false, true]) {
    await t.test(`${build} ${demo ? "demo" : "full"} LOAD preserves bytes, Enters and waits`, () => {
      const result = run(build, demo);assert.equal(result.status, 0, result.stderr);
      const groups = submitted(result.records);
      assert.deepEqual(groups.map(group => group.command), [demo ? 'PRGEDIT 0:LOADV "TXT:NS2" OUT C$:PRGSET C$' : 'LOAD "TXT:NS2"', '', ...following]);
      assert.equal(groups.length, 5);
      const confirmationMs = build === 'gui' ? 111 : 0;
      const waits = build === 'gui' ? [222, 333, 444] : [1000, 0, 0];
      assert.equal((groups[1].enterAt - groups[0].enterAt) / 1000000, 50 + confirmationMs);
      for (let next = 2, wait = 0; next < groups.length; next++, wait++)
        assert.equal((groups[next].firstAt - groups[next - 1].enterAt) / 1000000, 50 + waits[wait]);
      if (build === 'gui') events(result, demo, true);
      else assert.deepEqual(result.records.filter(row => row.kind === 'sleep').map(row => row.seconds), [1]);
    });
  }
  await t.test('both editions default to 10 ms keys and one second after the second LOAD Enter', () => {
    for (const build of ['cli','gui']) for (const demo of [false,true]) {
      const result=run(build,demo,['--auto'],'',{},true,true);
      assert.equal(result.status,0,result.stderr);
      const usb=result.records.filter(row=>row.kind==='usb');
      const first=usb.findIndex(row=>row.report[2]!==0);
      assert.ok(first>=0);
      assert.equal((usb[first+2].atNs-usb[first].atNs)/1000000,10);
      const groups=submitted(result.records);
      assert.equal((groups[1].enterAt-groups[0].enterAt)/1000000,10,
        build+' '+(demo?'demo':'full')+' sends the second LOAD Enter without a wait');
      for(let next=2;next<groups.length;next++)
        assert.equal((groups[next].firstAt-groups[next-1].enterAt)/1000000,next===2?1010:10,
          build+' '+(demo?'demo':'full')+' default wait before '+groups[next].command);
      if(build==='gui'){
        assert.deepEqual([...new Map(result.records.filter(row=>row.type==='wait').map(row=>[row.label,row.durationMs]))],[['LOAD',1000]]);
        const enters=result.records.flatMap((row,index)=>row.kind==='usb'&&row.report[2]===40?[index]:[]);
        assert.ok(result.records.findIndex(row=>row.type==='wait'&&row.label==='LOAD')>enters[1],
          'the one-second LOAD wait starts after the second Enter');
      }else assert.deepEqual(result.records.filter(row=>row.kind==='sleep').map(row=>row.seconds),[1]);
    }
  });
  await t.test('manual first-step prompts describe the selected command and retain approval boundaries', () => {
    for (const build of ['cli', 'gui']) for (const demo of [false, true]) {
      const result = run(build, demo, [], '\n'.repeat(4));assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(demo ? 'STEP 1/4: Focus SmileBASIC Direct mode. Load NS2 with LOADV?' : 'STEP 1/4: Focus SmileBASIC Direct mode. Send LOAD "TXT:NS2"?'));
      const groups=submitted(result.records);
      assert.equal(groups.length,5);
      assert.equal(groups[1].command,'');
      assert.equal((groups[1].enterAt-groups[0].enterAt)/1000000,50+(build==='gui'?111:0));
      if (build === 'gui') events(result, demo, false);
      else assert.deepEqual(result.records.filter(row => row.kind === 'sleep').map(row => row.seconds), [1]);
    }
  });
  await t.test('dry-run describes full YES and demo OK confirmations without touching USB', () => {
    for (const build of ['cli', 'gui']) for (const demo of [false, true]) {
      const result = run(build, demo, ['--dry-run']);assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes('1: ' + (demo ? 'PRGEDIT 0:LOADV "TXT:NS2" OUT C$:PRGSET C$' : 'LOAD "TXT:NS2"') + ' [Enter]\n2: RUN [Enter]'));
      assert.ok(result.stdout.includes(demo ? 'LOADV receives one additional Enter to accept its OK confirmation before RUN.' : 'LOAD receives one additional Enter to accept its YES confirmation before RUN.'));
      assert.equal(result.records.some(row => row.kind === 'usb'), false);
      const help = run(build, demo, ['--help']);assert.equal(help.status, 0);assert.match(help.stdout, /--demo/);
    }
  });
  await t.test('GUI timing protocol preserves the LOAD confirmation wait without USB', () => {
    for (const demo of [false, true]) {
      const result = run('gui', demo, ['--gui-timing-test']);assert.equal(result.status, 0, result.stderr);
      assert.equal(result.records.some(row => row.kind === 'usb'), false);events(result, demo, true);
    }
  });
  await t.test('cancelled LOAD confirmation and failed confirmation Enter never proceed to RUN in either edition or mode', () => {
    for(const demo of [false,true]) for(const mode of ['cli','gui','selected']) {
      const build=mode==='cli'?'cli':'gui';
      const args=['--auto',...(mode==='selected'?['--commands','load,run']:[])];
      const baseline=run(build,demo,args);assert.equal(baseline.status,0,baseline.stderr);
      const load=submitted(baseline.records)[0].command;
      const usb=baseline.records.filter(row=>row.kind==='usb');
      const enterIndices=usb.flatMap((row,index)=>row.report[2]===40?[index+1]:[]);
      assert.ok(enterIndices.length>=3);
      const cancelled=run(build,demo,args,'',build==='gui'?{TEST_CANCEL_AT_WAIT:String(load.length+2)}:{TEST_CANCEL_AT_SLEEP:'1'});
      assert.equal(cancelled.status,1,cancelled.stderr);
      assert.deepEqual(submitted(cancelled.records).map(row=>row.command),build==='gui'?[load]:[load,''],mode+' '+(demo?'demo':'full'));
      assert.equal(cancelled.records.some(row=>row.type==='command-start'&&row.label==='RUN'),false);
      const failed=run(build,demo,args,'',{TEST_FAIL_AT:String(enterIndices[1])});
      assert.equal(failed.status,1,failed.stderr);
      assert.deepEqual(submitted(failed.records).map(row=>row.command),[load,'']);
      assert.equal(failed.records.some(row=>row.type==='command-start'&&row.label==='RUN'),false);
      assert.equal(failed.stdout.includes('Sending: RUN'),false);
    }
  });
  await t.test('every canonical nonempty command subset types only selected bytes with relative progress and waits', () => {
    fs.rmSync(path.join(temporary,'vendor'),{recursive:true,force:true});
    for (const demo of [false, true]) {
    const names=['load','run','remove','start'],texts=[demo ? 'PRGEDIT 0:LOADV "TXT:NS2" OUT C$:PRGSET C$' : 'LOAD "TXT:NS2"','RUN','REMOVE NSR,&H60000000,&H3FFFFFFF','V=START(39380,198,51,100,17)'];
    for(let mask=1;mask<16;mask++) {
      const selected=names.filter((_,index)=>mask&(1<<index)),total=selected.length;
      const result=run('gui',demo,['--auto','--commands',selected.join(','),...(selected.includes('start')?['--start-command',texts[3]]:[])]);
      assert.equal(result.status,0,result.stderr);
      const groups=submitted(result.records),expected=[];
      for(const name of selected){expected.push(texts[names.indexOf(name)]);if(name==='load')expected.push('');}
      assert.deepEqual(groups.map(group=>group.command),expected,selected.join(','));
      let groupIndex=0;
      for(let position=0;position<selected.length;position++) {
        const name=selected[position];
        if(name==='load') {
          assert.equal((groups[groupIndex+1].enterAt-groups[groupIndex].enterAt)/1000000,161);
          groupIndex++;
        }
        if(position<selected.length-1) {
          assert.equal((groups[groupIndex+1].firstAt-groups[groupIndex].enterAt)/1000000,50+{load:222,run:333,remove:444}[name]);
          groupIndex++;
        }
      }
      const native=result.records.filter(row=>row.kind==='event');
      assert.deepEqual(native.filter(row=>row.type.startsWith('command-')).map(row=>[row.type,row.step,row.completed,row.total,row.label]),
        selected.flatMap((name,index)=>[['command-start',index+1,index,total,name.toUpperCase()],['command-complete',index+1,index+1,total,name.toUpperCase()]]));
      const expectedWaits=[];
      if(selected.includes('load'))expectedWaits.push(['LOAD confirmation',111],['LOAD',222]);
      for(const name of selected.slice(0,-1).filter(name=>name!=='load'))
        expectedWaits.push([name.toUpperCase(),{run:333,remove:444}[name]]);
      assert.deepEqual([...new Map(native.filter(row=>row.type==='wait').map(row=>[row.label,row.durationMs]))],expectedWaits);
      assert.ok(native.every(row=>row.total===total));
      assert.equal(fs.existsSync(path.join(temporary,'vendor')),false);
    }
    }
    const normal=run('gui',false,['--auto']);assert.equal(normal.status,1);assert.match(normal.stderr,/No active ns2jb command/);
  });
  await t.test('each START prefix subset leaves exact pending text and never submits its final command', () => {
    const names=['load','run','remove','start'];
    for(const demo of [false,true]) for(let mask=8;mask<16;mask++) {
      const selected=names.filter((_,index)=>mask&(1<<index));
      const result=run('gui',demo,['--auto','--commands',selected.join(','),'--start-prefix']);
      assert.equal(result.status,0,result.stderr);
      const groups=submitted(result.records,'V=START(39380,');
      assert.equal(groups.length,selected.length-1+(selected.includes('load')?1:0));
      assert.equal(groups.some(group=>group.command.startsWith('V=START')),false);
      const native=result.records.filter(row=>row.kind==='event');
      assert.equal(native.some(row=>row.type==='command-complete'&&row.label==='START'),false);
      const prefix=native.find(row=>row.type==='command-prefix-complete');
      assert.deepEqual(prefix,{kind:'event',type:'command-prefix-complete',step:selected.length,completed:selected.length-1,total:selected.length,label:'START',prefix:'V=START(39380,',startPending:true});
      assert.equal(result.records.filter(row=>row.kind==='usb'&&row.report[2]===40).length,groups.length);
      if(selected.length===1)assert.equal(native.some(row=>row.type==='wait'),false);
    }
  });
  await t.test('selected pepsipu protocol submits its exact nine arguments and rejects invalid tokens before USB', () => {
    const nine='V=START(39380,192,0,2,1,0,1,281474976710655,42)';
    const manual=run('gui',false,['--auto','--start-arity','9','--commands','start','--start-command',nine]);
    assert.equal(manual.status,0,manual.stderr);
    assert.deepEqual(submitted(manual.records).map(row=>row.command),[nine]);
    fs.mkdirSync(path.dirname(active),{recursive:true});
    fs.writeFileSync(active,`${process.pid}\n${nine}\n`);
    try {
      const paired=run('gui',false,['--auto','--start-arity','9']);
      assert.equal(paired.status,0,paired.stderr);assert.equal(submitted(paired.records).at(-1).command,nine);
      const wrong=run('gui',false,['--auto']);assert.equal(wrong.status,1);assert.equal(wrong.records.length,0);
    } finally {fs.rmSync(path.join(temporary,'vendor'),{recursive:true,force:true});}
    for(const value of [start,nine.replace('281474976710655','281474976710656'),nine.replace(',42)',',042)'),
      nine.replace(',42)',',-1)'),nine+';PRINT 1']) {
      const result=run('gui',false,['--auto','--start-arity','9','--commands','start','--start-command',value]);
      assert.equal(result.status,2,value);assert.equal(result.records.length,0);
    }
    for(const extra of [['--start-arity','6'],['--start-arity','9','--start-arity','9']]) {
      const result=run('gui',false,['--auto',...extra]);assert.equal(result.status,2);assert.equal(result.records.length,0);
    }
    assert.equal(run('cli',false,['--auto','--start-arity','9']).status,2);
  });
  await t.test('invalid selections, malformed manual START and removed address override fail before USB', () => {
    for(const csv of ['',',','load,','load,load','run,load','remove,run','start,remove','LOAD','load,unknown']) {
      const result=run('gui',false,['--auto','--commands',csv]);assert.equal(result.status,2,csv+'\n'+result.stderr);
      assert.equal(result.records.some(row=>row.kind==='usb'),false);
    }
    for(const value of ['', 'V=START(39380,192,0,2,1,0,0,0,0)','V=START(39381,192,0,2,1)',
      'V=START(39380,256,0,2,1)','V=START(39380,192,0,2,01)','V=START(39380,192,0,2,1);PRINT 1',' V=START(39380,192,0,2,1)']) {
      const result=run('gui',false,['--auto','--commands','start','--start-command',value]);assert.equal(result.status,2,value+'\n'+result.stderr);
      assert.equal(result.records.some(row=>row.kind==='usb'),false);
    }
    for(const extra of [['--commands','start'],['--start-command',start],['--commands','run','--start-prefix'],
      ['--commands','start','--start-prefix','--start-command',start],['--commands','run','--commands','load'],
      ['--commands','start','--start-prefix','--start-prefix'],['--start-address','192.0.2.1']]) {
      const result=run('gui',false,extra);assert.equal(result.status,2,JSON.stringify(extra)+'\n'+result.stderr);
      assert.equal(result.records.some(row=>row.kind==='usb'),false);
    }
    const cli=run('cli',false,['--commands','run']);assert.equal(cli.status,2);assert.match(cli.stderr,/unknown argument/);
  });
  await t.test('subset previews and timing protocol do not send USB or consult the host record', () => {
    for(const demo of [false,true]) for(const extra of [['--dry-run'],['--gui-timing-test']]) {
      const result=run('gui',demo,[...extra,'--commands','run,start','--start-prefix']);assert.equal(result.status,0,result.stderr);
      assert.equal(result.records.some(row=>row.kind==='usb'),false);
      assert.equal(result.stdout.includes('receives one additional Enter'),false);
      assert.equal(result.records.some(row=>row.type==='wait'&&row.label==='LOAD confirmation'),false);
      if(extra[0]==='--dry-run')assert.match(result.stdout,/2: V=START\(39380, \[no Enter; finish manually\]/);
      else assert.ok(result.records.some(row=>row.type==='command-prefix-complete'&&row.completed===1&&row.total===2));
      const load=run('gui',demo,[...extra,'--commands','load']);assert.equal(load.status,0,load.stderr);
      assert.equal(load.records.some(row=>row.kind==='usb'),false);
      if(extra[0]==='--dry-run')assert.ok(load.stdout.includes(demo?'LOADV receives one additional Enter to accept its OK confirmation.':'LOAD receives one additional Enter to accept its YES confirmation.'));
      else assert.deepEqual([...new Map(load.records.filter(row=>row.type==='wait').map(row=>[row.label,row.durationMs]))],[['LOAD confirmation',111],['LOAD',222]]);
    }
    const preview=run('gui',false,['--dry-run','--commands','start','--start-command',start]);
    assert.equal(preview.status,0);assert.match(preview.stdout,/1: V=START\(39380,192,0,2,1\) \[Enter\]/);
    assert.equal(fs.existsSync(path.join(temporary,'vendor')),false);
  });
  await t.test('failed or cancelled prefix typing never publishes prefix completion or Enter', () => {
    for(const environment of [{TEST_FAIL_AT:'8'},{TEST_CANCEL_AT_WAIT:'3'}]) {
      const result=run('gui',false,['--auto','--commands','start','--start-prefix'],'',environment);
      assert.equal(result.status,1,result.stderr);
      assert.equal(result.records.some(row=>row.type==='command-prefix-complete'||row.type==='command-complete'),false);
      assert.equal(result.records.some(row=>row.kind==='usb'&&row.report[2]===40),false);
    }
  });
  for (const demo of [false,true]) await t.test(`${demo?'demo':'full'} bootstrap SAVE types exact bytes and one Enter with no host or prompt confirmation`,()=>{
    const text=demo?'PRGEDIT 0:C$="":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV "TXT:NS2",C$':'SAVE "NS2"';
    for (const useDefault of [false,true]) {
      const result=run('gui',demo,['--auto','--save-bootstrap'],'',{},useDefault);
      assert.equal(result.status,0,result.stderr);
      const typed=submitted(result.records).map(row=>row.command);
      assert.deepEqual(typed,[text]);
      if(demo)assert.match(typed[0],/PRGGET\$\(\) :NEXT:/,'PRGGET$ must be a closed zero-argument function call');
      const native=result.records.filter(row=>row.kind==='event'||row.kind==='save-bootstrap');
      assert.deepEqual(native.filter(row=>row.type.startsWith('command-')).map(row=>[row.type,row.step,row.completed,row.total,row.label]),
        [['command-start',1,0,1,'SAVE'],['command-complete',1,1,1,'SAVE']]);
      assert.equal(native.some(row=>row.type==='wait'),false);
      const pauses=result.records.filter(row=>row.kind==='pause');assert.equal(pauses.length,text.length+1);
      assert.ok(pauses.every(row=>row.durationNs===(useDefault?10:50)*1000000));
      assert.equal(fs.existsSync(path.join(temporary,'vendor')),false);
    }
    const preview=run('gui',demo,['--dry-run','--save-bootstrap']);assert.equal(preview.status,0,preview.stderr);
    assert.match(preview.stdout,/No extra Enter is sent/);assert.ok(preview.stdout.includes(`1: ${text} [Enter]\n`));
    assert.equal(preview.records.some(row=>row.kind==='usb'),false);
    for(const extraEnv of [{TEST_FAIL_AT:'8'},{TEST_CANCEL_AT_WAIT:'3'},{TEST_CANCEL_AT_WAIT:String(text.length+1)},
      {TEST_FAIL_AT:String(2*text.length+3)}]) {
      const failed=run('gui',demo,['--auto','--save-bootstrap'],'',extraEnv);assert.equal(failed.status,1,failed.stderr);
      assert.equal(failed.records.some(row=>row.type==='command-complete'),false);
      assert.ok(failed.records.filter(row=>row.kind==='usb'&&row.report[2]===40).length<=1);
    }
  });
  await t.test('SAVE cannot be combined with other command modes and is unavailable in the legacy CLI',()=>{
    for(const demo of [false,true]) for(const extra of [['--commands','load'],['--start-command',start],['--start-prefix'],['--gui-timing-test'],['--save-bootstrap']]) {
      const result=run('gui',demo,['--save-bootstrap',...extra]);assert.equal(result.status,2,JSON.stringify(extra)+'\n'+result.stderr);
      assert.equal(result.records.some(row=>row.kind==='usb'),false);
    }
    const cli=run('cli',false,['--save-bootstrap']);assert.equal(cli.status,2);assert.match(cli.stderr,/unknown argument/);
  });
});
