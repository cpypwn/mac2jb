#pragma once

// NES MMC5 (mapper 5)
//
// Historically this core implemented only enough of the MMC5 to run
// Castlevania 3 (U). This version fleshes it out to cover the rest of the
// commercial library and common homebrew: the four PRG banking modes, the
// four CHR banking modes with the upper-bit register, PRG-RAM (work/save RAM)
// at $6000 with the write-protect handshake, the hardware multiplier,
// nametable-mode selection, and the scanline IRQ.
//
// Some MMC5 features cannot be reproduced faithfully in this core because its
// PPU exposes no per-tile fetch hook: extended-attribute mode (ExGrafix), the
// vertical split window, and a separate 8x16-sprite CHR bank set. Games that
// lean on those for cosmetic effects still run, but those specific effects are
// approximated or absent. The MMC5's two extra pulse channels and PCM are not
// emulated. PRG-RAM windowed into $8000-$DFFF (bit 7 clear in $5114-$5116) is
// not used by any known game and falls back to leaving ROM mapped there.

// Nes_Emu 0.7.0. http://www.slack.net/~ant/

#include "Nes_Mapper.h"

#include "Nes_Core.h"
#include <string.h>

/* Copyright (C) 2004-2006 Shay Green. This module is free software; you
can redistribute it and/or modify it under the terms of the GNU Lesser
General Public License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version. This
module is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for
more details. You should have received a copy of the GNU Lesser General
Public License along with this module; if not, write to the Free Software
Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA 02111-1307 USA */

#include "blargg_source.h"


// Registered (savestated) MMC5 state. All bytes, so no padding; kept well
// under max_mapper_state_size (512). ExRAM is deliberately NOT part of this
// struct: at 1 KiB it would blow the state budget, and the games that read it
// back are the ExGrafix titles this core can't fully render regardless.
struct mmc5_state_t
{
	uint8_t prg_mode;         // $5100 & 3
	uint8_t chr_mode;         // $5101 & 3
	uint8_t ram_protect1;     // $5102 & 3
	uint8_t ram_protect2;     // $5103 & 3
	uint8_t exram_mode;       // $5104 & 3
	uint8_t nametable_mode;   // $5105
	uint8_t fill_tile;        // $5106
	uint8_t fill_attr;        // $5107 & 3
	uint8_t prg_banks [5];    // $5113-$5117
	uint8_t chr_banks [12];   // $5120-$512B
	uint8_t chr_upper;        // $5130 & 3
	uint8_t mul_a;            // $5205
	uint8_t mul_b;            // $5206
	uint8_t irq_enabled;      // $5204
	uint8_t irq_scanline;     // $5203
};
BOOST_STATIC_ASSERT( sizeof (mmc5_state_t) == 30 );

// MMC5

class Mapper005 : public Nes_Mapper, mmc5_state_t {
public:
	Mapper005()
	{
		mmc5_state_t* state = this;
		register_state( state, sizeof *state );
	}

	virtual void reset_state()
	{
		irq_time = no_irq;

		prg_mode = 3;          // power-on: four 8K banks, last fixed
		chr_mode = 0;
		ram_protect1 = 0;
		ram_protect2 = 0;
		exram_mode = 0;
		nametable_mode = 0;
		fill_tile = 0;
		fill_attr = 0;
		chr_upper = 0;
		mul_a = mul_b = 0xff;
		irq_enabled = 0;
		irq_scanline = 0;

		prg_banks [0] = 0;      // $5113
		prg_banks [1] = 0x80;   // $5114 (ROM)
		prg_banks [2] = 0x80;   // $5115 (ROM)
		prg_banks [3] = 0x80;   // $5116 (ROM)
		prg_banks [4] = 0x7f;   // $5117 (ROM, last bank)

		for ( int i = 0; i < 12; i++ )
			chr_banks [i] = 0;

		memset( exram, 0, sizeof exram );
	}

	virtual void read_state( mapper_state_t const& in )
	{
		Nes_Mapper::read_state( in );
		irq_time = no_irq;
	}

