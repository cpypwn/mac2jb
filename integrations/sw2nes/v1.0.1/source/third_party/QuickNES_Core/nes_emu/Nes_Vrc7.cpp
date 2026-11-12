#include "Nes_Mapper.h"
#include "Nes_Vrc7.h"
#include "emu2413.h"
#include <string.h>

#define BYTESWAP(xxxx) {uint32_t _temp = (uint32_t)(xxxx);\
((uint8_t*)&(xxxx))[0] = (uint8_t)((_temp) >> 24);\
((uint8_t*)&(xxxx))[1] = (uint8_t)((_temp) >> 16);\
((uint8_t*)&(xxxx))[2] = (uint8_t)((_temp) >> 8);\
((uint8_t*)&(xxxx))[3] = (uint8_t)((_temp) >> 0);\
}

Nes_Vrc7::Nes_Vrc7()
{
	opll = OPLL_new( 3579545 );
	output( NULL );
	volume();
	reset();
}

Nes_Vrc7::~Nes_Vrc7()
{
	OPLL_delete( ( OPLL * ) opll );
}

void Nes_Vrc7::reset()
{
	last_time = 0;
	count = 0;

	for ( int i = 0; i < osc_count; ++i )
	{
		Vrc7_Osc& osc = oscs [i];
		for ( int j = 0; j < 3; ++j )
			osc.regs [j] = 0;
		osc.last_amp = 0;
	}

	OPLL_reset( ( OPLL * ) opll );
}

void Nes_Vrc7::volume()
{
	synth.volume( 357913941 ); // (1/3), Q30
}

void Nes_Vrc7::treble_eq( blip_eq_t const& eq )
{
	synth.treble_eq( eq );
}

void Nes_Vrc7::output( Blip_Buffer* buf )
{
	for ( int i = 0; i < osc_count; i++ )
		osc_output( i, buf );
}

void Nes_Vrc7::run_until( nes_time_t end_time )
{
	if ( end_time <= last_time )
	{
		last_time = end_time;
		return;
	}

	// The OPLL ticks once every 36 CPU cycles. The original implementation
	// looped one cycle at a time and only did real work when an internal
	// counter wrapped at 36, which on NTSC means ~29800 wasted iterations
	// per frame. Compute the tick schedule directly instead.
	nes_time_t total = end_time - last_time;
	long total_count = (long) count + (long) total;
	long num_ticks = total_count / 36;

	// First tick fires when the internal counter increments from 35 to 36.
	// Starting from `count`, that takes (36 - count) increments, with the
	// work happening before the time-step at the end of that iteration --
	// i.e. at last_time + (35 - count). Subsequent ticks are 36 cycles apart.
	nes_time_t tick_time = last_time + (35 - count);

	for ( long k = 0; k < num_ticks; ++k )
	{
		bool run = false;
		for ( unsigned i = 0; i < osc_count; ++i )
		{
			Vrc7_Osc & osc = oscs [i];
			if ( osc.output )
			{
				if ( ! run )
				{
					run = true;
					OPLL_run( ( OPLL * ) opll );
				}
				int amp = OPLL_calcCh( ( OPLL * ) opll, i );
				int delta = amp - osc.last_amp;
				if ( delta )
				{
					osc.last_amp = amp;
					synth.offset( tick_time, delta, osc.output );
				}
			}
		}
		tick_time += 36;
	}

	count = (int) (total_count % 36);
	last_time = end_time;
}

void Nes_Vrc7::write_reg( int data )
{
	OPLL_writeIO( ( OPLL * ) opll, 0, data );
}

void Nes_Vrc7::write_data( nes_time_t time, int data )
{
	if ( ( unsigned ) ( ( ( OPLL * ) opll )->adr - 0x10 ) < 0x36 )
	{
		int type = ( ( OPLL * ) opll )->adr >> 4;
		int chan = ( ( OPLL * ) opll )->adr & 15;
		
		if ( chan < 6 ) oscs [chan].regs [type-1] = data;
	}

	run_until( time );
	OPLL_writeIO( ( OPLL * ) opll, 1, data );
}

