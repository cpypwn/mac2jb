// SW2NES: palette-index -> RGBA conversion for the jitless JS engine.
// Hand-written instead of compiled C: local Int32Array views with element
// indices avoid wasm2js's per-access address arithmetic. Values stay small
// integers (RGBA as signed int32), so no number boxing.
//
// rows of input indices are `pitch` bytes apart (4-byte aligned); prev/out rows
// are dense (64 words / 256 pixels). mode 0: compare with prev and convert only
// changed 4-pixel words; 1: convert all and refresh prev; 2: convert all, leave
// prev stale (caller guarantees a mode-1 frame before the next mode-0 frame).
// Returns the number of changed words (mode 0) or 0.
mergeInto(LibraryManager.library, {
  sw2nes_js_convert: function (inPtr, pitch, outPtr, prevPtr, palPtr, rows, mode) {
    var H = HEAP32, P = new Int32Array(HEAP32.buffer, palPtr, 256);
    var s = inPtr >> 2, sStep = pitch >> 2, p = prevPtr >> 2, o = outPtr >> 2;
    var changed = 0, y, e, v, q;
    if (mode === 0) {
      for (y = 0; y < rows; y++, s += sStep, p += 64, o += 256) {
        for (e = 0; e < 64; e++) {
          v = H[s + e];
          if (v === H[p + e]) continue;
          H[p + e] = v; changed++; q = o + (e << 2);
          H[q] = P[v & 255]; H[q + 1] = P[(v >> 8) & 255]; H[q + 2] = P[(v >> 16) & 255]; H[q + 3] = P[v >>> 24];
        }
      }
      return changed;
    }
    var U = HEAPU8;
    for (y = 0; y < rows; y++, s += sStep, o += 256) {
      if (mode === 1) U.copyWithin(prevPtr + (y << 8), (s << 2), (s << 2) + 256);  // native memmove
      for (e = 0, q = o; e < 64; e += 4, q += 16) {
        v = H[s + e];     H[q] = P[v & 255];      H[q + 1] = P[(v >> 8) & 255];  H[q + 2] = P[(v >> 16) & 255];  H[q + 3] = P[v >>> 24];
        v = H[s + e + 1]; H[q + 4] = P[v & 255];  H[q + 5] = P[(v >> 8) & 255];  H[q + 6] = P[(v >> 16) & 255];  H[q + 7] = P[v >>> 24];
        v = H[s + e + 2]; H[q + 8] = P[v & 255];  H[q + 9] = P[(v >> 8) & 255];  H[q + 10] = P[(v >> 16) & 255]; H[q + 11] = P[v >>> 24];
        v = H[s + e + 3]; H[q + 12] = P[v & 255]; H[q + 13] = P[(v >> 8) & 255]; H[q + 14] = P[(v >> 16) & 255]; H[q + 15] = P[v >>> 24];
      }
    }
    return 0;
  }
});
