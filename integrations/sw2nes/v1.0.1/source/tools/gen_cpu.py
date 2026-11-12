#!/usr/bin/env python3
"""Generate native/cpu_lib.js: QuickNES's 6502 run() as an Emscripten JS library.

The generated interpreter mirrors Nes_Cpu::run() in third_party/.../Nes_Cpu.cpp
exactly (cycle table, page-crossing and dummy reads, IRQ/CLI/SEI handling,
unofficial opcodes, no 16-bit address wrapping where QuickNES has none). Each
addressing mode and operation is written once below, following QuickNES's
macros and shared goto tails, then expanded per opcode into a flat switch.
Hot state lives in function locals; RAM/ROM accesses are inlined and only
other addresses call into C (sw2nes_cpu_read/_read_ppu/_write).
"""
from pathlib import Path
import os
PROFILE = os.environ.get('SW2NES_PROFILE') == '1'
import re

CLOCK = [
    7,6,2,8,3,3,5,5,3,2,2,2,4,4,6,6, 3,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
    6,6,2,8,3,3,5,5,4,2,2,2,4,4,6,6, 3,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
    6,6,2,8,3,3,5,5,3,2,2,2,3,4,6,6, 3,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
    6,6,2,8,3,3,5,5,4,2,2,2,5,4,6,6, 3,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
    2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4, 3,6,2,6,4,4,4,4,2,5,2,5,5,5,5,5,
    2,6,2,6,3,3,3,3,2,2,2,2,4,4,4,4, 3,5,2,5,4,4,4,4,2,4,2,4,4,4,4,4,
    2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6, 3,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
    2,6,2,8,3,3,5,5,2,2,2,2,4,4,6,6, 3,5,2,8,4,4,6,6,2,4,2,7,4,4,7,7,
]

# ---- primitives (JS snippets). Locals: m (HEAPU8), H (HEAP32), lm (low_mem),
# cmi (code_map int index), pg (current page base), pc, data, a, x, y, sp, c,
# nz, st (status), clk, lim, cpu, ad/t/v temporaries.
def LOW(e): return f'm[lm + ({e})]'
OPB = 'm[pg + pc]'
OP16 = '(m[pg + pc] | m[pg + pc + 1] << 8)'
ADD_PAGE = 'pc++; data += m[pg + pc] << 8;'
RELOAD = 'lim = H[clO]; cp = -1;'

def _ccall(expr):
    return (f'(profC0 = performance.now(), profV = {expr}, profC0 = performance.now() - profC0, profCT += profC0, SW2NES_PCB[ad & 0xFFFF] += profC0, SW2NES_PCN[ad & 0xFFFF]++, profV)' if PROFILE else expr)

# Cartridge RAM ($6000-$7FFF) without a C call, exactly as Nes_Core::cpu_read/
# cpu_write do when no mapper intercepts the page: SRAM access plus clock_ update.
def SRAM_R(): return '(ad >= 0x6000 && ad < H[srR] && !m[drm + (ad >> 11)])'
SET_CLOCK = 'H[ckO] = clk + H[ctO];'

def READ(addr, dst):
    """READ(addr) == Nes_Core::cpu_read semantics, RAM/ROM inlined."""
    return (f'ad = {addr}; if (!(ad & 0xE000)) {dst} = m[lm + (ad & 0x7FF)]; '
            f'else if (ad > 0x7FFF) {dst} = m[H[cmi + (ad >> 11)] + ad]; '
            f'else if {SRAM_R()} {{ {dst} = m[srm + (ad & 0x1FFF)]; {SET_CLOCK} }} '
            f'else {{ {dst} = ' + _ccall('_sw2nes_cpu_read(cpu, ad, clk)') + f'; {RELOAD} }}')

def DREAD(addr):
    """Discarded READ: only I/O addresses have side effects."""
    return (f'ad = {addr}; if ((ad & 0xE000) && ad <= 0x7FFF) {{ if {SRAM_R()} {{ {SET_CLOCK} }} '
            'else { ' + _ccall('_sw2nes_cpu_read(cpu, ad, clk)') + f'; {RELOAD} }} }}')

def READ_PPU(addr, dst):
    """READ_LIKELY_PPU == Nes_Core::cpu_read_ppu (0x2002 fast path is in C)."""
    return (f'ad = {addr}; if (ad !== 0x2002 && !(ad & 0xE000)) {dst} = m[lm + (ad & 0x7FF)]; '
            f'else if (ad > 0x7FFF) {dst} = m[H[cmi + (ad >> 11)] + ad]; '
            f'else if {SRAM_R()} {{ {dst} = m[srm + (ad & 0x1FFF)]; {SET_CLOCK} }} '
            f'else {{ {dst} = ' + _ccall('_sw2nes_cpu_read_ppu(cpu, ad, clk)') + f'; {RELOAD} }}')

