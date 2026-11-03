#!/usr/bin/env node
'use strict';
// Read-only analyzer for ns2jb acquisition runs. It never opens the console and
// never includes account identifiers or addresses in its summary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function lastError(file) {
  let error = '';
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.startsWith('{') || !line.includes('"error"')) continue;
      try { error = JSON.parse(line).error || error; } catch { /* ignore */ }
    }
  } catch { /* no log */ }
  return (error || '').split('\n')[0];
}

function classify(error, report) {
  if (/link candidate/i.test(error)) return 'no-link-candidate';
  if (/bucket period/i.test(error)) return 'bucket-period';
  if (/General-heap/i.test(error)) return 'heap-drift';
  if (/canary/i.test(error)) return 'canary';
  if (/alias/i.test(error)) return 'cache-alias';
  if (/Native batch/i.test(error)) return 'native-batch';
  if (/retire|cleanup/i.test(error)) return 'cleanup';
  if (error) return 'other';
  const cases = report.cases || [];
  if (cases.some(c => c.profile === 'extent-present' && !c.allPending)) return 'extent-requalify';
  return 'unknown';
}

function summarize(runDir) {
  const root = path.join(runDir, 'switch2', 'ro', 'root', 'current-root.json');
  const pipelineFile = path.join(runDir, 'switch2', 'pipeline.json');
  const logFile = path.join(runDir, 'switch2', 'acquisition.log');
  const memoryDir = path.join(runDir, 'switch2', 'memory');
  let pipeline = null;
  try { pipeline = JSON.parse(fs.readFileSync(pipelineFile, 'utf8')); } catch { /* none */ }
  const last = pipeline && pipeline.stages && pipeline.stages[pipeline.stages.length - 1];
  let report = {};
  try {
    const files = fs.readdirSync(memoryDir)
      .filter(name => /^reserved-gap-.*\.json$/.test(name) && !name.endsWith('-plan.json'))
      .sort();
    if (files.length) report = JSON.parse(fs.readFileSync(path.join(memoryDir, files[files.length - 1]), 'utf8'));
  } catch { /* no report */ }
  const error = lastError(logFile) || (last && last.error) || '';
  const success = fs.existsSync(root) ||
    (Number(report.qualifiedReadSize) > 0 && (!last || last.status === 'complete'));
  const pins = (report.cases || []).filter(c => c.pinCost != null).map(c => c.pinCost);
  const windows = (report.cases || []).filter(c => 'pinWindow' in c).map(c => c.pinWindow);
  let engine = null;
  try {
    engine = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(memoryDir, 'probe-reserved-gap.cjs')))
      .digest('hex').slice(0, 12);
  } catch { /* older runs have no copy */ }
  return {
    run: path.basename(runDir),
    success,
    failure: success ? null : classify(error, report),
    error: error.slice(0, 120),
    engine,
    pins,
    pinWindows: windows,
    qualifiedReadSize: report.qualifiedReadSize == null ? null : Number(report.qualifiedReadSize),
    links: (report.linkCandidates || []).length,
    marker: report.markerSelected == null ? null : !!report.markerSelected,
    cases: (report.cases || []).length,
    lastStage: last ? last.status : 'none',
  };
}

function main() {
  const args = process.argv.slice(2);
  const roots = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (args[i] === '--root' && args[i + 1]) { roots.push(args[++i]); continue; }
    roots.push(args[i]);
  }
  if (!roots.length) roots.push(path.join(process.env.HOME || '.', 'ns2jb-rpc', 'runs'));
  const runs = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('switch2-')) continue;
      const dir = path.join(root, name);
      try { if (fs.statSync(dir).isDirectory()) runs.push(summarize(dir)); } catch { /* skip */ }
    }
  }
  runs.sort((a, b) => a.run.localeCompare(b.run));
  if (json) {
    console.log(JSON.stringify({runs}, null, 2));
    return;
  }
  console.log('run                     result  failure              links  qualified  marker  stage');
  for (const run of runs) {
    console.log([run.run.padEnd(22), run.success ? 'PASS  ' : 'FAIL  ',
      String(run.failure || '-').padEnd(21), String(run.links).padStart(5),
      String(run.qualifiedReadSize || '-').padStart(10),
      String(run.marker == null ? '-' : run.marker).padStart(7), run.lastStage].join(' '));
  }
  const successes = runs.filter(r => r.success);
  const failures = runs.filter(r => !r.success);
  const classes = {};
  for (const run of failures) classes[run.failure] = (classes[run.failure] || 0) + 1;
  console.log('\n' + successes.length + ' passed, ' + failures.length + ' failed');
  console.log('failure classes: ' + JSON.stringify(classes));
  if (successes.length && failures.length) {
    const minLinks = Math.min(...successes.map(r => r.links));
    const maxFailLinks = Math.max(...failures.map(r => r.links));
    console.log('links: successes min=' + minLinks + ', failures max=' + maxFailLinks);
    const okPins = new Set(successes.flatMap(r => r.pins));
    const badPins = new Set(failures.flatMap(r => r.pins));
    console.log('pin costs: success=' + [...okPins].join(',') + ' failure=' + [...badPins].join(','));
  }
}

if (require.main === module) main();
module.exports = {summarize, classify};
