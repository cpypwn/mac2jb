/*
 * civ_bridge.js — ns2jb wire-protocol console bridge for the CivSwitch (Civ 7) loader.
 *
 * Eval'd inside the CivSwitch loader closure (TCP :9026); all BRIDGE-CONTRACT.md §1
 * primitives (read64/write64/.../call_rop/malloc/free/socket family/log) are in scope.
 *
 * Implements BRIDGE-CONTRACT.md §2 exactly:
 *   - connect OUT to PC_IP:PC_PORT
 *   - send 128-byte HELLO (16 x u64 LE)
 *   - RPC loop: recv exactly 0x8080 bytes into scratch+0x40000,
 *     execute record A [+0x00] then record B [+0x28] via call_rop(fn, a0, a1, a2, a3),
 *     write resultB at scratch+0x4030 and resultA at scratch+0x4038,
 *     send exactly 0x8010 bytes from scratch+0x4030.
 *   - record A first 20 bytes all zero => clean shutdown.
 *
 * SAFETY: this payload only ever touches (a) memory it malloc'd, (b) addresses
 * derived from svcQueryMemory results, and (c) addresses supplied by the PC engine
 * inside RPC records. No blind pointer chasing: an unmapped read/write is a
 * hardware fault and is NOT catchable from JS — it would kill the game process.
 *
 * The bridge occupies the loader eval for its entire lifetime (long-running);
 * log() lines keep streaming back over the loader's :9026 client connection.
 */
