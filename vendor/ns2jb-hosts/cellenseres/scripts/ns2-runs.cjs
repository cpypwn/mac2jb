// Summarize run results and failure reasons.
const fs = require('node:fs');
const path = require('node:path');
const runsDefault = path.join(__dirname, '..', 'runs');
let runsRoot = runsDefault;
const timeZone = 'Europe/Berlin';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function classify(text) {
  const rules = [
    [/Pinning storage was not created/, 'welle-0'],
    [/The input extent did not qualify/, 'extent'],
    [/interleaved input extent did not requalify/, 'requalify'],
    [/Overwrite missed the qualified canary/, 'overwrite-miss'],
    [/Repeated overwrite missed/, 'repeat-miss'],
    [/FS acquisition has an error/, 'acquisition-error'],
    [/probe exited with code 0/, 'kein-control'],
    [/Unexpected end of JSON input/, 'host-read'],
    [/ENOENT/, 'host-read'],
    [/EADDRINUSE/, 'port-belegt'],
    [/Application worker qualification failed/, 'qualify'],
  ];
  for (const [pattern, label] of rules) if (pattern.test(text)) return label;
  const line = (text.match(/^Error: .*$/m) || [''])[0];
  return line.replace(/^Error: /, '').slice(0, 48) || 'unbekannt';
}

function probeReport(directory) {
  const memory = path.join(directory, 'switch2', 'memory');
  let names = [];
  try { names = fs.readdirSync(memory).filter(name => /^reserved-gap-\d+\.json$/.test(name)).sort(); }
  catch { return null; }
  return names.length ? readJson(path.join(memory, names[names.length - 1])) : null;
}

function summary(directory) {
  const result = readJson(path.join(directory, 'result.json')) || {};
  let log = '';
  try { log = fs.readFileSync(path.join(directory, 'run.log'), 'utf8'); } catch {}
  const probe = probeReport(directory) || {};
  const aborted = !result.started;
  // Prefer probe errors over generic runner failures.
  const text = [probe.error, probe.cleanupError, probe.controlMissing, log, String(result.error || '')]
    .filter(Boolean).join('\n');
  return {
    session: path.basename(directory),
    started: String(result.started || ''),
    at: (result.started ? new Date(result.started).toLocaleTimeString('de-DE', {timeZone, hour12: false}) : '--:--:--').padStart(8),
    verified: Boolean(result.verified),
    waves: Array.isArray(probe.cases) ? probe.cases.length : 0,
    qualified: Boolean(probe.qualifiedReadSize),
    marker: Boolean(probe.markerSelected),
    reproduced: Boolean(probe.markerReproduced),
    cleaned: probe.cleanedUp === true,
    cause: result.verified ? 'ok' : aborted ? 'abgebrochen (kein result.json)' : classify(text),
    directory,
  };
}

function collect() {
  let names = [];
  try { names = fs.readdirSync(runsRoot); }
  catch (error) { throw Error('No runs directory at ' + runsRoot + ' (' + error.code + ')'); }
  return names.filter(name => /^switch2-[A-Za-z0-9]{6}$/.test(name))
    .map(name => summary(path.join(runsRoot, name)))
    .sort((left, right) => left.started.localeCompare(right.started));
}

function line(row, wide) {
  const flags = [row.qualified ? 'Q' : '-', row.marker ? 'M' : '-', row.reproduced ? 'R' : '-',
    row.cleaned ? 'C' : '-'].join('');
  const head = [row.at, row.session, String(row.waves).padStart(2) + ' W', flags, row.verified ? 'OK' : row.cause];
  return head[0] + '  ' + head[1] + '  ' + head[2] + '  ' + head[3] + '  ' + head[4] +
    (wide && row.verified ? '  ' + row.directory : '');
}

function kvLine(row) {
  return ['session=' + row.session, 'verified=' + (row.verified ? 1 : 0),
    'cleaned=' + (row.cleaned ? 1 : 0), 'waves=' + row.waves,
    'q=' + (row.qualified ? 1 : 0), 'm=' + (row.marker ? 1 : 0), 'r=' + (row.reproduced ? 1 : 0),
    'cause=' + row.cause].join(';');
}

const args = process.argv.slice(2);
const runsAt = args.indexOf('--runs');
if (runsAt >= 0) runsRoot = path.resolve(String(args[runsAt + 1] || '.'));
const dirAt = args.indexOf('--dir');
if (dirAt >= 0) {
  // Report the requested run, not the newest one.
  const row = summary(path.resolve(String(args[dirAt + 1] || '.')));
  console.log(args.includes('--kv') ? kvLine(row) : line(row, true));
  process.exit(row.verified ? 0 : 3);
}
const all = collect();
if (args.includes('--kv')) {
  const row = all[all.length - 1];
  if (!row) { console.log('session=;verified=0;cleaned=0;waves=0;q=0;m=0;r=0;cause=none'); process.exit(3); }
  console.log(kvLine(row));
  process.exit(row.verified ? 0 : 3);
}
if (args.includes('--last')) {
  const row = all[all.length - 1];
  if (!row) { console.log('kein Lauf gefunden'); process.exit(args.includes('--exit') ? 3 : 0); }
  console.log(line(row, true));
  if (args.includes('--exit')) process.exit(row.verified ? 0 : 3);
} else {
  console.log('Zeit   Session          Wellen  QMRC  Ergebnis');
  console.log('Q = extent qualifiziert, M = markerSelected, R = markerReproduced, C = sauber aufgeräumt');
  for (const row of all) console.log(line(row, false));
  const tally = new Map();
  for (const row of all) tally.set(row.verified ? 'ok' : row.cause, (tally.get(row.verified ? 'ok' : row.cause) || 0) + 1);
  console.log('');
  for (const [cause, count] of [...tally].sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(3) + 'x  ' + cause);
  console.log(String(all.length).padStart(3) + '   gesamt');
}