def WRITE(addr, val):
    """NES_CPU_WRITE: <0x800 direct; RAM mirrors match cpu_write; else C."""
    return (f'ad = {addr}; v = {val}; if (ad < 0x800) m[lm + ad] = v; '
            f'else if (!(ad & 0xE000)) m[lm + (ad & 0x7FF)] = v; '
            f'else if (ad >= 0x6000 && ad < H[swO] && !m[dwm + (ad >> 11)]) {{ m[srm + (ad & 0x1FFF)] = v; {SET_CLOCK} }} '
            'else { ' + _ccall('_sw2nes_cpu_write(cpu, ad, v, clk)') + f'; {RELOAD} }}')

CALC_STATUS = ('t = st & 0x4C; t |= (c >> 8) & 1; if (nz & 0x880) t |= 0x80; '
               'if (!(nz & 0xFF)) t |= 0x02;')
def SET_STATUS(src):
    return f'st = {src} & 0x4C; c = {src} << 8; nz = ({src} << 4) & 0x800; nz |= ~{src} & 0x02;'

LOOP = 'continue;'

# Idle-loop skip (exact). At a short backward branch/JMP (loop end in `ad`,
# loop start in pc): if we arrive at the same loop start with identical
# registers/flags and the body is side-effect free (SW2NES_IDLE_OK), every
# further iteration is identical except for the cycle count, which QuickNES
# would only interrupt at `lim`. Skip whole iterations of measured length,
# leaving at least one to run normally so the stop point is unchanged.
IDLE = ('if (pc === iT && a === iA && x === iX && y === iY && nz === iNZ && c === iC && st === iST && sp === iSP && '
        '(v = clk - iClk) > 0 && SW2NES_IDLE_OK(m, H, cmi, pc, ad)) { t = ((lim - clk) / v | 0) - 1; if (t > 0) clk += t * v; } '
        'iT = pc; iClk = clk; iA = a; iX = x; iY = y; iNZ = nz; iC = c; iST = st; iSP = sp;')

def BRANCH(cond):
    return ('pc++; t = (data << 24) >> 24; v = (pc & 0xFF) + t; '
            f'if (!({cond})) {{ clk--; {LOOP} }} '
            f'ad = pc; pc = (pc + t) & 0xFFFF; clk += (v >> 8) & 1; '
            f'if (t < 0 && t >= -16) {{ {IDLE} }} {LOOP}')

IND_X = f'v = data + x; data = ({LOW("(v + 1) & 0xFF")} << 8) + {LOW("v & 0xFF")};'

def IND_Y(r, cpen):
    s = f'v = {LOW("data")} + y; data = v + ({LOW("(data + 1) & 0xFF")} << 8);'
    if cpen:
        s += ' clk += v >> 8;'
    if r:
        s += f' if (v & 0x100) {{ {DREAD("data - 0x100")} }}'
    else:
        s += ' ' + DREAD('data - (v & 0x100)')
    return s

# ---- tails (code after the imm label) -----------------------------------
ADC = ('t = (c >> 8) & 1; v = (a ^ 0x80) + t + ((data << 24) >> 24); '
       'st &= ~0x40; st |= (v >> 2) & 0x40; c = nz = a + data + t; pc++; a = nz & 0xFF; ' + LOOP)
TAILS = {
    0xC5: 'nz = a - data; pc++; c = ~nz; nz &= 0xFF; ' + LOOP,          # CMP
    0x25: 'nz = (a &= data); pc++; ' + LOOP,                              # AND
    0x45: 'nz = (a ^= data); pc++; ' + LOOP,                              # EOR
    0x05: 'nz = (a |= data); pc++; ' + LOOP,                              # ORA
    0xE5: 'data ^= 0xFF; ' + ADC,                                         # SBC
    0x65: ADC,                                                            # ADC
}
RMW = {  # ARITH_ADDR_MODES_PTR tails; data is the effective address
    0xC7: (READ('data', 'nz') + ' ' + WRITE('data', 'nz') + ' nz = (nz - 1) & 0xFF; ' + WRITE('data', 'nz') +
           ' pc++; nz = a - nz; c = ~nz; nz &= 0xFF; ' + LOOP),                                   # DCP
    0xE7: (READ('data', 'nz') + ' ' + WRITE('data', 'nz') + ' nz = (nz + 1) & 0xFF; ' + WRITE('data', 'nz') +
           ' data = nz ^ 0xFF; ' + ADC),                                                          # ISC
    0x27: (READ('data', 'nz') + ' ' + WRITE('data', 'nz') + ' t = c; c = nz << 1; nz = (c & 0xFF) | ((t >> 8) & 1); ' +
           WRITE('data', 'nz') + ' pc++; nz = (a &= nz); ' + LOOP),                               # RLA
    0x67: (READ('data', 't') + ' ' + WRITE('data', 't') + ' nz = ((c >> 1) & 0x80) | (t >> 1); ' + WRITE('data', 'nz') +
           ' data = nz; c = t << 8; ' + ADC),                                                     # RRA
    0x07: (READ('data', 'nz') + ' ' + WRITE('data', 'nz') + ' c = nz << 1; nz = c & 0xFF; ' + WRITE('data', 'nz') +
           ' nz = (a |= nz); pc++; ' + LOOP),                                                     # SLO
    0x47: (READ('data', 'nz') + ' ' + WRITE('data', 'nz') + ' c = nz << 8; nz >>= 1; ' + WRITE('data', 'nz') +
           ' nz = (a ^= nz); pc++; ' + LOOP),                                                     # SRE
}