	enum { regs_addr = 0x5100 };

	// CPU time at which the scanline IRQ counter reaches compare scanline 'sl'.
	// Returns no_irq for compares that never occur within visible rendering.
	nes_time_t irq_compare_time( int sl ) const
	{
		if ( sl && sl < 240 )
			return (341 * 21 + 128 + (sl * 341)) / 3;
		return no_irq;
	}

	virtual nes_time_t next_irq( nes_time_t )
	{
		if ( irq_enabled & 0x80 )
			return irq_time;

		return no_irq;
	}

	// Re-arm the scanline IRQ for the next frame. The MMC5 counter runs every
	// frame and re-asserts at the compare scanline; a $5204 read acknowledges
	// (de-asserts) the current assertion but does not stop the counter. Games
	// that reprogram $5203 each frame (Castlevania 3) overwrite this anyway, so
	// this only changes behaviour for games that arm once and rely on the
	// counter re-firing (Metal Slader Glory's message-window raster split).
	virtual void end_frame( nes_time_t )
	{
		irq_time = irq_compare_time( irq_scanline );
		irq_changed();
	}

	// -- PRG banking ---------------------------------------------------------

	// A $5114-$5117 value: bit 7 set selects ROM, clear selects PRG-RAM.
	// $5117 is always ROM. Only ROM windows above $6000 are honored (see file
	// header); a RAM selection there leaves the previous ROM mapping in place.
	void set_prg_reg( int slot_addr, bank_size_t size, int value )
	{
		if ( value & 0x80 ) // ROM
			set_prg_bank( slot_addr, size, (value & 0x7f) >> (size - bank_8k) );
		// RAM window above $6000: not honored (no known user); leave mapping.
	}

	void sync_prg()
	{
		// $6000 window is always PRG-RAM (this core's single 8K SRAM chip).
		enable_sram( true, ram_write_protected() );

		switch ( prg_mode )
		{
		case 0: // one 32K ROM bank from $5117
			set_prg_bank( 0x8000, bank_32k, (prg_banks [4] & 0x7f) >> 2 );
			break;

		case 1: // two 16K: $5115 at $8000, $5117 at $C000
			set_prg_reg( 0x8000, bank_16k, prg_banks [2] );
			set_prg_bank( 0xC000, bank_16k, (prg_banks [4] & 0x7f) >> 1 );
			break;

		case 2: // 16K $5115 @ $8000, 8K $5116 @ $C000, 8K $5117 @ $E000
			set_prg_reg( 0x8000, bank_16k, prg_banks [2] );
			set_prg_reg( 0xC000, bank_8k,  prg_banks [3] );
			set_prg_bank( 0xE000, bank_8k, prg_banks [4] & 0x7f );
			break;

		case 3: // four 8K: $5114 $5115 $5116 $5117
			set_prg_reg( 0x8000, bank_8k, prg_banks [1] );
			set_prg_reg( 0xA000, bank_8k, prg_banks [2] );
			set_prg_reg( 0xC000, bank_8k, prg_banks [3] );
			set_prg_bank( 0xE000, bank_8k, prg_banks [4] & 0x7f );
			break;
		}
	}

	// -- CHR banking (background set) ----------------------------------------

