#pragma once

// Nes_Emu 0.7.0. http://www.slack.net/~ant/

#include "Nes_Mapper.h"

#include <string.h>
#include "Nes_Core.h"

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

// 264 or less breaks Gargoyle's Quest II
// 267 or less breaks Magician
int const irq_fine_tune = 268;
nes_time_t const first_scanline = 20 * Nes_Ppu::scanline_len + irq_fine_tune;
nes_time_t const last_scanline = first_scanline + 240 * Nes_Ppu::scanline_len;

// MMC3

class Mapper004 : public Nes_Mapper, mmc3_state_t {
public:
	Mapper004()
	{
		mmc3_state_t* state = this;
		register_state( state, sizeof *state );
	}
	
	virtual void reset_state()
	{
		memcpy( banks, "\0\2\4\5\6\7\0\1", sizeof banks );
		
		counter_just_clocked = 0;
		next_time = 0;
		mirror = 1;

		/* Cart specified vertical mirroring */
		if ( cart().mirroring() & 1 )
			mirror = 0;
	}
	
	void start_frame() { next_time = first_scanline; }
	
	virtual void apply_mapping()
	{
		write( 0, 0xA000, mirror );
		write( 0, 0xA001, sram_mode );
		update_chr_banks();
		update_prg_banks();
		start_frame();
	}
	
	void clock_counter()
	{
		if ( counter_just_clocked )
			counter_just_clocked--;
		
		if ( !irq_ctr-- )
			irq_ctr = irq_latch;
		
		if ( irq_ctr == 0 )
			irq_flag = irq_enabled;
	}
	
	
	virtual void a12_clocked()
	{
		clock_counter();
		if ( irq_enabled )
			irq_changed();
	}
	
	virtual void end_frame( nes_time_t end_time )
	{
		run_until( end_time );
		start_frame();
	}
	
	virtual nes_time_t next_irq( nes_time_t present )
	{
		run_until( present );
		
		if ( !irq_enabled )
			return no_irq;
		
		if ( irq_flag )
			return 0;
		
		if ( !ppu_enabled() )
			return no_irq;
		
		int remain = irq_ctr - 1;
		if ( remain < 0 )
			remain = irq_latch;
		
		long time = remain * 341L + next_time;
		if ( time > last_scanline )
			return no_irq;
		
		return time / ppu_overclock + 1;
	}

	void run_until( nes_time_t end_time )
	{
		bool bg_enabled = ppu_enabled();

		// The MMC3 IRQ counter is clocked by rising edges on PPU A12.
		// During normal rendering, A12 transitions once per scanline IFF
		// the background and sprite pattern tables are in different
		// halves of CHR (different A12 values, controlled by PPUCTRL
		// bits 3-4). If both BG and sprites use the same pattern table
		// half, A12 doesn't transition during visible rendering and the
		// IRQ counter doesn't clock.
		//
		// Mega Man 3's pause menu (issue #76) configures both BG and
		// sprites at $1000 expecting no IRQ counter clocking during
		// visible scanlines -- the game relies on the IRQ NOT firing so
		// the HUD's nametable scroll-split stays put. Without this check
		// QuickNES over-clocks the counter, fires extra IRQs each of
		// which reapplies the scroll, and the same HUD row renders
		// multiple times stacked.
		//
		// 8x16 sprite mode (PPUCTRL bit 5) uses per-tile pattern table
		// selection so A12 may still transition regardless of bits 3-4;
		// in that mode we conservatively keep the per-scanline clocking.
		// Per-tile sprite-pattern detection would need OAM inspection
		// which isn't worth it here.
		int ctrl                  = emu().ppu.w2000;
		bool sprite_8x16          = (ctrl & 0x20) != 0;
		bool same_pattern_table   = ((ctrl & 0x18) == 0x00) || ((ctrl & 0x18) == 0x18);
		bool clock_per_scanline   = bg_enabled && (!same_pattern_table || sprite_8x16);

		if (next_time < 0) next_time = 0;

		end_time *= ppu_overclock;
		while ( next_time < end_time && next_time <= last_scanline )
		{
			if ( clock_per_scanline )
				clock_counter();
			next_time += Nes_Ppu::scanline_len;
		}
	}

	void update_chr_banks()
	{
		int chr_xor = (mode >> 7 & 1) * 0x1000;
		set_chr_bank( 0x0000 ^ chr_xor, bank_2k, banks [0] >> 1 );
		set_chr_bank( 0x0800 ^ chr_xor, bank_2k, banks [1] >> 1 );
		set_chr_bank( 0x1000 ^ chr_xor, bank_1k, banks [2] );
		set_chr_bank( 0x1400 ^ chr_xor, bank_1k, banks [3] );
		set_chr_bank( 0x1800 ^ chr_xor, bank_1k, banks [4] );
		set_chr_bank( 0x1c00 ^ chr_xor, bank_1k, banks [5] );
	}

	void update_prg_banks()
	{
		set_prg_bank( 0xA000, bank_8k, banks [7] );
		nes_addr_t addr = 0x8000 + 0x4000 * (mode >> 6 & 1);
		set_prg_bank( addr, bank_8k, banks [6] );
		set_prg_bank( addr ^ 0x4000, bank_8k, last_bank - 1 );
	}

	void write_irq( nes_addr_t addr, int data )
	{
		switch ( addr & 0xE001 )
		{
		case 0xC000:
			irq_latch = data;
			break;
		
		case 0xC001:
			/* MMC3 IRQ counter pathological behavior triggered if
			* counter_just_clocked is 1 */
			counter_just_clocked = 2;
			irq_ctr = 0;
			break;
		
		case 0xE000:
			irq_flag = false;
			irq_enabled = false;
			break;
		
		case 0xE001:
			irq_enabled = true;
			break;
		}
		if ( irq_enabled )
			irq_changed();
	}

	void write( nes_time_t time, nes_addr_t addr, int data )
	{
		switch ( addr & 0xE001 )
		{
		case 0x8000: {
			int changed = mode ^ data;
			mode = data;
			// avoid unnecessary bank updates
			if ( changed & 0x80 )
				update_chr_banks();
			if ( changed & 0x40 )
				update_prg_banks();
			break;
		}
		
		case 0x8001: {
			int bank = mode & 7;
			banks [bank] = data;
			if ( bank < 6 )
				update_chr_banks();
			else
				update_prg_banks();
			break;
		}
		
		case 0xA000:
			mirror = data;
			if ( !(cart().mirroring() & 0x08) )
			{
				if ( mirror & 1 )
					mirror_horiz();
				else
					mirror_vert();
			}
			break;
		
		case 0xA001:
			sram_mode = data;
			
			// Startropics 1 & 2 use MMC6 and always enable low 512 bytes of SRAM
			if ( (data & 0x3F) == 0x30 )
				enable_sram( true );
			else
				enable_sram( data & 0x80, data & 0x40 );
			break;
		
		default:
			run_until( time );
			write_irq( addr, data );
			break;
		}
	}

	nes_time_t next_time;
	int counter_just_clocked; // used only for debugging
};