cases = {}
def case(op, body):
    assert op not in cases, hex(op)
    cases[op] = body

def arith(op, tail):
    ptr = READ('data', 'data') + ' '
    ind = f'clk += data >> 8; t = data; {ADD_PAGE} if (t & 0x100) {{ {DREAD("data - 0x100")} }} '
    case(op - 0x04, IND_X + ' ' + ptr + tail)
    case(op + 0x0C, IND_Y(True, True) + ' ' + ptr + tail)
    case(op + 0x10, f'data = (data + x) & 0xFF; data = {LOW("data")}; ' + tail)
    case(op + 0x00, f'data = {LOW("data")}; ' + tail)
    case(op + 0x14, 'data += y; ' + ind + ptr + tail)
    case(op + 0x18, 'data += x; ' + ind + ptr + tail)
    case(op + 0x08, ADD_PAGE + ' ' + ptr + tail)
    case(op + 0x04, tail)

def arith_ptr(op, tail):
    ind = f't = data; {ADD_PAGE} {DREAD("data - (t & 0x100)")} '
    case(op - 0x04, IND_X + ' ' + tail)
    case(op + 0x0C, IND_Y(False, False) + ' ' + tail)
    case(op + 0x10, 'data = (data + x) & 0xFF; ' + tail)
    case(op + 0x14, 'data += y; ' + ind + tail)
    case(op + 0x18, 'data += x; ' + ind + tail)
    case(op + 0x08, ADD_PAGE + ' ' + tail)
    case(op + 0x00, tail)

for op, tail in TAILS.items():
    arith(op, tail)
for op, tail in RMW.items():
    arith_ptr(op, tail)
case(0xEB, 'data ^= 0xFF; ' + ADC)

# Loads/stores
case(0xB5, f'data = (data + x) & 0xFF; a = nz = {LOW("data")}; pc++; {LOOP}')
case(0xA5, f'a = nz = {LOW("data")}; pc++; {LOOP}')
case(0xA9, f'pc++; a = data; nz = data; {LOOP}')
case(0xAD, f'v = {OP16}; pc += 2; {READ_PPU("v", "a")} nz = a; {LOOP}')
IDX_TAIL = ('pc++; clk += data >> 8; t = data; data += msb << 8; '
            'ad = data & 0xFFFF; a = nz = m[H[cmi + (ad >> 11)] + ad]; '
            f'if (((data - 0x2000) >>> 0) >= 0x6000) {LOOP} '
            f'if (t & 0x100) {{ {DREAD("data - 0x100")} }} {READ("data", "a")} nz = a; {LOOP}')
case(0xB9, f'data += y; pc++; msb = {OPB}; ' + IDX_TAIL)
case(0xBD, f'pc++; msb = {OPB}; data += x; ' + IDX_TAIL)
case(0xB1, f'msb = {LOW("(data + 1) & 0xFF")}; data = {LOW("data")} + y; ' + IDX_TAIL)
case(0xA1, f'{IND_X} {READ("data", "a")} nz = a; pc++; {LOOP}')
case(0x95, f'data = (data + x) & 0xFF; pc++; {LOW("data")} = a; {LOOP}')
case(0x85, f'pc++; {LOW("data")} = a; {LOOP}')
case(0x94, f'data = (data + x) & 0xFF; pc++; {LOW("data")} = y; {LOOP}')
case(0x84, f'pc++; {LOW("data")} = y; {LOOP}')
case(0x96, f'data = (data + y) & 0xFF; pc++; {LOW("data")} = x; {LOOP}')
case(0x86, f'pc++; {LOW("data")} = x; {LOOP}')
case(0xB6, f'data = (data + y) & 0xFF; data = {LOW("data")}; pc++; x = data; nz = data; {LOOP}')
case(0xA6, f'data = {LOW("data")}; pc++; x = data; nz = data; {LOOP}')
case(0xA2, f'pc++; x = data; nz = data; {LOOP}')
case(0xB4, f'data = (data + x) & 0xFF; data = {LOW("data")}; pc++; y = data; nz = data; {LOOP}')
case(0xA4, f'data = {LOW("data")}; pc++; y = data; nz = data; {LOOP}')
case(0xA0, f'pc++; y = data; nz = data; {LOOP}')
STA_PTR = f'pc++; {WRITE("data", "a")} {LOOP}'
STA_IND = f't = data; {ADD_PAGE} {DREAD("data - (t & 0x100)")} ' + STA_PTR
case(0x99, 'data += y; ' + STA_IND)
case(0x9D, 'data += x; ' + STA_IND)
case(0x8D, ADD_PAGE + ' ' + STA_PTR)
case(0x91, IND_Y(False, False) + ' ' + STA_PTR)
case(0x81, IND_X + ' ' + STA_PTR)
LDY_ABS = (f'pc++; v = data + ({OPB} << 8); if (data & 0x100) {{ {DREAD("v - 0x100")} }} pc++; '
           f'{READ("v", "y")} nz = y; {LOOP}')
