
// Blip_Buffer 0.4.0. http://www.slack.net/~ant/

#include "Blip_Buffer.h"

#include <limits.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

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

#ifdef BLARGG_ENABLE_OPTIMIZER
	#include BLARGG_ENABLE_OPTIMIZER
#endif

int const buffer_extra = blip_widest_impulse_ + 2;

Blip_Buffer::Blip_Buffer()
{
	factor_ = LONG_MAX;
	offset_ = 0;
	buffer_ = 0;
	buffer_size_ = 0;
	sample_rate_ = 0;
	reader_accum = 0;
	bass_shift = 0;
	clock_rate_ = 0;
	bass_freq_ = 16;
	length_ = 0;

	extra_length = length_;
	extra_offset = offset_;
	extra_reader_accum = reader_accum;
	memset(extra_buffer, 0, sizeof(extra_buffer));
	extra_valid = false;
}

Blip_Buffer::~Blip_Buffer()
{
	if ( buffer_ )
		free( buffer_ );
}

void Blip_Buffer::clear( int entire_buffer )
{
	offset_ = 0;
	reader_accum = 0;
	if ( buffer_ )
	{
		long count = (entire_buffer ? buffer_size_ : samples_avail());
		memset( buffer_, 0, (count + buffer_extra) * sizeof (buf_t_) );
	}
}

const char *Blip_Buffer::set_sample_rate( long new_rate, int msec )
{
	// start with maximum length that resampled time can represent
	long new_size = (ULONG_MAX >> BLIP_BUFFER_ACCURACY) - buffer_extra - 64;
	if ( msec != blip_max_length )
	{
		long s = (new_rate * (msec + 1) + 999) / 1000;
		if ( s < new_size )
			new_size = s;
	}
	
	if ( buffer_size_ != new_size )
	{
		void* p = realloc( buffer_, (new_size + buffer_extra) * sizeof *buffer_ );
		if ( !p )
			return "Out of memory";
		buffer_ = (buf_t_*) p;
	}
	
	buffer_size_ = new_size;
	// update things based on the sample rate
	sample_rate_ = new_rate;
	length_ = new_size * 1000 / new_rate - 1;
	if ( clock_rate_ )
		clock_rate( clock_rate_ );
	bass_freq( bass_freq_ );
	
	clear();
	
	return 0; // success
}

blip_resampled_time_t Blip_Buffer::clock_rate_factor( long clock_rate ) const
{
	// factor = round( sample_rate_ / clock_rate * 2^BLIP_BUFFER_ACCURACY ),
	// computed as an exact 64-bit integer (correctly rounded, no float).
	long long num = ( (long long) sample_rate_ << BLIP_BUFFER_ACCURACY ) + clock_rate / 2;
	long factor = (long) ( num / clock_rate );
	return (blip_resampled_time_t) factor;
}

void Blip_Buffer::bass_freq( int freq )
{
	bass_freq_ = freq;
	int shift = 31;
	if ( freq > 0 )
	{
		shift = 13;
		long f = (freq << 16) / sample_rate_;
		while ( (f >>= 1) && --shift ) { }
	}
	bass_shift = shift;
}

void Blip_Buffer::end_frame( blip_time_t t )
{
	offset_ += t * factor_;
}

void Blip_Buffer::remove_silence( long count )
{
	offset_ -= (blip_resampled_time_t) count << BLIP_BUFFER_ACCURACY;
}

long Blip_Buffer::count_samples( blip_time_t t ) const
{
	unsigned long last_sample  = resampled_time( t ) >> BLIP_BUFFER_ACCURACY;
	unsigned long first_sample = offset_ >> BLIP_BUFFER_ACCURACY;
	return (long) (last_sample - first_sample);
}

blip_time_t Blip_Buffer::count_clocks( long count ) const
{
	if ( count > buffer_size_ )
		count = buffer_size_;
	blip_resampled_time_t time = (blip_resampled_time_t) count << BLIP_BUFFER_ACCURACY;
	return (blip_time_t) ((time - offset_ + factor_ - 1) / factor_);
}

