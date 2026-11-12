/* nes_ntsc 0.2.2. http://www.slack.net/~ant/ */

#include "nes_ntsc.h"

/* Copyright (C) 2006-2007 Shay Green. This module is free software; you
can redistribute it and/or modify it under the terms of the GNU Lesser
General Public License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version. This
module is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more
details. You should have received a copy of the GNU Lesser General Public
License along with this module; if not, write to the Free Software Foundation,
Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA */

nes_ntsc_setup_t const nes_ntsc_monochrome = { 0,-1, 0, 0,.2,  0,.2,-.2,-.2,-1, 1, 0, 0, 0 };
nes_ntsc_setup_t const nes_ntsc_composite  = { 0, 0, 0, 0, 0,  0, 0,  0,  0, 0, 1, 0, 0, 0 };
nes_ntsc_setup_t const nes_ntsc_svideo     = { 0, 0, 0, 0,.2,  0,.2, -1, -1, 0, 1, 0, 0, 0 };
nes_ntsc_setup_t const nes_ntsc_rgb        = { 0, 0, 0, 0,.2,  0,.7, -1, -1,-1, 1, 0, 0, 0 };


/* ---- Deterministic fixed-point palette generation (Q30) ---- */
#if defined(_MSC_VER)
typedef __int64 ntsc_i64;
#else
typedef long long ntsc_i64;
#endif

#define NES_NTSC_QFX      30
#define NES_NTSC_FX_ONE   ( ( (ntsc_i64) 1 ) << NES_NTSC_QFX )
#define NES_NTSC_FX_HALF  ( ( (ntsc_i64) 1 ) << ( NES_NTSC_QFX - 1 ) )

/* round-to-nearest arithmetic right shift by NES_NTSC_QFX, ties away from zero */
static ntsc_i64 nes_ntsc_fx_rsh( ntsc_i64 v )
{
	if ( v >= 0 )
		return ( v + NES_NTSC_FX_HALF ) >> NES_NTSC_QFX;
	return -( ( -v + NES_NTSC_FX_HALF ) >> NES_NTSC_QFX );
}
#define NES_NTSC_FX_MUL( a, b ) nes_ntsc_fx_rsh( (ntsc_i64)(a) * (ntsc_i64)(b) )

#include "nes_ntsc_palette_fixed.h"

/* Generate the 512-entry (64 base * 8 emphasis) RGB palette, 3 bytes/entry,
   from a 64-entry base RGB palette using the standard NES decoder with no
   hue/saturation/contrast/brightness/gamma adjustment.  Byte-exact to the
   exact rational result of the reference pipeline and deterministic across
   platforms (no floating point, no libm). */