case(0xBC, 'data += x; clk += data >> 8; ' + LDY_ABS)
case(0xAC, LDY_ABS)
LDX_ABS = (f'pc++; v = data + ({OPB} << 8); pc++; if (data & 0x100) {{ {DREAD("v - 0x100")} }} '
           f'{READ("v", "x")} nz = x; {LOOP}')
case(0xBE, 'data += y; clk += data >> 8; ' + LDX_ABS)
case(0xAE, LDX_ABS)
case(0x8C, f'v = {OP16}; {WRITE("v", "y")} pc += 2; {LOOP}')
case(0x8E, f'v = {OP16}; {WRITE("v", "x")} pc += 2; {LOOP}')

# Compare
CPX = f'nz = x - data; pc++; c = ~nz; nz &= 0xFF; {LOOP}'
CPY = f'nz = y - data; pc++; c = ~nz; nz &= 0xFF; {LOOP}'
case(0xEC, f'v = {OP16}; pc++; {READ("v", "data")} ' + CPX)
case(0xE4, f'data = {LOW("data")}; ' + CPX)
case(0xE0, CPX)
case(0xCC, f'v = {OP16}; pc++; {READ("v", "data")} ' + CPY)
case(0xC4, f'data = {LOW("data")}; ' + CPY)
case(0xC0, CPY)

# BIT
BIT_TAIL = f'st |= nz & 0x40; if (a & nz) {LOOP} nz = nz << 4 & 0x800; {LOOP}'
case(0x2C, f'v = {OP16}; pc += 2; st &= ~0x40; {READ_PPU("v", "nz")} ' + BIT_TAIL)
case(0x24, f'nz = {LOW("data")}; pc++; st &= ~0x40; ' + BIT_TAIL)

# Branches / jumps
case(0xD0, BRANCH('nz & 0xFF'))
case(0xF0, BRANCH('!(nz & 0xFF)'))
case(0x10, BRANCH('!(nz & 0x880)'))
case(0x30, BRANCH('nz & 0x880'))
case(0x50, BRANCH('!(st & 0x40)'))
case(0x70, BRANCH('st & 0x40'))
case(0xB0, BRANCH('c & 0x100'))
case(0x90, BRANCH('!(c & 0x100)'))
case(0x20, (f'v = pc + 1; pc = {OP16}; {LOW("0x100 | (sp - 1)")} = v >> 8; sp = (sp - 2) | 0x100; '
            f'{LOW("sp")} = v; {LOOP}'))
case(0x4C, f'ad = pc + 2; pc = {OP16}; if (pc < ad && ad - pc <= 16) {{ {IDLE} }} {LOOP}')
case(0x60, (f'pc = 1 + {LOW("sp")}; pc += {LOW("0x100 | (sp - 0xFF)")} * 0x100; '
            f'sp = (sp - 0xFE) | 0x100; {LOOP}'))
case(0x6C, (f'data = {OP16}; {READ("data", "pc")} {READ("(data & 0xFF00) | ((data + 1) & 0xFF)", "v")} '
            f'pc |= v << 8; {LOOP}'))

# Shifts / rotates
case(0x4A, f'c = 0; nz = (c >> 1) & 0x80; c = a << 8; nz |= a >> 1; a = nz; {LOOP}')
case(0x6A, f'nz = (c >> 1) & 0x80; c = a << 8; nz |= a >> 1; a = nz; {LOOP}')
case(0x0A, f'nz = a << 1; c = nz; a = nz & 0xFF; {LOOP}')
case(0x2A, f'nz = a << 1; t = (c >> 8) & 1; c = nz; nz |= t; a = nz & 0xFF; {LOOP}')
ROTATE_COMMON = f'pc++; {WRITE("data", "nz & 0xFF")} {LOOP}'
def rol_abs(dummy):
    s = f't = data; {ADD_PAGE} '
    if dummy:
        s += DREAD('data - (t & 0x100)') + ' '
    s += f'{READ("data", "t")} {WRITE("data", "t")} nz = (c >> 8) & 1; nz |= (c = t << 1); ' + ROTATE_COMMON
    return s
