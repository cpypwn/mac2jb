// SW2NES: QuickNES background renderer (Nes_Ppu_Rendering::draw_background_
// with Nes_Ppu_Bg.h, SW2NES_ALIGNED_BG layout) hand-written for the jitless JS
// engine. Same algorithm, same stores, same order; heap accesses use 32-bit
// word indices instead of per-store byte-address arithmetic. Only called for
// the plain case (no MMC5 ExGrafix, no MMC2/4 latches, 4-byte row pitch);
// everything else stays in C. Verified frame-for-frame against the C build.
//
// args (int32 words): 0 vram_addr & 0x7fff, 1 vram_temp, 2 scanline_pixels -
// pixel_x, 3 left_clip, 4 remain, 5 row bytes, 6-9 nametable bank pointers,
// 10 palette_offset, 11 tile_cache, 12 bg_bank, 13 chr_pages pointer.
mergeInto(LibraryManager.library, {
  sw2nes_js_bg: function (ap) {
    var H = HEAP32, U = HEAPU8, A = ap >> 2;
    var va = H[A], vt = H[A + 1], rowPixels = H[A + 2], lc = H[A + 3], remain = H[A + 4], rb = H[A + 5];
    var pal = H[A + 10], tc = H[A + 11], bgBank = H[A + 12], cp = H[A + 13] >> 2;
    var rw = rb >> 2, M = 0x03030303;
    rowPixels += lc * 8;
    // Draw shifted right to a 4-byte boundary, then move each row back.
    var bgShift = (0 - rowPixels) & 3, shiftStart = rowPixels, shiftRows = remain, shiftLen = (33 - lc) * 8;
    rowPixels += bgShift;
    var height, hsc, addr, yy, nt, nt2, count, count2, attr, pixels, fineY, clipped, h2;
    var attrib, off, ta, t, p, line, li, n;
    do {
      // scanlines until next row
      height = 8 - (va >> 12);
      if (height > remain) height = remain;
      // handle hscroll change before next scanline
      hsc = (va ^ vt) & 0x41f;
      addr = va;
      if (hsc) { va ^= hsc; height = 1; }
      remain -= height;
      // increment address for next row
      va += height << 12;
      if (va & 0x8000) {
        yy = (va + 0x20) & 0x3e0;
        va &= 0x7fff & ~0x3e0;
        if (yy === 30 * 0x20) yy = 0x800;
        va ^= yy;
      }
      nt = H[A + 6 + ((addr >> 10) & 3)];
      nt2 = H[A + 6 + (((addr ^ 0x400) >> 10) & 3)];
      count2 = addr & 31;
      count = 32 - count2 - lc;
      count2++;
      attr = nt + (0x3c0 | (addr >> 4 & 0x38));
      addr += lc;
      pixels = rowPixels;
      rowPixels += height * rb;
      if (height === 8) { addr &= 0x3ff; clipped = false; fineY = 0; h2 = 8; }
      else { fineY = addr >> 12; addr &= 0x3ff; h2 = height - (fineY & 1); clipped = true; }
      for (;;) {
        while (count-- > 0) {
          attrib = U[attr + (addr >> 2 & 7)] >> ((addr >> 4 & 4) | (addr & 2));
          off = ((attrib & 3) * 0x04040404 + pal) | 0;
          ta = (U[nt + addr] + bgBank) << 4;
          t = (tc + H[cp + (ta >> 10)] + ta) >> 2;  // tile_cache + map_chr_addr(index * 16)
          p = pixels >> 2;
          addr++;
          pixels += 8;
          if (!clipped) {
            line = H[t];
            H[p] = (line >>> 4 & M) + off; H[p + 1] = (line & M) + off; p += rw;
            H[p] = (line >>> 6 & M) + off; H[p + 1] = (line >>> 2 & M) + off; p += rw;
            line = H[t + 1];
            H[p] = (line >>> 4 & M) + off; H[p + 1] = (line & M) + off; p += rw;
            H[p] = (line >>> 6 & M) + off; H[p + 1] = (line >>> 2 & M) + off; p += rw;
            line = H[t + 2];
            H[p] = (line >>> 4 & M) + off; H[p + 1] = (line & M) + off; p += rw;
            H[p] = (line >>> 6 & M) + off; H[p + 1] = (line >>> 2 & M) + off; p += rw;
            line = H[t + 3];
            H[p] = (line >>> 4 & M) + off; H[p + 1] = (line & M) + off; p += rw;
            H[p] = (line >>> 6 & M) + off; H[p + 1] = (line >>> 2 & M) + off;
          } else {
            li = t + (fineY >> 1);
            if (fineY & 1) {
              line = H[li++];
              H[p] = (line >>> 6 & M) + off; H[p + 1] = (line >>> 2 & M) + off; p += rw;
            }
            for (n = h2 >> 1; n > 0; n--) {
              line = H[li++];
              H[p] = (line >>> 4 & M) + off; H[p + 1] = (line & M) + off; p += rw;
              H[p] = (line >>> 6 & M) + off; H[p + 1] = (line >>> 2 & M) + off; p += rw;
            }
            if (h2 & 1) {
              line = H[li];
              H[p] = (line >>> 4 & M) + off; H[p + 1] = (line & M) + off;
            }
          }
        }
        count = count2;
        count2 = 0;
        addr -= 32;
        attr = attr - nt + nt2;
        nt = nt2;
        if (!count) break;
      }
    } while (remain);
    if (bgShift) {
      for (var i = 0, r = shiftStart; i < shiftRows; i++, r += rb) U.copyWithin(r, r + bgShift, r + bgShift + shiftLen);
    }
  }
});