void Blip_Buffer::remove_samples( long count )
{
	if ( count )
	{
		remove_silence( count );
		
		// copy remaining samples to beginning and clear old samples
		long remain = samples_avail() + buffer_extra;
		memmove( buffer_, buffer_ + count, remain * sizeof *buffer_ );
		memset( buffer_ + remain, 0, count * sizeof *buffer_ );
	}
}

// Blip_Synth_

Blip_Synth_::Blip_Synth_( short* p, int w ) :
	impulses( p ),
	width( w )
{
	volume_unit_q30_ = 0;
	kernel_unit = 0;
	buf = 0;
	last_amp = 0;
	delta_factor = 0;
}

/* The reference (float) kernel math lives in the offline generator
   tools/gen_blip_kernels.cpp, which produced blip_kernels.h. The library
   itself contains no floating point. */

void Blip_Synth_::adjust_impulse()
{
	// sum pairs for each phase and add error correction to end of first half
	int const size = impulses_size();
	for ( int p = blip_res; p-- >= blip_res / 2; )
	{
		int p2 = blip_res - 2 - p;
		long error = kernel_unit;
		for ( int i = 1; i < size; i += blip_res )
		{
			error -= impulses [i + p ];
			error -= impulses [i + p2];
		}
		if ( p == p2 )
			error /= 2; // phase = 0.5 impulse uses same half for both sides
		impulses [size - blip_res + p] += error;
		//printf( "error: %ld\n", error );
	}
	
	//for ( int i = blip_res; i--; printf( "\n" ) )
	//  for ( int j = 0; j < width / 2; j++ )
	//      printf( "%5ld,", impulses [j * blip_res + i + 1] );
}

#include "blip_kernels.h"
bool Blip_Synth_::load_baked_kernel( blip_eq_t const& eq )
{
	int n = 0;
	short const* k = 0;
	// All QuickNES EQ presets leave cutoff_freq at 0; anything else is off-menu.
	if ( eq.cutoff_freq == 0 )
		k = blip_lookup_kernel( width, eq.treble, eq.rolloff_freq, eq.sample_rate, &n );
	if ( !k || n != impulses_size() )
	{
		// Off-menu combo (never requested in normal operation): fall back to the
		// canonical 'nes' kernel @44100 for this width, which is always baked.
		// Keeps the default build entirely float-free.
		k = blip_lookup_kernel( width, -1, 80, 44100, &n );
		if ( !k || n != impulses_size() )
			return false;
	}
	for ( int i = 0; i < n; i++ )
		impulses [i] = k [i];
	kernel_unit = 32768; // base_unit; matches the baked (post-adjust_impulse) state
	return true;
}

void Blip_Synth_::treble_eq( blip_eq_t const& eq )
{
	// Deterministic baked kernel (always succeeds via the canonical fallback).
	// No floating point: the reference kernel math lives in the offline generator
	// tools/gen_blip_kernels.cpp, which produced blip_kernels.h.
	load_baked_kernel( eq );
	
	// volume might require rescaling
	long long vol = volume_unit_q30_;
	if ( vol )
	{
		volume_unit_q30_ = 0;
		volume_unit_fixed( vol );
	}
}

void Blip_Synth_::volume_unit_fixed( long long unit_q30 )
{
	if ( unit_q30 != volume_unit_q30_ )
	{
		// use default eq if it hasn't been set yet
		if ( !kernel_unit )
			treble_eq( blip_eq_t( -8 ) );
		
		volume_unit_q30_ = unit_q30;
		
		// factor(real) = unit * 2^blip_sample_bits / kernel_unit.
		// With unit stored in Q30, factor == unit_q30 / kernel_unit; carry it
		// in Q16 fixed for the attenuation test and the final round.
		long long factor_q16 = ( unit_q30 << 16 ) / kernel_unit;
		
		if ( factor_q16 > 0 )
		{
			int shift = 0;
			
			// if unit is really small, might need to attenuate kernel
			while ( factor_q16 < ( 2LL << 16 ) )
			{
				shift++;
				factor_q16 <<= 1;
			}
			
			if ( shift )
			{
				kernel_unit >>= shift;
				
				// keep values positive to avoid round-towards-zero of sign-preserving
				// right shift for negative values
				long offset = 0x8000 + (1 << (shift - 1));
				long offset2 = 0x8000 >> shift;
				for ( int i = impulses_size(); i--; )
					impulses [i] = (short) (((impulses [i] + offset) >> shift) - offset2);
				adjust_impulse();
			}
		}
		delta_factor = (int) ( ( factor_q16 + (1 << 15) ) >> 16 ); // round(factor)
	}
}

