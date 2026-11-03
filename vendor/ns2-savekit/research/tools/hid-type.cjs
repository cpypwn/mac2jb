#!/usr/bin/env node
// Type into the console through an ESP32-S2 HID keyboard over WiFi.
//
//   node hid-type.cjs http://192.168.50.x 'PRINT 1'
//   node hid-type.cjs http://192.168.50.x --stdin < bootstrap.txt
//   node hid-type.cjs http://192.168.50.x --status
//
// Same role as switch-type.cjs, but the device is a WiFi Devboard running
// tools/esp32_hid/esp32_hid.ino: USB HID to the console, HTTP back to here. No
// kernel extension, no SIP change and no KDK, because macOS is not in the path.
const http = require('node:http');
const fs = require('node:fs');

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {timeout: 20000}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', part => { body += part; });
      response.on('end', () => resolve(body));
    });
    request.on('timeout', () => request.destroy(new Error('device did not answer')));
    request.on('error', reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const base = argv.shift();
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('usage: node hid-type.cjs http://<device-ip> "<text>"');
    console.error('   or: node hid-type.cjs http://<device-ip> --stdin < file');
    console.error('   or: node hid-type.cjs http://<device-ip> --status');
    process.exit(2);
  }
  if (argv.includes('--status')) {
    console.log(await get(base.replace(/\/$/, '') + '/status'));
    return;
  }
  const text = argv.includes('--stdin') ? fs.readFileSync(0, 'utf8') : argv.join(' ');
  if (!text) {
    console.error('no text given'); process.exit(2);
  }
  // Chunk to keep URLs short; the sketch types each chunk in order.
  const chunks = [];
  let current = '';
  for (const character of text) {
    if (Buffer.byteLength(current + character) > 400) { chunks.push(current); current = ''; }
    current += character;
  }
  if (current) chunks.push(current);
  let typed = 0, skipped = 0;
  for (const chunk of chunks) {
    const reply = await get(base.replace(/\/$/, '') + '/type?text=' + encodeURIComponent(chunk));
    let parsed;
    try { parsed = JSON.parse(reply); } catch { throw Error('unexpected reply: ' + reply.slice(0, 80)); }
    if (!parsed.ok) throw Error('device refused: ' + reply.slice(0, 80));
    typed += parsed.typed || 0; skipped += parsed.skipped || 0;
  }
  console.log(`typed ${typed} character(s)` + (skipped ? `, skipped ${skipped} unsupported` : ''));
  if (skipped) process.exitCode = 1;
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