	void sync_chr()
	{
		// $5130 bits 0-1 are the upper CHR address bits (A16/A17). set_chr_bank
		// scales the bank index by the bank size, and the MMC5 registers are
		// already expressed in units of their bank size, so the register value
		// (plus the upper bits shifted to that unit) is passed directly.
		int up = chr_upper;

		switch ( chr_mode )
		{
		case 0: // 8K
			set_chr_bank( 0x0000, bank_8k, chr_banks [7] | (up << 8) );
			break;

		case 1: // 4K
			set_chr_bank( 0x0000, bank_4k, chr_banks [3] | (up << 8) );
			set_chr_bank( 0x1000, bank_4k, chr_banks [7] | (up << 8) );
			break;

		case 2: // 2K
			set_chr_bank( 0x0000, bank_2k, chr_banks [1] | (up << 8) );
			set_chr_bank( 0x0800, bank_2k, chr_banks [3] | (up << 8) );
			set_chr_bank( 0x1000, bank_2k, chr_banks [5] | (up << 8) );
			set_chr_bank( 0x1800, bank_2k, chr_banks [7] | (up << 8) );
			break;

		case 3: // 1K
			// Background pattern space is filled from both CHR sets, matching
			// the original Castlevania 3 mapping: $5120-$5123 -> the low four
			// 1 KiB slots, $5128-$512B -> the high four. (A per-fetch sprite/bg
			// split is not possible in this PPU.)
			set_chr_bank( 0x0000, bank_1k, chr_banks [0] | (up << 8) );
			set_chr_bank( 0x0400, bank_1k, chr_banks [1] | (up << 8) );
			set_chr_bank( 0x0800, bank_1k, chr_banks [2] | (up << 8) );
			set_chr_bank( 0x0c00, bank_1k, chr_banks [3] | (up << 8) );
			set_chr_bank( 0x1000, bank_1k, chr_banks [8]  | (up << 8) );
			set_chr_bank( 0x1400, bank_1k, chr_banks [9]  | (up << 8) );
			set_chr_bank( 0x1800, bank_1k, chr_banks [10] | (up << 8) );
			set_chr_bank( 0x1c00, bank_1k, chr_banks [11] | (up << 8) );
			break;
		}
	}

	// Enable ExGrafix (extended-attribute) background rendering in the PPU when
	// the MMC5 is in ExRAM mode 1; otherwise leave normal rendering in force.
	// In mode 1 each background tile takes its 4 KiB CHR bank and palette from
	// the per-tile ExRAM byte, which the PPU can only honour through this hook.
	void sync_exgrafix()
	{
		if ( exram_mode == 1 )
			set_exgrafix( exram, chr_upper );
		else
			set_exgrafix( NULL, 0 );
	}

	// -- Nametables / mirroring ---------------------------------------------

	void sync_mirror()
	{
		// $5105: two bits per slot. 0/1 select CIRAM pages; 2 (ExRAM) and 3
		// (fill) can't be pointed at real sources here, so approximate with
		// CIRAM page 0.
		int m = nametable_mode;
		int p [4];
		for ( int i = 0; i < 4; i++ )
		{
			int sel = (m >> (i * 2)) & 3;
			p [i] = (sel == 1) ? 1 : 0;
		}
		mirror_manual( p [0], p [1], p [2], p [3] );
	}

	// -----------------------------------------------------------------------

	virtual bool write_intercepted( nes_time_t time, nes_addr_t addr, int data )
	{
		unsigned reg = addr - regs_addr;
		if ( reg < 0x30 )
		{
			switch ( reg )
			{
			case 0x00: prg_mode     = data & 3; sync_prg();   break; // $5100
			case 0x01: chr_mode     = data & 3; sync_chr();   break; // $5101
			case 0x02: ram_protect1 = data & 3; sync_prg();   break; // $5102
			case 0x03: ram_protect2 = data & 3; sync_prg();   break; // $5103
			case 0x04: exram_mode   = data & 3; sync_exgrafix(); break; // $5104
			case 0x05: nametable_mode = data; sync_mirror();  break; // $5105
			case 0x06: fill_tile    = data;                   break; // $5106
			case 0x07: fill_attr    = data & 3;               break; // $5107

			case 0x13: prg_banks [0] = data; sync_prg(); break; // $5113
			case 0x14: prg_banks [1] = data; sync_prg(); break; // $5114
			case 0x15: prg_banks [2] = data; sync_prg(); break; // $5115
			case 0x16: prg_banks [3] = data; sync_prg(); break; // $5116
			case 0x17: prg_banks [4] = data; sync_prg(); break; // $5117

			case 0x20: case 0x21: case 0x22: case 0x23:
			case 0x24: case 0x25: case 0x26: case 0x27:
				chr_banks [reg - 0x20] = data;
				sync_chr();
				break;

			case 0x28: case 0x29: case 0x2a: case 0x2b:
				chr_banks [8 + (reg - 0x28)] = data;
				sync_chr();
				break;

			case 0x30: chr_upper = data & 3; sync_chr(); sync_exgrafix(); break; // $5130
			}
		}
		else if ( addr == 0x5203 ) // IRQ scanline compare
		{
			irq_scanline = data;
			irq_time = no_irq;
			if ( data && data < 240 )
			{
				irq_time = (341 * 21 + 128 + (data * 341)) / 3;
				if ( irq_time < time )
					irq_time = no_irq;
			}
			irq_changed();
		}
		else if ( addr == 0x5204 ) // IRQ enable
		{
			irq_enabled = data;
			irq_changed();
		}
		else if ( addr == 0x5205 ) // multiplicand
		{
			mul_a = data;
		}
		else if ( addr == 0x5206 ) // multiplier
		{
			mul_b = data;
		}
		else if ( (unsigned) (addr - 0x5c00) < 0x400 ) // ExRAM
		{
			exram [addr - 0x5c00] = data;
		}
		else
		{
			return false;
		}

		return true;
	}