void Nes_Vrc7::end_frame( nes_time_t time )
{
	if ( time > last_time )
		run_until( time );
	last_time -= time;
}

#ifdef MSB_FIRST
static void OPLL_state_byteswap(OPLL_STATE *state)
{
	int i;
	BYTESWAP(state->pm_phase);
	BYTESWAP(state->am_phase);

	for (i = 0; i < 12; i++)
	{
		OPLL_SLOT_STATE *slotState = &(state->slot[i]);
		BYTESWAP(slotState->feedback);
		BYTESWAP(slotState->output[0]);
		BYTESWAP(slotState->output[1]);
		BYTESWAP(slotState->phase);
		BYTESWAP(slotState->pgout);
		BYTESWAP(slotState->eg_mode);
		BYTESWAP(slotState->eg_phase);
		BYTESWAP(slotState->eg_dphase);
		BYTESWAP(slotState->egout);
	}
}
#endif


void Nes_Vrc7::save_snapshot( vrc7_snapshot_t* out )
{
	out->latch = ( ( OPLL * ) opll )->adr;
	memcpy( out->inst, ( ( OPLL * ) opll )->CustInst, 8 );
	for ( int i = 0; i < osc_count; ++i )
	{
		for ( int j = 0; j < 3; ++j )
		{
			out->regs [i] [j] = oscs [i].regs [j];
		}
	}
	out->count = count;
	out->internal_opl_state_size = sizeof(OPLL_STATE);
#ifdef MSB_FIRST
	BYTESWAP(out->internal_opl_state_size);
#endif
	OPLL_serialize((OPLL*)opll, &(out->internal_opl_state));
#ifdef MSB_FIRST
	OPLL_state_byteswap(&(out->internal_opl_state));
#endif
}

void Nes_Vrc7::load_snapshot( vrc7_snapshot_t const& in, int dataSize )
{
	reset();
	write_reg( in.latch );
	int i;
	for ( i = 0; i < osc_count; ++i )
	{
		for ( int j = 0; j < 3; ++j )
		{
			oscs [i].regs [j] = in.regs [i] [j];
		}
	}
	count = in.count;

	for ( i = 0; i < 8; ++i )
	{
		OPLL_writeReg( ( OPLL * ) opll, i, in.inst [i] );
	}

	for ( i = 0; i < 3; ++i )
	{
		for ( int j = 0; j < 6; ++j )
		{
			OPLL_writeReg( ( OPLL * ) opll, 0x10 + i * 0x10 + j, oscs [j].regs [i] );
		}
	}

	// Operate on a local copy so the caller's snapshot stays untouched. The
	// previous in-place byte-swap-and-deserialize left the caller's struct
	// in host-endian afterwards, which silently broke a second restore from
	// the same buffer on a big-endian host.
	int state_size = in.internal_opl_state_size;
#ifdef MSB_FIRST
	BYTESWAP(state_size);
#endif
	if (state_size == sizeof(OPLL_STATE))
	{
		OPLL_STATE local_state = in.internal_opl_state;
#ifdef MSB_FIRST
		OPLL_state_byteswap(&local_state);
#endif
		OPLL_deserialize((OPLL*)opll, &local_state);
	}
	update_last_amp();
}

void Nes_Vrc7::update_last_amp()
{
	for (unsigned i = 0; i < osc_count; ++i)
	{
		Vrc7_Osc & osc = oscs[i];
		if (osc.output)
		{
			int amp = OPLL_calcCh((OPLL *)opll, i);
			int delta = amp - osc.last_amp;
			if (delta)
			{
				osc.last_amp = amp;
				synth.offset(last_time, delta, osc.output);
			}
		}
	}
}