def ror_abs(dummy):
    s = f't = data; {ADD_PAGE} '
    if dummy:
        s += DREAD('data - (t & 0x100)') + ' '
    s += f'{READ("data", "t")} {WRITE("data", "t")} nz = ((c >> 1) & 0x80) | (t >> 1); c = t << 8; ' + ROTATE_COMMON
    return s
case(0x3E, 'data += x; ' + rol_abs(True))
case(0x1E, 'data += x; c = 0; ' + rol_abs(True))
case(0x0E, 'c = 0; ' + rol_abs(False))
case(0x2E, rol_abs(False))
case(0x7E, 'data += x; ' + ror_abs(True))
case(0x5E, 'data += x; c = 0; ' + ror_abs(True))
case(0x4E, 'c = 0; ' + ror_abs(False))
case(0x6E, ror_abs(False))
WRITE_NZ_ZP = f'pc++; {LOW("data")} = nz; {LOOP}'
ROR_ZP = f't = {LOW("data")}; nz = ((c >> 1) & 0x80) | (t >> 1); c = t << 8; ' + WRITE_NZ_ZP
ROL_ZP = f'nz = (c >> 8) & 1; nz |= (c = {LOW("data")} << 1); ' + WRITE_NZ_ZP
case(0x76, 'data = (data + x) & 0xFF; ' + ROR_ZP)
case(0x56, 'data = (data + x) & 0xFF; c = 0; ' + ROR_ZP)
case(0x46, 'c = 0; ' + ROR_ZP)
case(0x66, ROR_ZP)
case(0x36, 'data = (data + x) & 0xFF; ' + ROL_ZP)
case(0x16, 'data = (data + x) & 0xFF; c = 0; ' + ROL_ZP)
case(0x06, 'c = 0; ' + ROL_ZP)
case(0x26, ROL_ZP)

# Increment / decrement
case(0xE8, f'x = (nz = x + 1) & 0xFF; {LOOP}')
case(0xC8, f'y = (nz = y + 1) & 0xFF; {LOOP}')
case(0xCA, f'x = (nz = x - 1) & 0xFF; {LOOP}')
case(0x88, f'y = (nz = y - 1) & 0xFF; {LOOP}')
ADD_NZ_ZP = f'nz += {LOW("data")}; ' + WRITE_NZ_ZP
case(0xF6, 'data = (data + x) & 0xFF; nz = 1; ' + ADD_NZ_ZP)
case(0xE6, 'nz = 1; ' + ADD_NZ_ZP)
case(0xD6, 'data = (data + x) & 0xFF; nz = -1; ' + ADD_NZ_ZP)
case(0xC6, 'nz = -1; ' + ADD_NZ_ZP)
INC_COMMON = f'{READ("data", "t")} {WRITE("data", "t")} nz += t; pc += 2; {WRITE("data", "nz & 0xFF")} {LOOP}'
case(0xFE, f't = data + x; data = x + {OP16}; {DREAD("data - (t & 0x100)")} nz = 1; ' + INC_COMMON)
case(0xEE, f'data = {OP16}; nz = 1; ' + INC_COMMON)
case(0xDE, f't = data + x; data = x + {OP16}; {DREAD("data - (t & 0x100)")} nz = -1; ' + INC_COMMON)
case(0xCE, f'data = {OP16}; nz = -1; ' + INC_COMMON)

# Transfers / stack
case(0xAA, f'x = a; a = nz = x; {LOOP}')
case(0x8A, f'a = nz = x; {LOOP}')
case(0xA8, f'y = a; a = nz = y; {LOOP}')
case(0x98, f'a = nz = y; {LOOP}')
case(0x9A, f'sp = (x + 1) | 0x100; {LOOP}')
case(0xBA, f'x = nz = (sp - 1) & 0xFF; {LOOP}')
case(0x48, f'sp = (sp - 1) | 0x100; {LOW("sp")} = a; {LOOP}')
case(0x68, f'a = nz = {LOW("sp")}; sp = (sp - 0xFF) | 0x100; {LOOP}')
case(0x08, f'{CALC_STATUS} sp = (sp - 1) | 0x100; {LOW("sp")} = t | 0x30; {LOOP}')

# Interrupt flag handling (labels i_flag_changed / handle_cli / handle_sei)
I_FLAG_CHANGED = ('m[rSt] = st; lim = H[endO]; H[clO] = lim; '
                  f'if (lim <= H[irqO]) {LOOP} if (st & 0x04) {LOOP} lim = H[irqO]; H[clO] = lim; {LOOP}')
HANDLE_CLI = ('m[rSt] = st; t = H[endO]; if (clk < t) { v = H[irqO]; '
              f'if (t <= v) {LOOP} if (clk >= v) {{ v = clk + 1; H[irqO] = v; }} lim = v; H[clO] = lim; {LOOP} }} '
              'result = 2; break run;')