(async function () {
  // ============================ CONFIG ============================
  // Edit before deployment, or keep defaults and let runtime resolution run.
  const CONFIG = {
    // --- PC endpoint (the PC listens; we connect out) ---
    PC_IP: '<PC_IP>',   // <-- set to the PC's LAN IPv4
    PC_PORT: 39380,           // ns2jb default

    // --- HELLO fields (u64). 0n = "auto-resolve at runtime" where supported ---
    SCRATCH: 0n,        // 0 => malloc(0x80000)
    MAIN: 0n,           // 0 => svcQueryMemory region base containing main_base anchor
    SDK: 0n,            // 0 => svcQueryMemory region base containing sdk_base anchor
    GOT: 0n,            // unused by the Civ7 engine target
    MEMMOVE: 0n,        // 0 => resolved sdk text base + 0x522830
    BACKING: 0n,        // unused by the Civ7 engine target
    CONTROLLER: 0n,     // keep-awake is disabled for Civ7
    SDK_CRC32: 157086863n, // zlib CRC-32 of the 0x602000-byte Civ7 sdk text

    // --- svcQueryMemory wrapper (absolute). 0n => pattern-scan for it ---
    // In the dumped session it sat at sdk_text_base + 0x168B0C (stable per build).
    QMFUNC: 0n,

    VERBOSE: false,     // log a line every 1000 RPCs
  };
  // ================================================================

  const SCRATCH_BYTES   = 0x80000n;
  const REQUEST_BYTES   = 0x8080;   // console <- PC
  const RESPONSE_BYTES  = 0x8010;   // console -> PC
  const INPUT_OFF       = 0x40000n; // request lands at scratch+0x40000
  const REC_B_OFF       = 0x28n;    // record B inside request
  const RESULT_B_OFF    = 0x4030n;  // response[0:8]  = second call result
  const RESULT_A_OFF    = 0x4038n;  // response[8:16] = first  call result
  const HELLO_MAGIC     = 0x31545344n;
  const HELLO_VERSION   = 1n;
  const HELLO_PLATFORM  = 2n;       // 2 = Switch 2

  const hex = v => '0x' + BigInt(v).toString(16);

  // ---- sock helpers (wrappers return signed-32 BigInt; <=0 means fail/EOF) ----
  async function sendAll(fd, addr, len) {
    let off = 0;
    while (off < len) {
      const r = send(fd, addr + BigInt(off), len - off, 0);
      if (r <= 0n) { await log('send failed mid-stream: ret=' + r + ' at ' + off + '/' + len); return false; }
      off += Number(r);
    }
    return true;
  }
  async function recvFull(fd, addr, len) {
    let off = 0;
    while (off < len) {
      const r = recv(fd, addr + BigInt(off), len - off, 0);
      if (r <= 0n) { await log('recv ended: ret=' + r + ' after ' + off + '/' + len + ' bytes'); return false; }
      off += Number(r);
    }
    return true;
  }

  let scratch = 0n;
  let scratchOwned = false;
  let aux = 0n;
  let fd = -1n;
  try {
    await log('=== civ_bridge: ns2jb console bridge starting ===');

    // ---- 1. scratch buffer (0x80000) ----
    scratch = CONFIG.SCRATCH;
    if (scratch === 0n) {
      scratch = malloc(Number(SCRATCH_BYTES));   // calloc-backed => zeroed
      scratchOwned = true;
    }
    if (!scratch) { await log('FATAL: malloc(0x80000) failed'); return; }
    await log('scratch = ' + hex(scratch) + ' (' + (scratchOwned ? 'malloc' : 'CONFIG') + ')');

    // Aux buffers live OUTSIDE scratch so the RPC areas stay pristine.
    aux = malloc(0x400);   // calloc-backed => zeroed
    if (!aux) { await log('FATAL: malloc(0x400) failed'); return; }
    const saBuf    = aux;             // 16-byte sockaddr_in
    const helloBuf = aux + 0x40n;     // 128-byte HELLO
    const infoBuf  = aux + 0x100n;    // svcQueryMemory MemoryInfo out (0x20 used)
    const pageBuf  = aux + 0x140n;    // svcQueryMemory page-info out (8)

    // ---- 2. locate the svcQueryMemory wrapper inside the sdk module ----
    // Pattern (BRIDGE-CONTRACT.md §1): str x1,[sp,#-16]! (0xF81F0FE1) ; svc #6 (0xD40000C1)
    const STRX1 = 0xF81F0FE1n, SVC6 = 0xD40000C1n;
    let qmFunc = CONFIG.QMFUNC;
    if (qmFunc === 0n) {
      await log('scanning [sdk_base, sdk_base+0x5F0000) for svcQueryMemory wrapper...');
      let prevHi = 0n;               // carry high word to catch 4-byte (non-8) alignment
      const scanEnd = sdk_base + 0x5F0000n;
      for (let a = sdk_base; a < scanEnd; a += 8n) {
        const pair = read64(a);
        const lo = pair & 0xffffffffn, hi = pair >> 32n;
        if (lo === STRX1 && hi === SVC6) { qmFunc = a; break; }       // start at a
        if (prevHi === STRX1 && lo === SVC6) { qmFunc = a - 4n; break; } // start at a-4
        prevHi = hi;
      }
      if (qmFunc === 0n) { await log('FATAL: svcQueryMemory wrapper not found'); return; }
    }
    await log('svcQueryMemory wrapper = ' + hex(qmFunc));

    // ---- 3. region query helper ----
    function query(addr) {
      const r = call_rop(qmFunc, infoBuf, pageBuf, addr);
      if (r !== 0n) return null;
      return {
        base: read64(infoBuf), size: read64(infoBuf + 8n),
        type: Number(read32(infoBuf + 0x10n)), perm: Number(read32(infoBuf + 0x18n)),
      };
    }

    // ---- 4. resolve true module bases for HELLO ----
    let sdk = CONFIG.SDK;
    if (sdk === 0n) {
      const t = query(sdk_base);
      if (!t) { await log('FATAL: svcQueryMemory(sdk_base) failed'); return; }
      sdk = t.base;
      await log('sdk region : ' + hex(t.base) + ' + ' + hex(t.size) +
                ' type=' + t.type + ' perm=' + t.perm + ((t.perm & 4) ? '' : '  (WARN: not executable!)'));
    }
    let main = CONFIG.MAIN;
    if (main === 0n) {
      const t = query(main_base);
      if (!t) { await log('FATAL: svcQueryMemory(main_base) failed'); return; }
      main = t.base;
      await log('main region: ' + hex(t.base) + ' + ' + hex(t.size) +
                ' type=' + t.type + ' perm=' + t.perm + ((t.perm & 4) ? '' : '  (WARN: not executable!)'));
    }

    // ---- 5. connect out to the PC ----
    const ipParts = CONFIG.PC_IP.split('.').map(Number);
    if (ipParts.length !== 4 || ipParts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
      await log('FATAL: bad CONFIG.PC_IP "' + CONFIG.PC_IP + '"'); return;
    }
    // sockaddr_in (see core.js): len=16, family=AF_INET(2), port big-endian,
    // IPv4 octets in order at +4..+7 (write32 of the little-endian assembly).
    const port = CONFIG.PC_PORT;
    const ipLE = BigInt(ipParts[0] + ipParts[1] * 0x100 + ipParts[2] * 0x10000 + ipParts[3] * 0x1000000);
    write8 (saBuf + 0n, 16n);
    write8 (saBuf + 1n, 2n);
    write16(saBuf + 2n, BigInt(((port & 0xff) << 8) | (port >> 8)));
    write32(saBuf + 4n, ipLE);

    fd = socket(2n, 1n, 0n);   // AF_INET, SOCK_STREAM, IPPROTO_IP
    if (fd < 0n) { await log('FATAL: socket() failed: ret=' + fd); return; }
    await log('socket fd=' + fd + '; connecting to ' + CONFIG.PC_IP + ':' + port + ' ...');
    const cr = connect(fd, saBuf, 16n);
    if (cr !== 0n) { await log('FATAL: connect() failed: ret=' + cr + ' (is the PC listening on ' + port + '?)'); return; }
    await log('connected to PC');

    // ---- 6. build + send the 128-byte HELLO (16 x u64 LE) ----
    const memmove = CONFIG.MEMMOVE === 0n ? sdk + 0x522830n : CONFIG.MEMMOVE;
    const helloFields = [
      HELLO_MAGIC, HELLO_VERSION, HELLO_PLATFORM,
      scratch, SCRATCH_BYTES, main, sdk,
      CONFIG.GOT, memmove, CONFIG.BACKING, CONFIG.CONTROLLER,
      0n, 0n, 0n, 0n, CONFIG.SDK_CRC32,
    ];
    for (let i = 0; i < 16; i++) write64(helloBuf + BigInt(i * 8), helloFields[i]);
    await log('HELLO: scratch=' + hex(scratch) + ' main=' + hex(main) + ' sdk=' + hex(sdk) +
              ' got=' + hex(CONFIG.GOT) + ' memmove=' + hex(memmove) +
              ' backing=' + hex(CONFIG.BACKING) + ' controller=' + hex(CONFIG.CONTROLLER) +
              ' sdkCrc32=' + hex(CONFIG.SDK_CRC32));
    if (CONFIG.GOT === 0n)
      await log('NOTE: got is unused by the Civ7 target; backing/controller remain zero.');
    if (!(await sendAll(fd, helloBuf, 128))) return;
    await log('HELLO sent; entering RPC loop');

    // ---- 7. RPC loop (BRIDGE-CONTRACT.md §2) ----
    const inBuf = scratch + INPUT_OFF;
    let rpcCount = 0;
    let skippedNull = false;
    for (;;) {
      if (!(await recvFull(fd, inBuf, REQUEST_BYTES))) break;

      // Termination: record A's first 20 bytes (fnAddr + a0 + low half of a1) all zero.
      if (read64(inBuf) === 0n && read64(inBuf + 8n) === 0n && read32(inBuf + 16n) === 0n) {
        await log('termination record received');
        break;
      }

      let resultA = 0n, resultB = 0n;

      const fnA = read64(inBuf);
      const b = inBuf + REC_B_OFF;
      const fnB = read64(b);
      if (fnB === 2n) {
        if (fnA !== 0n && fnA % 4n === 0n) {
          try {
            resultA = call_rop(fnA, read64(inBuf + 8n), read64(inBuf + 16n),
                                    read64(inBuf + 24n), read64(inBuf + 32n),
                                    read64(b + 8n), read64(b + 16n));
          } catch (e) { await log('six-argument call_rop JS error (fn=' + hex(fnA) + '): ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await log('WARN: invalid six-argument continuation — skipped'); }
      } else {
        // Record A (request+0x00). Defensive: a zero fn with non-zero args is not
        // the termination packet but is still not callable — skip instead of
        // jumping to address 0 (which would fault the process).
        if (fnA !== 0n) {
          try {
            resultA = call_rop(fnA, read64(inBuf + 8n), read64(inBuf + 16n),
                                    read64(inBuf + 24n), read64(inBuf + 32n));
          } catch (e) { await log('record A call_rop JS error (fn=' + hex(fnA) + '): ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await log('WARN: record A fn=0 (not the termination packet) — skipped'); }

        // Record B (request+0x28). The engine always pads single-call exchanges
        // with a memmove(output,output,0,0) no-op; if a peer leaves fn=0, skip.
        if (fnB !== 0n) {
          try {
            resultB = call_rop(fnB, read64(b + 8n), read64(b + 16n),
                                    read64(b + 24n), read64(b + 32n));
          } catch (e) { await log('record B call_rop JS error (fn=' + hex(fnB) + '): ' + e.message); }
        } else if (!skippedNull) { skippedNull = true; await log('WARN: record B fn=0 — skipped (engine should pad with a no-op)'); }
      }

      // Response header: resultB first, then resultA (matches bootstrap.bas and
      // native.cjs, where response[0:8] = second call, response[8:16] = first).
      write64(scratch + RESULT_B_OFF, resultB);
      write64(scratch + RESULT_A_OFF, resultA);

      if (!(await sendAll(fd, scratch + RESULT_B_OFF, RESPONSE_BYTES))) break;

      rpcCount++;
      if (CONFIG.VERBOSE && rpcCount % 1000 === 0) await log('rpc: ' + rpcCount + ' exchanges');
    }

    await log('=== civ_bridge: exiting after ' + rpcCount + ' RPC exchanges ===');
  } catch (e) {
    // Never let a JS exception kill the eval silently — report and return.
    try { await log('FATAL bridge exception: ' + ((e && e.stack) || e)); } catch (_) {}
  } finally {
    if (fd >= 0n) { try { close(fd); } catch (_) {} }
    if (aux) { try { free(aux); } catch (_) {} }
    if (scratchOwned && scratch) { try { free(scratch); } catch (_) {} }
  }
})();
