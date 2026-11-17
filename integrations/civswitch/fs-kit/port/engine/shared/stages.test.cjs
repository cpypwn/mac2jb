'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {run} = require('./stages.cjs');

async function withStage(source, action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-timeout-'));
  try {
    await fs.writeFile(path.join(directory, 'probe.cjs'), source);
    await action(directory);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
}

test('cooperative timeout lets an active stage finish its cleanup', async () => {
  await withStage(`
    const fs = require('node:fs');
    const path = require('node:path');
    const {RunControl, StopRequested} = require(${JSON.stringify(path.join(__dirname,
      '../switch2/memory/run-control.cjs'))});
    (async () => {
      const control = new RunControl({id: 'test', save: async () => {}});
      await control.start();
      try {
        await control.begin('native wave');
        await new Promise(resolve => setTimeout(resolve, 550));
        try {await control.end('native wave');}
        catch (error) {if (!(error instanceof StopRequested)) throw error;}
      } finally {
        control.retire();
        await control.close();
        fs.writeFileSync(path.join(__dirname, 'cleaned'), 'yes');
      }
    })().catch(error => {console.error(error); process.exitCode = 1;});
  `, async directory => {
    await assert.rejects(run(directory, 'probe', [], 300,
      {cooperative: true, graceMs: 1000}), /stopped at its timeout/);
    assert.equal(await fs.readFile(path.join(directory, 'cleaned'), 'utf8'), 'yes');
  });
});

test('cooperative timeout reports when cleanup exceeds its grace period', async () => {
  await withStage(`
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `, async directory => {
    await assert.rejects(run(directory, 'probe', [], 300,
      {cooperative: true, graceMs: 100}), /timed out before cleanup completed/);
  });
});

test('cooperative mode requires a positive cleanup grace period', async () => {
  await assert.rejects(run('/tmp', 'probe', [], 100, {cooperative: true, graceMs: 0}),
    /positive cleanup grace period/);
});