static void nes_ntsc_palette_fixed( unsigned char const* base_palette,
		unsigned char* palette_out )
{
	int entry;
	for ( entry = 0; entry < 64 * 8; entry++ )
	{
		int level = ( entry >> 4 ) & 0x03;
		int color = entry & 0x0F;
		ntsc_i64 lo = nes_ntsc_lo_q30 [level];
		ntsc_i64 hi = nes_ntsc_hi_q30 [level];
		ntsc_i64 y, i, q;
		int tint, k;
		unsigned rgb;
		ntsc_i64 comp [3];
		unsigned char const* in;

		if ( color == 0 )    lo = hi;
		if ( color == 0x0D ) hi = lo;
		if ( color > 0x0D )  hi = lo = 0;

		in = &base_palette [(entry & 0x3F) * 3];
		{
			ntsc_i64 r = nes_ntsc_div255_q30 [in [0]];
			ntsc_i64 g = nes_ntsc_div255_q30 [in [1]];
			ntsc_i64 b = nes_ntsc_div255_q30 [in [2]];
			y = nes_ntsc_fx_rsh( NTSCFX_qRY*r + NTSCFX_qGY*g + NTSCFX_qBY*b );
			i = nes_ntsc_fx_rsh( NTSCFX_qRI*r + NTSCFX_qGI*g + NTSCFX_qBI*b );
			q = nes_ntsc_fx_rsh( NTSCFX_qRQ*r + NTSCFX_qGQ*g + NTSCFX_qBQ*b );
		}

		tint = ( entry >> 6 ) & 7;
		if ( tint && color <= 0x0D )
		{
			if ( tint == 7 )
			{
				y = NES_NTSC_FX_MUL( y, NTSCFX_qam113 ) - NTSCFX_qas113;
			}
			else
			{
				static const int tints [8] = { 0, 6, 10, 8, 2, 4, 0, 0 };
				int tc = tints [tint];
				ntsc_i64 sat = NES_NTSC_FX_MUL( hi, NTSCFX_qsm ) + NTSCFX_qss;
				y -= NES_NTSC_FX_MUL( sat, NTSCFX_q05 );
				if ( tint >= 3 && tint != 4 )
				{
					sat = NES_NTSC_FX_MUL( sat, NTSCFX_q06 );
					y -= sat;
				}
				i += NES_NTSC_FX_MUL( nes_ntsc_phases_q30 [tc],     sat );
				q += NES_NTSC_FX_MUL( nes_ntsc_phases_q30 [tc + 3], sat );
			}
		}

		y += NTSCFX_qbright;

		/* single baked matrix P = DEC*ENC*DEC (post-emphasis path is linear
		   because gamma is a no-op here), then scale by 256, add offset and
		   truncate toward zero */
		for ( k = 0; k < 3; k++ )
		{
			ntsc_i64 D = nes_ntsc_fx_rsh( nes_ntsc_P_q30 [k][0]*y +
					nes_ntsc_P_q30 [k][1]*i + nes_ntsc_P_q30 [k][2]*q );
			comp [k] = ( ( D << 8 ) + NTSCFX_qoffset ) >> NES_NTSC_QFX;
		}
		if ( comp [2] >= 0x3E0 ) comp [2] = 0x3E0;

		/* PACK_RGB + NES_NTSC_CLAMP_( shift 0 ) + byte extract */
		rgb = ( (unsigned) comp [0] << 21 ) | ( (unsigned) comp [1] << 11 ) |
				( (unsigned) comp [2] << 1 );
		{
			unsigned const builder = (1u<<21) | (1u<<11) | (1u<<1);
			unsigned const cmask = builder * 3u / 2u;
			unsigned const cadd  = builder * 0x101u;
			unsigned sub = ( rgb >> 9 ) & cmask;
			unsigned clamp = cadd - sub;
			rgb |= clamp; clamp -= sub; rgb &= clamp;
		}
		palette_out [entry*3    ] = (unsigned char) ( rgb >> 21 );
		palette_out [entry*3 + 1] = (unsigned char) ( rgb >> 11 );
		palette_out [entry*3 + 2] = (unsigned char) ( rgb >>  1 );
	}
}

void nes_ntsc_init( nes_ntsc_t* ntsc, nes_ntsc_setup_t const* setup )
{
	/* nes_ntsc is used solely as a palette generator.  The built-in NTSC blitter
	   and its floating-point kernel generation have been removed, so no kernel
	   table is produced and the implementation contains no floating point. */
	(void) ntsc;
	if ( !setup )
		setup = &nes_ntsc_composite;

	/* Standard NES-decoder palette generation: base palette supplied, default
	   decoder, and no hue/saturation/contrast/brightness/gamma adjustment.
	   Deterministic Q30 fixed-point, byte-exact to the exact rational reference. */
	if ( setup->palette_out && setup->base_palette &&
			!setup->palette &&
			setup->hue == 0 && setup->saturation == 0 &&
			setup->contrast == 0 && setup->brightness == 0 && setup->gamma == 0 )
		nes_ntsc_palette_fixed( setup->base_palette, setup->palette_out );
}