HANDLE_SEI = f'm[rSt] = st; lim = H[endO]; H[clO] = lim; if (clk < H[irqO]) {LOOP} result = 1; break run;'
case(0x40, (f't = {LOW("sp")}; pc = {LOW("0x100 | (sp - 0xFF)")}; pc |= {LOW("0x100 | (sp - 0xFE)")} * 0x100; '
            f'sp = (sp - 0xFD) | 0x100; data = st; {SET_STATUS("t")} if (!((data ^ st) & 0x04)) {LOOP} ' + I_FLAG_CHANGED))
case(0x28, (f't = {LOW("sp")}; sp = (sp - 0xFF) | 0x100; data = st; {SET_STATUS("t")} '
            f'if (!((data ^ st) & 0x04)) {LOOP} if (!(st & 0x04)) {{ {HANDLE_CLI} }} else {{ {HANDLE_SEI} }}'))
case(0x58, f'if (!(st & 0x04)) {LOOP} st &= ~0x04; ' + HANDLE_CLI)
case(0x78, f'if (st & 0x04) {LOOP} st |= 0x04; ' + HANDLE_SEI)
case(0x00, (f'pc++; {LOW("0x100 | (sp - 1)")} = pc >> 8; {LOW("0x100 | (sp - 2)")} = pc; {CALC_STATUS} '
            f'sp = (sp - 3) | 0x100; {LOW("sp")} = t | 0x30; '
            'v = H[cmi + 31]; pc = m[v + 0xFFFE] | m[v + 0xFFFF] << 8; st |= 0x04; ' + I_FLAG_CHANGED))

# Flags
case(0x38, f'c = ~0; {LOOP}')
case(0x18, f'c = 0; {LOOP}')
case(0xB8, f'st &= ~0x40; {LOOP}')
case(0xD8, f'st &= ~0x08; {LOOP}')
case(0xF8, f'st |= 0x08; {LOOP}')

# Unofficial
for op in (0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC):
    case(op, (f'data += x; clk += data >> 8; v = {OP16} + x; if (data & 0x100) {{ {DREAD("v - 0x100")} }} '
              f'{DREAD("v")} pc += 2; {LOOP}'))
case(0x0C, f'pc += 2; {LOOP}')
for op in (0x74, 0x04, 0x14, 0x34, 0x44, 0x54, 0x64, 0x80, 0x82, 0x89, 0xC2, 0xD4, 0xE2, 0xF4):
    case(op, f'pc++; {LOOP}')
for op in (0xEA, 0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA):
    case(op, LOOP)
LSR_A = f'c = 0; nz = (c >> 1) & 0x80; c = a << 8; nz |= a >> 1; a = nz; {LOOP}'
case(0x4B, 'nz = (a &= data); pc++; ' + LSR_A)
case(0x0B, f'nz = a &= data; c = a << 1; pc++; {LOOP}')
case(0x2B, f'nz = a &= data; c = a << 1; pc++; {LOOP}')
case(0x6B, (f'nz = a = (((data & a) >> 1) | ((c >> 1) & 0x80)) & 0xFF; c = a << 2; '
            f'st = (st & ~0x40) | ((a ^ a << 1) & 0x40); pc++; {LOOP}'))
case(0xAB, f'a = data; x = data; nz = data; pc++; {LOOP}')
LAX_IMM = f'nz = x = a = data; pc++; {LOOP}'
LAX_PTR = READ('data', 'data') + ' ' + LAX_IMM
case(0xA3, IND_X + ' ' + LAX_PTR)
case(0xB3, IND_Y(True, True) + ' ' + LAX_PTR)
case(0xB7, f'data = (data + y) & 0xFF; data = {LOW("data")}; ' + LAX_IMM)
case(0xA7, f'data = {LOW("data")}; ' + LAX_IMM)
case(0xBF, f'data += y; clk += data >> 8; t = data; {ADD_PAGE} if (t & 0x100) {{ {DREAD("data - 0x100")} }} ' + LAX_PTR)
case(0xAF, ADD_PAGE + ' ' + LAX_PTR)
SAX = f'{WRITE("data", "a & x")} pc++; {LOOP}'
case(0x83, IND_X + ' ' + SAX)
case(0x97, 'data = (data + y) & 0xFF; ' + SAX)
case(0x8F, ADD_PAGE + ' ' + SAX)
case(0x87, SAX)
case(0xCB, f'data = (a & x) - data; c = ((data >>> 0) <= 0xFF) ? 0x100 : 0; nz = x = data & 0xFF; pc++; {LOOP}')
case(0x93, f'{IND_Y(False, False)} pc++; {WRITE("data", "(a & x & ((data >> 8) + 1)) & 0xFF")} {LOOP}')
SH_PRE = f't = data; {ADD_PAGE} {DREAD("data - (t & 0x100)")} pc++; '
case(0x9F, 'data += y; ' + SH_PRE + f'{WRITE("data", "(a & x & ((data >> 8) + 1)) & 0xFF")} {LOOP}')
case(0x9E, 'data += y; ' + SH_PRE + f'if (!(t & 0x100)) {{ {WRITE("data", "(x & ((data >> 8) + 1)) & 0xFF")} }} {LOOP}')
case(0x9C, 'data += x; ' + SH_PRE + f'if (!(t & 0x100)) {{ {WRITE("data", "(y & ((data >> 8) + 1)) & 0xFF")} }} {LOOP}')
case(0x9B, 'data += y; ' + SH_PRE + f'sp = ((a & x) + 1) | 0x100; {WRITE("data", "(a & x & ((data >> 8) + 1)) & 0xFF")} {LOOP}')
case(0xBB, (f'data += y; clk += data >> 8; t = data; {ADD_PAGE} if (t & 0x100) {{ {DREAD("data - 0x100")} }} pc++; '
            f'a = (sp - 1) & 0xFF; {READ("data", "v")} x = a &= v; sp = (a + 1) | 0x100; {LOOP}'))