long Blip_Buffer::read_samples( blip_sample_t* out, long max_samples, int stereo )
{
	long count = samples_avail();
	if ( count > max_samples )
		count = max_samples;
	
	if ( count )
	{
		int const sample_shift = blip_sample_bits - 16;
		int const bass_shift = this->bass_shift;
		long accum = reader_accum;
		buf_t_* in = buffer_;
		
		if (out != NULL)
		{
			if ( !stereo )
			{
				for ( long n = count; n--; )
				{
					long s = accum >> sample_shift;
					accum -= accum >> bass_shift;
					accum += *in++;
					*out++ = (blip_sample_t) s;
					
					// clamp sample
					if ( (blip_sample_t) s != s )
						out [-1] = (blip_sample_t) (0x7FFF - (s >> 24));
				}
			}
			else
			{
				for ( long n = count; n--; )
				{
					long s = accum >> sample_shift;
					accum -= accum >> bass_shift;
					accum += *in++;
					*out = (blip_sample_t) s;
					out += 2;
				
					// clamp sample
					if ( (blip_sample_t) s != s )
						out [-2] = (blip_sample_t) (0x7FFF - (s >> 24));
				}
			}
		}
		else
		{
			//only run accumulator, do not output anything
			for (long n = count; n--; )
			{
				accum -= accum >> bass_shift;
				accum += *in++;
			}
		}
		
		reader_accum = accum;
		remove_samples( count );
	}
	return count;
}

void Blip_Buffer::mix_samples( blip_sample_t const* in, long count )
{
	buf_t_* out = buffer_ + (offset_ >> BLIP_BUFFER_ACCURACY) + blip_widest_impulse_ / 2;
	
	int const sample_shift = blip_sample_bits - 16;
	int prev = 0;
	while ( count-- )
	{
		long s = (long) *in++ << sample_shift;
		*out += s - prev;
		prev = s;
		++out;
	}
	*out -= prev;
}

void Blip_Buffer::SaveAudioBufferState()
{
	// Save the live portion of buffer_ (samples_avail + the impulse-response
	// tail buffer_extra), bounded by the dedicated extra_buffer's capacity.
	// In practice the post-read-samples residual is only ~18 longs, but
	// callers may serialize before draining and we want to preserve as much
	// as the snapshot area can hold.
	long live = samples_avail() + (long) buffer_extra;
	if ( live > (long) extra_buffer_size )
		live = (long) extra_buffer_size;
	extra_length = length_;
	extra_offset = offset_;
	extra_reader_accum = reader_accum;
	if ( live > 0 && buffer_ )
		memcpy( extra_buffer, buffer_, (size_t) live * sizeof (buf_t_) );
	// Zero any tail to keep deterministic contents in the snapshot.
	if ( live < (long) extra_buffer_size )
		memset( extra_buffer + live, 0,
		        (size_t) (extra_buffer_size - live) * sizeof (buf_t_) );
	extra_valid = true;
}
void Blip_Buffer::RestoreAudioBufferState()
{
	if ( !extra_valid )
		return; // no Save has happened in this Blip_Buffer's lifetime
	length_ = extra_length;
	offset_ = extra_offset;
	reader_accum = extra_reader_accum;
	if ( buffer_ && buffer_size_ > 0 )
	{
		long copy = (long) extra_buffer_size;
		if ( copy > buffer_size_ )
			copy = buffer_size_;
		memcpy( buffer_, extra_buffer, (size_t) copy * sizeof (buf_t_) );
		// Beyond the snapshot, the buffer may still hold "future" samples
		// written by the speculative emulation that ran between Save and
		// Restore. Clear them so the restored read state is exact.
		if ( copy < buffer_size_ )
			memset( buffer_ + copy, 0,
			        (size_t) (buffer_size_ - copy) * sizeof (buf_t_) );
	}
}
