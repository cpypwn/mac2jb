const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

test('the guided delete pulls a fresh backup and passes its folder to the delete tool', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-kit-delete-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const tools = path.join(root, 'tools');
  const library = path.join(tools, 'lib');
  fs.mkdirSync(library, {recursive: true});
  fs.copyFileSync(path.join(__dirname, '..', 'tools/kit.cjs'), path.join(tools, 'kit.cjs'));
  fs.writeFileSync(path.join(library, 'titles.cjs'),
    'module.exports={refresh:async()=>true,available:()=>true,unnamed:()=>[],label:id=>id,slug:id=>id}');
  fs.writeFileSync(path.join(tools, 'list-apps.cjs'),
    'console.log("0x010042d022aea000")');
  fs.writeFileSync(path.join(tools, 'save-pull-root.cjs'), `
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--list-uids')) console.log('${'a'.repeat(32)}');
else if(args.includes('--list-only')) {
  console.log('mounted space=User type=Account rank=0 index=0 uid=${'a'.repeat(16)}');
  console.log('listed 1 files, 4 bytes (read-only, nothing written)');
} else {
  fs.mkdirSync(args[2],{recursive:true});
  console.log('backup complete');
}`);
  fs.writeFileSync(path.join(tools, 'save-delete-root.cjs'),
    'require("node:fs").writeFileSync(process.env.MAC2JB_KIT_CAPTURE,JSON.stringify(process.argv.slice(2)));');
  const capture = path.join(root, 'delete-args.json');
  const child = spawn(process.execPath, [path.join(tools, 'kit.cjs'), path.join(root, 'run')],
    {env: {...process.env, MAC2JB_KIT_CAPTURE: capture}, stdio: ['pipe', 'pipe', 'pipe']});
  const steps = [
    [/Number 1-1  \(i = installed inventory/, '1\n'],
    [/Number 1-6 \(blank = back\):/, '4\n'],
    [/File to delete at the save root/, '/save.dat\n'],
    [/Delete \/save\.dat from 010042d022aea000 \[y\/N\]:/, 'y\n'],
    [/Number 1-6 \(blank = back\):/, '\n'],
    [/Number 1-1  \(i = installed inventory/, '\n']
  ];
  let stdout = '', stderr = '', cursor = 0, stage = 0;
  child.stdout.on('data', data => {
    stdout += data;
    const next = steps[stage];
    if (next && next[0].test(stdout.slice(cursor))) {
      cursor = stdout.length;
      stage += 1;
      child.stdin.write(next[1]);
    }
  });
  child.stderr.on('data', data => {stderr += data;});
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {child.kill(); reject(Error('guided delete timed out'));}, 5000);
    child.on('error', error => {clearTimeout(timeout); reject(error);});
    child.on('close', code => {clearTimeout(timeout); resolve(code);});
  });
  assert.equal(result, 0, stdout + stderr);
  assert.equal(stage, steps.length, stdout + stderr);
  const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(args.slice(0, 4),
    [path.join(root, 'run'), '010042d022aea000', 'a'.repeat(32), '/save.dat']);
  assert.match(args[4], /\/saves\/010042d022aea000\/user-aaaaaaaa\/\d{4}-\d{2}-\d{2}_\d{4}$/);
  assert.equal(fs.existsSync(args[4]), true);
});