DEFAULT = ('t = ROWLEN[(op >> 2) & 7] >> ((op << 1) & 6) & 3; if (op === 0x9C) t = 3; '
           f'pc += t - 1; H[errO] = (H[errO] + 1) | 0; {LOOP}')
case(0xF2, f'if (pc > 0x10000) {{ pc = (pc - 1) & 0xFFFF; clk -= 2; {LOOP} }} ' + DEFAULT)

# ---- assemble ---------------------------------------------------------------
PROF_START = '\n    var profT0 = performance.now(), profC0 = 0, profV = 0, profCT = 0, profN = 0;' if PROFILE else ''
PROF_END = ('\n    HEAPF64[(_nes_prof_ptr() >> 3) + 1] += performance.now() - profT0; HEAPF64[(_nes_prof_ptr() >> 3) + 4] += 1; HEAPF64[(_nes_prof_ptr() >> 3) + 5] += profCT; HEAPF64[(_nes_prof_ptr() >> 3) + 6] += profN;' if PROFILE else '')

# One-byte instructions: no operand prefetch needed.
IMPLIED = {0x00, 0x08, 0x18, 0x28, 0x38, 0x40, 0x48, 0x58, 0x60, 0x68, 0x78, 0x88, 0x8A, 0x98,
           0x9A, 0xA8, 0xAA, 0xB8, 0xBA, 0xC8, 0xCA, 0xD8, 0xE8, 0xEA, 0xF8, 0x0A, 0x2A, 0x4A,
           0x6A, 0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA}

PROF_TABLES = ("\n  $SW2NES_POP: '(Module.sw2nesOpcodes = new Float64Array(256))',"
               "\n  $SW2NES_PCB: '(Module.sw2nesCbTime = new Float64Array(65536))',"
               "\n  $SW2NES_PCN: '(Module.sw2nesCbCount = new Float64Array(65536))',") if PROFILE else ''
PROF_DEPS = ", '$SW2NES_POP', '$SW2NES_PCB', '$SW2NES_PCN'" if PROFILE else ''