	virtual int read( nes_time_t time, nes_addr_t addr )
	{
		if ( addr == 0x5204 )
		{
			// MMC5 IRQ/status. bit 7 = scanline IRQ pending, bit 6 = "in
			// frame" (PPU currently rendering a visible scanline). This core has no
			// per-scanline hook, so both bits are derived from the current
			// time: the visible-render window runs from scanline 0 to 239,
			// and the IRQ is pending once that window has reached the compare
			// scanline programmed at $5203 (while enabled).
			int status = 0;

			// Mapper time is in CPU cycles; a PPU scanline is 341/3 cycles and
			// visible rendering starts after the 21 pre-render/vblank lines
			// (matching the $5203 -> irq_time conversion above).
			nes_time_t frame_start = (341 * 21 + 128) / 3;
			nes_time_t frame_end   = (341 * 21 + 128 + 240 * 341) / 3;
			if ( ppu_enabled() && time >= frame_start && time < frame_end )
				status |= 0x40; // in frame

			// Report the pending flag and acknowledge it: clearing irq_time
			// de-asserts the IRQ line for the rest of this frame (so a polling
			// game like Metal Slader Glory can proceed past its wait loop),
			// while end_frame re-arms the counter for the next frame. Games
			// that re-arm explicitly via $5203 (Castlevania 3) are unaffected.
			if ( (irq_enabled & 0x80) && irq_time != no_irq && time >= irq_time )
			{
				status |= 0x80;
				irq_time = no_irq;
				irq_changed();
			}

			return status;
		}
		if ( addr == 0x5205 )
			return (mul_a * mul_b) & 0xff;
		if ( addr == 0x5206 )
			return (mul_a * mul_b) >> 8;
		if ( (unsigned) (addr - 0x5c00) < 0x400 )
			return exram [addr - 0x5c00];
		return -1; // not handled / open bus
	}

	void apply_mapping()
	{
		// Intercept the whole $5000-$5FFF register space so PRG-RAM control,
		// the multiplier, IRQ, and ExRAM all reach the mapper (reads too, for
		// the multiplier and ExRAM).
		intercept_writes( 0x5000, 0x1000 );
		intercept_reads( 0x5000, 0x1000 );

		sync_prg();
		sync_chr();
		sync_mirror();

		// Set ExGrafix state directly (no mid-frame render flush needed here).
		if ( exram_mode == 1 )
			emu().ppu.set_exgrafix( exram, chr_upper );
		else
			emu().ppu.set_exgrafix( NULL, 0 );
	}

	virtual void write( nes_time_t, nes_addr_t, int ) { }

	nes_time_t irq_time;

private:
	uint8_t exram [0x400]; // 1 KiB extended RAM (not savestated; see above)

	bool ram_write_protected() const
	{
		// $5102 must hold %10 and $5103 must hold %01 to allow PRG-RAM writes.
		return !( ram_protect1 == 2 && ram_protect2 == 1 );
	}
};
