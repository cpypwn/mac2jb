
// Nes_Emu 0.7.0. http://www.slack.net/~ant/

#include "Nes_Fme7_Apu.h"

#include <string.h>

/* Copyright (C) 2003-2006 Shay Green. This module is free software; you
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

void Nes_Fme7_Apu::reset()
{
	last_time = 0;
	
	for ( int i = 0; i < osc_count; i++ )
		oscs [i].last_amp = 0;
	
	fme7_apu_state_t* state = this;
	memset( state, 0, sizeof *state );
}

unsigned char Nes_Fme7_Apu::amp_table [16] =
{
	/* Sunsoft 5B/FME7 logarithmic volume levels, baked to integers.
	   Each entry is (unsigned char)(coeff * amp_range + 0.5) with amp_range==192
	   and coeff = { .0000, .0078, .0110, .0156, .0221, .0312, .0441, .0624,
	   .0883, .1249, .1766, .2498, .3534, .4998, .7070, 1.0000 }. Precomputed so
	   the table carries no floating point. */
	0,  1,  2,  3,
	4,  6,  8,  12,
	17, 24, 34, 48,
	68, 96, 136, 192
};

void Nes_Fme7_Apu::run_until( blip_time_t end_time )
{
	for ( int index = 0; index < osc_count; index++ )
	{
		int mode = regs [7] >> index;
		int vol_mode = regs [010 + index];
		int volume = amp_table [vol_mode & 0x0f];
		
		if ( !oscs [index].output )
			continue;
		
		if ( (mode & 001) | (vol_mode & 0x10) )
			volume = 0; // noise and envelope aren't supported
		
		// period
		int const period_factor = 16;
		unsigned period = (regs [index * 2 + 1] & 0x0f) * 0x100 * period_factor +
				regs [index * 2] * period_factor;
		if ( period < 50 ) // around 22 kHz
		{
			volume = 0;
			if ( !period ) // on my AY-3-8910A, period doesn't have extra one added
				period = period_factor;
		}
		
		// current amplitude
		int amp = volume;
		if ( !phases [index] )
			amp = 0;
		int delta = amp - oscs [index].last_amp;
		if ( delta )
		{
			oscs [index].last_amp = amp;
			synth.offset( last_time, delta, oscs [index].output );
		}
		
		blip_time_t time = last_time + delays [index];
		if ( time < end_time )
		{
			Blip_Buffer* const osc_output = oscs [index].output;
			int delta = amp * 2 - volume;
			
			if ( volume )
			{
				do
				{
					delta = -delta;
					synth.offset_inline( time, delta, osc_output );
					time += period;
				}
				while ( time < end_time );
				
				oscs [index].last_amp = (delta + volume) >> 1;
				phases [index] = (delta > 0);
			}
			else
			{
				// maintain phase when silent
				int count = (end_time - time + period - 1) / period;
				phases [index] ^= count & 1;
				time += (long) count * period;
			}
		}
		
		delays [index] = time - end_time;
	}
	
	last_time = end_time;
}