def build():
    lines = []
    for op in range(256):
        body = cases.get(op)
        if body is None:
            continue
        pre = f'clk += {CLOCK[op]}; '
        if op in IMPLIED:
            # Must never read the operand byte: data must be assigned before any use.
            first = re.search(r'\bdata\b(\s*=(?!=))?', body)
            assert first is None or first.group(1), hex(op)
        else:
            pre += 'data = m[pg + pc]; '
        lines.append(f'        case 0x{op:02X}: {{ {pre}{body} }}')
    switch = '\n'.join(lines)
    return f'''// GENERATED by tools/gen_cpu.py - do not edit. QuickNES 6502 run() for the
// jitless JS engine; see Nes_Cpu.cpp (SW2NES_JS_CPU) for the C side.
mergeInto(LibraryManager.library, {{
  $SW2NES_CT: 'new Uint8Array([{','.join(map(str, CLOCK))}])',
  $SW2NES_ROWLEN: 'new Uint8Array([0x95, 0x95, 0x95, 0xd5, 0x95, 0x95, 0xd5, 0xf5])',{PROF_TABLES}
  // Loop body [start, end) may only contain side-effect-free instructions:
  // zero-page/RAM (< $2000) reads, immediates, compares, branches, transfers,
  // flag ops, NOP, and JMP. No stores, stack, or I/O reads.
  $SW2NES_IDLE_OK: function (m, H, cmi, start, end) {{
    var a = start, op, n, hi;
    if (end - a > 16) return false;
    while (a < end) {{
      op = m[H[cmi + (a >> 11)] + a];
      switch (op) {{
        case 0xA5: case 0xA6: case 0xA4: case 0x24: case 0xC5: case 0xE4: case 0xC4: case 0x25: case 0x05: case 0x45:
        case 0xA9: case 0xA2: case 0xA0: case 0x29: case 0x09: case 0x49: case 0xC9: case 0xE0: case 0xC0:
          n = 2; break;
        case 0x10: case 0x30: case 0x50: case 0x70: case 0x90: case 0xB0: case 0xD0: case 0xF0:
          // Branch targets must stay inside the loop, so no other code runs.
          hi = a + 2 + ((m[H[cmi + ((a + 1) >> 11)] + a + 1] << 24) >> 24);
          if (hi < start || hi > end) return false; n = 2; break;
        case 0xAD: case 0xAE: case 0xAC: case 0x2C: case 0xCD: case 0xEC: case 0xCC: case 0x2D: case 0x0D: case 0x4D:
          hi = m[H[cmi + ((a + 2) >> 11)] + a + 2]; if (hi >= 0x20) return false; n = 3; break;
        case 0x4C:
          hi = m[H[cmi + ((a + 1) >> 11)] + a + 1] | m[H[cmi + ((a + 2) >> 11)] + a + 2] << 8;
          if (hi < start || hi > end) return false; n = 3; break;
        case 0xEA: case 0x18: case 0x38: case 0xB8: case 0xAA: case 0x8A: case 0xA8: case 0x98: n = 1; break;
        default: return false;
      }}
      a += n;
    }}
    return a === end;
  }},
  sw2nes_js_cpu_run__deps: ['$SW2NES_CT', '$SW2NES_ROWLEN', '$SW2NES_IDLE_OK'{PROF_DEPS}],
  sw2nes_js_cpu_run: function (cpu, end, layout) {{
    var m = HEAPU8, H = HEAP32, L = layout >> 2;
    var CT = SW2NES_CT, ROWLEN = SW2NES_ROWLEN;
    if (H[L + 13] !== 4 || H[L + 14] !== 4 || H[L + 15] !== 4) throw Error('Unexpected QuickNES CPU layout');
    var cmi = (cpu + H[L]) >> 2, clO = (cpu + H[L + 1]) >> 2, ccO = (cpu + H[L + 2]) >> 2;
    var irqO = (cpu + H[L + 3]) >> 2, endO = (cpu + H[L + 4]) >> 2, errO = (cpu + H[L + 5]) >> 2;
    var rPc = (cpu + H[L + 6]) >> 2, rA = cpu + H[L + 7], rX = cpu + H[L + 8], rY = cpu + H[L + 9];
    var rSt = cpu + H[L + 10], rSp = cpu + H[L + 11], lm = cpu + H[L + 12];
    if (H[L + 23] !== 12) throw Error('Unexpected QuickNES core layout');
    var ckO = (cpu + H[L + 16]) >> 2, ctO = (cpu + H[L + 17]) >> 2, srR = (cpu + H[L + 18]) >> 2, swO = (cpu + H[L + 19]) >> 2;
    var drm = cpu + H[L + 20], dwm = cpu + H[L + 21], srm = H[L + 22];
    var clk = 0, lim = H[clO], result = 0;{PROF_START}
    var pc = H[rPc], sp = (m[rSp] + 1) | 0x100, a = m[rA], x = m[rX], y = m[rY];
    var st, c, nz, t = m[rSt];
    {SET_STATUS('t')}
    var pg = 0, cp = -1, op = 0, data = 0, ad = 0, v = 0, msb = 0;
    var iT = -1, iClk = 0, iA = 0, iX = 0, iY = 0, iNZ = 0, iC = 0, iST = 0, iSP = 0;
    run: for (;;) {{
      if ((pc >> 11) !== cp) {{ cp = pc >> 11; pg = H[cmi + cp]; }}
      op = m[pg + pc];
      pc++;{'profN++; SW2NES_POP[op]++;' if PROFILE else ''}
      if (clk >= lim) {{ pc--; break run; }}
      switch (op) {{
{switch}
        default: {{ clk += CT[op]; {DEFAULT} }}
      }}
    }}
    {CALC_STATUS}
    m[rSt] = t;
    H[ccO] = clk;
    H[rPc] = pc;
    m[rSp] = (sp - 1) & 0xFF;
    m[rA] = a; m[rX] = x; m[rY] = y;
    H[irqO] = 0x40000000;{PROF_END}
    return result;
  }}
}});
'''

def coverage():
    explicit = set(cases)
    missing = sorted(set(range(256)) - explicit)
    return missing

if __name__ == '__main__':
    print('default-path opcodes:', ' '.join('%02X' % o for o in coverage()))
    out = Path(__file__).resolve().parents[1] / 'native/cpu_lib.js'
    out.write_text(build())
    print(f'wrote {out} ({len(cases)} explicit opcodes)')
